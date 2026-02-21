// tests/integration/bridge-flow.test.js
// Integration test: Full end-to-end bridge flow
//
// Tests:
//  1. Lock tokens on Chain A → Mint wrapped tokens on Chain B
//  2. Burn wrapped tokens on Chain B → Unlock original tokens on Chain A
//  3. Invariant: lockedBalance(ChainA) == totalSupply(ChainB) at all times
//
// Simulates the relayer inline (no running relayer process needed for unit/integration).

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, mine } = require("@nomicfoundation/hardhat-network-helpers");

describe("Bridge Flow — End-to-End Integration", function () {
    async function deployAllFixture() {
        const [owner, relayer, user] = await ethers.getSigners();

        // ── Chain A contracts ──────────────────────────────────────────────────
        const VaultToken = await ethers.getContractFactory("VaultToken");
        const vaultToken = await VaultToken.deploy(owner.address);

        const BridgeLock = await ethers.getContractFactory("BridgeLock");
        const bridgeLock = await BridgeLock.deploy(
            await vaultToken.getAddress(),
            owner.address,
            relayer.address
        );

        const GovernanceEmergency = await ethers.getContractFactory("GovernanceEmergency");
        const governanceEmergency = await GovernanceEmergency.deploy(
            await bridgeLock.getAddress(),
            owner.address,
            relayer.address
        );

        // Grant PAUSER_ROLE on BridgeLock to GovernanceEmergency
        const PAUSER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("PAUSER_ROLE"));
        await bridgeLock.grantRole(PAUSER_ROLE, await governanceEmergency.getAddress());

        // ── Chain B contracts ──────────────────────────────────────────────────
        const WrappedVaultToken = await ethers.getContractFactory("WrappedVaultToken");
        const wrappedVaultToken = await WrappedVaultToken.deploy(owner.address);

        const BridgeMint = await ethers.getContractFactory("BridgeMint");
        const bridgeMint = await BridgeMint.deploy(
            await wrappedVaultToken.getAddress(),
            owner.address,
            relayer.address
        );

        const MINTER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("MINTER_ROLE"));
        await wrappedVaultToken.grantRole(MINTER_ROLE, await bridgeMint.getAddress());

        const GovernanceVoting = await ethers.getContractFactory("GovernanceVoting");
        const governanceVoting = await GovernanceVoting.deploy(
            await wrappedVaultToken.getAddress(),
            owner.address,
            5, // votingPeriod = 5 blocks
            ethers.parseEther("1") // quorum = 1 token
        );

        // Fund user with VaultTokens
        const USER_BALANCE = ethers.parseEther("10000");
        await vaultToken.mint(user.address, USER_BALANCE);

        return {
            vaultToken,
            bridgeLock,
            governanceEmergency,
            wrappedVaultToken,
            bridgeMint,
            governanceVoting,
            owner,
            relayer,
            user,
            USER_BALANCE,
        };
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Test 1: Lock → Mint Flow
    // ──────────────────────────────────────────────────────────────────────────
    describe("Lock on Chain A → Mint on Chain B", function () {
        it("should complete the full lock-and-mint flow", async function () {
            const { vaultToken, bridgeLock, wrappedVaultToken, bridgeMint, relayer, user } =
                await loadFixture(deployAllFixture);

            const LOCK_AMOUNT = ethers.parseEther("100");

            // Record balances before
            const userVTKBefore = await vaultToken.balanceOf(user.address);
            const userWVTKBefore = await wrappedVaultToken.balanceOf(user.address);
            expect(userWVTKBefore).to.equal(0n);

            // Step 1: User approves and locks tokens on Chain A
            await vaultToken.connect(user).approve(await bridgeLock.getAddress(), LOCK_AMOUNT);
            const lockTx = await bridgeLock.connect(user).lock(LOCK_AMOUNT);
            const lockReceipt = await lockTx.wait();

            // Verify Locked event
            const lockedEvent = lockReceipt.logs.find((log) => {
                try {
                    return bridgeLock.interface.parseLog(log)?.name === "Locked";
                } catch { return false; }
            });
            expect(lockedEvent).to.not.be.undefined;

            const parsed = bridgeLock.interface.parseLog(lockedEvent);
            const { user: lockedUser, amount: lockedAmount, nonce } = parsed.args;

            expect(lockedUser).to.equal(user.address);
            expect(lockedAmount).to.equal(LOCK_AMOUNT);
            expect(nonce).to.equal(1n);

            // VaultToken balance must have decreased
            const userVTKAfterLock = await vaultToken.balanceOf(user.address);
            expect(userVTKAfterLock).to.equal(userVTKBefore - LOCK_AMOUNT);

            // Step 2: Relayer calls mintWrapped on Chain B (simulated — no confirmation delay in unit env)
            await bridgeMint.connect(relayer).mintWrapped(user.address, LOCK_AMOUNT, nonce);

            // Verify WrappedVaultToken balance increased
            const userWVTKAfterMint = await wrappedVaultToken.balanceOf(user.address);
            expect(userWVTKAfterMint).to.equal(LOCK_AMOUNT);

            console.log(`  ✅ Lock-Mint flow complete:`);
            console.log(`     User VTK Before: ${ethers.formatEther(userVTKBefore)}`);
            console.log(`     User VTK After:  ${ethers.formatEther(userVTKAfterLock)}`);
            console.log(`     User wVTK:       ${ethers.formatEther(userWVTKAfterMint)}`);
        });
    });

    // ──────────────────────────────────────────────────────────────────────────
    // Test 2: Burn → Unlock Flow
    // ──────────────────────────────────────────────────────────────────────────
    describe("Burn on Chain B → Unlock on Chain A", function () {
        it("should complete the full burn-and-unlock flow", async function () {
            const { vaultToken, bridgeLock, wrappedVaultToken, bridgeMint, relayer, user } =
                await loadFixture(deployAllFixture);

            const AMOUNT = ethers.parseEther("100");

            // Setup: Lock and mint first
            await vaultToken.connect(user).approve(await bridgeLock.getAddress(), AMOUNT);
            await bridgeLock.connect(user).lock(AMOUNT);
            await bridgeMint.connect(relayer).mintWrapped(user.address, AMOUNT, 1);

            const userVTKAfterLock = await vaultToken.balanceOf(user.address);
            const userWVTKBeforeBurn = await wrappedVaultToken.balanceOf(user.address);

            // Step 1: User burns wrapped tokens on Chain B
            const burnTx = await bridgeMint.connect(user).burn(AMOUNT);
            const burnReceipt = await burnTx.wait();

            // Verify Burned event
            const burnedEvent = burnReceipt.logs.find((log) => {
                try { return bridgeMint.interface.parseLog(log)?.name === "Burned"; }
                catch { return false; }
            });
            expect(burnedEvent).to.not.be.undefined;

            const parsedBurn = bridgeMint.interface.parseLog(burnedEvent);
            const { user: burnedUser, amount: burnedAmount, nonce: burnNonce } = parsedBurn.args;

            expect(burnedUser).to.equal(user.address);
            expect(burnedAmount).to.equal(AMOUNT);
            expect(burnNonce).to.equal(1n);

            // wVTK balance should be zero
            expect(await wrappedVaultToken.balanceOf(user.address)).to.equal(0n);

            // Step 2: Relayer calls unlock on Chain A
            await bridgeLock.connect(relayer).unlock(user.address, AMOUNT, burnNonce);

            // VTK balance should be restored
            const userVTKAfterUnlock = await vaultToken.balanceOf(user.address);
            expect(userVTKAfterUnlock).to.equal(userVTKAfterLock + AMOUNT);

            console.log(`  ✅ Burn-Unlock flow complete`);
        });
    });

    // ──────────────────────────────────────────────────────────────────────────
    // Test 3: Invariant Check — lockedBalance == totalSupply
    // ──────────────────────────────────────────────────────────────────────────
    describe("Invariant: BridgeLock.lockedBalance() == WrappedVaultToken.totalSupply()", function () {
        it("should maintain invariant throughout the bridge lifecycle", async function () {
            const { vaultToken, bridgeLock, wrappedVaultToken, bridgeMint, relayer, user } =
                await loadFixture(deployAllFixture);

            const AMOUNT = ethers.parseEther("500");

            // Initial state: both should be zero
            expect(await bridgeLock.lockedBalance()).to.equal(0n);
            expect(await wrappedVaultToken.totalSupply()).to.equal(0n);

            // After lock + mint: invariant holds
            await vaultToken.connect(user).approve(await bridgeLock.getAddress(), AMOUNT);
            await bridgeLock.connect(user).lock(AMOUNT);
            await bridgeMint.connect(relayer).mintWrapped(user.address, AMOUNT, 1);

            expect(await bridgeLock.lockedBalance()).to.equal(AMOUNT);
            expect(await wrappedVaultToken.totalSupply()).to.equal(AMOUNT);
            console.log(`  ✅ After lock+mint: lockedBalance == totalSupply == ${ethers.formatEther(AMOUNT)} VTK`);

            // After burn + unlock: invariant holds (both back to zero)
            await bridgeMint.connect(user).burn(AMOUNT);
            await bridgeLock.connect(relayer).unlock(user.address, AMOUNT, 1);

            expect(await bridgeLock.lockedBalance()).to.equal(0n);
            expect(await wrappedVaultToken.totalSupply()).to.equal(0n);
            console.log(`  ✅ After burn+unlock: lockedBalance == totalSupply == 0`);
        });
    });
});
