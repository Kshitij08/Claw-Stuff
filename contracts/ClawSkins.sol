// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import "@openzeppelin/contracts/token/common/ERC2981.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title ClawSkins
 * @notice Single ERC-721 collection of 5555 combined Body+Eyes+Mouth skin NFTs for Claw IO.
 *         Agents mint free via operatorMint (backend); humans pay mintPrice (111 MON) via publicMint,
 *         or 50% discount in $MClawIO via publicMintWithMClaw.
 *         5% royalties via ERC-2981 for marketplace compatibility.
 */
contract ClawSkins is ERC721, ERC721Enumerable, ERC2981, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 public constant MAX_SUPPLY = 5555;

    address public operator;
    address public treasury;
    uint256 public mintPrice;  // 111 MON in wei
    uint256 public mintPriceMClaw;  // $MClawIO amount (in wei) equal to 55.5 MON value; owner can update
    IERC20 public immutable mclawToken;  // $MClawIO; address(0) = MClaw mint disabled
    string private _baseTokenURI;
    uint256 private _nextTokenId = 1;

    event OperatorMint(address indexed to, uint256 indexed tokenId);
    event PublicMint(address indexed to, uint256 indexed tokenId, uint256 paid);

    modifier onlyOperator() {
        require(msg.sender == operator, "ClawSkins: not operator");
        _;
    }

    constructor(
        address _treasury,
        address _operator,
        uint256 _mintPrice,
        string memory baseURI_,
        address _mclawToken,
        uint256 _initialMintPriceMClaw
    ) ERC721("Claw Skins", "CLAWS") Ownable(msg.sender) {
        require(_treasury != address(0), "ClawSkins: zero treasury");
        require(_operator != address(0), "ClawSkins: zero operator");
        treasury = _treasury;
        operator = _operator;
        mintPrice = _mintPrice;
        // $MClawIO amount (wei) equal to 55.5 MON value; pass 0 to use mintPrice/2 as fallback
        mintPriceMClaw = _initialMintPriceMClaw != 0 ? _initialMintPriceMClaw : _mintPrice / 2;
        mclawToken = IERC20(_mclawToken);  // can be address(0) to disable MClaw mint
        _baseTokenURI = baseURI_;
        _setDefaultRoyalty(_treasury, 500); // 5%
    }

    function _baseURI() internal view override returns (string memory) {
        return _baseTokenURI;
    }

    function setBaseURI(string calldata baseURI_) external onlyOwner {
        _baseTokenURI = baseURI_;
    }

    function setMintPrice(uint256 _mintPrice) external onlyOwner {
        mintPrice = _mintPrice;
    }

    /** @notice Set $MClawIO mint price (amount in wei equal to 55.5 MON value). Owner updates from oracle/backend. */
    function setMintPriceMClaw(uint256 _mintPriceMClaw) external onlyOwner {
        mintPriceMClaw = _mintPriceMClaw;
    }

    function setOperator(address _operator) external onlyOwner {
        require(_operator != address(0), "ClawSkins: zero address");
        operator = _operator;
    }

    function setTreasury(address _treasury) external onlyOwner {
        require(_treasury != address(0), "ClawSkins: zero address");
        treasury = _treasury;
        _setDefaultRoyalty(_treasury, 500);
    }

    /** @notice Operator mints to an address (free, for agents after challenge). */
    function operatorMint(address to) external onlyOperator nonReentrant returns (uint256 tokenId) {
        require(_nextTokenId <= MAX_SUPPLY, "ClawSkins: sold out");
        tokenId = _nextTokenId++;
        _safeMint(to, tokenId);
        emit OperatorMint(to, tokenId);
        return tokenId;
    }

    /** @notice Public mint for 111 MON (humans). MON is sent directly to treasury. */
    function publicMint() external payable nonReentrant returns (uint256 tokenId) {
        require(msg.value == mintPrice, "ClawSkins: wrong mint price");
        require(_nextTokenId <= MAX_SUPPLY, "ClawSkins: sold out");
        (bool ok, ) = payable(treasury).call{value: msg.value}("");
        require(ok, "ClawSkins: treasury transfer failed");
        tokenId = _nextTokenId++;
        _safeMint(msg.sender, tokenId);
        emit PublicMint(msg.sender, tokenId, msg.value);
        return tokenId;
    }

    /** @notice Public mint paying with $MClawIO (price = 55.5 MON value; owner sets mintPriceMClaw). Caller must approve this contract. */
    function publicMintWithMClaw() external nonReentrant returns (uint256 tokenId) {
        require(address(mclawToken) != address(0), "ClawSkins: MClaw mint disabled");
        require(_nextTokenId <= MAX_SUPPLY, "ClawSkins: sold out");
        mclawToken.safeTransferFrom(msg.sender, treasury, mintPriceMClaw);
        tokenId = _nextTokenId++;
        _safeMint(msg.sender, tokenId);
        emit PublicMint(msg.sender, tokenId, 0);
        return tokenId;
    }

    function withdraw() external onlyOwner nonReentrant {
        uint256 balance = address(this).balance;
        require(balance > 0, "ClawSkins: no balance");
        (bool ok, ) = payable(treasury).call{value: balance}("");
        require(ok, "ClawSkins: withdraw failed");
    }

    function totalMinted() external view returns (uint256) {
        return _nextTokenId - 1;
    }

    // ─── ERC721Enumerable + ERC2981 overrides ─────────────────────────────

    function _update(address to, uint256 tokenId, address auth)
        internal
        override(ERC721, ERC721Enumerable)
        returns (address)
    {
        return super._update(to, tokenId, auth);
    }

    function _increaseBalance(address account, uint128 value)
        internal
        override(ERC721, ERC721Enumerable)
    {
        super._increaseBalance(account, value);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, ERC721Enumerable, ERC2981)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
