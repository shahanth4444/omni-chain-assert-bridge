// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title BridgeLock
 * @dev Settlement contract on Chain A that locks VaultTokens for bridging.
 *
 * Security features:
 *  - Pausable: Bridge can be halted by GovernanceEmergency
 *  - AccessControl: Only privileged RELAYER_ROLE can call unlock()
 *  - ReentrancyGuard: Prevents reentrancy attacks
 *  - Nonce tracking: Every unlock nonce is tracked to prevent replay attacks
 *
 * Flow:
 *  User calls lock(amount) → VaultTokens transferred to this contract
 *                          → Locked event emitted with unique nonce
 *  Relayer calls unlock(user, amount, nonce) → VaultTokens returned to user
 *                                            → Unlocked event emitted
 */
contract BridgeLock is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant RELAYER_ROLE = keccak256("RELAYER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    IERC20 public immutable vaultToken;

    // Global nonce counter for lock operations (monotonically increasing)
    uint256 public lockNonce;

    // Tracks which unlock nonces have already been processed (replay protection)
    mapping(uint256 => bool) public processedUnlockNonces;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    /**
     * @notice Emitted when a user locks tokens to bridge to Chain B.
     * @param user  The address that locked the tokens.
     * @param amount The amount of VaultTokens locked (in wei).
     * @param nonce  A unique identifier for this lock event; used by the relayer.
     */
    event Locked(address indexed user, uint256 amount, uint256 nonce);

    /**
     * @notice Emitted when the relayer unlocks tokens (bridge-back from Chain B).
     * @param user   The recipient address on Chain A.
     * @param amount The amount of VaultTokens returned.
     * @param nonce  The corresponding burn nonce from Chain B.
     */
    event Unlocked(address indexed user, uint256 amount, uint256 nonce);

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error ZeroAmount();
    error NonceAlreadyProcessed(uint256 nonce);
    error InsufficientContractBalance(uint256 available, uint256 required);

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(address _vaultToken, address admin, address relayer) {
        require(_vaultToken != address(0), "BridgeLock: zero token address");
        require(admin != address(0), "BridgeLock: zero admin address");
        require(relayer != address(0), "BridgeLock: zero relayer address");

        vaultToken = IERC20(_vaultToken);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(RELAYER_ROLE, relayer);
        _grantRole(PAUSER_ROLE, admin);
    }

    // -------------------------------------------------------------------------
    // Core Bridge Functions
    // -------------------------------------------------------------------------

    /**
     * @notice Lock VaultTokens in this contract to initiate a bridge transfer to Chain B.
     * @dev Caller must have approved this contract for `amount` VaultTokens.
     *      Emits a Locked event that the relayer listens for.
     * @param amount The amount of VaultTokens to lock (must be > 0).
     */
    function lock(uint256 amount) external whenNotPaused nonReentrant {
        if (amount == 0) revert ZeroAmount();

        // Transfer tokens from user to this contract (requires prior approval)
        vaultToken.safeTransferFrom(msg.sender, address(this), amount);

        // Increment nonce BEFORE emitting event (CEI pattern)
        uint256 nonce = ++lockNonce;

        emit Locked(msg.sender, amount, nonce);
    }

    /**
     * @notice Unlock VaultTokens back to a user (called by relayer after burn on Chain B).
     * @dev Protected by RELAYER_ROLE. Prevents nonce reuse (replay protection).
     *      Idempotent: reverts if nonce already processed.
     * @param user   The address to receive VaultTokens.
     * @param amount The amount of VaultTokens to release.
     * @param nonce  The unique nonce from the Burned event on Chain B.
     */
    function unlock(
        address user,
        uint256 amount,
        uint256 nonce
    ) external onlyRole(RELAYER_ROLE) nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (processedUnlockNonces[nonce]) revert NonceAlreadyProcessed(nonce);

        uint256 contractBalance = vaultToken.balanceOf(address(this));
        if (contractBalance < amount)
            revert InsufficientContractBalance(contractBalance, amount);

        // Mark nonce as processed BEFORE transfer (CEI pattern)
        processedUnlockNonces[nonce] = true;

        vaultToken.safeTransfer(user, amount);

        emit Unlocked(user, amount, nonce);
    }

    // -------------------------------------------------------------------------
    // Pause Control (called by GovernanceEmergency via PAUSER_ROLE)
    // -------------------------------------------------------------------------

    /**
     * @notice Pause the bridge. Prevents new lock() calls.
     * @dev Can be called by accounts with PAUSER_ROLE.
     */
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /**
     * @notice Unpause the bridge. Re-enables lock() calls.
     * @dev Can be called by accounts with PAUSER_ROLE.
     */
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // -------------------------------------------------------------------------
    // View Functions
    // -------------------------------------------------------------------------

    /**
     * @notice Returns the total amount of VaultTokens held by this contract.
     */
    function lockedBalance() external view returns (uint256) {
        return vaultToken.balanceOf(address(this));
    }

    /**
     * @notice Check if an unlock nonce has already been processed.
     */
    function isUnlockProcessed(uint256 nonce) external view returns (bool) {
        return processedUnlockNonces[nonce];
    }
}
