// tests/unit/GovernanceEmergency.test.js
// Unit tests for GovernanceEmergency contract on Chain A
//
// Requirements covered:
//  - pauseBridge() callable only by RELAYER_ROLE (access control)
//  - pauseBridge() pauses BridgeLock
//  - Double-execution prevention (replay protection for proposals)
//  - unpauseBridge() restores operation
//  - setBridgeLock() admin function

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("GovernanceEmergency", function () {
    async function deployFixture() {
        const [owner, relayer, attacker] = await ethers.getSigners();

        // Deploy VaultToken + BridgeLock (on-chain A side)
        const VaultToken = await ethers.getContractFactory("VaultToken");
        const vaultToken = await VaultToken.deploy(owner.address);

        const BridgeLock = await ethers.getContractFactory("BridgeLock");
        const bridgeLock = await BridgeLock.deploy(
            await vaultToken.getAddress(),
            owner.address,
            relayer.address
        );

        // Deploy GovernanceEmergency
        const GovernanceEmergency = await ethers.getContractFactory("GovernanceEmergency");
        const governanceEmergency = await GovernanceEmergency.deploy(
            await bridgeLock.getAddress(),
            owner.address,
            relayer.address
        );

        // Grant PAUSER_ROLE to GovernanceEmergency so it can pause BridgeLock
        const PAUSER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("PAUSER_ROLE"));
        await bridgeLock.grantRole(PAUSER_ROLE, await governanceEmergency.getAddress());

        return {
            vaultToken,
            bridgeLock,
            governanceEmergency,
            owner,
            relayer,
            attacker,
        };
    }

    // ─── pauseBridge() ────────────────────────────────────────────────────────

    describe("pauseBridge()", function () {
        it("should allow relayer to pause BridgeLock and emit EmergencyPauseExecuted", async function () {
            const { bridgeLock, governanceEmergency, relayer } =
                await loadFixture(deployFixture);

            expect(await bridgeLock.paused()).to.be.false;

            await expect(governanceEmergency.connect(relayer).pauseBridge(1))
                .to.emit(governanceEmergency, "EmergencyPauseExecuted")
                .withArgs(1n, relayer.address);

            expect(await bridgeLock.paused()).to.be.true;
        });

        it("should revert if caller does not have RELAYER_ROLE (access control)", async function () {
            const { governanceEmergency, attacker } = await loadFixture(deployFixture);

            await expect(
                governanceEmergency.connect(attacker).pauseBridge(1)
            ).to.be.revertedWithCustomError(
                governanceEmergency,
                "AccessControlUnauthorizedAccount"
            );
        });

        it("should revert on double execution of the same proposalId (replay protection)", async function () {
            const { governanceEmergency, bridgeLock, relayer, owner } =
                await loadFixture(deployFixture);

            // First call succeeds
            await governanceEmergency.connect(relayer).pauseBridge(42);

            // Unpause so we can test execution replay separately
            await bridgeLock.connect(owner).unpause();

            // Second call with the same proposalId must revert
            await expect(
                governanceEmergency.connect(relayer).pauseBridge(42)
            ).to.be.revertedWithCustomError(
                governanceEmergency,
                "ProposalAlreadyExecuted"
            );
        });

        it("should mark proposal as executed after calling pauseBridge", async function () {
            const { governanceEmergency, relayer } = await loadFixture(deployFixture);

            expect(await governanceEmergency.isProposalExecuted(7)).to.be.false;
            await governanceEmergency.connect(relayer).pauseBridge(7);
            expect(await governanceEmergency.isProposalExecuted(7)).to.be.true;
        });

        it("should allow different proposalIds to pause independently", async function () {
            const { governanceEmergency, bridgeLock, relayer, owner } =
                await loadFixture(deployFixture);

            await governanceEmergency.connect(relayer).pauseBridge(1);
            expect(await bridgeLock.paused()).to.be.true;

            // Unpause via admin
            await bridgeLock.connect(owner).unpause();

            // Use a new proposalId — should work
            await governanceEmergency.connect(relayer).pauseBridge(2);
            expect(await bridgeLock.paused()).to.be.true;
        });
    });

    // ─── unpauseBridge() ──────────────────────────────────────────────────────

    describe("unpauseBridge()", function () {
        it("should allow relayer to unpause BridgeLock", async function () {
            const { bridgeLock, governanceEmergency, relayer } =
                await loadFixture(deployFixture);

            // Pause first
            await governanceEmergency.connect(relayer).pauseBridge(1);
            expect(await bridgeLock.paused()).to.be.true;

            // Unpause with a new proposalId
            await expect(governanceEmergency.connect(relayer).unpauseBridge(2))
                .to.emit(governanceEmergency, "EmergencyUnpauseExecuted")
                .withArgs(2n, relayer.address);

            expect(await bridgeLock.paused()).to.be.false;
        });

        it("should revert if non-relayer calls unpauseBridge", async function () {
            const { governanceEmergency, attacker } = await loadFixture(deployFixture);

            await expect(
                governanceEmergency.connect(attacker).unpauseBridge(1)
            ).to.be.revertedWithCustomError(
                governanceEmergency,
                "AccessControlUnauthorizedAccount"
            );
        });

        it("should revert if same proposalId used for unpause twice", async function () {
            const { governanceEmergency, bridgeLock, relayer } =
                await loadFixture(deployFixture);

            await governanceEmergency.connect(relayer).pauseBridge(10);
            await governanceEmergency.connect(relayer).unpauseBridge(11);

            // Replay same unpause proposalId
            await expect(
                governanceEmergency.connect(relayer).unpauseBridge(11)
            ).to.be.revertedWithCustomError(governanceEmergency, "ProposalAlreadyExecuted");
        });
    });

    // ─── setBridgeLock() ──────────────────────────────────────────────────────

    describe("setBridgeLock()", function () {
        it("should allow admin to update BridgeLock address", async function () {
            const { vaultToken, governanceEmergency, owner } =
                await loadFixture(deployFixture);

            // Deploy a second BridgeLock
            const BridgeLock = await ethers.getContractFactory("BridgeLock");
            const newBridgeLock = await BridgeLock.deploy(
                await vaultToken.getAddress(),
                owner.address,
                owner.address
            );
            const newAddr = await newBridgeLock.getAddress();

            await expect(
                governanceEmergency.connect(owner).setBridgeLock(newAddr)
            ).to.emit(governanceEmergency, "BridgeLockAddressUpdated");

            expect(await governanceEmergency.bridgeLock()).to.equal(newAddr);
        });

        it("should revert if non-admin calls setBridgeLock", async function () {
            const { governanceEmergency, relayer } = await loadFixture(deployFixture);

            await expect(
                governanceEmergency.connect(relayer).setBridgeLock(relayer.address)
            ).to.be.revertedWithCustomError(governanceEmergency, "AccessControlUnauthorizedAccount");
        });

        it("should revert if zero address is passed", async function () {
            const { governanceEmergency, owner } = await loadFixture(deployFixture);

            await expect(
                governanceEmergency.connect(owner).setBridgeLock(ethers.ZeroAddress)
            ).to.be.revertedWithCustomError(governanceEmergency, "ZeroAddress");
        });
    });
});
