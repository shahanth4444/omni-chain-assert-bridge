// tests/integration/relayer-recovery.test.js
// Integration test: Relayer crash recovery simulation
//
// Scenario:
//  1. System is running normally
//  2. Relayer is "stopped" (simulated by not processing events for a period)
//  3. A lock() operation happens on Chain A while relayer is "down"
//  4. Relayer "restarts" — scans historical events from last known block
//  5. Relayer detects the missed Locked event and processes it (mintWrapped)
//  6. Assert WrappedVaultToken balance is correct
//
// NOTE: This test simulates the relayer's recovery logic inline using the
//       same algorithm as relayer/src/relayer.js scanHistoricalEvents().

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, mine } = require("@nomicfoundation/hardhat-network-helpers");

describe("Relayer Crash Recovery — Integration", function () {
    async function deployAllFixture() {
        const [owner, relayer, user] = await ethers.getSigners();

        const VaultToken = await ethers.getContractFactory("VaultToken");
        const vaultToken = await VaultToken.deploy(owner.address);

        const BridgeLock = await ethers.getContractFactory("BridgeLock");
        const bridgeLock = await BridgeLock.deploy(
            await vaultToken.getAddress(), owner.address, relayer.address
        );

        const WrappedVaultToken = await ethers.getContractFactory("WrappedVaultToken");
        const wrappedVaultToken = await WrappedVaultToken.deploy(owner.address);

        const BridgeMint = await ethers.getContractFactory("BridgeMint");
        const bridgeMint = await BridgeMint.deploy(
            await wrappedVaultToken.getAddress(), owner.address, relayer.address
        );
        const MINTER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("MINTER_ROLE"));
        await wrappedVaultToken.grantRole(MINTER_ROLE, await bridgeMint.getAddress());

        await vaultToken.mint(user.address, ethers.parseEther("10000"));

        return { vaultToken, bridgeLock, wrappedVaultToken, bridgeMint, owner, relayer, user };
    }

    it("should process missed Locked events after relayer restart (crash recovery)", async function () {
        const { vaultToken, bridgeLock, wrappedVaultToken, bridgeMint, relayer, user } =
            await loadFixture(deployAllFixture);

        const LOCK_AMOUNT = ethers.parseEther("250");

        // ── Phase 1: Relayer is online, last known block = 0 ──────────────────
        let relayerLastKnownBlock = await ethers.provider.getBlockNumber();
        const processedNonces = new Set(); // In-memory (simulating SQLite)

        // ── Phase 2: Relayer goes offline ──────────────────────────────────────
        // (In production this is a docker stop — here we just stop processing)
        console.log(`  📋 Relayer offline at block ${relayerLastKnownBlock}`);

        // ── Phase 3: Lock happens while relayer is down ─────────────────────────
        await vaultToken.connect(user).approve(await bridgeLock.getAddress(), LOCK_AMOUNT);
        const lockTx = await bridgeLock.connect(user).lock(LOCK_AMOUNT);
        const lockReceipt = await lockTx.wait();

        const lockBlock = lockReceipt.blockNumber;
        console.log(`  🔒 Lock transaction mined at block ${lockBlock} (relayer offline)`);

        // Mine more blocks (simulating time passing)
        await mine(5);

        const wVTKBeforeRecovery = await wrappedVaultToken.balanceOf(user.address);
        expect(wVTKBeforeRecovery).to.equal(0n); // Not yet minted
        console.log(`  📊 wVTK balance before recovery: ${ethers.formatEther(wVTKBeforeRecovery)}`);

        // ── Phase 4: Relayer restarts ──────────────────────────────────────────
        console.log(`  🔄 Relayer restarting...`);
        const currentBlock = await ethers.provider.getBlockNumber();

        // Scan historical Locked events from lastKnownBlock to currentBlock
        const lockedFilter = bridgeLock.filters.Locked();
        const missedEvents = await bridgeLock.queryFilter(
            lockedFilter,
            relayerLastKnownBlock,
            currentBlock
        );

        console.log(`  📜 Found ${missedEvents.length} missed Locked event(s) during recovery scan`);
        expect(missedEvents.length).to.be.greaterThan(0);

        // Process each missed event (same logic as scanHistoricalEvents() in relayer.js)
        for (const event of missedEvents) {
            const [eventUser, eventAmount, eventNonce] = event.args;
            const nonceNum = Number(eventNonce);

            if (processedNonces.has(nonceNum)) {
                console.log(`  ⏭️  Nonce ${nonceNum} already processed, skipping`);
                continue;
            }

            const CONFIRMATION_DEPTH = 3;
            const confirmBlock = event.blockNumber + CONFIRMATION_DEPTH;

            // Confirmations already passed since we mined 5 blocks
            expect(currentBlock).to.be.greaterThanOrEqual(confirmBlock);

            // Process: mint on Chain B
            await bridgeMint.connect(relayer).mintWrapped(eventUser, eventAmount, eventNonce);
            processedNonces.add(nonceNum);

            console.log(`  ✅ Processed missed Locked event nonce=${nonceNum}`);
        }

        // ── Phase 5: Assert recovery was successful ────────────────────────────
        const wVTKAfterRecovery = await wrappedVaultToken.balanceOf(user.address);
        expect(wVTKAfterRecovery).to.equal(LOCK_AMOUNT);

        console.log(`  ✅ Recovery complete: wVTK balance = ${ethers.formatEther(wVTKAfterRecovery)}`);
        console.log(`  ✅ Invariant: locked(${ethers.formatEther(await bridgeLock.lockedBalance())}) == supply(${ethers.formatEther(await wrappedVaultToken.totalSupply())})`);

        // Final invariant check
        expect(await bridgeLock.lockedBalance()).to.equal(await wrappedVaultToken.totalSupply());
    });

    it("should not reprocess events that were already handled before restart", async function () {
        const { vaultToken, bridgeLock, wrappedVaultToken, bridgeMint, relayer, user } =
            await loadFixture(deployAllFixture);

        const LOCK_AMOUNT = ethers.parseEther("100");

        // Normal operation: lock + mint
        await vaultToken.connect(user).approve(await bridgeLock.getAddress(), LOCK_AMOUNT);
        await bridgeLock.connect(user).lock(LOCK_AMOUNT);

        const relayerLastKnownBlock = await ethers.provider.getBlockNumber();
        const processedNonces = new Set([1]); // Nonce 1 already in DB

        await bridgeMint.connect(relayer).mintWrapped(user.address, LOCK_AMOUNT, 1);
        await mine(5);

        // Recovery scan
        const currentBlock = await ethers.provider.getBlockNumber();
        const missedEvents = await bridgeLock.queryFilter(
            bridgeLock.filters.Locked(),
            0,
            currentBlock
        );

        // All events should be skipped (already processed)
        for (const event of missedEvents) {
            const nonceNum = Number(event.args[2]);
            if (processedNonces.has(nonceNum)) {
                // Skip — this is the correct behavior
                continue;
            }
            // If we reach here, a new event was found — process it
            await bridgeMint.connect(relayer).mintWrapped(event.args[0], event.args[1], event.args[2]);
        }

        // Token should still be minted once, not twice
        const balance = await wrappedVaultToken.balanceOf(user.address);
        expect(balance).to.equal(LOCK_AMOUNT);
        console.log(`  ✅ No double-minting occurred after recovery scan`);
    });
});
