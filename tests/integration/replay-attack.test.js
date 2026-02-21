// tests/integration/replay-attack.test.js
// Tests that replay attacks are properly prevented for both mint and unlock operations.
// This directly tests the nonce-based replay protection in BridgeLock and BridgeMint.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("Replay Attack Prevention", function () {
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

        const LOCK_AMOUNT = ethers.parseEther("100");
        await vaultToken.mint(user.address, ethers.parseEther("10000"));
        await vaultToken.connect(user).approve(await bridgeLock.getAddress(), ethers.parseEther("10000"));

        return { vaultToken, bridgeLock, wrappedVaultToken, bridgeMint, owner, relayer, user, LOCK_AMOUNT };
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Mint Replay Attack
    // ──────────────────────────────────────────────────────────────────────────
    describe("Mint Replay Attack (Chain B)", function () {
        it("should revert second mintWrapped with the same nonce", async function () {
            const { bridgeMint, relayer, user, LOCK_AMOUNT } = await loadFixture(deployAllFixture);

            const nonce = 1;

            // First mint succeeds
            await expect(bridgeMint.connect(relayer).mintWrapped(user.address, LOCK_AMOUNT, nonce))
                .to.emit(bridgeMint, "Minted");

            // Second mint with same nonce must revert
            await expect(
                bridgeMint.connect(relayer).mintWrapped(user.address, LOCK_AMOUNT, nonce)
            )
                .to.be.revertedWithCustomError(bridgeMint, "NonceAlreadyProcessed")
                .withArgs(nonce);

            console.log(`  ✅ Mint replay attack with nonce=${nonce} correctly rejected`);
        });

        it("should allow minting with a different nonce", async function () {
            const { bridgeMint, relayer, user, LOCK_AMOUNT } = await loadFixture(deployAllFixture);

            await bridgeMint.connect(relayer).mintWrapped(user.address, LOCK_AMOUNT, 1);
            // Nonce 2 is fine
            await expect(bridgeMint.connect(relayer).mintWrapped(user.address, LOCK_AMOUNT, 2))
                .to.emit(bridgeMint, "Minted");
        });

        it("processedMintNonces mapping correctly tracks processed nonces", async function () {
            const { bridgeMint, relayer, user, LOCK_AMOUNT } = await loadFixture(deployAllFixture);

            expect(await bridgeMint.isMintProcessed(5)).to.be.false;
            await bridgeMint.connect(relayer).mintWrapped(user.address, LOCK_AMOUNT, 5);
            expect(await bridgeMint.isMintProcessed(5)).to.be.true;
            expect(await bridgeMint.isMintProcessed(6)).to.be.false;
        });
    });

    // ──────────────────────────────────────────────────────────────────────────
    // Unlock Replay Attack
    // ──────────────────────────────────────────────────────────────────────────
    describe("Unlock Replay Attack (Chain A)", function () {
        it("should revert second unlock with the same nonce", async function () {
            const { bridgeLock, relayer, user, LOCK_AMOUNT } = await loadFixture(deployAllFixture);

            // Lock tokens first (2 separate locks for balance)
            await bridgeLock.connect(user).lock(LOCK_AMOUNT);
            await bridgeLock.connect(user).lock(LOCK_AMOUNT);

            const burnNonce = 1;

            // First unlock succeeds
            await expect(bridgeLock.connect(relayer).unlock(user.address, LOCK_AMOUNT, burnNonce))
                .to.emit(bridgeLock, "Unlocked");

            // Second unlock with same nonce must revert
            await expect(
                bridgeLock.connect(relayer).unlock(user.address, LOCK_AMOUNT, burnNonce)
            )
                .to.be.revertedWithCustomError(bridgeLock, "NonceAlreadyProcessed")
                .withArgs(burnNonce);

            console.log(`  ✅ Unlock replay attack with nonce=${burnNonce} correctly rejected`);
        });

        it("processedUnlockNonces mapping correctly tracks processed nonces", async function () {
            const { bridgeLock, relayer, user, LOCK_AMOUNT } = await loadFixture(deployAllFixture);
            await bridgeLock.connect(user).lock(LOCK_AMOUNT);

            expect(await bridgeLock.isUnlockProcessed(99)).to.be.false;
            await bridgeLock.connect(relayer).unlock(user.address, LOCK_AMOUNT, 99);
            expect(await bridgeLock.isUnlockProcessed(99)).to.be.true;
        });
    });
});
