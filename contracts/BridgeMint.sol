// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title BridgeMint
 * @dev Execution contract on Chain B responsible for minting WrappedVaultToken
 *      when tokens are locked on Chain A, and burning them when users want to
 *      bridge back.
 *
 * Security features:
 *  - AccessControl: Only RELAYER_ROLE can call mintWrapped()
 *  - Nonce replay protection: processedMintNonces prevents double-minting
 *  - ReentrancyGuard: Prevents reentrancy in burn flow
 *  - CEI pattern: State updates before external calls
 *
 * Events listened to by the relayer:
 *  - Burned(user, amount, nonce): Triggers unlock() on Chain A
 */
contract BridgeMint is AccessControl, ReentrancyGuard {
    bytes32 public constant RELAYER_ROLE = keccak256("RELAYER_ROLE");

    IWrappedVaultToken public immutable wrappedVaultToken;

    // Global nonce counter for burn operations
    uint256 public burnNonce;

    // Tracks which mint nonces have already been processed (replay protection)
    mapping(uint256 => bool) public processedMintNonces;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    /**
     * @notice Emitted when wrapped tokens are minted (lock on Chain A detected).
     * @param user   The recipient of minted tokens.
     * @param amount Amount minted.
     * @param nonce  Corresponding lock nonce from Chain A.
     */
    event Minted(address indexed user, uint256 amount, uint256 nonce);

    /**
     * @notice Emitted when a user burns wrapped tokens to bridge back to Chain A.
     * @param user   The address that burned tokens.
     * @param amount Amount burned.
     * @param nonce  Unique burn nonce for this operation (used by relayer for unlock on Chain A).
     */
    event Burned(address indexed user, uint256 amount, uint256 nonce);

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error ZeroAmount();
    error NonceAlreadyProcessed(uint256 nonce);
    error ZeroAddress();

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(address _wrappedVaultToken, address admin, address relayer) {
        if (_wrappedVaultToken == address(0)) revert ZeroAddress();
        if (admin == address(0)) revert ZeroAddress();
        if (relayer == address(0)) revert ZeroAddress();

        wrappedVaultToken = IWrappedVaultToken(_wrappedVaultToken);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(RELAYER_ROLE, relayer);
    }

    // -------------------------------------------------------------------------
    // Core Bridge Functions
    // -------------------------------------------------------------------------

    /**
     * @notice Mint WrappedVaultTokens for a user (called by relayer after Locked event on Chain A).
     * @dev Idempotent: reverts if the nonce has already been processed.
     *      Nonce corresponds to the lock nonce from Chain A.
     * @param user   The address to receive minted tokens.
     * @param amount The amount of WrappedVaultTokens to mint.
     * @param nonce  The lock nonce from Chain A (unique per lock operation).
     */
    function mintWrapped(
        address user,
        uint256 amount,
        uint256 nonce
    ) external onlyRole(RELAYER_ROLE) nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (user == address(0)) revert ZeroAddress();
        if (processedMintNonces[nonce]) revert NonceAlreadyProcessed(nonce);

        // Mark nonce BEFORE minting (CEI pattern)
        processedMintNonces[nonce] = true;

        wrappedVaultToken.mint(user, amount);

        emit Minted(user, amount, nonce);
    }

    /**
     * @notice Burn WrappedVaultTokens to initiate bridge-back to Chain A.
     * @dev User must have sufficient balance. Emits Burned event with unique nonce
     *      that the relayer uses to call unlock() on Chain A.
     * @param amount Amount of WrappedVaultTokens to burn.
     */
    function burn(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();

        // Increment nonce BEFORE burn (CEI pattern)
        uint256 nonce = ++burnNonce;

        // Transfer tokens from user to this contract, then burn via WrappedVaultToken
        wrappedVaultToken.burnFrom(msg.sender, amount);

        emit Burned(msg.sender, amount, nonce);
    }

    // -------------------------------------------------------------------------
    // View Functions
    // -------------------------------------------------------------------------

    /**
     * @notice Check if a mint nonce has already been processed.
     */
    function isMintProcessed(uint256 nonce) external view returns (bool) {
        return processedMintNonces[nonce];
    }
}

// -------------------------------------------------------------------------
// Interface
// -------------------------------------------------------------------------

interface IWrappedVaultToken {
    function mint(address to, uint256 amount) external;
    function burnFrom(address from, uint256 amount) external;
    function balanceOf(address account) external view returns (uint256);
    function totalSupply() external view returns (uint256);
}
