/**
 * Typed error hierarchy for structured error handling
 */

export type ErrorCode =
  | "NOT_FOUND"
  | "VALIDATION_FAILED"
  | "EXECUTION_FAILED"
  | "INTEGRATION_ERROR"
  | "PLUGIN_ERROR"
  | "CONFIG_ERROR"
  | "TIMEOUT"
  | "CANCELLED"
  | "MCP_ERROR";

export class VortexError extends Error {
  readonly code: ErrorCode;
  readonly meta: Record<string, unknown>;

  constructor(
    message: string,
    code: ErrorCode,
    meta: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "VortexError";
    this.code = code;
    this.meta = meta;
  }
}

export class NotFoundError extends VortexError {
  constructor(message: string, meta: Record<string, unknown> = {}) {
    super(message, "NOT_FOUND", meta);
    this.name = "NotFoundError";
  }
}

export class ValidationError extends VortexError {
  constructor(message: string, meta: Record<string, unknown> = {}) {
    super(message, "VALIDATION_FAILED", meta);
    this.name = "ValidationError";
  }
}

export class ExecutionError extends VortexError {
  constructor(message: string, meta: Record<string, unknown> = {}) {
    super(message, "EXECUTION_FAILED", meta);
    this.name = "ExecutionError";
  }
}

export class IntegrationError extends VortexError {
  constructor(message: string, meta: Record<string, unknown> = {}) {
    super(message, "INTEGRATION_ERROR", meta);
    this.name = "IntegrationError";
  }
}

export class PluginError extends VortexError {
  constructor(message: string, meta: Record<string, unknown> = {}) {
    super(message, "PLUGIN_ERROR", meta);
    this.name = "PluginError";
  }
}

export class ConfigError extends VortexError {
  constructor(message: string, meta: Record<string, unknown> = {}) {
    super(message, "CONFIG_ERROR", meta);
    this.name = "ConfigError";
  }
}

export class TimeoutError extends VortexError {
  constructor(message: string, meta: Record<string, unknown> = {}) {
    super(message, "TIMEOUT", meta);
    this.name = "TimeoutError";
  }
}

export class CancelledError extends VortexError {
  constructor(message: string, meta: Record<string, unknown> = {}) {
    super(message, "CANCELLED", meta);
    this.name = "CancelledError";
  }
}

export class MCPError extends VortexError {
  constructor(message: string, meta: Record<string, unknown> = {}) {
    super(message, "MCP_ERROR", meta);
    this.name = "MCPError";
  }
}
