// relayer/src/logger.js
// Winston logger with structured JSON output and console formatting

const { createLogger, format, transports } = require("winston");
const { combine, timestamp, printf, colorize, errors } = format;

const logLevel = process.env.LOG_LEVEL || "info";

const consoleFormat = printf(({ level, message, timestamp, stack, ...meta }) => {
    let log = `${timestamp} [${level.toUpperCase()}] ${message}`;
    if (Object.keys(meta).length > 0) {
        log += ` ${JSON.stringify(meta)}`;
    }
    if (stack) {
        log += `\n${stack}`;
    }
    return log;
});

const logger = createLogger({
    level: logLevel,
    format: combine(errors({ stack: true }), timestamp()),
    transports: [
        // Console transport with colors
        new transports.Console({
            format: combine(colorize(), timestamp({ format: "HH:mm:ss" }), consoleFormat),
        }),
        // File transport for structured logs
        new transports.File({
            filename: process.env.LOG_FILE || "./data/relayer.log",
            format: combine(timestamp(), format.json()),
            maxsize: 10 * 1024 * 1024, // 10MB
            maxFiles: 5,
        }),
    ],
});

module.exports = logger;
