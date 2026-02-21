// relayer/src/db.js
// SQLite database layer for relayer state persistence.
// Prevents replay attacks and enables crash recovery.
//
// Tables:
//   processed_events  - stores every processed event nonce
//   last_blocks       - stores last seen block per chain (for recovery)

const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const logger = require("./logger");

const DB_PATH = process.env.DB_PATH || "./data/bridge.db";

let db;

/**
 * Initialize the SQLite database and create tables if they don't exist.
 */
function initDB() {
    const dbDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
        logger.info(`Created data directory: ${dbDir}`);
    }

    db = new Database(DB_PATH);

    // Enable WAL mode for better crash safety and concurrent reads
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");

    // Create processed_events table
    db.exec(`
    CREATE TABLE IF NOT EXISTS processed_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type  TEXT NOT NULL,
      nonce       INTEGER NOT NULL,
      chain       TEXT NOT NULL,
      tx_hash     TEXT,
      block_number INTEGER,
      user_addr   TEXT,
      amount      TEXT,
      processed_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(event_type, nonce, chain)
    );
  `);

    // Create last_blocks table for crash recovery
    db.exec(`
    CREATE TABLE IF NOT EXISTS last_blocks (
      chain       TEXT PRIMARY KEY,
      block_number INTEGER NOT NULL,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

    // Initialize last_blocks if empty
    const initBlock = db.prepare(
        "INSERT OR IGNORE INTO last_blocks (chain, block_number) VALUES (?, 0)"
    );
    initBlock.run("chainA");
    initBlock.run("chainB");

    logger.info(`SQLite database initialized at: ${DB_PATH}`);
    return db;
}

// ─── Processed Events ─────────────────────────────────────────────────────────

/**
 * Check if an event has already been processed.
 * @param {string} eventType - 'LOCK', 'BURN', or 'PROPOSAL'
 * @param {number|string} nonce - the event nonce
 * @param {string} chain - 'chainA' or 'chainB'
 * @returns {boolean}
 */
function isProcessed(eventType, nonce, chain) {
    const stmt = db.prepare(
        "SELECT id FROM processed_events WHERE event_type = ? AND nonce = ? AND chain = ?"
    );
    const row = stmt.get(eventType, nonce.toString(), chain);
    return !!row;
}

/**
 * Mark an event as processed (atomic insert).
 * Uses SQLite's atomic transaction for crash safety.
 * @param {string} eventType
 * @param {number|string} nonce
 * @param {string} chain
 * @param {object} meta - { txHash, blockNumber, userAddr, amount }
 */
function markProcessed(eventType, nonce, chain, meta = {}) {
    const stmt = db.prepare(`
    INSERT OR IGNORE INTO processed_events
      (event_type, nonce, chain, tx_hash, block_number, user_addr, amount)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
    stmt.run(
        eventType,
        nonce.toString(),
        chain,
        meta.txHash || null,
        meta.blockNumber || null,
        meta.userAddr || null,
        meta.amount ? meta.amount.toString() : null
    );
    logger.debug(`Marked processed: ${eventType} nonce=${nonce} chain=${chain}`);
}

// ─── Last Block Tracking ──────────────────────────────────────────────────────

/**
 * Get the last processed block number for a chain.
 * @param {string} chain - 'chainA' or 'chainB'
 * @returns {number}
 */
function getLastBlock(chain) {
    const stmt = db.prepare("SELECT block_number FROM last_blocks WHERE chain = ?");
    const row = stmt.get(chain);
    return row ? row.block_number : 0;
}

/**
 * Update the last processed block number for a chain.
 * @param {string} chain - 'chainA' or 'chainB'
 * @param {number} blockNumber
 */
function setLastBlock(chain, blockNumber) {
    const stmt = db.prepare(`
    INSERT OR REPLACE INTO last_blocks (chain, block_number, updated_at)
    VALUES (?, ?, datetime('now'))
  `);
    stmt.run(chain, blockNumber);
}

/**
 * Get all processed events (for debugging / testing).
 */
function getAllProcessed() {
    return db.prepare("SELECT * FROM processed_events ORDER BY id DESC").all();
}

/**
 * Get all processed nonces for a specific event type.
 */
function getProcessedNonces(eventType, chain) {
    return db
        .prepare("SELECT nonce FROM processed_events WHERE event_type = ? AND chain = ?")
        .all(eventType, chain)
        .map((r) => r.nonce);
}

/**
 * Close the database connection.
 */
function closeDB() {
    if (db) {
        db.close();
        logger.info("SQLite database closed");
    }
}

module.exports = {
    initDB,
    isProcessed,
    markProcessed,
    getLastBlock,
    setLastBlock,
    getAllProcessed,
    getProcessedNonces,
    closeDB,
};
