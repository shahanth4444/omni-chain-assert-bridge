// tests/unit/GovernanceVoting.test.js
// Unit tests for GovernanceVoting contract on Chain B

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, mine } = require("@nomicfoundation/hardhat-network-helpers");

describe("GovernanceVoting", function () {
    async function deployFixture() {
        const [owner, voter1, voter2, nonHolder] = await ethers.getSigners();

        const WrappedVaultToken = await ethers.getContractFactory("WrappedVaultToken");
        const wrappedVaultToken = await WrappedVaultToken.deploy(owner.address);

        const BridgeMint = await ethers.getContractFactory("BridgeMint");
        const bridgeMint = await BridgeMint.deploy(
            await wrappedVaultToken.getAddress(),
            owner.address,
            owner.address
        );
        const MINTER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("MINTER_ROLE"));
        await wrappedVaultToken.grantRole(MINTER_ROLE, await bridgeMint.getAddress());

        const VOTING_PERIOD = 5;
        const QUORUM = ethers.parseEther("1");
        const GovernanceVoting = await ethers.getContractFactory("GovernanceVoting");
        const governanceVoting = await GovernanceVoting.deploy(
            await wrappedVaultToken.getAddress(),
            owner.address,
            VOTING_PERIOD,
            QUORUM
        );

        const VOTE_TOKENS = ethers.parseEther("100");
        await bridgeMint.mintWrapped(voter1.address, VOTE_TOKENS, 1);
        await bridgeMint.mintWrapped(voter2.address, VOTE_TOKENS, 2);

        return {
            wrappedVaultToken, bridgeMint, governanceVoting,
            owner, voter1, voter2, nonHolder,
            VOTING_PERIOD, QUORUM, VOTE_TOKENS,
        };
    }

    // ─── createProposal() ─────────────────────────────────────────────────────

    describe("createProposal()", function () {
        it("should allow token holders to create a proposal", async function () {
            const { governanceVoting, voter1 } = await loadFixture(deployFixture);

            const tx = await governanceVoting.connect(voter1).createProposal(
                "Emergency: Pause Bridge",
                ethers.toUtf8Bytes("PAUSE")
            );
            const receipt = await tx.wait();

            // Verify ProposalCreated event emitted with correct fields
            const event = receipt.logs.find((log) => {
                try { return governanceVoting.interface.parseLog(log)?.name === "ProposalCreated"; }
                catch { return false; }
            });
            expect(event).to.not.be.undefined;

            const parsed = governanceVoting.interface.parseLog(event);
            expect(parsed.args.proposalId).to.equal(1n);
            expect(parsed.args.proposer).to.equal(voter1.address);
            expect(parsed.args.description).to.equal("Emergency: Pause Bridge");

            // Verify proposal count
            expect(await governanceVoting.proposalCount()).to.equal(1n);
        });

        it("should revert if non-token-holder creates a proposal", async function () {
            const { governanceVoting, nonHolder } = await loadFixture(deployFixture);
            await expect(
                governanceVoting.connect(nonHolder).createProposal("Bad proposal", "0x")
            ).to.be.revertedWithCustomError(governanceVoting, "NotTokenHolder");
        });
    });

    // ─── vote() ───────────────────────────────────────────────────────────────

    describe("vote()", function () {
        async function proposalFixture() {
            const base = await deployFixture();
            await base.governanceVoting
                .connect(base.voter1)
                .createProposal("Test Proposal", ethers.toUtf8Bytes("PAUSE"));
            return base;
        }

        it("should allow token holder to vote FOR a proposal", async function () {
            const { governanceVoting, voter1, VOTE_TOKENS } = await loadFixture(proposalFixture);

            await expect(governanceVoting.connect(voter1).vote(1, true))
                .to.emit(governanceVoting, "VoteCast")
                .withArgs(1n, voter1.address, true, VOTE_TOKENS);

            const proposal = await governanceVoting.getProposal(1);
            expect(proposal.forVotes).to.equal(VOTE_TOKENS);
        });

        it("should allow voting AGAINST a proposal", async function () {
            const { governanceVoting, voter2, VOTE_TOKENS } = await loadFixture(proposalFixture);

            await governanceVoting.connect(voter2).vote(1, false);
            const proposal = await governanceVoting.getProposal(1);
            expect(proposal.againstVotes).to.equal(VOTE_TOKENS);
        });

        it("should revert double voting", async function () {
            const { governanceVoting, voter1 } = await loadFixture(proposalFixture);
            await governanceVoting.connect(voter1).vote(1, true);

            await expect(
                governanceVoting.connect(voter1).vote(1, true)
            ).to.be.revertedWithCustomError(governanceVoting, "AlreadyVoted");
        });

        it("should revert if non-holder tries to vote", async function () {
            const { governanceVoting, nonHolder } = await loadFixture(proposalFixture);
            await expect(
                governanceVoting.connect(nonHolder).vote(1, true)
            ).to.be.revertedWithCustomError(governanceVoting, "NotTokenHolder");
        });
    });

    // ─── executeProposal() ───────────────────────────────────────────────────

    describe("executeProposal()", function () {
        it("should emit ProposalPassed when quorum met and FOR > AGAINST", async function () {
            const { governanceVoting, voter1, voter2, VOTING_PERIOD } =
                await loadFixture(deployFixture);

            const proposalData = ethers.toUtf8Bytes("PAUSE");
            await governanceVoting.connect(voter1).createProposal("Emergency Pause", proposalData);

            await governanceVoting.connect(voter1).vote(1, true);
            await governanceVoting.connect(voter2).vote(1, true);

            await mine(VOTING_PERIOD + 1);

            await expect(governanceVoting.connect(voter1).executeProposal(1))
                .to.emit(governanceVoting, "ProposalPassed")
                .withArgs(1n, proposalData);
        });

        it("should emit ProposalFailed when AGAINST > FOR", async function () {
            const { governanceVoting, voter1, voter2, VOTING_PERIOD } =
                await loadFixture(deployFixture);

            await governanceVoting.connect(voter1).createProposal("Failing Prop", "0x");
            await governanceVoting.connect(voter1).vote(1, false);
            await governanceVoting.connect(voter2).vote(1, false);

            await mine(VOTING_PERIOD + 1);

            await expect(governanceVoting.connect(voter1).executeProposal(1))
                .to.emit(governanceVoting, "ProposalFailed");
        });

        it("should revert execution before voting period ends", async function () {
            const { governanceVoting, voter1 } = await loadFixture(deployFixture);
            await governanceVoting.connect(voter1).createProposal("Early", "0x");
            await governanceVoting.connect(voter1).vote(1, true);

            await expect(
                governanceVoting.connect(voter1).executeProposal(1)
            ).to.be.revertedWithCustomError(governanceVoting, "VotingPeriodNotEnded");
        });

        it("should revert double execution", async function () {
            const { governanceVoting, voter1, voter2, VOTING_PERIOD } =
                await loadFixture(deployFixture);

            await governanceVoting.connect(voter1).createProposal("Test", "0x");
            await governanceVoting.connect(voter1).vote(1, true);
            await mine(VOTING_PERIOD + 1);
            await governanceVoting.connect(voter1).executeProposal(1);

            await expect(
                governanceVoting.connect(voter1).executeProposal(1)
            ).to.be.revertedWithCustomError(governanceVoting, "ProposalAlreadyExecuted");
        });
    });
});
