// relayer/src/relayer.js
// Core relayer logic — the bridge backbone.
//
// Responsibilities:
//  1. Connect to Chain A and Chain B via ethers.js
//  2. Load contract addresses from deployed-addresses.json
//  3. On startup: scan missed events since last known block (crash recovery)
//  4. Listen for Locked (ChainA), Burned & ProposalPassed (ChainB) events
//  5. Wait CONFIRMATION_DEPTH blocks before processing each event
//  6. Execute relay transactions with exponential backoff retry
//  7. Persist every processed nonce to SQLite

require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
const logger = require("./logger");
const db = require("./db");
const {
    BRIDGE_LOCK_ABI,
    BRIDGE_MINT_ABI,
    GOVERNANCE_EMERGENCY_ABI,
    GOVERNANCE_VOTING_ABI,
} = require("./abis");

// ─── Configuration ────────────────────────────────────────────────────────────
const CHAIN_A_RPC = process.env.CHAIN_A_RPC_URL || "http://127.0.0.1:8545";
const CHAIN_B_RPC = process.env.CHAIN_B_RPC_URL || "http://127.0.0.1:9545";
const PRIVATE_KEY =
    process.env.DEPLOYER_PRIVATE_KEY ||
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const CONFIRMATION_DEPTH = parseInt(process.env.CONFIRMATION_DEPTH || "3", 10);
const MAX_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 1000;
const POLL_INTERVAL_MS = 2000; // Poll for new blocks every 2 seconds
const ADDRESSES_PATH =
    process.env.ADDRESSES_PATH ||
    path.join(__dirname, "..", "data", "deployed-addresses.json");

// ─── State ────────────────────────────────────────────────────────────────────
let providerA, providerB, signerA, signerB;
let bridgeLock, bridgeMint, governanceEmergency, governanceVoting;
let addresses;
let running = true;

// ─── Retry Utility ───────────────────────────────────────────────────────────

/**
 * Execute a function with exponential backoff retry.
 * @param {Function} fn - Async function to execute
 * @param {string} label - Description for logging
 * @param {number} maxRetries
 */
async function withRetry(fn, label, maxRetries = MAX_RETRIES) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const isLastAttempt = attempt === maxRetries;
            const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);

            if (isLastAttempt) {
                logger.error(`[RETRY] ${label} failed after ${maxRetries} attempts`, {
                    error: err.message,
                });
                throw err;
            }

            logger.warn(
                `[RETRY] ${label} attempt ${attempt}/${maxRetries} failed. Retrying in ${delay}ms...`,
                { error: err.message }
            );
            await sleep(delay);
        }
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Connection Setup ─────────────────────────────────────────────────────────

async function connectWithRetry(rpcUrl, label) {
    return withRetry(async () => {
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        // Test connection
        const network = await provider.getNetwork();
        logger.info(`Connected to ${label}: chainId=${network.chainId} rpc=${rpcUrl}`);
        return provider;
    }, `Connect to ${label}`);
}

async function loadAddresses() {
    let attempts = 0;
    while (attempts < 30) {
        if (fs.existsSync(ADDRESSES_PATH)) {
            const raw = fs.readFileSync(ADDRESSES_PATH, "utf8");
            addresses = JSON.parse(raw);
            logger.info("Loaded deployed addresses", { path: ADDRESSES_PATH });
            return;
        }
        attempts++;
        logger.warn(
            `Waiting for deployed-addresses.json (attempt ${attempts}/30)...`
        );
        await sleep(3000);
    }
    throw new Error(`deployed-addresses.json not found at ${ADDRESSES_PATH}`);
}

async function initConnections() {
    await loadAddresses();

    providerA = await connectWithRetry(CHAIN_A_RPC, "Chain A");
    providerB = await connectWithRetry(CHAIN_B_RPC, "Chain B");

    signerA = new ethers.Wallet(PRIVATE_KEY, providerA);
    signerB = new ethers.Wallet(PRIVATE_KEY, providerB);

    logger.info(`Relayer wallet: ${signerA.address}`);

    // Instantiate contracts
    bridgeLock = new ethers.Contract(
        addresses.chainA.contracts.BridgeLock,
        BRIDGE_LOCK_ABI,
        signerA
    );
    bridgeMint = new ethers.Contract(
        addresses.chainB.contracts.BridgeMint,
        BRIDGE_MINT_ABI,
        signerB
    );
    governanceEmergency = new ethers.Contract(
        addresses.chainA.contracts.GovernanceEmergency,
        GOVERNANCE_EMERGENCY_ABI,
        signerA
    );
    governanceVoting = new ethers.Contract(
        addresses.chainB.contracts.GovernanceVoting,
        GOVERNANCE_VOTING_ABI,
        signerB
    );

    logger.info("All contracts instantiated", {
        BridgeLock: addresses.chainA.contracts.BridgeLock,
        BridgeMint: addresses.chainB.contracts.BridgeMint,
        GovernanceEmergency: addresses.chainA.contracts.GovernanceEmergency,
        GovernanceVoting: addresses.chainB.contracts.GovernanceVoting,
    });
}

