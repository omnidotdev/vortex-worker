import { LOG_LEVEL, isProdEnv } from "lib/config/env.config";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_VALUES: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

type LogMeta = Record<string, unknown>;

type Logger = {
  debug: (message: string, meta?: LogMeta) => void;
  info: (message: string, meta?: LogMeta) => void;
  warn: (message: string, meta?: LogMeta) => void;
  error: (message: string, meta?: LogMeta) => void;
  child: (defaultMeta: LogMeta) => Logger;
};

function isValidLevel(level: string): level is LogLevel {
  return level in LEVEL_VALUES;
}

const threshold = isValidLevel(LOG_LEVEL) ? LOG_LEVEL : "info";

function formatMessage(
  level: LogLevel,
  service: string,
  message: string,
  meta: LogMeta,
): string | object {
  const entry = {
    level,
    service,
    message,
    timestamp: new Date().toISOString(),
    ...meta,
  };

  if (isProdEnv) {
    return JSON.stringify(entry);
  }

  const metaKeys = Object.keys(meta);
  const metaStr = metaKeys.length > 0 ? ` ${JSON.stringify(meta)}` : "";

  return `[${entry.timestamp}] ${level.toUpperCase()} [${service}] ${message}${metaStr}`;
}

const LOG_FN: Record<LogLevel, "info" | "warn" | "error"> = {
  debug: "info",
  info: "info",
  warn: "warn",
  error: "error",
};

/**
 * Create a structured logger for a service.
 * @param service - Service name used in log entries.
 * @param defaultMeta - Default metadata merged into every log entry.
 */
function createLogger(service: string, defaultMeta: LogMeta = {}): Logger {
  function log(level: LogLevel, message: string, meta?: LogMeta): void {
    if (LEVEL_VALUES[level] < LEVEL_VALUES[threshold]) return;

    const merged = { ...defaultMeta, ...meta };
    const output = formatMessage(level, service, message, merged);

    // biome-ignore lint/suspicious/noConsole: logger implementation
    console[LOG_FN[level]](output);
  }

  return {
    debug: (message, meta) => log("debug", message, meta),
    info: (message, meta) => log("info", message, meta),
    warn: (message, meta) => log("warn", message, meta),
    error: (message, meta) => log("error", message, meta),
    child: (childMeta) =>
      createLogger(service, { ...defaultMeta, ...childMeta }),
  };
}

const logger = createLogger("vortex-worker");

export default logger;
