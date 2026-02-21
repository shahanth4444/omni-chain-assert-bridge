// tests/unit/BridgeLock.test.js
// Unit tests for BridgeLock contract on Chain A

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("BridgeLock", function () {
    async function deployFixture() {
        const [owner, relayer, user, attacker] = await ethers.getSigners();

        // Deploy VaultToken
        const VaultToken = await ethers.getContractFactory("VaultToken");
        const vaultToken = await VaultToken.deploy(owner.address);

        // Deploy BridgeLock
        const BridgeLock = await ethers.getContractFactory("BridgeLock");
        const bridgeLock = await BridgeLock.deploy(
            await vaultToken.getAddress(),
            owner.address,
            relayer.address
        );

        // Mint tokens to user
        const AMOUNT = ethers.parseEther("1000");
        await vaultToken.mint(user.address, AMOUNT);

        // User approves BridgeLock
        await vaultToken.connect(user).approve(await bridgeLock.getAddress(), AMOUNT);

        return { vaultToken, bridgeLock, owner, relayer, user, attacker, AMOUNT };
    }

    // ─── lock() tests ─────────────────────────────────────────────────────────

    describe("lock()", function () {
        it("should transfer tokens from user to contract and emit Locked event", async function () {
            const { vaultToken, bridgeLock, user } = await loadFixture(deployFixture);
            const lockAmount = ethers.parseEther("100");

            const userBalanceBefore = await vaultToken.balanceOf(user.address);
            const contractBalanceBefore = await vaultToken.balanceOf(await bridgeLock.getAddress());

            await expect(bridgeLock.connect(user).lock(lockAmount))
                .to.emit(bridgeLock, "Locked")
                .withArgs(user.address, lockAmount, 1n);

            expect(await vaultToken.balanceOf(user.address)).to.equal(
                userBalanceBefore - lockAmount
            );
            expect(await vaultToken.balanceOf(await bridgeLock.getAddress())).to.equal(
                contractBalanceBefore + lockAmount
            );
        });

        it("should increment nonce with each lock", async function () {
            const { bridgeLock, user } = await loadFixture(deployFixture);
            const lockAmount = ethers.parseEther("50");

            await expect(bridgeLock.connect(user).lock(lockAmount))
                .to.emit(bridgeLock, "Locked")
                .withArgs(user.address, lockAmount, 1n);

            await expect(bridgeLock.connect(user).lock(lockAmount))
                .to.emit(bridgeLock, "Locked")
                .withArgs(user.address, lockAmount, 2n);
        });

        it("should revert when amount is zero", async function () {
            const { bridgeLock, user } = await loadFixture(deployFixture);
            await expect(bridgeLock.connect(user).lock(0)).to.be.revertedWithCustomError(
                bridgeLock,
                "ZeroAmount"
            );
        });

        it("should revert when contract is paused", async function () {
            const { bridgeLock, user, owner } = await loadFixture(deployFixture);
            await bridgeLock.connect(owner).pause();
            await expect(bridgeLock.connect(user).lock(ethers.parseEther("100")))
                .to.be.revertedWithCustomError(bridgeLock, "EnforcedPause");
        });

        it("should revert without token approval", async function () {
            const { bridgeLock, attacker } = await loadFixture(deployFixture);
            await expect(
                bridgeLock.connect(attacker).lock(ethers.parseEther("100"))
            ).to.be.reverted;
        });
    });

    // ─── unlock() tests ───────────────────────────────────────────────────────

    describe("unlock()", function () {
        it("should transfer tokens back to user and emit Unlocked event", async function () {
            const { vaultToken, bridgeLock, relayer, user, owner } =
                await loadFixture(deployFixture);
            const lockAmount = ethers.parseEther("100");

            // First lock some tokens
            await bridgeLock.connect(user).lock(lockAmount);

            const userBalanceBefore = await vaultToken.balanceOf(user.address);

            await expect(bridgeLock.connect(relayer).unlock(user.address, lockAmount, 1))
                .to.emit(bridgeLock, "Unlocked")
                .withArgs(user.address, lockAmount, 1n);

            expect(await vaultToken.balanceOf(user.address)).to.equal(
                userBalanceBefore + lockAmount
            );
        });

        it("should revert if caller is not the relayer (access control)", async function () {
            const { bridgeLock, user, attacker } = await loadFixture(deployFixture);
            await bridgeLock.connect(user).lock(ethers.parseEther("100"));

            await expect(
                bridgeLock.connect(attacker).unlock(user.address, ethers.parseEther("100"), 1)
            ).to.be.revertedWithCustomError(bridgeLock, "AccessControlUnauthorizedAccount");
        });

        it("should revert on nonce replay attack (same nonce twice)", async function () {
            const { bridgeLock, relayer, user } = await loadFixture(deployFixture);
            const lockAmount = ethers.parseEther("100");
            await bridgeLock.connect(user).lock(lockAmount);
            await bridgeLock.connect(user).lock(lockAmount); // second lock for balance

            // First unlock succeeds
            await bridgeLock.connect(relayer).unlock(user.address, lockAmount, 1);

            // Second unlock with same nonce reverts
            await expect(
                bridgeLock.connect(relayer).unlock(user.address, lockAmount, 1)
            ).to.be.revertedWithCustomError(bridgeLock, "NonceAlreadyProcessed");
        });

        it("should revert when amount is zero", async function () {
            const { bridgeLock, relayer, user } = await loadFixture(deployFixture);
            await expect(
                bridgeLock.connect(relayer).unlock(user.address, 0, 1)
            ).to.be.revertedWithCustomError(bridgeLock, "ZeroAmount");
        });
    });

    // ─── Pause tests ─────────────────────────────────────────────────────────

    describe("pause() / unpause()", function () {
        it("should pause and unpause correctly", async function () {
            const { bridgeLock, owner } = await loadFixture(deployFixture);

            expect(await bridgeLock.paused()).to.be.false;
            await bridgeLock.connect(owner).pause();
            expect(await bridgeLock.paused()).to.be.true;
            await bridgeLock.connect(owner).unpause();
            expect(await bridgeLock.paused()).to.be.false;
        });

        it("should revert pause if caller is not pauser", async function () {
            const { bridgeLock, attacker } = await loadFixture(deployFixture);
            await expect(
                bridgeLock.connect(attacker).pause()
            ).to.be.revertedWithCustomError(bridgeLock, "AccessControlUnauthorizedAccount");
        });
    });

    // ─── lockedBalance() view ────────────────────────────────────────────────

    describe("lockedBalance()", function () {
        it("should return correct locked balance", async function () {
            const { bridgeLock, user } = await loadFixture(deployFixture);
            const lockAmount = ethers.parseEther("250");
            await bridgeLock.connect(user).lock(lockAmount);
            expect(await bridgeLock.lockedBalance()).to.equal(lockAmount);
        });
    });
});