// ─── Confirmation Waiting ─────────────────────────────────────────────────────

/**
 * Wait for CONFIRMATION_DEPTH blocks after the event block.
 * @param {ethers.Provider} provider
 * @param {number} eventBlock - Block number in which the event occurred
 * @param {string} chainLabel
 */
async function waitForConfirmations(provider, eventBlock, chainLabel) {
    const targetBlock = eventBlock + CONFIRMATION_DEPTH;
    logger.info(
        `[${chainLabel}] Waiting for ${CONFIRMATION_DEPTH} confirmations (event block: ${eventBlock}, target: ${targetBlock})...`
    );

    while (running) {
        const currentBlock = await provider.getBlockNumber();
        if (currentBlock >= targetBlock) {
            logger.info(
                `[${chainLabel}] ${CONFIRMATION_DEPTH} confirmations reached (current block: ${currentBlock})`
            );
            return;
        }
        await sleep(POLL_INTERVAL_MS);
    }
}

// ─── Event Handlers ───────────────────────────────────────────────────────────

/**
 * Handle a Locked event from Chain A → mint on Chain B.
 */
async function handleLocked(user, amount, nonce, event) {
    const nonceNum = Number(nonce);
    logger.info(`[ChainA] Locked event detected`, {
        user,
        amount: amount.toString(),
        nonce: nonceNum,
        block: event.log.blockNumber,
    });

    // Check if already processed in SQLite (idempotency)
    if (db.isProcessed("LOCK", nonceNum, "chainA")) {
        logger.warn(`[ChainA] Nonce ${nonceNum} already processed, skipping`);
        return;
    }

    // Wait for confirmation depth
    await waitForConfirmations(providerA, event.log.blockNumber, "ChainA");

    if (!running) return;

    // Mint on Chain B with retry
    await withRetry(async () => {
        logger.info(`[ChainB] Calling mintWrapped`, {
            user,
            amount: amount.toString(),
            nonce: nonceNum,
        });
        const tx = await bridgeMint.mintWrapped(user, amount, nonce);
        const receipt = await tx.wait();
        logger.info(`[ChainB] mintWrapped successful`, {
            txHash: receipt.hash,
            block: receipt.blockNumber,
        });

        // Persist to SQLite
        db.markProcessed("LOCK", nonceNum, "chainA", {
            txHash: receipt.hash,
            blockNumber: receipt.blockNumber,
            userAddr: user,
            amount: amount.toString(),
        });
        db.setLastBlock("chainA", event.log.blockNumber);
    }, `mintWrapped nonce=${nonceNum}`);
}

/**
 * Handle a Burned event from Chain B → unlock on Chain A.
 */
async function handleBurned(user, amount, nonce, event) {
    const nonceNum = Number(nonce);
    logger.info(`[ChainB] Burned event detected`, {
        user,
        amount: amount.toString(),
        nonce: nonceNum,
        block: event.log.blockNumber,
    });

    if (db.isProcessed("BURN", nonceNum, "chainB")) {
        logger.warn(`[ChainB] Nonce ${nonceNum} already processed, skipping`);
        return;
    }

    await waitForConfirmations(providerB, event.log.blockNumber, "ChainB");

    if (!running) return;

    await withRetry(async () => {
        logger.info(`[ChainA] Calling unlock`, {
            user,
            amount: amount.toString(),
            nonce: nonceNum,
        });
        const tx = await bridgeLock.unlock(user, amount, nonce);
        const receipt = await tx.wait();
        logger.info(`[ChainA] unlock successful`, {
            txHash: receipt.hash,
            block: receipt.blockNumber,
        });

        db.markProcessed("BURN", nonceNum, "chainB", {
            txHash: receipt.hash,
            blockNumber: receipt.blockNumber,
            userAddr: user,
            amount: amount.toString(),
        });
        db.setLastBlock("chainB", event.log.blockNumber);
    }, `unlock nonce=${nonceNum}`);
}

/**
 * Handle a ProposalPassed event from Chain B → execute pause on Chain A.
 */
