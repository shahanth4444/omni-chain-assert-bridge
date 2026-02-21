// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title GovernanceVoting
 * @dev On-chain governance contract on Chain B allowing WrappedVaultToken holders
 *      to vote on proposals. Passing proposals emit ProposalPassed events that
 *      the relayer picks up to execute emergency actions on Chain A.
 *
 * Voting mechanics:
 *  - Any WrappedVaultToken holder can create a proposal
 *  - Each address can vote once per proposal (snapshot-free, simple design)
 *  - Quorum is reached when FOR votes exceed quorumThreshold (configurable)
 *  - After voting window closes, anyone can execute a passed proposal
 *  - Execution emits ProposalPassed(proposalId, data) for the relayer
 */
contract GovernanceVoting is AccessControl, ReentrancyGuard {
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    IWrappedVaultTokenGov public immutable votingToken;

    // Voting period in blocks
    uint256 public votingPeriod;

    // Minimum FOR votes to pass (as a percentage basis points, e.g. 5000 = 50%)
    uint256 public quorumThreshold;

    uint256 public proposalCount;

    // -------------------------------------------------------------------------
    // Data Structures
    // -------------------------------------------------------------------------

    enum ProposalState { Active, Passed, Failed, Executed }

    struct Proposal {
        uint256 id;
        address proposer;
        string description;
        bytes data;                   // Arbitrary data passed to relayer (e.g., action type)
        uint256 startBlock;
        uint256 endBlock;
        uint256 forVotes;
        uint256 againstVotes;
        ProposalState state;
        bool executed;
    }

    mapping(uint256 => Proposal) public proposals;

    // proposalId => voter => hasVoted
    mapping(uint256 => mapping(address => bool)) public hasVoted;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event ProposalCreated(
        uint256 indexed proposalId,
        address indexed proposer,
        string description,
        uint256 startBlock,
        uint256 endBlock
    );

    event VoteCast(
        uint256 indexed proposalId,
        address indexed voter,
        bool support,
        uint256 weight
    );

    /**
     * @notice Emitted when a proposal passes and is ready to be executed on Chain A.
     * @param proposalId The unique ID of the passed proposal.
     * @param data       Arbitrary encoded data for the relayer to use on Chain A.
     */
    event ProposalPassed(uint256 indexed proposalId, bytes data);

    event ProposalFailed(uint256 indexed proposalId);

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error NotTokenHolder();
    error ProposalNotActive(uint256 proposalId);
    error AlreadyVoted(uint256 proposalId, address voter);
    error VotingPeriodNotEnded(uint256 proposalId);
    error ProposalAlreadyExecuted(uint256 proposalId);
    error InvalidProposal(uint256 proposalId);
    error ZeroVotingPeriod();

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(
        address _votingToken,
        address admin,
        uint256 _votingPeriod,   // in blocks, e.g. 10
        uint256 _quorumThreshold // min FOR votes (in token units, not %)
    ) {
        require(_votingToken != address(0), "GovVoting: zero token");
        require(admin != address(0), "GovVoting: zero admin");
        require(_votingPeriod > 0, "GovVoting: zero voting period");

        votingToken = IWrappedVaultTokenGov(_votingToken);
        votingPeriod = _votingPeriod;
        quorumThreshold = _quorumThreshold;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
    }

    // -------------------------------------------------------------------------
    // Proposal Lifecycle
    // -------------------------------------------------------------------------

    /**
     * @notice Create a new governance proposal.
     * @dev Caller must hold WrappedVaultTokens.
     * @param description Human-readable description of the proposal.
     * @param data        Arbitrary data (e.g., ABI-encoded action for Chain A).
     * @return proposalId The ID of the created proposal.
     */
    function createProposal(
        string calldata description,
        bytes calldata data
    ) external nonReentrant returns (uint256 proposalId) {
        if (votingToken.balanceOf(msg.sender) == 0) revert NotTokenHolder();

        proposalId = ++proposalCount;
        uint256 startBlock = block.number;
        uint256 endBlock = startBlock + votingPeriod;

        proposals[proposalId] = Proposal({
            id: proposalId,
            proposer: msg.sender,
            description: description,
            data: data,
            startBlock: startBlock,
            endBlock: endBlock,
            forVotes: 0,
            againstVotes: 0,
            state: ProposalState.Active,
            executed: false
        });

        emit ProposalCreated(proposalId, msg.sender, description, startBlock, endBlock);
    }

    /**
     * @notice Cast a vote on an active proposal.
     * @dev Vote weight is the voter's current WrappedVaultToken balance.
     *      Each address can only vote once per proposal.
     * @param proposalId ID of the proposal to vote on.
     * @param support    true = vote FOR, false = vote AGAINST.
     */
    function vote(uint256 proposalId, bool support) external nonReentrant {
        if (proposalId == 0 || proposalId > proposalCount) revert InvalidProposal(proposalId);

        Proposal storage proposal = proposals[proposalId];

        if (proposal.state != ProposalState.Active) revert ProposalNotActive(proposalId);
        if (block.number > proposal.endBlock) revert ProposalNotActive(proposalId);
        if (hasVoted[proposalId][msg.sender]) revert AlreadyVoted(proposalId, msg.sender);

        uint256 weight = votingToken.balanceOf(msg.sender);
        if (weight == 0) revert NotTokenHolder();

        hasVoted[proposalId][msg.sender] = true;

        if (support) {
            proposal.forVotes += weight;
        } else {
            proposal.againstVotes += weight;
        }

        emit VoteCast(proposalId, msg.sender, support, weight);
    }

    /**
     * @notice Execute a proposal after voting period ends.
     * @dev Determines pass/fail and emits ProposalPassed for relayer.
     *      Idempotent: reverts if already executed.
     * @param proposalId ID of the proposal to execute.
     */
    function executeProposal(uint256 proposalId) external nonReentrant {
        if (proposalId == 0 || proposalId > proposalCount) revert InvalidProposal(proposalId);

        Proposal storage proposal = proposals[proposalId];

        if (proposal.executed) revert ProposalAlreadyExecuted(proposalId);
        if (block.number <= proposal.endBlock) revert VotingPeriodNotEnded(proposalId);

        proposal.executed = true;

        // Check if proposal passed: forVotes > againstVotes AND forVotes >= quorumThreshold
        bool passed = proposal.forVotes > proposal.againstVotes
            && proposal.forVotes >= quorumThreshold;

        if (passed) {
            proposal.state = ProposalState.Passed;
            emit ProposalPassed(proposalId, proposal.data);
        } else {
            proposal.state = ProposalState.Failed;
            emit ProposalFailed(proposalId);
        }
    }

    // -------------------------------------------------------------------------
    // Admin Functions
    // -------------------------------------------------------------------------

    /**
     * @notice Update the voting period (in blocks).
     */
    function setVotingPeriod(uint256 _votingPeriod) external onlyRole(ADMIN_ROLE) {
        if (_votingPeriod == 0) revert ZeroVotingPeriod();
        votingPeriod = _votingPeriod;
    }

    /**
     * @notice Update the quorum threshold (minimum FOR votes).
     */
    function setQuorumThreshold(uint256 _quorumThreshold) external onlyRole(ADMIN_ROLE) {
        quorumThreshold = _quorumThreshold;
    }

    // -------------------------------------------------------------------------
    // View Functions
    // -------------------------------------------------------------------------

    /**
     * @notice Get proposal details.
     */
    function getProposal(uint256 proposalId) external view returns (Proposal memory) {
        return proposals[proposalId];
    }

    /**
     * @notice Get current state of a proposal.
     */
    function getProposalState(uint256 proposalId) external view returns (ProposalState) {
        return proposals[proposalId].state;
    }
}

// -------------------------------------------------------------------------
// Interface
// -------------------------------------------------------------------------

interface IWrappedVaultTokenGov {
    function balanceOf(address account) external view returns (uint256);
    function totalSupply() external view returns (uint256);
}
