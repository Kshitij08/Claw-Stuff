// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title ClawBetting
 * @notice Pari-mutuel prediction market for Claw IO matches using native MON
 *         and ERC20 $builderarena. Humans and agents always place and fund their
 *         own bets (self-funded). After a match, the operator resolves and
 *         winners claim their proportional share of 90% of each token pool.
 *
 * Distribution:
 *   90% → bettors who backed the winning agent(s)  (proportional)
 *    5% → winning agent wallet(s)                   (split equally on draw)
 *    5% → treasury
 *
 * If nobody bet on the winning agent(s), the 90% bettor share goes to treasury.
 *
 * Deploy via Remix IDE on Base mainnet (chainId 8453).
 */
contract ClawBetting is Ownable, ReentrancyGuard {
    // ── Constants ──────────────────────────────────────────────────────
    uint256 public constant WINNER_BETTORS_BPS = 9000; // 90 %
    uint256 public constant WINNER_AGENT_BPS   =  500; //  5 %
    uint256 public constant TREASURY_BPS       =  500; //  5 %
    uint256 public constant BPS_DENOMINATOR    = 10000;

    // ── State ──────────────────────────────────────────────────────────
    address public treasury;
    address public operator;
    uint256 public minBetAmount;
    uint256 public maxBetAmount; // 0 = no limit

    // ERC-20 token used for the secondary pool ($builderarena)
    IERC20 public immutable builderarenaToken;

    enum MatchStatus { None, Open, Closed, Resolved, Cancelled }

    // Per-token pool for a match
    struct Pool {
        uint256 totalPool;
        // agentId → total amount bet on that agent for this token
        mapping(bytes32 => uint256) agentPools;
        // bettor → agentId → amount for this token
        mapping(address => mapping(bytes32 => uint256)) bets;
        // bettor → total across all agents in this match for this token
        mapping(address => uint256) totalBetByUser;
        // list of unique bettors for this token (for refunds)
        address[] bettors;
    }

    struct MatchInfo {
        MatchStatus status;
        bytes32[] agentIds;
        bytes32[] winnerAgentIds;
        // One pool per token: native MON and ERC20 $builderarena
        Pool monPool;
        Pool builderarenaPool;
        // bettor → already claimed for each token
        mapping(address => bool) claimedMon;
        mapping(address => bool) claimedBuilderarena;
    }

    mapping(bytes32 => MatchInfo) private matches;

    // ── Events ─────────────────────────────────────────────────────────
    event BettingOpened(bytes32 indexed matchId, bytes32[] agentIds);
    event BetPlaced(
        bytes32 indexed matchId,
        address indexed bettor,
        bytes32 indexed agentId,
        uint256 amount
    );
    event BettingClosed(bytes32 indexed matchId);
    event MatchResolved(
        bytes32 indexed matchId,
        bytes32[] winnerAgentIds,
        uint256 totalPool,
        uint256 treasuryPayout,
        uint256 agentPayout
    );
    event WinningsClaimed(
        bytes32 indexed matchId,
        address indexed bettor,
        uint256 amount
    );
    event MatchCancelled(bytes32 indexed matchId);
    event BetRefunded(
        bytes32 indexed matchId,
        address indexed bettor,
        uint256 amount
    );

    // Token-specific events
    event BuilderarenaBetPlaced(
        bytes32 indexed matchId,
        address indexed bettor,
        bytes32 indexed agentId,
        uint256 amount
    );

    event MatchResolvedToken(
        bytes32 indexed matchId,
        address indexed token, // address(0) = MON, builderarenaToken = $builderarena
        uint256 totalPool,
        uint256 treasuryPayout,
        uint256 agentPayout
    );

    // ── Modifiers ──────────────────────────────────────────────────────
    modifier onlyOperator() {
        require(msg.sender == operator, "ClawBetting: caller is not the operator");
        _;
    }

    // ── Constructor ────────────────────────────────────────────────────
    constructor(
        address _treasury,
        address _operator,
        uint256 _minBetAmount,
        uint256 _maxBetAmount,
        address _builderarenaToken
    ) Ownable(msg.sender) {
        require(_treasury != address(0), "ClawBetting: zero treasury");
        require(_operator != address(0), "ClawBetting: zero operator");
        require(_builderarenaToken != address(0), "ClawBetting: zero builderarena token");
        treasury = _treasury;
        operator = _operator;
        minBetAmount = _minBetAmount;
        maxBetAmount = _maxBetAmount;
        builderarenaToken = IERC20(_builderarenaToken);
    }

    // ── Admin setters ──────────────────────────────────────────────────
    function setTreasury(address _treasury) external onlyOwner {
        require(_treasury != address(0), "ClawBetting: zero address");
        treasury = _treasury;
    }

    function setOperator(address _operator) external onlyOwner {
        require(_operator != address(0), "ClawBetting: zero address");
        operator = _operator;
    }

    function setBetLimits(uint256 _min, uint256 _max) external onlyOwner {
        minBetAmount = _min;
        maxBetAmount = _max;
    }

    // ── Core: open / bet / close / resolve / claim / cancel ────────────

    /**
     * @notice Operator opens betting for a match.
     */
    function openBetting(
        bytes32 matchId,
        bytes32[] calldata agentIds
    ) external onlyOperator {
        MatchInfo storage m = matches[matchId];
        require(m.status == MatchStatus.None, "ClawBetting: match already exists");
        require(agentIds.length >= 2, "ClawBetting: need >= 2 agents");
        m.status = MatchStatus.Open;
        m.agentIds = agentIds;
        emit BettingOpened(matchId, agentIds);
    }

    /**
     * @notice Operator adds agents to an open match (for late-joining players).
     */
    function addAgents(
        bytes32 matchId,
        bytes32[] calldata newAgentIds
    ) external onlyOperator {
        MatchInfo storage m = matches[matchId];
        require(m.status == MatchStatus.Open, "ClawBetting: betting not open");
        for (uint256 i = 0; i < newAgentIds.length; i++) {
            bool exists = false;
            for (uint256 j = 0; j < m.agentIds.length; j++) {
                if (m.agentIds[j] == newAgentIds[i]) {
                    exists = true;
                    break;
                }
            }
            if (!exists) {
                m.agentIds.push(newAgentIds[i]);
            }
        }
    }

    /**
     * @notice Human or agent places a bet by sending MON directly from their
     *         own wallet. All bets are self-funded; the operator never places
     *         bets on behalf of others.
     */
    function placeBet(
        bytes32 matchId,
        bytes32 agentId
    ) external payable nonReentrant {
        MatchInfo storage m = matches[matchId];
        require(m.status == MatchStatus.Open, "ClawBetting: betting not open");
        _placeBetInPool(m, m.monPool, msg.sender, agentId, msg.value);
        emit BetPlaced(matchId, msg.sender, agentId, msg.value);
    }

    /**
     * @notice Human or agent places a bet using ERC20 $builderarena. Caller must
     *         have approved this contract for at least `amount`.
     */
    function placeBuilderarenaBet(
        bytes32 matchId,
        bytes32 agentId,
        uint256 amount
    ) external nonReentrant {
        MatchInfo storage m = matches[matchId];
        require(m.status == MatchStatus.Open, "ClawBetting: betting not open");
        require(amount > 0, "ClawBetting: zero amount");

        require(
            builderarenaToken.transferFrom(msg.sender, address(this), amount),
            "ClawBetting: builderarena transfer failed"
        );

        _placeBetInPool(m, m.builderarenaPool, msg.sender, agentId, amount);
        emit BuilderarenaBetPlaced(matchId, msg.sender, agentId, amount);
    }

    /**
     * @notice Operator locks betting when the match starts.
     */
    function closeBetting(bytes32 matchId) external onlyOperator {
        MatchInfo storage m = matches[matchId];
        require(m.status == MatchStatus.Open, "ClawBetting: not open");
        m.status = MatchStatus.Closed;
        emit BettingClosed(matchId);
    }

    /**
     * @notice Operator resolves the match. Supports single winner & draws.
     *         Sends 5 % to winning agent wallet(s) and 5 % to treasury.
     *         If no one bet on the winner(s), the 90 % bettor pool also goes to treasury.
     */
    function resolveMatch(
        bytes32 matchId,
        bytes32[] calldata winnerAgentIds,
        address[] calldata winnerAgentWallets
    ) external onlyOperator nonReentrant {
        MatchInfo storage m = matches[matchId];
        require(m.status == MatchStatus.Closed, "ClawBetting: not closed");
        require(
            winnerAgentIds.length == winnerAgentWallets.length,
            "ClawBetting: arrays length mismatch"
        );
        require(winnerAgentIds.length > 0, "ClawBetting: no winners");

        m.status = MatchStatus.Resolved;
        m.winnerAgentIds = winnerAgentIds;

        // Resolve MON pool
        _resolvePoolForToken(
            matchId,
            m,
            m.monPool,
            address(0),
            winnerAgentIds,
            winnerAgentWallets
        );

        // Resolve builderarena pool
        _resolvePoolForToken(
            matchId,
            m,
            m.builderarenaPool,
            address(builderarenaToken),
            winnerAgentIds,
            winnerAgentWallets
        );
    }

    /**
     * @notice Winning bettor claims proportional share of the 90 % MON pool.
     */
    function claim(bytes32 matchId) external nonReentrant {
        _claimMon(msg.sender, matchId);
    }

    /**
     * @notice Operator claims MON winnings on behalf of a bettor (e.g. agents).
     */
    function claimFor(address bettor, bytes32 matchId) external onlyOperator nonReentrant {
        _claimMon(bettor, matchId);
    }

    /**
     * @notice Winning bettor claims proportional share of the 90 % $builderarena pool.
     */
    function claimBuilderarena(bytes32 matchId) external nonReentrant {
        _claimBuilderarena(msg.sender, matchId);
    }

    /**
     * @notice Operator claims $builderarena winnings on behalf of a bettor.
     */
    function claimBuilderarenaFor(address bettor, bytes32 matchId) external onlyOperator nonReentrant {
        _claimBuilderarena(bettor, matchId);
    }

    /**
     * @notice Operator cancels a match → full refund to all bettors.
     */
    function cancelMatch(bytes32 matchId) external onlyOperator nonReentrant {
        MatchInfo storage m = matches[matchId];
        require(
            m.status == MatchStatus.Open || m.status == MatchStatus.Closed,
            "ClawBetting: cannot cancel"
        );
        m.status = MatchStatus.Cancelled;

        // Refund MON bettors
        for (uint256 i = 0; i < m.monPool.bettors.length; i++) {
            address bettor = m.monPool.bettors[i];
            uint256 total = m.monPool.totalBetByUser[bettor];
            if (total > 0) {
                m.monPool.totalBetByUser[bettor] = 0;
                (bool ok, ) = bettor.call{value: total}("");
                require(ok, "ClawBetting: refund failed");
                emit BetRefunded(matchId, bettor, total);
            }
        }

        // Refund builderarena bettors
        for (uint256 i = 0; i < m.builderarenaPool.bettors.length; i++) {
            address bettor = m.builderarenaPool.bettors[i];
            uint256 total = m.builderarenaPool.totalBetByUser[bettor];
            if (total > 0) {
                m.builderarenaPool.totalBetByUser[bettor] = 0;
                require(
                    builderarenaToken.transfer(bettor, total),
                    "ClawBetting: builderarena refund failed"
                );
            }
        }

        emit MatchCancelled(matchId);
    }

    // ── View helpers ───────────────────────────────────────────────────

    function getMatchStatus(bytes32 matchId) external view returns (
        MatchStatus status,
        uint256 totalPoolMon,
        uint256 totalPoolBuilderarena,
        bytes32[] memory agentIds,
        bytes32[] memory winnerAgentIds
    ) {
        MatchInfo storage m = matches[matchId];
        return (m.status, m.monPool.totalPool, m.builderarenaPool.totalPool, m.agentIds, m.winnerAgentIds);
    }

    function getAgentPool(bytes32 matchId, bytes32 agentId) external view returns (uint256) {
        MatchInfo storage m = matches[matchId];
        return m.monPool.agentPools[agentId];
    }

    function getAgentPoolBuilderarena(bytes32 matchId, bytes32 agentId) external view returns (uint256) {
        MatchInfo storage m = matches[matchId];
        return m.builderarenaPool.agentPools[agentId];
    }

    function getBet(
        bytes32 matchId,
        address bettor,
        bytes32 agentId
    ) external view returns (uint256) {
        MatchInfo storage m = matches[matchId];
        return m.monPool.bets[bettor][agentId];
    }

    function getBetBuilderarena(
        bytes32 matchId,
        address bettor,
        bytes32 agentId
    ) external view returns (uint256) {
        MatchInfo storage m = matches[matchId];
        return m.builderarenaPool.bets[bettor][agentId];
    }

    function hasClaimed(bytes32 matchId, address bettor) external view returns (bool) {
        MatchInfo storage m = matches[matchId];
        return m.claimedMon[bettor];
    }

    function hasClaimedBuilderarena(bytes32 matchId, address bettor) external view returns (bool) {
        MatchInfo storage m = matches[matchId];
        return m.claimedBuilderarena[bettor];
    }

    function getClaimableAmounts(
        bytes32 matchId,
        address bettor
    ) external view returns (uint256 monAmount, uint256 builderarenaAmount) {
        MatchInfo storage m = matches[matchId];
        if (m.status != MatchStatus.Resolved) {
            return (0, 0);
        }

        if (!m.claimedMon[bettor]) {
            (uint256 combinedWinnerPoolMon, uint256 userWinningBetsMon) =
                _winningBetsInPool(m, m.monPool, bettor);
            if (combinedWinnerPoolMon > 0 && userWinningBetsMon > 0) {
                uint256 payoutPoolMon = (m.monPool.totalPool * WINNER_BETTORS_BPS) / BPS_DENOMINATOR;
                monAmount = (userWinningBetsMon * payoutPoolMon) / combinedWinnerPoolMon;
            }
        }

        if (!m.claimedBuilderarena[bettor]) {
            (uint256 combinedWinnerPoolBuilderarena, uint256 userWinningBetsBuilderarena) =
                _winningBetsInPool(m, m.builderarenaPool, bettor);
            if (combinedWinnerPoolBuilderarena > 0 && userWinningBetsBuilderarena > 0) {
                uint256 payoutPoolBuilderarena = (m.builderarenaPool.totalPool * WINNER_BETTORS_BPS) / BPS_DENOMINATOR;
                builderarenaAmount = (userWinningBetsBuilderarena * payoutPoolBuilderarena) / combinedWinnerPoolBuilderarena;
            }
        }
    }

    function getBettorCount(bytes32 matchId) external view returns (uint256) {
        MatchInfo storage m = matches[matchId];
        return m.monPool.bettors.length;
    }

    // ── Owner-only admin ────────────────────────────────────────────────

    /**
     * @notice Owner can withdraw any amount of MON from the contract.
     *         Use with care – only for recovering stuck/unclaimed funds.
     */
    function withdraw(address payable to, uint256 amount) external onlyOwner nonReentrant {
        require(to != address(0), "ClawBetting: zero address");
        require(amount > 0 && amount <= address(this).balance, "ClawBetting: invalid amount");
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "ClawBetting: withdraw failed");
    }

    /**
     * @notice Owner can withdraw the entire contract balance.
     */
    function withdrawAll(address payable to) external onlyOwner nonReentrant {
        require(to != address(0), "ClawBetting: zero address");
        uint256 bal = address(this).balance;
        require(bal > 0, "ClawBetting: nothing to withdraw");
        (bool ok, ) = to.call{value: bal}("");
        require(ok, "ClawBetting: withdraw failed");
    }

    // ── Internal ───────────────────────────────────────────────────────

    function _placeBetInPool(
        MatchInfo storage m,
        Pool storage p,
        address bettor,
        bytes32 agentId,
        uint256 amount
    ) internal {
        require(amount >= minBetAmount, "ClawBetting: below min bet");
        require(maxBetAmount == 0 || amount <= maxBetAmount, "ClawBetting: above max bet");

        // Validate agentId
        bool validAgent = false;
        for (uint256 i = 0; i < m.agentIds.length; i++) {
            if (m.agentIds[i] == agentId) {
                validAgent = true;
                break;
            }
        }
        require(validAgent, "ClawBetting: invalid agent");

        // Track new bettor for this token pool
        if (p.totalBetByUser[bettor] == 0) {
            p.bettors.push(bettor);
        }

        p.bets[bettor][agentId] += amount;
        p.agentPools[agentId]   += amount;
        p.totalPool             += amount;
        p.totalBetByUser[bettor] += amount;
    }

    function _resolvePoolForToken(
        bytes32 matchId,
        MatchInfo storage m,
        Pool storage p,
        address token,
        bytes32[] calldata winnerAgentIds,
        address[] calldata winnerAgentWallets
    ) internal {
        uint256 pool = p.totalPool;
        if (pool == 0) {
            emit MatchResolvedToken(matchId, token, 0, 0, 0);
            return;
        }

        uint256 treasuryAmount = (pool * TREASURY_BPS) / BPS_DENOMINATOR;
        uint256 agentAmount    = (pool * WINNER_AGENT_BPS) / BPS_DENOMINATOR;

        uint256 combinedWinnerPool = 0;
        for (uint256 i = 0; i < winnerAgentIds.length; i++) {
            combinedWinnerPool += p.agentPools[winnerAgentIds[i]];
        }

        if (combinedWinnerPool == 0) {
            // Nobody bet on the winner(s) → 90 % also goes to treasury
            treasuryAmount = pool - agentAmount; // treasury gets 95 %
        }

        uint256 perAgent = agentAmount / winnerAgentIds.length;
        uint256 unclaimedAgentReward = 0;
        for (uint256 i = 0; i < winnerAgentIds.length; i++) {
            address wallet = winnerAgentWallets[i];
            if (wallet != address(0) && perAgent > 0) {
                _payoutToken(token, wallet, perAgent);
            } else {
                unclaimedAgentReward += perAgent;
            }
        }
        treasuryAmount += unclaimedAgentReward;

        if (treasuryAmount > 0) {
            _payoutToken(token, treasury, treasuryAmount);
        }

        // Preserve existing MatchResolved event semantics for MON for backwards compatibility
        if (token == address(0)) {
            emit MatchResolved(matchId, m.winnerAgentIds, pool, treasuryAmount, agentAmount);
        }

        emit MatchResolvedToken(matchId, token, pool, treasuryAmount, agentAmount);
    }

    function _claimMon(address bettor, bytes32 matchId) internal {
        MatchInfo storage m = matches[matchId];
        require(m.status == MatchStatus.Resolved, "ClawBetting: not resolved");
        require(!m.claimedMon[bettor], "ClawBetting: already claimed MON");

        (uint256 combinedWinnerPool, uint256 userWinningBets) =
            _winningBetsInPool(m, m.monPool, bettor);
        require(userWinningBets > 0, "ClawBetting: no winning bets");

        m.claimedMon[bettor] = true;

        uint256 payoutPool = (m.monPool.totalPool * WINNER_BETTORS_BPS) / BPS_DENOMINATOR;
        uint256 payout = (userWinningBets * payoutPool) / combinedWinnerPool;

        (bool ok, ) = bettor.call{value: payout}("");
        require(ok, "ClawBetting: payout transfer failed");

        emit WinningsClaimed(matchId, bettor, payout);
    }

    function _claimBuilderarena(address bettor, bytes32 matchId) internal {
        MatchInfo storage m = matches[matchId];
        require(m.status == MatchStatus.Resolved, "ClawBetting: not resolved");
        require(!m.claimedBuilderarena[bettor], "ClawBetting: already claimed builderarena");

        (uint256 combinedWinnerPool, uint256 userWinningBets) =
            _winningBetsInPool(m, m.builderarenaPool, bettor);
        require(userWinningBets > 0, "ClawBetting: no winning bets");

        m.claimedBuilderarena[bettor] = true;

        uint256 payoutPool = (m.builderarenaPool.totalPool * WINNER_BETTORS_BPS) / BPS_DENOMINATOR;
        uint256 payout = (userWinningBets * payoutPool) / combinedWinnerPool;

        require(
            builderarenaToken.transfer(bettor, payout),
            "ClawBetting: builderarena payout transfer failed"
        );
    }

    /**
     * @dev Sums the combined pool of all winning agents and the bettor's
     *      bets that were placed on winning agents for a specific token pool.
     */
    function _winningBetsInPool(
        MatchInfo storage m,
        Pool storage p,
        address bettor
    ) internal view returns (uint256 combinedWinnerPool, uint256 userWinningBets) {
        for (uint256 i = 0; i < m.winnerAgentIds.length; i++) {
            bytes32 wId = m.winnerAgentIds[i];
            combinedWinnerPool += p.agentPools[wId];
            userWinningBets    += p.bets[bettor][wId];
        }
    }

    function _payoutToken(address token, address to, uint256 amount) internal {
        if (token == address(0)) {
            (bool ok, ) = to.call{value: amount}("");
            require(ok, "ClawBetting: native transfer failed");
        } else {
            require(IERC20(token).transfer(to, amount), "ClawBetting: ERC20 transfer failed");
        }
    }
}
