require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const DEPLOYER_PRIVATE_KEY =
  process.env.DEPLOYER_PRIVATE_KEY ||
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    // Chain A - Settlement Chain
    chainA: {
      url: process.env.CHAIN_A_RPC_URL || "http://127.0.0.1:8545",
      chainId: 1111,
      accounts: [DEPLOYER_PRIVATE_KEY],
    },
    // Chain B - Execution Chain
    chainB: {
      url: process.env.CHAIN_B_RPC_URL || "http://127.0.0.1:9545",
      chainId: 2222,
      accounts: [DEPLOYER_PRIVATE_KEY],
    },
    // Default hardhat in-process network for unit tests
    hardhat: {
      chainId: 31337,
    },
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
  },
  paths: {
    sources: "./contracts",
    tests: "./tests",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  mocha: {
    timeout: 120000,
  },
};
