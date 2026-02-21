// tests/integration/governance-flow.test.js
// Integration test: Cross-chain governance flow
//
// Flow:
//  1. Voters create + pass a proposal on GovernanceVoting (Chain B)
//  2. ProposalPassed event emitted
//  3. Relayer detects event → calls pauseBridge() on GovernanceEmergency (Chain A)
//  4. BridgeLock enters paused state
//  5. Subsequent lock() calls revert

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, mine } = require("@nomicfoundation/hardhat-network-helpers");

describe("Cross-Chain Governance Flow — Integration", function () {
    async function deployAllFixture() {
        const [owner, relayer, voter] = await ethers.getSigners();

        // ── Chain A ────────────────────────────────────────────────────────────
        const VaultToken = await ethers.getContractFactory("VaultToken");
        const vaultToken = await VaultToken.deploy(owner.address);

        const BridgeLock = await ethers.getContractFactory("BridgeLock");
        const bridgeLock = await BridgeLock.deploy(
            await vaultToken.getAddress(), owner.address, relayer.address
        );

        const GovernanceEmergency = await ethers.getContractFactory("GovernanceEmergency");
        const governanceEmergency = await GovernanceEmergency.deploy(
            await bridgeLock.getAddress(), owner.address, relayer.address
        );

        // Grant PAUSER_ROLE to GovernanceEmergency
        const PAUSER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("PAUSER_ROLE"));
        await bridgeLock.grantRole(PAUSER_ROLE, await governanceEmergency.getAddress());

        // ── Chain B ────────────────────────────────────────────────────────────
        const WrappedVaultToken = await ethers.getContractFactory("WrappedVaultToken");
        const wrappedVaultToken = await WrappedVaultToken.deploy(owner.address);

        const BridgeMint = await ethers.getContractFactory("BridgeMint");
        const bridgeMint = await BridgeMint.deploy(
            await wrappedVaultToken.getAddress(), owner.address, relayer.address
        );
        const MINTER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("MINTER_ROLE"));
        await wrappedVaultToken.grantRole(MINTER_ROLE, await bridgeMint.getAddress());

        const VOTING_PERIOD = 5;
        const QUORUM = ethers.parseEther("1");
        const GovernanceVoting = await ethers.getContractFactory("GovernanceVoting");
        const governanceVoting = await GovernanceVoting.deploy(
            await wrappedVaultToken.getAddress(), owner.address, VOTING_PERIOD, QUORUM
        );

        // Mint tokens to voter so they can participate
        await bridgeMint.connect(relayer).mintWrapped(voter.address, ethers.parseEther("500"), 1);

        // Fund owner with VaultTokens
        await vaultToken.mint(owner.address, ethers.parseEther("10000"));
        await vaultToken.approve(await bridgeLock.getAddress(), ethers.parseEther("10000"));

        return {
            vaultToken, bridgeLock, governanceEmergency,
            wrappedVaultToken, bridgeMint, governanceVoting,
            owner, relayer, voter, VOTING_PERIOD
        };
    }

    it("should pause BridgeLock on Chain A after governance proposal passes on Chain B", async function () {
        const {
            vaultToken, bridgeLock, governanceEmergency, governanceVoting,
            owner, relayer, voter, VOTING_PERIOD
        } = await loadFixture(deployAllFixture);

        // ── Step 1: Bridge is not paused initially ─────────────────────────────
        expect(await bridgeLock.paused()).to.be.false;

        // Verify lock works before pause
        await expect(bridgeLock.connect(owner).lock(ethers.parseEther("10")))
            .to.emit(bridgeLock, "Locked");

        // ── Step 2: Create and pass governance proposal on Chain B ─────────────
        const proposalData = ethers.AbiCoder.defaultAbiCoder().encode(
            ["string"],
            ["EMERGENCY_PAUSE"]
        );

        await governanceVoting.connect(voter).createProposal(
            "Emergency: Pause bridge due to exploit",
            proposalData
        );

        await governanceVoting.connect(voter).vote(1, true); // FOR

        // Mine past voting period
        await mine(VOTING_PERIOD + 1);

        // ── Step 3: Execute proposal → emits ProposalPassed ───────────────────
        const executeTx = await governanceVoting.connect(voter).executeProposal(1);
        const executeReceipt = await executeTx.wait();

        // Verify ProposalPassed event
        const passedEvent = executeReceipt.logs.find((log) => {
            try { return governanceVoting.interface.parseLog(log)?.name === "ProposalPassed"; }
            catch { return false; }
        });
        expect(passedEvent).to.not.be.undefined;
        const parsed = governanceVoting.interface.parseLog(passedEvent);
        expect(parsed.args.proposalId).to.equal(1n);

        console.log(`  ✅ ProposalPassed event emitted for proposalId=1`);

        // ── Step 4: Relayer calls pauseBridge on Chain A ───────────────────────
        await expect(governanceEmergency.connect(relayer).pauseBridge(1))
            .to.emit(governanceEmergency, "EmergencyPauseExecuted")
            .withArgs(1n, relayer.address);

        // ── Step 5: Verify BridgeLock is now paused ───────────────────────────
        expect(await bridgeLock.paused()).to.be.true;
        console.log(`  ✅ BridgeLock paused on Chain A`);

        // ── Step 6: Lock attempt must revert ────────────────────────────────────
        await expect(bridgeLock.connect(owner).lock(ethers.parseEther("100")))
            .to.be.revertedWithCustomError(bridgeLock, "EnforcedPause");
        console.log(`  ✅ lock() correctly reverts when paused`);
    });

    it("should prevent double execution of the same proposal via GovernanceEmergency", async function () {
        const { governanceEmergency, governanceVoting, voter, relayer, VOTING_PERIOD } =
            await loadFixture(deployAllFixture);

        await governanceVoting.connect(voter).createProposal("Test", "0x");
        await governanceVoting.connect(voter).vote(1, true);
        await mine(VOTING_PERIOD + 1);
        await governanceVoting.connect(voter).executeProposal(1);

        // First pauseBridge succeeds
        await governanceEmergency.connect(relayer).pauseBridge(1);

        // Second call with same proposalId reverts
        await expect(governanceEmergency.connect(relayer).pauseBridge(1))
            .to.be.revertedWithCustomError(governanceEmergency, "ProposalAlreadyExecuted");
    });
});
