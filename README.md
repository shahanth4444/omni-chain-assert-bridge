# Omnichain Asset Bridge 🌉

A production-grade, two-chain asset bridge with cross-chain governance — built with Solidity, Node.js, SQLite, and Docker.

[![Solidity](https://img.shields.io/badge/Solidity-0.8.20-blue.svg)](https://soliditylang.org)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org)
[![Hardhat](https://img.shields.io/badge/Hardhat-2.22-yellow.svg)](https://hardhat.org)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED.svg)](https://docker.com)

## Architecture

```
Chain A (Settlement) :8545            Chain B (Execution) :9545
┌─────────────────────────┐          ┌─────────────────────────┐
│  VaultToken (ERC20)     │          │  WrappedVaultToken      │
│  BridgeLock             │◄─────────►  BridgeMint             │
│  GovernanceEmergency    │  Relayer │  GovernanceVoting       │
└─────────────────────────┘          └─────────────────────────┘
                            ┌──────────────────┐
                            │  Node.js Relayer │
                            │  SQLite (WAL)    │
                            │  3-block delays  │
                            └──────────────────┘
```

See [architecture.md](./architecture.md) for detailed Mermaid diagrams.

## 🚀 Quick Start

### Option 1: Docker (Recommended)

```bash
# Clone repo and copy environment
git clone <repo-url> && cd omni-chain-assert-bridge
cp .env.example .env

# Create volume directory
mkdir -p relayer_data

# Start everything
docker-compose up --build
```

All three services start, chain healthchecks verify readiness, contracts deploy automatically, and the relayer begins listening.

### Option 2: Local (requires Foundry + Node.js 18)

```bash
# Install dependencies
npm install
cd relayer && npm install && cd ..

# Start chains, deploy, and run relayer
bash scripts/start-local.sh
```

## 📁 Project Structure

```
omni-chain-assert-bridge/
├── contracts/
│   ├── VaultToken.sol            # ERC20 — Chain A native asset
│   ├── BridgeLock.sol            # Lock/unlock with replay protection
│   ├── GovernanceEmergency.sol   # Execute cross-chain pause orders
│   ├── WrappedVaultToken.sol     # Mintable/burnable ERC20 — Chain B
│   ├── BridgeMint.sol            # Mint/burn with nonce protection
│   └── GovernanceVoting.sol      # Token-weighted on-chain voting
├── scripts/
│   ├── deploy.js                 # Master deployer (used in Docker)
│   ├── deployChainA.js           # Hardhat script for Chain A
│   ├── deployChainB.js           # Hardhat script for Chain B
│   └── start-local.sh            # Local dev startup script
├── relayer/
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       ├── index.js              # Entry point
│       ├── relayer.js            # Core bridge logic
│       ├── db.js                 # SQLite persistence (WAL mode)
│       ├── abis.js               # Contract ABI fragments
│       └── logger.js             # Winston structured logging
├── tests/
│   ├── unit/
│   │   ├── VaultToken.test.js
│   │   ├── BridgeLock.test.js
│   │   ├── BridgeMint.test.js
│   │   └── GovernanceVoting.test.js
│   └── integration/
│       ├── bridge-flow.test.js       # Lock→Mint + Burn→Unlock + Invariant
│       ├── governance-flow.test.js   # Cross-chain governance + pause
│       ├── replay-attack.test.js     # Nonce replay prevention
│       └── relayer-recovery.test.js  # Crash recovery simulation
├── docker-compose.yml
├── Dockerfile.deployer
├── hardhat.config.js
├── .env.example
└── architecture.md
```

## 📋 Environment Variables

Copy `.env.example` to `.env` and configure:

| Variable | Description | Default |
|---|---|---|
| `DEPLOYER_PRIVATE_KEY` | Wallet used for deployment + relaying | Hardhat test key |
| `CHAIN_A_RPC_URL` | Chain A JSON-RPC endpoint | `http://127.0.0.1:8545` |
| `CHAIN_B_RPC_URL` | Chain B JSON-RPC endpoint | `http://127.0.0.1:9545` |
| `CONFIRMATION_DEPTH` | Block confirmations before processing | `3` |
| `DB_PATH` | SQLite database file path | `./data/bridge.db` |
| `LOG_LEVEL` | Logger verbosity (`info`, `debug`) | `info` |

## ⛓️ Smart Contracts

### Chain A — Settlement Chain (chainId: 1111, port: 8545)

| Contract | Description |
|---|---|
| `VaultToken` | Standard ERC20 (1M initial supply). Owner can mint. |
| `BridgeLock` | Locks VaultTokens. `lock()` emits `Locked(user, amount, nonce)`. `unlock()` is relayer-only with nonce replay protection. Pausable. |
| `GovernanceEmergency` | Receives cross-chain governance decisions. `pauseBridge(proposalId)` is relayer-only with proposal replay protection. |

### Chain B — Execution Chain (chainId: 2222, port: 9545)

| Contract | Description |
|---|---|
| `WrappedVaultToken` | ERC20 mintable only by BridgeMint (MINTER_ROLE). |
| `BridgeMint` | `mintWrapped(user, amount, nonce)` is relayer-only with nonce protection. `burn(amount)` emits `Burned(user, amount, nonce)`. |
| `GovernanceVoting` | Token-weighted voting. Passed proposals emit `ProposalPassed(proposalId, data)` for the relayer. |

## 🔄 Relayer Service

The Node.js relayer is the cross-chain backbone:

| Feature | Implementation |
|---|---|
| **Event Listening** | `ethers.js` contract event listeners for `Locked`, `Burned`, `ProposalPassed` |
| **Confirmation Depth** | Waits 3 blocks before acting on any event |
| **State Persistence** | SQLite (WAL mode) — `processed_events` + `last_blocks` tables |
| **Replay Protection** | Checks nonce in DB before submitting any transaction |
| **Crash Recovery** | On startup: scans events from `last_blocks` → current block |
| **Retry Logic** | Exponential backoff, up to 5 attempts per transaction |
| **Logging** | Winston — console + rotating file logs |

## 🧪 Running Tests

```bash
# All tests (unit + integration)
npm test

# Unit tests only
npx hardhat test tests/unit/*.test.js

# Integration tests only
npx hardhat test tests/integration/*.test.js

# Specific test suite
npx hardhat test tests/integration/replay-attack.test.js --verbose

# With gas reporting
REPORT_GAS=true npm test
```

### Test Coverage

| Test File | What It Tests |
|---|---|
| `VaultToken.test.js` | Mint, transfer, access control |
| `BridgeLock.test.js` | lock(), unlock(), pause, access control, nonce replay |
| `BridgeMint.test.js` | mintWrapped(), burn(), nonce replay, access control |
| `GovernanceVoting.test.js` | Proposal lifecycle, voting, execution, ProposalPassed |
| `bridge-flow.test.js` | Full lock→mint + burn→unlock + invariant check |
| `governance-flow.test.js` | Proposal → ProposalPassed → pauseBridge → lock() reverts |
| `replay-attack.test.js` | Second mintWrapped/unlock with same nonce reverts |
| `relayer-recovery.test.js` | Missed events during "downtime" processed on "restart" |

## 🔐 Security Model

### Replay Attack Prevention
- **On-chain**: Both `BridgeLock.unlock()` and `BridgeMint.mintWrapped()` use `processedNonces` mappings
- **Off-chain**: Relayer checks SQLite before submitting any transaction
- **Governance**: `GovernanceEmergency` tracks `executedProposals`

### Access Control (OpenZeppelin AccessControl)
- `RELAYER_ROLE` — Only the relayer wallet can call `unlock()`, `mintWrapped()`, `pauseBridge()`
- `PAUSER_ROLE` — Only admin/GovernanceEmergency can pause BridgeLock
- `MINTER_ROLE` — Only BridgeMint can mint WrappedVaultToken

### CEI Pattern
All state-mutating functions follow **Checks-Effects-Interactions**: nonces marked processed before external calls.

### Bridge Invariant
At all times: `BridgeLock.lockedBalance() == WrappedVaultToken.totalSupply()`

## 🐳 Docker Architecture

```yaml
services:
  chain-a:    # Anvil, chainId=1111, port=8545, block-time=2s
  chain-b:    # Anvil, chainId=2222, port=9545, block-time=2s
  deployer:   # One-shot: compile + deploy all contracts
  relayer:    # Node.js relayer, depends on all above
```

The `relayer_data` volume persists the SQLite DB across container restarts.

## 💡 Design Decisions

| Decision | Rationale |
|---|---|
| SQLite over JSON file | WAL mode provides atomic transactions — safer if relayer crashes mid-write |
| Anvil over Hardhat nodes | Faster block times, `anvil_mine` RPC, better performance |
| On-chain + off-chain nonce check | Defense-in-depth — smart contract is the final authority |
| Monotonically increasing nonces | Simpler than hash-based nullifiers for a local bridge |
| GovernanceEmergency as intermediary | Decouples relayer address from pauser — governance can change relayer without redeploying BridgeLock |

## 📊 Deployment Verification

After `docker-compose up`:

```bash
# Verify Chain A chainId
curl -s -X POST http://localhost:8545 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}'
# Expected: 0x457 (1111 in hex)

# Verify Chain B chainId
curl -s -X POST http://localhost:9545 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}'
# Expected: 0x8ae (2222 in hex)

# Check relayer logs
docker-compose logs relayer
```
