// scripts/deploy.js
// Master deployment script that deploys to both chains sequentially.
// Used by Docker deployer service.
// Run: node scripts/deploy.js (requires both chains running)

require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

// ABI fragments — compiled artifacts
const ARTIFACTS_DIR = path.join(__dirname, "..", "artifacts", "contracts");

function loadArtifact(contractName) {
    const artifactPath = path.join(
        ARTIFACTS_DIR,
        `${contractName}.sol`,
        `${contractName}.json`
    );
    if (!fs.existsSync(artifactPath)) {
        throw new Error(`Artifact not found: ${artifactPath}. Run 'npx hardhat compile' first.`);
    }
    return JSON.parse(fs.readFileSync(artifactPath, "utf8"));
}

async function deployContract(factory, ...args) {
    const contract = await factory.deploy(...args);
    await contract.waitForDeployment();
    return contract;
}

async function deployChainA(provider, deployer) {
    console.log("\n🔗 Chain A Deployment (Settlement)");
    console.log("─".repeat(50));

    const VaultTokenArtifact = loadArtifact("VaultToken");
    const BridgeLockArtifact = loadArtifact("BridgeLock");
    const GovernanceEmergencyArtifact = loadArtifact("GovernanceEmergency");

    const VaultTokenFactory = new ethers.ContractFactory(
        VaultTokenArtifact.abi,
        VaultTokenArtifact.bytecode,
        deployer
    );
    const BridgeLockFactory = new ethers.ContractFactory(
        BridgeLockArtifact.abi,
        BridgeLockArtifact.bytecode,
        deployer
    );
    const GovernanceEmergencyFactory = new ethers.ContractFactory(
        GovernanceEmergencyArtifact.abi,
        GovernanceEmergencyArtifact.bytecode,
        deployer
    );

    console.log("  Deploying VaultToken...");
    const vaultToken = await deployContract(VaultTokenFactory, deployer.address);
    const vaultTokenAddress = await vaultToken.getAddress();
    console.log(`  ✅ VaultToken: ${vaultTokenAddress}`);

    console.log("  Deploying BridgeLock...");
    const bridgeLock = await deployContract(
        BridgeLockFactory,
        vaultTokenAddress,
        deployer.address,
        deployer.address
    );
    const bridgeLockAddress = await bridgeLock.getAddress();
    console.log(`  ✅ BridgeLock: ${bridgeLockAddress}`);

    console.log("  Deploying GovernanceEmergency...");
    const governanceEmergency = await deployContract(
        GovernanceEmergencyFactory,
        bridgeLockAddress,
        deployer.address,
        deployer.address
    );
    const governanceEmergencyAddress = await governanceEmergency.getAddress();
    console.log(`  ✅ GovernanceEmergency: ${governanceEmergencyAddress}`);

    // Grant PAUSER_ROLE to GovernanceEmergency
    const PAUSER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("PAUSER_ROLE"));
    await (await bridgeLock.grantRole(PAUSER_ROLE, governanceEmergencyAddress)).wait();
    console.log("  ✅ PAUSER_ROLE granted to GovernanceEmergency");

    return {
        VaultToken: vaultTokenAddress,
        BridgeLock: bridgeLockAddress,
        GovernanceEmergency: governanceEmergencyAddress,
    };
}

