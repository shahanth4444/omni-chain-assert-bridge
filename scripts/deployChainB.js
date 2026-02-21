// scripts/deployChainB.js
// Deployment script for Chain B (Execution Chain)
// Deploys: WrappedVaultToken → BridgeMint → GovernanceVoting
// Run: npx hardhat run scripts/deployChainB.js --network chainB

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
    console.log("\n🚀 Deploying Chain B Contracts (Execution Chain)...\n");

    const [deployer] = await ethers.getSigners();
    const relayerAddress = deployer.address; // In production, use a separate relayer key

    console.log(`📋 Deployer address: ${deployer.address}`);
    console.log(`📋 Relayer address:  ${relayerAddress}`);

    const balance = await ethers.provider.getBalance(deployer.address);
    console.log(`💰 Deployer balance: ${ethers.formatEther(balance)} ETH\n`);

    // ─── Deploy WrappedVaultToken ─────────────────────────────────────────────
    console.log("1️⃣  Deploying WrappedVaultToken...");
    const WrappedVaultToken = await ethers.getContractFactory("WrappedVaultToken");
    const wrappedVaultToken = await WrappedVaultToken.deploy(deployer.address);
    await wrappedVaultToken.waitForDeployment();
    const wrappedVaultTokenAddress = await wrappedVaultToken.getAddress();
    console.log(`   ✅ WrappedVaultToken deployed at: ${wrappedVaultTokenAddress}`);

    // ─── Deploy BridgeMint ────────────────────────────────────────────────────
    console.log("2️⃣  Deploying BridgeMint...");
    const BridgeMint = await ethers.getContractFactory("BridgeMint");
    const bridgeMint = await BridgeMint.deploy(
        wrappedVaultTokenAddress,
        deployer.address, // admin
        relayerAddress    // relayer
    );
    await bridgeMint.waitForDeployment();
    const bridgeMintAddress = await bridgeMint.getAddress();
    console.log(`   ✅ BridgeMint deployed at: ${bridgeMintAddress}`);

    // ─── Deploy GovernanceVoting ──────────────────────────────────────────────
    console.log("3️⃣  Deploying GovernanceVoting...");
    const VOTING_PERIOD_BLOCKS = 10; // 10 blocks voting window (fast for local testing)
    const QUORUM_THRESHOLD = ethers.parseEther("1"); // 1 wVTK minimum

    const GovernanceVoting = await ethers.getContractFactory("GovernanceVoting");
    const governanceVoting = await GovernanceVoting.deploy(
        wrappedVaultTokenAddress,
        deployer.address,    // admin
        VOTING_PERIOD_BLOCKS,
        QUORUM_THRESHOLD
    );
    await governanceVoting.waitForDeployment();
    const governanceVotingAddress = await governanceVoting.getAddress();
    console.log(`   ✅ GovernanceVoting deployed at: ${governanceVotingAddress}`);

    // ─── Grant MINTER_ROLE on WrappedVaultToken to BridgeMint ────────────────
    console.log("4️⃣  Granting MINTER_ROLE to BridgeMint on WrappedVaultToken...");
    const MINTER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("MINTER_ROLE"));
    const grantTx = await wrappedVaultToken.grantRole(MINTER_ROLE, bridgeMintAddress);
    await grantTx.wait();
    console.log("   ✅ MINTER_ROLE granted to BridgeMint");

    // ─── Save addresses ───────────────────────────────────────────────────────
    const addresses = {
        network: "chainB",
        chainId: 2222,
        deployedAt: new Date().toISOString(),
        deployer: deployer.address,
        votingPeriodBlocks: VOTING_PERIOD_BLOCKS,
        quorumThreshold: QUORUM_THRESHOLD.toString(),
        contracts: {
            WrappedVaultToken: wrappedVaultTokenAddress,
            BridgeMint: bridgeMintAddress,
            GovernanceVoting: governanceVotingAddress,
        },
    };

    const addressesPath = path.join(__dirname, "addresses-chainB.json");
    fs.writeFileSync(addressesPath, JSON.stringify(addresses, null, 2));
    console.log(`\n📁 Addresses saved to: ${addressesPath}`);

    // ─── Summary ──────────────────────────────────────────────────────────────
    console.log("\n" + "═".repeat(60));
    console.log("  Chain B Deployment Summary");
    console.log("═".repeat(60));
    console.log(`  WrappedVaultToken:  ${wrappedVaultTokenAddress}`);
    console.log(`  BridgeMint:         ${bridgeMintAddress}`);
    console.log(`  GovernanceVoting:   ${governanceVotingAddress}`);
    console.log("═".repeat(60) + "\n");

    return addresses;
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Deployment failed:", error);
        process.exit(1);
    });
