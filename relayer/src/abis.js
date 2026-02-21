// relayer/src/abis.js
// ABI fragments for all bridge contracts — only the events and functions
// the relayer needs to interact with.

const BRIDGE_LOCK_ABI = [
    // Events
    "event Locked(address indexed user, uint256 amount, uint256 nonce)",
    "event Unlocked(address indexed user, uint256 amount, uint256 nonce)",

    // Functions
    "function unlock(address user, uint256 amount, uint256 nonce) external",
    "function isUnlockProcessed(uint256 nonce) external view returns (bool)",
    "function paused() external view returns (bool)",
    "function lockedBalance() external view returns (uint256)",
    "function lockNonce() external view returns (uint256)",
];

const BRIDGE_MINT_ABI = [
    // Events
    "event Burned(address indexed user, uint256 amount, uint256 nonce)",
    "event Minted(address indexed user, uint256 amount, uint256 nonce)",

    // Functions
    "function mintWrapped(address user, uint256 amount, uint256 nonce) external",
    "function isMintProcessed(uint256 nonce) external view returns (bool)",
    "function burnNonce() external view returns (uint256)",
];

const GOVERNANCE_EMERGENCY_ABI = [
    // Events
    "event EmergencyPauseExecuted(uint256 indexed proposalId, address executor)",
    "event EmergencyUnpauseExecuted(uint256 indexed proposalId, address executor)",

    // Functions
    "function pauseBridge(uint256 proposalId) external",
    "function unpauseBridge(uint256 proposalId) external",
    "function isProposalExecuted(uint256 proposalId) external view returns (bool)",
];

const GOVERNANCE_VOTING_ABI = [
    // Events
    "event ProposalPassed(uint256 indexed proposalId, bytes data)",
    "event ProposalCreated(uint256 indexed proposalId, address indexed proposer, string description, uint256 startBlock, uint256 endBlock)",

    // Functions
    "function createProposal(string calldata description, bytes calldata data) external returns (uint256)",
    "function vote(uint256 proposalId, bool support) external",
    "function executeProposal(uint256 proposalId) external",
    "function getProposal(uint256 proposalId) external view returns (tuple(uint256 id, address proposer, string description, bytes data, uint256 startBlock, uint256 endBlock, uint256 forVotes, uint256 againstVotes, uint8 state, bool executed))",
];

const VAULT_TOKEN_ABI = [
    "function balanceOf(address account) external view returns (uint256)",
    "function totalSupply() external view returns (uint256)",
    "function approve(address spender, uint256 amount) external returns (bool)",
    "function transfer(address to, uint256 amount) external returns (bool)",
    "function decimals() external view returns (uint8)",
];

const WRAPPED_VAULT_TOKEN_ABI = [
    "function balanceOf(address account) external view returns (uint256)",
    "function totalSupply() external view returns (uint256)",
    "function decimals() external view returns (uint8)",
];

module.exports = {
    BRIDGE_LOCK_ABI,
    BRIDGE_MINT_ABI,
    GOVERNANCE_EMERGENCY_ABI,
    GOVERNANCE_VOTING_ABI,
    VAULT_TOKEN_ABI,
    WRAPPED_VAULT_TOKEN_ABI,
};