async function deployChainB(provider, deployer) {
    console.log("\n🔗 Chain B Deployment (Execution)");
    console.log("─".repeat(50));

    const WrappedVaultTokenArtifact = loadArtifact("WrappedVaultToken");
    const BridgeMintArtifact = loadArtifact("BridgeMint");
    const GovernanceVotingArtifact = loadArtifact("GovernanceVoting");

    const WrappedVaultTokenFactory = new ethers.ContractFactory(
        WrappedVaultTokenArtifact.abi,
        WrappedVaultTokenArtifact.bytecode,
        deployer
    );
    const BridgeMintFactory = new ethers.ContractFactory(
        BridgeMintArtifact.abi,
        BridgeMintArtifact.bytecode,
        deployer
    );
    const GovernanceVotingFactory = new ethers.ContractFactory(
        GovernanceVotingArtifact.abi,
        GovernanceVotingArtifact.bytecode,
        deployer
    );

    console.log("  Deploying WrappedVaultToken...");
    const wrappedVaultToken = await deployContract(WrappedVaultTokenFactory, deployer.address);
    const wrappedVaultTokenAddress = await wrappedVaultToken.getAddress();
    console.log(`  ✅ WrappedVaultToken: ${wrappedVaultTokenAddress}`);

    console.log("  Deploying BridgeMint...");
    const bridgeMint = await deployContract(
        BridgeMintFactory,
        wrappedVaultTokenAddress,
        deployer.address,
        deployer.address
    );
    const bridgeMintAddress = await bridgeMint.getAddress();
    console.log(`  ✅ BridgeMint: ${bridgeMintAddress}`);

    console.log("  Deploying GovernanceVoting...");
    const VOTING_PERIOD_BLOCKS = 10;
    const QUORUM_THRESHOLD = ethers.parseEther("1");
    const governanceVoting = await deployContract(
        GovernanceVotingFactory,
        wrappedVaultTokenAddress,
        deployer.address,
        VOTING_PERIOD_BLOCKS,
        QUORUM_THRESHOLD
    );
    const governanceVotingAddress = await governanceVoting.getAddress();
    console.log(`  ✅ GovernanceVoting: ${governanceVotingAddress}`);

    // Grant MINTER_ROLE to BridgeMint
    const MINTER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("MINTER_ROLE"));
    await (await wrappedVaultToken.grantRole(MINTER_ROLE, bridgeMintAddress)).wait();
    console.log("  ✅ MINTER_ROLE granted to BridgeMint");

    return {
        WrappedVaultToken: wrappedVaultTokenAddress,
        BridgeMint: bridgeMintAddress,
        GovernanceVoting: governanceVotingAddress,
    };
}

async function main() {
    const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;
    const CHAIN_A_RPC = process.env.CHAIN_A_RPC_URL || "http://127.0.0.1:8545";
    const CHAIN_B_RPC = process.env.CHAIN_B_RPC_URL || "http://127.0.0.1:9545";

    if (!PRIVATE_KEY) {
        throw new Error("DEPLOYER_PRIVATE_KEY not set in environment");
    }

    console.log("🌉 Omnichain Bridge — Master Deployment Script");
    console.log("=".repeat(60));
    console.log(`  Chain A: ${CHAIN_A_RPC}`);
    console.log(`  Chain B: ${CHAIN_B_RPC}`);

    const providerA = new ethers.JsonRpcProvider(CHAIN_A_RPC);
    const providerB = new ethers.JsonRpcProvider(CHAIN_B_RPC);
    const deployerA = new ethers.Wallet(PRIVATE_KEY, providerA);
    const deployerB = new ethers.Wallet(PRIVATE_KEY, providerB);

    const chainAAddresses = await deployChainA(providerA, deployerA);
    const chainBAddresses = await deployChainB(providerB, deployerB);

    // Save combined addresses
    const combined = {
        deployedAt: new Date().toISOString(),
        chainA: {
            chainId: 1111,
            rpc: CHAIN_A_RPC,
            contracts: chainAAddresses,
        },
        chainB: {
            chainId: 2222,
            rpc: CHAIN_B_RPC,
            contracts: chainBAddresses,
        },
    };

    // Primary output: ADDRESSES_OUTPUT_PATH (set to /app/data in Docker, shared volume)
    const primaryPath = process.env.ADDRESSES_OUTPUT_PATH
        || path.join(__dirname, "..", "relayer", "data", "deployed-addresses.json");
    const primaryDir = path.dirname(primaryPath);
    if (!fs.existsSync(primaryDir)) fs.mkdirSync(primaryDir, { recursive: true });
    fs.writeFileSync(primaryPath, JSON.stringify(combined, null, 2));
    console.log(`  ✅ Addresses written to: ${primaryPath}`);

    // Secondary output: scripts/ directory (for local non-Docker use)
    const localPath = path.join(__dirname, "deployed-addresses.json");
    fs.writeFileSync(localPath, JSON.stringify(combined, null, 2));

    console.log("\n" + "=".repeat(60));
    console.log("  Deployment Complete!");
    console.log("=".repeat(60));
    console.log(JSON.stringify(combined, null, 2));
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
