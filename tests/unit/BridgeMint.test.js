// tests/unit/BridgeMint.test.js
// Unit tests for BridgeMint contract on Chain B

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("BridgeMint", function () {
    async function deployFixture() {
        const [owner, relayer, user, attacker] = await ethers.getSigners();

        // Deploy WrappedVaultToken
        const WrappedVaultToken = await ethers.getContractFactory("WrappedVaultToken");
        const wrappedVaultToken = await WrappedVaultToken.deploy(owner.address);

        // Deploy BridgeMint
        const BridgeMint = await ethers.getContractFactory("BridgeMint");
        const bridgeMint = await BridgeMint.deploy(
            await wrappedVaultToken.getAddress(),
            owner.address,
            relayer.address
        );

        // Grant MINTER_ROLE to BridgeMint
        const MINTER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("MINTER_ROLE"));
        await wrappedVaultToken.grantRole(MINTER_ROLE, await bridgeMint.getAddress());

        const AMOUNT = ethers.parseEther("1000");

        return { wrappedVaultToken, bridgeMint, owner, relayer, user, attacker, AMOUNT };
    }

    // ─── mintWrapped() tests ──────────────────────────────────────────────────

    describe("mintWrapped()", function () {
        it("should mint wrapped tokens for user and emit Minted event", async function () {
            const { wrappedVaultToken, bridgeMint, relayer, user } =
                await loadFixture(deployFixture);
            const mintAmount = ethers.parseEther("100");
            const nonce = 1;

            await expect(bridgeMint.connect(relayer).mintWrapped(user.address, mintAmount, nonce))
                .to.emit(bridgeMint, "Minted")
                .withArgs(user.address, mintAmount, BigInt(nonce));

            expect(await wrappedVaultToken.balanceOf(user.address)).to.equal(mintAmount);
            expect(await wrappedVaultToken.totalSupply()).to.equal(mintAmount);
        });

        it("should revert if caller is not the relayer", async function () {
            const { bridgeMint, user, attacker } = await loadFixture(deployFixture);
            await expect(
                bridgeMint.connect(attacker).mintWrapped(user.address, ethers.parseEther("100"), 1)
            ).to.be.revertedWithCustomError(bridgeMint, "AccessControlUnauthorizedAccount");
        });

        it("should revert on nonce replay (same nonce twice)", async function () {
            const { bridgeMint, relayer, user } = await loadFixture(deployFixture);
            const mintAmount = ethers.parseEther("100");
            const nonce = 42;

            // First mint succeeds
            await bridgeMint.connect(relayer).mintWrapped(user.address, mintAmount, nonce);

            // Second mint with same nonce reverts
            await expect(
                bridgeMint.connect(relayer).mintWrapped(user.address, mintAmount, nonce)
            ).to.be.revertedWithCustomError(bridgeMint, "NonceAlreadyProcessed");
        });

        it("should revert with zero amount", async function () {
            const { bridgeMint, relayer, user } = await loadFixture(deployFixture);
            await expect(
                bridgeMint.connect(relayer).mintWrapped(user.address, 0, 1)
            ).to.be.revertedWithCustomError(bridgeMint, "ZeroAmount");
        });

        it("should revert with zero address user", async function () {
            const { bridgeMint, relayer } = await loadFixture(deployFixture);
            await expect(
                bridgeMint
                    .connect(relayer)
                    .mintWrapped(ethers.ZeroAddress, ethers.parseEther("100"), 1)
            ).to.be.revertedWithCustomError(bridgeMint, "ZeroAddress");
        });

        it("isMintProcessed should return true after minting", async function () {
            const { bridgeMint, relayer, user } = await loadFixture(deployFixture);
            const nonce = 7;
            await bridgeMint.connect(relayer).mintWrapped(user.address, ethers.parseEther("50"), nonce);
            expect(await bridgeMint.isMintProcessed(nonce)).to.be.true;
            expect(await bridgeMint.isMintProcessed(nonce + 1)).to.be.false;
        });
    });

    // ─── burn() tests ─────────────────────────────────────────────────────────

    describe("burn()", function () {
        async function mintedFixture() {
            const base = await deployFixture();
            const { bridgeMint, relayer, user, wrappedVaultToken } = base;
            const mintAmount = ethers.parseEther("500");
            await bridgeMint.connect(relayer).mintWrapped(user.address, mintAmount, 1);
            return { ...base, mintAmount };
        }

        it("should burn tokens and emit Burned event with unique nonce", async function () {
            const { wrappedVaultToken, bridgeMint, user, mintAmount } =
                await loadFixture(mintedFixture);
            const burnAmount = ethers.parseEther("100");

            const balanceBefore = await wrappedVaultToken.balanceOf(user.address);

            await expect(bridgeMint.connect(user).burn(burnAmount))
                .to.emit(bridgeMint, "Burned")
                .withArgs(user.address, burnAmount, 1n); // first burn → nonce 1

            expect(await wrappedVaultToken.balanceOf(user.address)).to.equal(
                balanceBefore - burnAmount
            );
        });

        it("should increment burn nonce on each burn", async function () {
            const { bridgeMint, user } = await loadFixture(mintedFixture);
            const burnAmount = ethers.parseEther("50");

            await expect(bridgeMint.connect(user).burn(burnAmount))
                .to.emit(bridgeMint, "Burned")
                .withArgs(user.address, burnAmount, 1n);

            await expect(bridgeMint.connect(user).burn(burnAmount))
                .to.emit(bridgeMint, "Burned")
                .withArgs(user.address, burnAmount, 2n);
        });

        it("should revert burn with zero amount", async function () {
            const { bridgeMint, user } = await loadFixture(mintedFixture);
            await expect(bridgeMint.connect(user).burn(0)).to.be.revertedWithCustomError(
                bridgeMint,
                "ZeroAmount"
            );
        });

        it("should revert burn with insufficient balance", async function () {
            const { bridgeMint, attacker } = await loadFixture(mintedFixture);
            // attacker has 0 tokens
            await expect(
                bridgeMint.connect(attacker).burn(ethers.parseEther("1"))
            ).to.be.reverted;
        });
    });
});
