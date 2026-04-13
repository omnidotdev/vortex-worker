/**
 * Built-in DateTime Plugin
 *
 * Date and time parsing, formatting, and calculations.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/** Format date input */
interface FormatInput {
  /** Date to format (ISO string, timestamp, or "now") */
  date: string | number;
  /** Output format pattern */
  format?: string;
  /** Timezone (e.g., "America/New_York", "UTC") */
  timezone?: string;
  /** Locale for formatting (e.g., "en-US", "de-DE") */
  locale?: string;
}

/** Parse date input */
interface ParseInput {
  /** Date string to parse */
  input: string;
  /** Expected format pattern */
  format?: string;
  /** Timezone to interpret input in */
  timezone?: string;
}

/** Add/subtract time input */
interface AddInput {
  /** Starting date (ISO string, timestamp, or "now") */
  date: string | number;
  /** Amount to add (negative to subtract) */
  amount: number;
  /** Unit of time */
  unit:
    | "milliseconds"
    | "seconds"
    | "minutes"
    | "hours"
    | "days"
    | "weeks"
    | "months"
    | "years";
}

/** Difference between dates input */
interface DiffInput {
  /** Start date */
  start: string | number;
  /** End date */
  end: string | number;
  /** Unit for result */
  unit?:
    | "milliseconds"
    | "seconds"
    | "minutes"
    | "hours"
    | "days"
    | "weeks"
    | "months"
    | "years";
}

/** Compare dates input */
interface CompareInput {
  /** First date */
  date1: string | number;
  /** Second date */
  date2: string | number;
}

/** Start/end of period input */
interface BoundaryInput {
  /** Date to get boundary of */
  date: string | number;
  /** Period type */
  period: "day" | "week" | "month" | "quarter" | "year";
  /** Start or end of period */
  boundary: "start" | "end";
  /** Timezone */
  timezone?: string;
}

/** Relative time input */
interface RelativeInput {
  /** Date to describe */
  date: string | number;
  /** Reference date (default: now) */
  relativeTo?: string | number;
  /** Locale */
  locale?: string;
}

/** Business days input */
interface BusinessDaysInput {
  /** Starting date */
  date: string | number;
  /** Number of business days to add */
  days: number;
  /** Weekend days (0=Sunday, 6=Saturday) */
  weekendDays?: number[];
  /** Holiday dates to skip */
  holidays?: string[];
}

/**
 * Parse a date from various input formats.
 */
