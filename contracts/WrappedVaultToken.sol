// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title WrappedVaultToken
 * @dev Wrapped ERC20 token on Chain B (Execution Chain).
 *      Represents locked VaultTokens from Chain A.
 *
 * Security:
 *  - Only BridgeMint contract (MINTER_ROLE) can mint tokens.
 *  - Token holders can burn their own tokens directly.
 *  - Uses AccessControl for fine-grained permission management.
 */
contract WrappedVaultToken is ERC20, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    uint8 private constant _DECIMALS = 18;

    event TokensMinted(address indexed to, uint256 amount, address indexed minter);
    event TokensBurned(address indexed from, uint256 amount);

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error ZeroAmount();
    error InsufficientBalance(uint256 available, uint256 required);

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(address admin) ERC20("Wrapped VaultToken", "wVTK") {
        require(admin != address(0), "WrappedVaultToken: zero admin");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        // Note: MINTER_ROLE is granted to BridgeMint after deployment
    }

    // -------------------------------------------------------------------------
    // Mint & Burn
    // -------------------------------------------------------------------------

    /**
     * @notice Mint wrapped tokens. Only callable by BridgeMint (MINTER_ROLE).
     * @param to     The recipient address.
     * @param amount The amount to mint (in wei).
     */
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        if (amount == 0) revert ZeroAmount();
        _mint(to, amount);
        emit TokensMinted(to, amount, msg.sender);
    }

    /**
     * @notice Burn tokens from the caller's balance.
     * @dev Called internally by BridgeMint.burn() after transferring tokens.
     * @param from   The address whose tokens are burned.
     * @param amount The amount to burn.
     */
    function burnFrom(address from, uint256 amount) external onlyRole(MINTER_ROLE) {
        if (amount == 0) revert ZeroAmount();
        _burn(from, amount);
        emit TokensBurned(from, amount);
    }

    /**
     * @notice Allow token holder to burn their own tokens directly.
     * @param amount Amount to burn.
     */
    function burn(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        _burn(msg.sender, amount);
        emit TokensBurned(msg.sender, amount);
    }

    function decimals() public pure override returns (uint8) {
        return _DECIMALS;
    }
}
