# Omnichain Asset Bridge — Architecture

This document provides a visual reference for the system architecture.

## System Architecture

```mermaid
graph TB
    subgraph ChainA["⛓️ Chain A — Settlement Chain (chainId: 1111, :8545)"]
        VTK[VaultToken\nERC20]
        BL[BridgeLock\nlock / unlock\nPausable + RBAC]
        GE[GovernanceEmergency\npauseBridge / unpauseBridge]
    end

    subgraph Relayer["🔄 Relayer Service (Node.js)"]
        RL[Event Listener\nLocked / Burned / ProposalPassed]
        CONF[Confirmation Manager\n3-block depth]
        DB[(SQLite DB\nprocessed_nonces\nlast_blocks)]
        RETRY[Retry Logic\nExponential Backoff]
    end

    subgraph ChainB["⛓️ Chain B — Execution Chain (chainId: 2222, :9545)"]
        WVTK[WrappedVaultToken\nERC20 mintable/burnable]
        BM[BridgeMint\nmintWrapped / burn\nNonce Replay Protection]
        GV[GovernanceVoting\ncreateProposal / vote / execute]
    end

    VTK -->|transferred to| BL
    BL -->|Locked event| RL
    RL --> CONF
    CONF --> DB
    DB --> RETRY
    RETRY -->|mintWrapped| BM
    BM -->|mints| WVTK

    WVTK -->|balance for voting| GV
    GV -->|ProposalPassed event| RL
    RETRY -->|pauseBridge| GE
    GE -->|pause| BL

    BM -->|Burned event| RL
    RETRY -->|unlock| BL
```

## Token Flow — Lock & Mint

```mermaid
sequenceDiagram
    participant User
    participant VaultToken as VaultToken (ChainA)
    participant BridgeLock as BridgeLock (ChainA)
    participant Relayer
    participant BridgeMint as BridgeMint (ChainB)
    participant WVTK as WrappedVaultToken (ChainB)

    User->>VaultToken: approve(bridgeLock, amount)
    User->>BridgeLock: lock(amount)
    BridgeLock->>VaultToken: transferFrom(user, bridge, amount)
    BridgeLock-->>Relayer: emit Locked(user, amount, nonce)
    Relayer->>Relayer: wait 3 confirmations
    Relayer->>Relayer: check SQLite (not processed)
    Relayer->>BridgeMint: mintWrapped(user, amount, nonce)
    BridgeMint->>WVTK: mint(user, amount)
    Relayer->>Relayer: persist nonce to SQLite
```

## Token Flow — Burn & Unlock

```mermaid
sequenceDiagram
    participant User
    participant BridgeMint as BridgeMint (ChainB)
    participant WVTK as WrappedVaultToken (ChainB)
    participant Relayer
    participant BridgeLock as BridgeLock (ChainA)
    participant VaultToken as VaultToken (ChainA)

    User->>BridgeMint: burn(amount)
    BridgeMint->>WVTK: burnFrom(user, amount)
    BridgeMint-->>Relayer: emit Burned(user, amount, nonce)
    Relayer->>Relayer: wait 3 confirmations
    Relayer->>Relayer: check SQLite (not processed)
    Relayer->>BridgeLock: unlock(user, amount, nonce)
    BridgeLock->>VaultToken: transfer(user, amount)
    Relayer->>Relayer: persist nonce to SQLite
```

## Governance Flow — Cross-Chain Emergency Pause

```mermaid
sequenceDiagram
    participant Voter
    participant GovernanceVoting as GovernanceVoting (ChainB)
    participant Relayer
    participant GovernanceEmergency as GovernanceEmergency (ChainA)
    participant BridgeLock as BridgeLock (ChainA)

    Voter->>GovernanceVoting: createProposal("EMERGENCY_PAUSE", data)
    Voter->>GovernanceVoting: vote(proposalId, true)
    Note over GovernanceVoting: Voting period ends
    Voter->>GovernanceVoting: executeProposal(proposalId)
    GovernanceVoting-->>Relayer: emit ProposalPassed(proposalId, data)
    Relayer->>Relayer: wait 3 confirmations
    Relayer->>GovernanceEmergency: pauseBridge(proposalId)
    GovernanceEmergency->>BridgeLock: pause()
    Note over BridgeLock: Bridge halted — lock() reverts
```

## Relayer State Machine

```mermaid
stateDiagram-v2
    [*] --> Starting
    Starting --> LoadingDB : Load SQLite state
    LoadingDB --> ConnectingChains : Scan last_blocks
    ConnectingChains --> ScanningHistory : Both chains healthy
    ScanningHistory --> Listening : Historical events processed
    Listening --> WaitingConfirmations : Event detected
    WaitingConfirmations --> CheckingDB : 3 blocks elapsed
    CheckingDB --> SubmittingTx : Nonce not in DB
    CheckingDB --> Listening : Nonce already in DB (idempotent)
    SubmittingTx --> PersistingNonce : Tx confirmed
    PersistingNonce --> Listening : Nonce stored in SQLite
    SubmittingTx --> RetryQueue : Tx failed
    RetryQueue --> SubmittingTx : Retry with backoff
    RetryQueue --> ErrorState : Max retries exceeded
    ErrorState --> [*]
```

## Docker Deployment

```mermaid
graph LR
    subgraph Docker["docker-compose.yml"]
        A[chain-a\nAnvil :8545\nchainId=1111]
        B[chain-b\nAnvil :9545\nchainId=2222]
        D[deployer\nCompile + Deploy\ncontracts]
        R[relayer\nNode.js\nSQLite volume]
    end

    A -->|healthcheck OK| D
    B -->|healthcheck OK| D
    D -->|deployed-addresses.json| R
    A -->|RPC events| R
    B -->|RPC events| R
    R -->|transactions| A
    R -->|transactions| B
    R <-->|persist| V[(relayer_data\nvolume)]
```

## Replay Protection Architecture

```mermaid
graph TD
    E[Incoming Event] --> C{Is nonce\nin SQLite?}
    C -->|Yes| SKIP[Skip\nNo duplicate TX]
    C -->|No| WAIT[Wait 3 confirmations]
    WAIT --> TX[Submit relay TX]
    TX --> MARK[Mark nonce\nin SQLite]
    MARK --> DONE[Done]
    TX -->|Fails| RETRY[Exponential Backoff Retry]
    RETRY --> TX
```