async function handleProposalPassed(proposalId, data, event) {
    const proposalIdNum = Number(proposalId);
    logger.info(`[ChainB] ProposalPassed event detected`, {
        proposalId: proposalIdNum,
        block: event.log.blockNumber,
    });

    if (db.isProcessed("PROPOSAL", proposalIdNum, "chainB")) {
        logger.warn(`[ChainB] Proposal ${proposalIdNum} already processed, skipping`);
        return;
    }

    await waitForConfirmations(providerB, event.log.blockNumber, "ChainB");

    if (!running) return;

    await withRetry(async () => {
        logger.info(`[ChainA] Calling pauseBridge for proposal ${proposalIdNum}`);
        const tx = await governanceEmergency.pauseBridge(proposalId);
        const receipt = await tx.wait();
        logger.info(`[ChainA] pauseBridge executed`, {
            txHash: receipt.hash,
            proposalId: proposalIdNum,
        });

        db.markProcessed("PROPOSAL", proposalIdNum, "chainB", {
            txHash: receipt.hash,
            blockNumber: receipt.blockNumber,
        });
        db.setLastBlock("chainB", event.log.blockNumber);
    }, `pauseBridge proposalId=${proposalIdNum}`);
}

// ─── Historical Event Scanning (Crash Recovery) ───────────────────────────────

/**
 * Scan historical events starting from lastBlock for crash recovery.
 * This ensures no events are missed if the relayer was offline.
 */
async function scanHistoricalEvents() {
    logger.info("📜 Scanning historical events for crash recovery...");

    const currentBlockA = await providerA.getBlockNumber();
    const currentBlockB = await providerB.getBlockNumber();

    const lastBlockA = db.getLastBlock("chainA");
    const lastBlockB = db.getLastBlock("chainB");

    logger.info(`Chain A: scanning blocks ${lastBlockA} → ${currentBlockA}`);
    logger.info(`Chain B: scanning blocks ${lastBlockB} → ${currentBlockB}`);

    // Scan Locked events on Chain A
    if (currentBlockA > lastBlockA) {
        try {
            const lockedFilter = bridgeLock.filters.Locked();
            const lockedEvents = await bridgeLock.queryFilter(
                lockedFilter,
                lastBlockA,
                currentBlockA
            );
            logger.info(`Found ${lockedEvents.length} historical Locked events`);
            for (const event of lockedEvents) {
                const [user, amount, nonce] = event.args;
                const nonceNum = Number(nonce);
                if (!db.isProcessed("LOCK", nonceNum, "chainA")) {
                    logger.info(`[Recovery] Processing missed Locked event nonce=${nonceNum}`);
                    // For recovery: skip confirmation wait if blocks already passed
                    const confirmBlock = event.blockNumber + CONFIRMATION_DEPTH;
                    if (currentBlockA >= confirmBlock) {
                        await withRetry(async () => {
                            const tx = await bridgeMint.mintWrapped(user, amount, nonce);
                            const receipt = await tx.wait();
                            db.markProcessed("LOCK", nonceNum, "chainA", {
                                txHash: receipt.hash,
                                blockNumber: receipt.blockNumber,
                                userAddr: user,
                                amount: amount.toString(),
                            });
                            logger.info(`[Recovery] Processed Locked nonce=${nonceNum}`, { txHash: receipt.hash });
                        }, `recovery mintWrapped nonce=${nonceNum}`);
                    }
                }
            }
        } catch (err) {
            logger.error("Error scanning historical Locked events", { error: err.message });
        }
    }

    // Scan Burned events on Chain B
    if (currentBlockB > lastBlockB) {
        try {
            const burnedFilter = bridgeMint.filters.Burned();
            const burnedEvents = await bridgeMint.queryFilter(
                burnedFilter,
                lastBlockB,
                currentBlockB
            );
            logger.info(`Found ${burnedEvents.length} historical Burned events`);
            for (const event of burnedEvents) {
                const [user, amount, nonce] = event.args;
                const nonceNum = Number(nonce);
                if (!db.isProcessed("BURN", nonceNum, "chainB")) {
                    logger.info(`[Recovery] Processing missed Burned event nonce=${nonceNum}`);
                    const confirmBlock = event.blockNumber + CONFIRMATION_DEPTH;
                    if (currentBlockB >= confirmBlock) {
                        await withRetry(async () => {
                            const tx = await bridgeLock.unlock(user, amount, nonce);
                            const receipt = await tx.wait();
                            db.markProcessed("BURN", nonceNum, "chainB", {
                                txHash: receipt.hash,
                                blockNumber: receipt.blockNumber,
                                userAddr: user,
                                amount: amount.toString(),
                            });
                            logger.info(`[Recovery] Processed Burned nonce=${nonceNum}`, { txHash: receipt.hash });
                        }, `recovery unlock nonce=${nonceNum}`);
                    }
                }
            }
        } catch (err) {
            logger.error("Error scanning historical Burned events", { error: err.message });
        }
    }

    // Scan ProposalPassed events on Chain B
    if (currentBlockB > lastBlockB) {
        try {
            const proposalFilter = governanceVoting.filters.ProposalPassed();
            const proposalEvents = await governanceVoting.queryFilter(
                proposalFilter,
                lastBlockB,
                currentBlockB
            );
            logger.info(`Found ${proposalEvents.length} historical ProposalPassed events`);
            for (const event of proposalEvents) {
                const [proposalId, data] = event.args;
                const proposalIdNum = Number(proposalId);
                if (!db.isProcessed("PROPOSAL", proposalIdNum, "chainB")) {
                    const confirmBlock = event.blockNumber + CONFIRMATION_DEPTH;
                    if (currentBlockB >= confirmBlock) {
                        await withRetry(async () => {
                            const tx = await governanceEmergency.pauseBridge(proposalId);
                            const receipt = await tx.wait();
                            db.markProcessed("PROPOSAL", proposalIdNum, "chainB", {
                                txHash: receipt.hash,
                                blockNumber: receipt.blockNumber,
                            });
                            logger.info(`[Recovery] Processed ProposalPassed proposalId=${proposalIdNum}`);
                        }, `recovery pauseBridge proposalId=${proposalIdNum}`);
                    }
                }
            }
        } catch (err) {
            logger.error("Error scanning historical ProposalPassed events", { error: err.message });
        }
    }

    // Update last block pointers
    db.setLastBlock("chainA", currentBlockA);
    db.setLastBlock("chainB", currentBlockB);

    logger.info("✅ Historical event scan complete");
}