const parseDate = (input: string | number): Date => {
  if (typeof input === "number") {
    return new Date(input);
  }
  if (input === "now") {
    return new Date();
  }
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date: ${input}`);
  }
  return date;
};

/**
 * Format date using Intl.DateTimeFormat or custom patterns.
 */
const formatDate = (
  date: Date,
  format?: string,
  locale = "en-US",
  timezone?: string,
): string => {
  const options: Intl.DateTimeFormatOptions = {};
  if (timezone) {
    options.timeZone = timezone;
  }

  // Custom format patterns
  if (format) {
    // Simple pattern replacements
    const patterns: Record<string, Intl.DateTimeFormatOptions> = {
      "YYYY-MM-DD": { year: "numeric", month: "2-digit", day: "2-digit" },
      "YYYY/MM/DD": { year: "numeric", month: "2-digit", day: "2-digit" },
      "DD/MM/YYYY": { year: "numeric", month: "2-digit", day: "2-digit" },
      "MM/DD/YYYY": { year: "numeric", month: "2-digit", day: "2-digit" },
      iso: {},
      timestamp: {},
    };

    if (format === "iso") {
      return date.toISOString();
    }
    if (format === "timestamp") {
      return String(date.getTime());
    }

    const patternOptions = patterns[format];
    if (patternOptions) {
      const formatted = new Intl.DateTimeFormat(locale, {
        ...options,
        ...patternOptions,
      }).format(date);
      return formatted;
    }

    // Manual pattern replacement
    let result = format;
    const parts = new Intl.DateTimeFormat("en-US", {
      ...options,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(date);

    const partMap: Record<string, string> = {};
    for (const part of parts) {
      partMap[part.type] = part.value;
    }

    result = result.replace(/YYYY/g, partMap.year || "");
    result = result.replace(/YY/g, (partMap.year || "").slice(-2));
    result = result.replace(/MM/g, partMap.month || "");
    result = result.replace(/DD/g, partMap.day || "");
    result = result.replace(/HH/g, partMap.hour || "");
    result = result.replace(/mm/g, partMap.minute || "");
    result = result.replace(/ss/g, partMap.second || "");

    return result;
  }

  return date.toISOString();
};

/**
 * Format a date with locale and timezone.
 */
const format = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as FormatInput;
    const date = parseDate(input.date);
    const formatted = formatDate(
      date,
      input.format,
      input.locale,
      input.timezone,
    );

    return {
      success: true,
      output: {
        formatted,
        iso: date.toISOString(),
        timestamp: date.getTime(),
      },
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
 * Parse a date string.
 */
const parse = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as ParseInput;
    const date = parseDate(input.input);

    return {
      success: true,
      output: {
        iso: date.toISOString(),
        timestamp: date.getTime(),
        year: date.getFullYear(),
        month: date.getMonth() + 1,
        day: date.getDate(),
        hour: date.getHours(),
        minute: date.getMinutes(),
        second: date.getSeconds(),
        dayOfWeek: date.getDay(),
        valid: true,
      },
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: true,
      output: {
        valid: false,
        error: error instanceof Error ? error.message : String(error),
      },
      durationMs: performance.now() - startTime,
    };
  }
};

/**
 * Add or subtract time from a date.
 */
const add = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as AddInput;
    const date = parseDate(input.date);

    const multipliers: Record<string, number> = {
      milliseconds: 1,
      seconds: 1000,
      minutes: 60 * 1000,
      hours: 60 * 60 * 1000,
      days: 24 * 60 * 60 * 1000,
      weeks: 7 * 24 * 60 * 60 * 1000,
    };

    if (input.unit === "months") {
      date.setMonth(date.getMonth() + input.amount);
    } else if (input.unit === "years") {
      date.setFullYear(date.getFullYear() + input.amount);
    } else {
      const ms = multipliers[input.unit] ?? 0;
      date.setTime(date.getTime() + input.amount * ms);
    }

    return {
      success: true,
      output: {
        iso: date.toISOString(),
        timestamp: date.getTime(),
      },
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
 * Get difference between two dates.
 */
const diff = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as DiffInput;
    const start = parseDate(input.start);
    const end = parseDate(input.end);

    const diffMs = end.getTime() - start.getTime();

    const divisors: Record<string, number> = {
      milliseconds: 1,
      seconds: 1000,
      minutes: 60 * 1000,
      hours: 60 * 60 * 1000,
      days: 24 * 60 * 60 * 1000,
      weeks: 7 * 24 * 60 * 60 * 1000,
    };

    let value = diffMs;
    const unit = input.unit ?? "milliseconds";

    if (unit === "months") {
      value =
        (end.getFullYear() - start.getFullYear()) * 12 +
        (end.getMonth() - start.getMonth());
    } else if (unit === "years") {
      value = end.getFullYear() - start.getFullYear();
    } else {
      value = diffMs / (divisors[unit] ?? 1);
    }

    return {
      success: true,
      output: {
        value,
        unit,
        milliseconds: diffMs,
      },
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
 * Compare two dates.
 */
const compare = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as CompareInput;
    const date1 = parseDate(input.date1);
    const date2 = parseDate(input.date2);

    const t1 = date1.getTime();
    const t2 = date2.getTime();

    return {
      success: true,
      output: {
        isBefore: t1 < t2,
        isAfter: t1 > t2,
        isEqual: t1 === t2,
        comparison: t1 < t2 ? -1 : t1 > t2 ? 1 : 0,
      },
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
 * Get start or end of a time period.
 */
const boundary = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as BoundaryInput;
    const date = parseDate(input.date);
    const result = new Date(date);

    if (input.boundary === "start") {
      switch (input.period) {
        case "day":
          result.setHours(0, 0, 0, 0);
          break;
        case "week":
          result.setDate(result.getDate() - result.getDay());
          result.setHours(0, 0, 0, 0);
          break;
        case "month":
          result.setDate(1);
          result.setHours(0, 0, 0, 0);
          break;
        case "quarter":
          result.setMonth(Math.floor(result.getMonth() / 3) * 3, 1);
          result.setHours(0, 0, 0, 0);
          break;
        case "year":
          result.setMonth(0, 1);
          result.setHours(0, 0, 0, 0);
          break;
      }
    } else {
      switch (input.period) {
        case "day":
          result.setHours(23, 59, 59, 999);
          break;
        case "week":
          result.setDate(result.getDate() + (6 - result.getDay()));
          result.setHours(23, 59, 59, 999);
          break;
        case "month":
          result.setMonth(result.getMonth() + 1, 0);
          result.setHours(23, 59, 59, 999);
          break;
        case "quarter":
          result.setMonth(Math.floor(result.getMonth() / 3) * 3 + 3, 0);
          result.setHours(23, 59, 59, 999);
          break;
        case "year":
          result.setMonth(11, 31);
          result.setHours(23, 59, 59, 999);
          break;
      }
    }

    return {
      success: true,
      output: {
        iso: result.toISOString(),
        timestamp: result.getTime(),
      },
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
 * Get relative time description.
 */
const relative = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as RelativeInput;
    const date = parseDate(input.date);
    const now = input.relativeTo ? parseDate(input.relativeTo) : new Date();
    const locale = input.locale ?? "en-US";

    const diffMs = date.getTime() - now.getTime();
    const absDiffMs = Math.abs(diffMs);

    // Find appropriate unit
    const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
      ["second", 1000],
      ["minute", 60 * 1000],
      ["hour", 60 * 60 * 1000],
      ["day", 24 * 60 * 60 * 1000],
      ["week", 7 * 24 * 60 * 60 * 1000],
      ["month", 30 * 24 * 60 * 60 * 1000],
      ["year", 365 * 24 * 60 * 60 * 1000],
    ];

    let unit: Intl.RelativeTimeFormatUnit = "second";
    let value = Math.round(diffMs / 1000);

    for (let i = units.length - 1; i >= 0; i--) {
      const [u, ms] = units[i];
      if (absDiffMs >= ms) {
        unit = u;
        value = Math.round(diffMs / ms);
        break;
      }
    }

    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    const relative = rtf.format(value, unit);

    return {
      success: true,
      output: {
        relative,
        isPast: diffMs < 0,
        isFuture: diffMs > 0,
        value,
        unit,
      },
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
 * Add business days to a date.
 */
const businessDays = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as BusinessDaysInput;
    const date = parseDate(input.date);
    const weekendDays = new Set(input.weekendDays ?? [0, 6]);
    const holidays = new Set(
      input.holidays?.map((h) => new Date(h).toDateString()) ?? [],
    );

    let remaining = Math.abs(input.days);
    const direction = input.days >= 0 ? 1 : -1;

    while (remaining > 0) {
      date.setDate(date.getDate() + direction);
      const dayOfWeek = date.getDay();
      const dateStr = date.toDateString();

      if (!weekendDays.has(dayOfWeek) && !holidays.has(dateStr)) {
        remaining--;
      }
    }

    return {
      success: true,
      output: {
        iso: date.toISOString(),
        timestamp: date.getTime(),
      },
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
 * Get current time in various formats.
 */
const now = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as { timezone?: string; format?: string };
    const date = new Date();

    return {
      success: true,
      output: {
        iso: date.toISOString(),
        timestamp: date.getTime(),
        formatted: formatDate(date, input.format, "en-US", input.timezone),
        year: date.getFullYear(),
        month: date.getMonth() + 1,
        day: date.getDate(),
        hour: date.getHours(),
        minute: date.getMinutes(),
        second: date.getSeconds(),
        dayOfWeek: date.getDay(),
      },
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
 * DateTime built-in plugin definition.
 */
export const dateTimePlugin: BuiltinPlugin = {
  id: "builtin:dateTime",
  name: "DateTime",
  description: "Date and time parsing, formatting, and calculations",
  actions: {
    format: {
      name: "format",
      description: "Format a date with locale and timezone",
      handler: format,
    },
    parse: {
      name: "parse",
      description: "Parse a date string",
      handler: parse,
    },
    add: {
      name: "add",
      description: "Add or subtract time from a date",
      handler: add,
    },
    diff: {
      name: "diff",
      description: "Get difference between two dates",
      handler: diff,
    },
    compare: {
      name: "compare",
      description: "Compare two dates",
      handler: compare,
    },
    boundary: {
      name: "boundary",
      description: "Get start or end of a time period",
      handler: boundary,
    },
    relative: {
      name: "relative",
      description: "Get relative time description (e.g., '2 days ago')",
      handler: relative,
    },
    businessDays: {
      name: "businessDays",
      description: "Add business days to a date",
      handler: businessDays,
    },
    now: {
      name: "now",
      description: "Get current time in various formats",
      handler: now,
    },
  },
};
