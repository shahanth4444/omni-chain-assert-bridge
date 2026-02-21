#!/bin/bash
# scripts/start-local.sh
# Quick-start script for local development without Docker.
# Starts both Anvil nodes, deploys contracts, and starts the relayer.

set -e

echo "🌉 Starting Omnichain Bridge — Local Development Mode"
echo "======================================================="

# ── Prerequisites check ───────────────────────────────────────────────────────
command -v anvil >/dev/null 2>&1 || { echo "❌ anvil not found. Install Foundry: https://getfoundry.sh"; exit 1; }
command -v node >/dev/null 2>&1  || { echo "❌ node not found. Install Node.js 18+"; exit 1; }

# ── Create data directory ─────────────────────────────────────────────────────
mkdir -p relayer_data

# ── Start Chain A ──────────────────────────────────────────────────────────────
echo ""
echo "1️⃣  Starting Chain A (Settlement, chainId=1111, port=8545)..."
anvil \
  --chain-id 1111 \
  --port 8545 \
  --block-time 2 \
  --mnemonic "test test test test test test test test test test test junk" \
  > ./relayer_data/chain-a.log 2>&1 &
CHAIN_A_PID=$!
echo "   PID: $CHAIN_A_PID"

sleep 2

# ── Start Chain B ──────────────────────────────────────────────────────────────
echo "2️⃣  Starting Chain B (Execution, chainId=2222, port=9545)..."
anvil \
  --chain-id 2222 \
  --port 9545 \
  --block-time 2 \
  --mnemonic "test test test test test test test test test test test junk" \
  > ./relayer_data/chain-b.log 2>&1 &
CHAIN_B_PID=$!
echo "   PID: $CHAIN_B_PID"

sleep 3

# ── Install dependencies ───────────────────────────────────────────────────────
echo "3️⃣  Installing dependencies..."
npm install --quiet
cd relayer && npm install --quiet && cd ..

# ── Compile contracts ──────────────────────────────────────────────────────────
echo "4️⃣  Compiling contracts..."
npx hardhat compile --quiet

# ── Deploy contracts ───────────────────────────────────────────────────────────
echo "5️⃣  Deploying contracts to both chains..."
node scripts/deploy.js

# ── Copy addresses for relayer ─────────────────────────────────────────────────
cp scripts/deployed-addresses.json relayer/data/deployed-addresses.json

# ── Start relayer ──────────────────────────────────────────────────────────────
echo "6️⃣  Starting relayer..."
cd relayer
DB_PATH=../relayer_data/bridge.db \
  CHAIN_A_RPC_URL=http://127.0.0.1:8545 \
  CHAIN_B_RPC_URL=http://127.0.0.1:9545 \
  CONFIRMATION_DEPTH=3 \
  node src/index.js &
RELAYER_PID=$!
cd ..

echo ""
echo "✅ All services running!"
echo "   Chain A: http://127.0.0.1:8545 (PID $CHAIN_A_PID)"
echo "   Chain B: http://127.0.0.1:9545 (PID $CHAIN_B_PID)"
echo "   Relayer: PID $RELAYER_PID"
echo ""
echo "Press Ctrl+C to stop all services."

# ── Cleanup on exit ────────────────────────────────────────────────────────────
cleanup() {
  echo ""
  echo "🛑 Stopping all services..."
  kill $CHAIN_A_PID $CHAIN_B_PID $RELAYER_PID 2>/dev/null || true
  echo "Done."
}
trap cleanup EXIT INT TERM
wait