// ─── Live Event Listeners ─────────────────────────────────────────────────────

function startEventListeners() {
    logger.info("👂 Starting live event listeners...");

    // Chain A: Listen for Locked events
    bridgeLock.on("Locked", async (user, amount, nonce, event) => {
        try {
            await handleLocked(user, amount, nonce, event);
        } catch (err) {
            logger.error("Error handling Locked event", { error: err.message, nonce: nonce.toString() });
        }
    });

    // Chain B: Listen for Burned events
    bridgeMint.on("Burned", async (user, amount, nonce, event) => {
        try {
            await handleBurned(user, amount, nonce, event);
        } catch (err) {
            logger.error("Error handling Burned event", { error: err.message, nonce: nonce.toString() });
        }
    });

    // Chain B: Listen for ProposalPassed events
    governanceVoting.on("ProposalPassed", async (proposalId, data, event) => {
        try {
            await handleProposalPassed(proposalId, data, event);
        } catch (err) {
            logger.error("Error handling ProposalPassed event", {
                error: err.message,
                proposalId: proposalId.toString(),
            });
        }
    });

    logger.info("✅ Event listeners active");
}

// ─── Health Check Logger ──────────────────────────────────────────────────────

async function logHealthStats() {
    try {
        const blockA = await providerA.getBlockNumber();
        const blockB = await providerB.getBlockNumber();
        logger.info("💓 Relayer health check", {
            chainA_block: blockA,
            chainB_block: blockB,
            db_last_A: db.getLastBlock("chainA"),
            db_last_B: db.getLastBlock("chainB"),
        });
    } catch (err) {
        logger.error("Health check failed", { error: err.message });
    }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function start() {
    logger.info("🌉 Omnichain Relayer starting...");
    logger.info(`Config: CONFIRMATION_DEPTH=${CONFIRMATION_DEPTH}, MAX_RETRIES=${MAX_RETRIES}`);

    // Initialize SQLite
    db.initDB();

    // Connect to both chains
    await initConnections();

    // Crash recovery: scan missed events
    await scanHistoricalEvents();

    // Start live event listeners
    startEventListeners();

    // Health check every 30 seconds
    const healthInterval = setInterval(logHealthStats, 30000);

    logger.info("🚀 Relayer is running. Press Ctrl+C to stop.");

    // Graceful shutdown
    process.on("SIGTERM", () => shutdown(healthInterval));
    process.on("SIGINT", () => shutdown(healthInterval));
}

function shutdown(healthInterval) {
    logger.info("🛑 Shutting down relayer...");
    running = false;
    clearInterval(healthInterval);

    // Remove event listeners
    if (bridgeLock) bridgeLock.removeAllListeners();
    if (bridgeMint) bridgeMint.removeAllListeners();
    if (governanceVoting) governanceVoting.removeAllListeners();

    db.closeDB();
    logger.info("Relayer shut down gracefully");
    process.exit(0);
}

module.exports = { start, handleLocked, handleBurned, handleProposalPassed };
