// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title GovernanceEmergency
 * @dev Emergency governance contract on Chain A that can pause/unpause BridgeLock.
 *
 * This contract is called by the relayer when a governance proposal passes on
 * Chain B (GovernanceVoting). It acts as the "executor" of cross-chain governance
 * decisions, specifically for emergency actions like pausing the bridge during an exploit.
 *
 * Only accounts with RELAYER_ROLE can call emergency functions.
 */
contract GovernanceEmergency is AccessControl {
    bytes32 public constant RELAYER_ROLE = keccak256("RELAYER_ROLE");

    // Interface for BridgeLock pause/unpause
    IBridgeLock public bridgeLock;

    // Track executed proposals to prevent replay
    mapping(uint256 => bool) public executedProposals;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event EmergencyPauseExecuted(uint256 indexed proposalId, address executor);
    event EmergencyUnpauseExecuted(uint256 indexed proposalId, address executor);
    event BridgeLockAddressUpdated(address indexed oldAddress, address indexed newAddress);

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error ProposalAlreadyExecuted(uint256 proposalId);
    error ZeroAddress();

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(address _bridgeLock, address admin, address relayer) {
        if (_bridgeLock == address(0)) revert ZeroAddress();
        if (admin == address(0)) revert ZeroAddress();
        if (relayer == address(0)) revert ZeroAddress();

        bridgeLock = IBridgeLock(_bridgeLock);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(RELAYER_ROLE, relayer);
    }

    // -------------------------------------------------------------------------
    // Emergency Actions
    // -------------------------------------------------------------------------

    /**
     * @notice Pause the BridgeLock contract (emergency action).
     * @dev Called by the relayer when a ProposalPassed event is detected on Chain B.
     *      Idempotent: reverts if proposal already executed.
     * @param proposalId The ID of the governance proposal from Chain B.
     */
    function pauseBridge(
        uint256 proposalId
    ) external onlyRole(RELAYER_ROLE) {
        if (executedProposals[proposalId]) revert ProposalAlreadyExecuted(proposalId);

        executedProposals[proposalId] = true;
        bridgeLock.pause();

        emit EmergencyPauseExecuted(proposalId, msg.sender);
    }

    /**
     * @notice Unpause the BridgeLock contract.
     * @dev Called by the relayer after governance votes to resume. Uses a different
     *      proposalId to allow re-execution for unpause.
     * @param proposalId The ID of the resume proposal from Chain B.
     */
    function unpauseBridge(
        uint256 proposalId
    ) external onlyRole(RELAYER_ROLE) {
        if (executedProposals[proposalId]) revert ProposalAlreadyExecuted(proposalId);

        executedProposals[proposalId] = true;
        bridgeLock.unpause();

        emit EmergencyUnpauseExecuted(proposalId, msg.sender);
    }

    /**
     * @notice Update the BridgeLock contract address (admin only).
     */
    function setBridgeLock(address _bridgeLock) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_bridgeLock == address(0)) revert ZeroAddress();
        emit BridgeLockAddressUpdated(address(bridgeLock), _bridgeLock);
        bridgeLock = IBridgeLock(_bridgeLock);
    }

    /**
     * @notice Check if a proposal has already been executed.
     */
    function isProposalExecuted(uint256 proposalId) external view returns (bool) {
        return executedProposals[proposalId];
    }
}

// -------------------------------------------------------------------------
// Interface
// -------------------------------------------------------------------------

interface IBridgeLock {
    function pause() external;
    function unpause() external;
    function paused() external view returns (bool);
}
