// tests/unit/VaultToken.test.js
// Unit tests for VaultToken ERC20 on Chain A

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("VaultToken", function () {
    async function deployFixture() {
        const [owner, user, attacker] = await ethers.getSigners();
        const VaultToken = await ethers.getContractFactory("VaultToken");
        const vaultToken = await VaultToken.deploy(owner.address);
        return { vaultToken, owner, user, attacker };
    }

    it("should have correct name and symbol", async function () {
        const { vaultToken } = await loadFixture(deployFixture);
        expect(await vaultToken.name()).to.equal("VaultToken");
        expect(await vaultToken.symbol()).to.equal("VTK");
        expect(await vaultToken.decimals()).to.equal(18);
    });

    it("should mint initial supply to deployer", async function () {
        const { vaultToken, owner } = await loadFixture(deployFixture);
        const totalSupply = await vaultToken.totalSupply();
        expect(totalSupply).to.equal(ethers.parseEther("1000000"));
        expect(await vaultToken.balanceOf(owner.address)).to.equal(totalSupply);
    });

    it("should allow owner to mint additional tokens", async function () {
        const { vaultToken, owner, user } = await loadFixture(deployFixture);
        const mintAmount = ethers.parseEther("500");
        await expect(vaultToken.connect(owner).mint(user.address, mintAmount))
            .to.emit(vaultToken, "TokensMinted")
            .withArgs(user.address, mintAmount);
        expect(await vaultToken.balanceOf(user.address)).to.equal(mintAmount);
    });

    it("should revert mint when called by non-owner", async function () {
        const { vaultToken, attacker, user } = await loadFixture(deployFixture);
        await expect(
            vaultToken.connect(attacker).mint(user.address, ethers.parseEther("100"))
        ).to.be.revertedWithCustomError(vaultToken, "OwnableUnauthorizedAccount");
    });

    it("should allow token transfers", async function () {
        const { vaultToken, owner, user } = await loadFixture(deployFixture);
        const transferAmount = ethers.parseEther("100");
        await vaultToken.connect(owner).transfer(user.address, transferAmount);
        expect(await vaultToken.balanceOf(user.address)).to.equal(transferAmount);
    });
});
