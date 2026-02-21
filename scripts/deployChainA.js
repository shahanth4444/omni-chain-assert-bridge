// scripts/deployChainA.js
// Deployment script for Chain A (Settlement Chain)
// Deploys: VaultToken → BridgeLock → GovernanceEmergency
// Run: npx hardhat run scripts/deployChainA.js --network chainA

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
    console.log("\n🚀 Deploying Chain A Contracts (Settlement Chain)...\n");

    const [deployer] = await ethers.getSigners();
    const relayerAddress = deployer.address; // In production, use a separate relayer key

    console.log(`📋 Deployer address: ${deployer.address}`);
    console.log(`📋 Relayer address:  ${relayerAddress}`);

    const balance = await ethers.provider.getBalance(deployer.address);
    console.log(`💰 Deployer balance: ${ethers.formatEther(balance)} ETH\n`);

    // ─── Deploy VaultToken ───────────────────────────────────────────────────
    console.log("1️⃣  Deploying VaultToken...");
    const VaultToken = await ethers.getContractFactory("VaultToken");
    const vaultToken = await VaultToken.deploy(deployer.address);
    await vaultToken.waitForDeployment();
    const vaultTokenAddress = await vaultToken.getAddress();
    console.log(`   ✅ VaultToken deployed at: ${vaultTokenAddress}`);

    // ─── Deploy BridgeLock ───────────────────────────────────────────────────
    console.log("2️⃣  Deploying BridgeLock...");
    const BridgeLock = await ethers.getContractFactory("BridgeLock");
    const bridgeLock = await BridgeLock.deploy(
        vaultTokenAddress,
        deployer.address, // admin
        relayerAddress    // relayer
    );
    await bridgeLock.waitForDeployment();
    const bridgeLockAddress = await bridgeLock.getAddress();
    console.log(`   ✅ BridgeLock deployed at: ${bridgeLockAddress}`);

    // ─── Deploy GovernanceEmergency ──────────────────────────────────────────
    console.log("3️⃣  Deploying GovernanceEmergency...");
    const GovernanceEmergency = await ethers.getContractFactory("GovernanceEmergency");
    const governanceEmergency = await GovernanceEmergency.deploy(
        bridgeLockAddress,
        deployer.address, // admin
        relayerAddress    // relayer
    );
    await governanceEmergency.waitForDeployment();
    const governanceEmergencyAddress = await governanceEmergency.getAddress();
    console.log(`   ✅ GovernanceEmergency deployed at: ${governanceEmergencyAddress}`);

    // ─── Grant PAUSER_ROLE on BridgeLock to GovernanceEmergency ─────────────
    console.log("4️⃣  Granting PAUSER_ROLE to GovernanceEmergency on BridgeLock...");
    const PAUSER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("PAUSER_ROLE"));
    const grantTx = await bridgeLock.grantRole(PAUSER_ROLE, governanceEmergencyAddress);
    await grantTx.wait();
    console.log("   ✅ PAUSER_ROLE granted to GovernanceEmergency");

    // ─── Save addresses ──────────────────────────────────────────────────────
    const addresses = {
        network: "chainA",
        chainId: 1111,
        deployedAt: new Date().toISOString(),
        deployer: deployer.address,
        contracts: {
            VaultToken: vaultTokenAddress,
            BridgeLock: bridgeLockAddress,
            GovernanceEmergency: governanceEmergencyAddress,
        },
    };

    const addressesPath = path.join(__dirname, "addresses-chainA.json");
    fs.writeFileSync(addressesPath, JSON.stringify(addresses, null, 2));
    console.log(`\n📁 Addresses saved to: ${addressesPath}`);

    // ─── Summary ─────────────────────────────────────────────────────────────
    console.log("\n" + "═".repeat(60));
    console.log("  Chain A Deployment Summary");
    console.log("═".repeat(60));
    console.log(`  VaultToken:          ${vaultTokenAddress}`);
    console.log(`  BridgeLock:          ${bridgeLockAddress}`);
    console.log(`  GovernanceEmergency: ${governanceEmergencyAddress}`);
    console.log("═".repeat(60) + "\n");

    return addresses;
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Deployment failed:", error);
        process.exit(1);
    });
