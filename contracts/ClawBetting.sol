// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title ClawBetting
 * @notice Pari-mutuel prediction market for Claw IO matches using native MON.
 *         Humans call placeBet() directly; the backend operator calls placeBetFor()
 *         on behalf of agents. After a match, the operator resolves and winners
 *         claim their proportional share of 90% of the pool.
 *
 * Distribution:
 *   90% → bettors who backed the winning agent(s)  (proportional)
 *    5% → winning agent wallet(s)                   (split equally on draw)
 *    5% → treasury
 *
 * If nobody bet on the winning agent(s), the 90% bettor share goes to treasury.
 *
 * Deploy via Remix IDE on Monad testnet (chainId 10143).
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

    enum MatchStatus { None, Open, Closed, Resolved, Cancelled }

    struct MatchInfo {
        MatchStatus status;
        uint256 totalPool;
        bytes32[] agentIds;
        bytes32[] winnerAgentIds;
        // agentId → total amount bet on that agent
        mapping(bytes32 => uint256) agentPools;
        // bettor → agentId → amount
        mapping(address => mapping(bytes32 => uint256)) bets;
        // bettor → total across all agents in this match
        mapping(address => uint256) totalBetByUser;
        // bettor → already claimed?
        mapping(address => bool) claimed;
        // list of unique bettors (for refund iteration)
        address[] bettors;
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
        uint256 _maxBetAmount
    ) Ownable(msg.sender) {
        require(_treasury != address(0), "ClawBetting: zero treasury");
        require(_operator != address(0), "ClawBetting: zero operator");
        treasury = _treasury;
        operator = _operator;
        minBetAmount = _minBetAmount;
        maxBetAmount = _maxBetAmount;
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
     * @notice Human places a bet by sending MON directly.
     */
    function placeBet(
        bytes32 matchId,
        bytes32 agentId
    ) external payable nonReentrant {
        _placeBet(msg.sender, matchId, agentId, msg.value);
    }

    /**
     * @notice Operator places a bet on behalf of an agent (sends MON with the call).
     */
    function placeBetFor(
        address bettor,
        bytes32 matchId,
        bytes32 agentId
    ) external payable onlyOperator nonReentrant {
        require(bettor != address(0), "ClawBetting: zero bettor");
        _placeBet(bettor, matchId, agentId, msg.value);
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

        uint256 pool = m.totalPool;
        if (pool == 0) {
            // Nothing wagered – just mark resolved.
            emit MatchResolved(matchId, winnerAgentIds, 0, 0, 0);
            return;
        }

        // ── Calculate shares ──
        uint256 treasuryAmount = (pool * TREASURY_BPS) / BPS_DENOMINATOR;
        uint256 agentAmount    = (pool * WINNER_AGENT_BPS) / BPS_DENOMINATOR;
        // bettorPool is implicitly whatever remains after treasury + agent

        // ── Check if anyone bet on any winner ──
        uint256 combinedWinnerPool = 0;
        for (uint256 i = 0; i < winnerAgentIds.length; i++) {
            combinedWinnerPool += m.agentPools[winnerAgentIds[i]];
        }

        if (combinedWinnerPool == 0) {
            // Nobody bet on the winner(s) → 90 % also goes to treasury
            treasuryAmount = pool - agentAmount; // treasury gets 95 %
        }

        // ── Transfer 5 % agent reward (split equally among winners) ──
        // Unclaimed shares (agent has no wallet) are added to treasury.
        uint256 perAgent = agentAmount / winnerAgentIds.length;
        uint256 unclaimedAgentReward = 0;
        for (uint256 i = 0; i < winnerAgentIds.length; i++) {
            if (winnerAgentWallets[i] != address(0) && perAgent > 0) {
                (bool ok, ) = winnerAgentWallets[i].call{value: perAgent}("");
                require(ok, "ClawBetting: agent transfer failed");
            } else {
                unclaimedAgentReward += perAgent;
            }
        }
        treasuryAmount += unclaimedAgentReward;

        // ── Transfer treasury share ──
        if (treasuryAmount > 0) {
            (bool ok, ) = treasury.call{value: treasuryAmount}("");
            require(ok, "ClawBetting: treasury transfer failed");
        }

        emit MatchResolved(matchId, winnerAgentIds, pool, treasuryAmount, agentAmount);
    }

    /**
     * @notice Winning bettor claims proportional share of the 90 % pool.
     */
    function claim(bytes32 matchId) external nonReentrant {
        _claim(msg.sender, matchId);
    }

    /**
     * @notice Operator claims on behalf of an agent bettor.
     */
    function claimFor(
        address bettor,
        bytes32 matchId
    ) external onlyOperator nonReentrant {
        _claim(bettor, matchId);
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

        for (uint256 i = 0; i < m.bettors.length; i++) {
            address bettor = m.bettors[i];
            uint256 total = m.totalBetByUser[bettor];
            if (total > 0) {
                m.totalBetByUser[bettor] = 0;
                (bool ok, ) = bettor.call{value: total}("");
                require(ok, "ClawBetting: refund failed");
                emit BetRefunded(matchId, bettor, total);
            }
        }

        emit MatchCancelled(matchId);
    }

    // ── View helpers ───────────────────────────────────────────────────

    function getMatchStatus(bytes32 matchId) external view returns (
        MatchStatus status,
        uint256 totalPool,
        bytes32[] memory agentIds,
        bytes32[] memory winnerAgentIds
    ) {
        MatchInfo storage m = matches[matchId];
        return (m.status, m.totalPool, m.agentIds, m.winnerAgentIds);
    }

    function getAgentPool(bytes32 matchId, bytes32 agentId) external view returns (uint256) {
        return matches[matchId].agentPools[agentId];
    }

    function getBet(
        bytes32 matchId,
        address bettor,
        bytes32 agentId
    ) external view returns (uint256) {
        return matches[matchId].bets[bettor][agentId];
    }

    function hasClaimed(bytes32 matchId, address bettor) external view returns (bool) {
        return matches[matchId].claimed[bettor];
    }

    function getClaimableAmount(
        bytes32 matchId,
        address bettor
    ) external view returns (uint256) {
        MatchInfo storage m = matches[matchId];
        if (m.status != MatchStatus.Resolved) return 0;
        if (m.claimed[bettor]) return 0;

        (uint256 combinedWinnerPool, uint256 userWinningBets) = _winningBetsOf(m, bettor);
        if (combinedWinnerPool == 0 || userWinningBets == 0) return 0;

        uint256 payoutPool = (m.totalPool * WINNER_BETTORS_BPS) / BPS_DENOMINATOR;
        return (userWinningBets * payoutPool) / combinedWinnerPool;
    }

    function getBettorCount(bytes32 matchId) external view returns (uint256) {
        return matches[matchId].bettors.length;
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

    function _placeBet(
        address bettor,
        bytes32 matchId,
        bytes32 agentId,
        uint256 amount
    ) internal {
        MatchInfo storage m = matches[matchId];
        require(m.status == MatchStatus.Open, "ClawBetting: betting not open");
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

        // Track new bettor
        if (m.totalBetByUser[bettor] == 0) {
            m.bettors.push(bettor);
        }

        m.bets[bettor][agentId] += amount;
        m.agentPools[agentId]   += amount;
        m.totalPool             += amount;
        m.totalBetByUser[bettor] += amount;

        emit BetPlaced(matchId, bettor, agentId, amount);
    }

    function _claim(address bettor, bytes32 matchId) internal {
        MatchInfo storage m = matches[matchId];
        require(m.status == MatchStatus.Resolved, "ClawBetting: not resolved");
        require(!m.claimed[bettor], "ClawBetting: already claimed");

        (uint256 combinedWinnerPool, uint256 userWinningBets) = _winningBetsOf(m, bettor);
        require(userWinningBets > 0, "ClawBetting: no winning bets");

        m.claimed[bettor] = true;

        uint256 payoutPool = (m.totalPool * WINNER_BETTORS_BPS) / BPS_DENOMINATOR;
        uint256 payout = (userWinningBets * payoutPool) / combinedWinnerPool;

        (bool ok, ) = bettor.call{value: payout}("");
        require(ok, "ClawBetting: payout transfer failed");

        emit WinningsClaimed(matchId, bettor, payout);
    }

    /**
     * @dev Sums the combined pool of all winning agents and the bettor's
     *      bets that were placed on winning agents. Used for proportional payout.
     */
    function _winningBetsOf(
        MatchInfo storage m,
        address bettor
    ) internal view returns (uint256 combinedWinnerPool, uint256 userWinningBets) {
        for (uint256 i = 0; i < m.winnerAgentIds.length; i++) {
            bytes32 wId = m.winnerAgentIds[i];
            combinedWinnerPool += m.agentPools[wId];
            userWinningBets    += m.bets[bettor][wId];
        }
    }
}
