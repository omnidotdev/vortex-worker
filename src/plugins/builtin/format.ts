/**
 * Built-in Format Plugin
 *
 * Format values for display using Intl formatters.
 * Supports dates, numbers, currency, percentages, and bytes.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/** Supported format types */
type FormatType = "date" | "number" | "currency" | "percentage" | "bytes";

/** Format data input */
interface FormatDataInput {
  /** Value to format */
  input: unknown;
  /** Format type */
  type: FormatType;
  /** Format options */
  options?: FormatOptions;
}

/** Format options */
interface FormatOptions {
  /** Locale for formatting (default: "en-US") */
  locale?: string;
  /** Date format pattern or style */
  pattern?: "short" | "medium" | "long" | "full";
  /** Currency code (e.g., "USD", "EUR") */
  currency?: string;
  /** Number of decimal places */
  decimals?: number;
  /** Timezone for dates */
  timezone?: string;
  /** Whether to use binary units for bytes (1024 vs 1000) */
  binary?: boolean;
}

/** Byte unit thresholds */
const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];
const BYTE_UNITS_BINARY = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];

/**
 * Format a byte value to human-readable string.
 */
const formatBytes = (
  bytes: number,
  decimals = 2,
  binary = false,
): string => {
  if (bytes === 0) return "0 B";

  const base = binary ? 1024 : 1000;
  const units = binary ? BYTE_UNITS_BINARY : BYTE_UNITS;
  const exponent = Math.min(
    Math.floor(Math.log(Math.abs(bytes)) / Math.log(base)),
    units.length - 1,
  );
  const value = bytes / base ** exponent;

  return `${value.toFixed(decimals)} ${units[exponent]}`;
};

/**
 * Format a date value.
 */
const formatDate = (
  input: unknown,
  options: FormatOptions = {},
): string => {
  const { locale = "en-US", pattern = "medium", timezone } = options;

  let date: Date;
  if (input instanceof Date) {
    date = input;
  } else if (typeof input === "number") {
    date = new Date(input);
  } else if (typeof input === "string") {
    date = new Date(input);
  } else {
    throw new Error("Invalid date input");
  }

  if (Number.isNaN(date.getTime())) {
    throw new Error("Invalid date value");
  }

  const formatOptions: Intl.DateTimeFormatOptions = {
    timeZone: timezone,
  };

  switch (pattern) {
    case "short":
      formatOptions.dateStyle = "short";
      break;
    case "medium":
      formatOptions.dateStyle = "medium";
      break;
    case "long":
      formatOptions.dateStyle = "long";
      break;
    case "full":
      formatOptions.dateStyle = "full";
      break;
  }

  return new Intl.DateTimeFormat(locale, formatOptions).format(date);
};

/**
 * Format a number value.
 */
const formatNumber = (
  input: unknown,
  options: FormatOptions = {},
): string => {
  const { locale = "en-US", decimals } = options;

  const num = Number(input);
  if (Number.isNaN(num)) {
    throw new Error("Invalid number input");
  }

  const formatOptions: Intl.NumberFormatOptions = {};
  if (decimals !== undefined) {
    formatOptions.minimumFractionDigits = decimals;
    formatOptions.maximumFractionDigits = decimals;
  }

  return new Intl.NumberFormat(locale, formatOptions).format(num);
};

/**
 * Format a currency value.
 */
const formatCurrency = (
  input: unknown,
  options: FormatOptions = {},
): string => {
  const { locale = "en-US", currency = "USD", decimals } = options;

  const num = Number(input);
  if (Number.isNaN(num)) {
    throw new Error("Invalid number input");
  }

  const formatOptions: Intl.NumberFormatOptions = {
    style: "currency",
    currency,
  };
  if (decimals !== undefined) {
    formatOptions.minimumFractionDigits = decimals;
    formatOptions.maximumFractionDigits = decimals;
  }

  return new Intl.NumberFormat(locale, formatOptions).format(num);
};

/**
 * Format a percentage value.
 */
const formatPercentage = (
  input: unknown,
  options: FormatOptions = {},
): string => {
  const { locale = "en-US", decimals = 0 } = options;

  const num = Number(input);
  if (Number.isNaN(num)) {
    throw new Error("Invalid number input");
  }

  const formatOptions: Intl.NumberFormatOptions = {
    style: "percent",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  };

  return new Intl.NumberFormat(locale, formatOptions).format(num);
};

/**
 * Format data for display.
 */
const formatData = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const { input, type, options = {} } = inputs as unknown as FormatDataInput;

    if (input === undefined || input === null) {
      return {
        success: false,
        error: "Input value is required",
        durationMs: performance.now() - startTime,
      };
    }

    if (!type) {
      return {
        success: false,
        error: "Format type is required",
        durationMs: performance.now() - startTime,
      };
    }

    let result: string;

    switch (type) {
      case "date": {
        result = formatDate(input, options);
        break;
      }

      case "number": {
        result = formatNumber(input, options);
        break;
      }

      case "currency": {
        result = formatCurrency(input, options);
        break;
      }

      case "percentage": {
        result = formatPercentage(input, options);
        break;
      }

      case "bytes": {
        const num = Number(input);
        if (Number.isNaN(num)) {
          return {
            success: false,
            error: "Invalid bytes input",
            durationMs: performance.now() - startTime,
          };
        }
        result = formatBytes(num, options.decimals ?? 2, options.binary ?? false);
        break;
      }

      default: {
        return {
          success: false,
          error: `Unsupported format type: ${type}`,
          durationMs: performance.now() - startTime,
        };
      }
    }

    return {
      success: true,
      output: { result, type, input },
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

/**
 * Format built-in plugin definition.
 */
export const formatPlugin: BuiltinPlugin = {
  id: "builtin:format",
  name: "Format",
  description: "Format values for display (dates, numbers, currency, bytes)",
  actions: {
    data: {
      name: "data",
      description: "Format a value for display",
      handler: formatData,
    },
  },
};
