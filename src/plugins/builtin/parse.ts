/**
 * Built-in Parse Plugin
 *
 * Parse data from various formats into structured objects.
 * Supports JSON, querystring, CSV, and YAML.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/** Supported parse formats */
type ParseFormat = "json" | "xml" | "csv" | "yaml" | "querystring";

/** Parse data input */
interface ParseDataInput {
  /** Input string to parse */
  input: string;
  /** Format to parse from */
  format: ParseFormat;
  /** Format-specific options */
  options?: ParseOptions;
}

/** Format-specific parse options */
interface ParseOptions {
  /** CSV: delimiter character (default: ",") */
  delimiter?: string;
  /** CSV: whether first row contains headers (default: true) */
  headers?: boolean;
  /** CSV: quote character (default: '"') */
  quote?: string;
}

/**
 * Parse a CSV string into an array of objects or arrays.
 */
const parseCsv = (
  input: string,
  options: ParseOptions = {},
): Record<string, string>[] | string[][] => {
  const { delimiter = ",", headers = true, quote = '"' } = options;
  const lines: string[] = [];
  let current = "";
  let inQuotes = false;

  // Split into lines, handling quoted newlines.
  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (char === quote) {
      inQuotes = !inQuotes;
      current += char;
    } else if (char === "\n" && !inQuotes) {
      if (current.trim()) {
        lines.push(current);
      }
      current = "";
    } else if (char === "\r" && !inQuotes) {
      // Skip carriage returns.
      continue;
    } else {
      current += char;
    }
  }
  if (current.trim()) {
    lines.push(current);
  }

  // Parse each line into fields.
  const parseRow = (row: string): string[] => {
    const fields: string[] = [];
    let field = "";
    let inFieldQuotes = false;

    for (let i = 0; i < row.length; i++) {
      const char = row[i];

      if (char === quote) {
        if (inFieldQuotes && row[i + 1] === quote) {
          // Escaped quote.
          field += quote;
          i++;
        } else {
          inFieldQuotes = !inFieldQuotes;
        }
      } else if (char === delimiter && !inFieldQuotes) {
        fields.push(field.trim());
        field = "";
      } else {
        field += char;
      }
    }
    fields.push(field.trim());

    return fields;
  };

  const rows = lines.map(parseRow);

  if (!headers || rows.length === 0) {
    return rows;
  }

  // Convert to objects using header row.
  const headerRow = rows[0];
  const dataRows = rows.slice(1);

  return dataRows.map((row) => {
    const obj: Record<string, string> = {};
    for (let i = 0; i < headerRow.length; i++) {
      obj[headerRow[i]] = row[i] ?? "";
    }
    return obj;
  });
};

/**
 * Parse a simple YAML string (key: value format).
 */
const parseYaml = (input: string): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  const lines = input.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const colonIndex = trimmed.indexOf(":");
    if (colonIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, colonIndex).trim();
    let value: unknown = trimmed.slice(colonIndex + 1).trim();

    // Handle quoted strings.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = (value as string).slice(1, -1);
    }
    // Handle booleans.
    else if (value === "true") {
      value = true;
    } else if (value === "false") {
      value = false;
    }
    // Handle null.
    else if (value === "null" || value === "~" || value === "") {
      value = null;
    }
    // Handle numbers.
    else if (!Number.isNaN(Number(value)) && value !== "") {
      value = Number(value);
    }

    result[key] = value;
  }

  return result;
};

/**
 * Parse data from a string format.
 */
const parseData = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const { input, format, options = {} } = inputs as unknown as ParseDataInput;

    if (typeof input !== "string") {
      return {
        success: false,
        error: "Input must be a string",
        durationMs: performance.now() - startTime,
      };
    }

    if (!format) {
      return {
        success: false,
        error: "Format is required",
        durationMs: performance.now() - startTime,
      };
    }

    let result: unknown;

    switch (format) {
      case "json": {
        result = JSON.parse(input);
        break;
      }

      case "querystring": {
        const params = new URLSearchParams(input);
        const obj: Record<string, string | string[]> = {};
        for (const [key, value] of params.entries()) {
          if (key in obj) {
            const existing = obj[key];
            if (Array.isArray(existing)) {
              existing.push(value);
            } else {
              obj[key] = [existing, value];
            }
          } else {
            obj[key] = value;
          }
        }
        result = obj;
        break;
      }

      case "csv": {
        result = parseCsv(input, options);
        break;
      }

      case "yaml": {
        result = parseYaml(input);
        break;
      }

      case "xml": {
        return {
          success: false,
          error: "XML parsing is not yet implemented",
          durationMs: performance.now() - startTime,
        };
      }

      default: {
        return {
          success: false,
          error: `Unsupported format: ${format}`,
          durationMs: performance.now() - startTime,
        };
      }
    }

    return {
      success: true,
      output: { result, format },
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
 * Parse built-in plugin definition.
 */
export const parsePlugin: BuiltinPlugin = {
  id: "builtin:parse",
  name: "Parse",
  description: "Parse data from various string formats",
  actions: {
    data: {
      name: "data",
      description: "Parse data from JSON, CSV, YAML, or querystring format",
      handler: parseData,
    },
  },
};
