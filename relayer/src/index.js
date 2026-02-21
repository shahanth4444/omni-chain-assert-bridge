// relayer/src/index.js
// Entry point for the relayer service.
// Handles top-level error catching and process lifecycle.

require("dotenv").config();
const logger = require("./logger");
const { start } = require("./relayer");

process.on("uncaughtException", (err) => {
    logger.error("Uncaught exception", { error: err.message, stack: err.stack });
    process.exit(1);
});

process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled promise rejection", {
        reason: reason instanceof Error ? reason.message : reason,
    });
    process.exit(1);
});

start().catch((err) => {
    logger.error("Fatal relayer error", { error: err.message, stack: err.stack });
    process.exit(1);
});
