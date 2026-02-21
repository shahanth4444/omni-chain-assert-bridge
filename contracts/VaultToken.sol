// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title VaultToken
 * @dev Standard ERC20 token deployed on Chain A (Settlement Chain).
 *      This is the native asset that users lock in the BridgeLock contract
 *      to receive WrappedVaultToken on Chain B.
 */
contract VaultToken is ERC20, Ownable {
    uint8 private constant _DECIMALS = 18;

    event TokensMinted(address indexed to, uint256 amount);

    constructor(
        address initialOwner
    ) ERC20("VaultToken", "VTK") Ownable(initialOwner) {
        // Mint initial supply of 1,000,000 VTK to deployer
        _mint(initialOwner, 1_000_000 * 10 ** _DECIMALS);
        emit TokensMinted(initialOwner, 1_000_000 * 10 ** _DECIMALS);
    }

    /**
     * @dev Allows owner to mint additional tokens (for testing and faucet purposes).
     * @param to Recipient address.
     * @param amount Amount to mint (in wei).
     */
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
        emit TokensMinted(to, amount);
    }

    /**
     * @dev Returns token decimals.
     */
    function decimals() public pure override returns (uint8) {
        return _DECIMALS;
    }
}
