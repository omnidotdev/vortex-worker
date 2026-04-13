/**
 * Built-in Transform Plugin
 *
 * Provides data transformation capabilities for workflows.
 * Supports JSONPath extraction, template rendering, and data mapping.
 */

import { JSONPath } from "jsonpath-plus";

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/** JSONPath extraction input */
export interface JsonPathInput {
  /** Source data to extract from */
  data: unknown;
  /** JSONPath expression (e.g., "$.items[*].name") */
  path: string;
  /** Return first match only (default: false) */
  first?: boolean;
  /** Wrap result in object with key (optional) */
  resultKey?: string;
}

/** Template render input */
export interface TemplateInput {
  /** Template string with {{variable}} placeholders */
  template: string;
  /** Variables to substitute */
  variables: Record<string, unknown>;
  /** Delimiter start (default: "{{") */
  delimiterStart?: string;
  /** Delimiter end (default: "}}") */
  delimiterEnd?: string;
}

/** Object mapping input */
export interface MapInput {
  /** Source data */
  data: unknown;
  /** Mapping definition: { targetKey: "$.source.path" | literal } */
  mapping: Record<string, string | unknown>;
}

/** Pick/omit input */
export interface PickOmitInput {
  /** Source object */
  data: Record<string, unknown>;
  /** Keys to pick or omit */
  keys: string[];
}

/**
 * Extract data using JSONPath expression.
 */
const jsonPath = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const {
      data,
      path,
      first = false,
      resultKey,
    } = inputs as unknown as JsonPathInput;

    if (!path) {
      return {
        success: false,
        error: "JSONPath expression is required",
        durationMs: performance.now() - startTime,
      };
    }

    const result = JSONPath({
      path,
      json: data as object,
      wrap: !first,
    });

    const output = resultKey ? { [resultKey]: result } : { result };

    return {
      success: true,
      output,
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
 * Render a template string with variable substitution.
 */
const renderTemplate = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const {
      template,
      variables,
      delimiterStart = "{{",
      delimiterEnd = "}}",
    } = inputs as unknown as TemplateInput;

    if (!template) {
      return {
        success: false,
        error: "Template string is required",
        durationMs: performance.now() - startTime,
      };
    }

    // Build regex to match delimiters
    const escapedStart = delimiterStart.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escapedEnd = delimiterEnd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(
      `${escapedStart}\\s*([\\w.\\[\\]]+)\\s*${escapedEnd}`,
      "g",
    );

    // Replace placeholders with values
    const result = template.replace(regex, (_match, key: string) => {
      const value = getNestedValue(variables, key);
      if (value === undefined) {
        return "";
      }
      return typeof value === "object" ? JSON.stringify(value) : String(value);
    });

    return {
      success: true,
      output: { result },
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
 * Map data from source to target structure.
 */
const mapData = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const { data, mapping } = inputs as unknown as MapInput;

    if (!mapping || typeof mapping !== "object") {
      return {
        success: false,
        error: "Mapping definition is required",
        durationMs: performance.now() - startTime,
      };
    }

    const result: Record<string, unknown> = {};

    for (const [targetKey, sourceValue] of Object.entries(mapping)) {
      if (typeof sourceValue === "string" && sourceValue.startsWith("$.")) {
        // JSONPath expression
        const extracted = JSONPath({
          path: sourceValue,
          json: data as object,
          wrap: false,
        });
        result[targetKey] = extracted;
      } else {
        // Literal value
        result[targetKey] = sourceValue;
      }
    }

    return {
      success: true,
      output: { result },
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
 * Pick specific keys from an object.
 */
const pick = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const { data, keys } = inputs as unknown as PickOmitInput;

    if (!data || typeof data !== "object") {
      return {
        success: false,
        error: "Data must be an object",
        durationMs: performance.now() - startTime,
      };
    }

    if (!Array.isArray(keys)) {
      return {
        success: false,
        error: "Keys must be an array",
        durationMs: performance.now() - startTime,
      };
    }

    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (key in data) {
        result[key] = data[key];
      }
    }

    return {
      success: true,
      output: { result },
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
 * Omit specific keys from an object.
 */
const omit = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const { data, keys } = inputs as unknown as PickOmitInput;

    if (!data || typeof data !== "object") {
      return {
        success: false,
        error: "Data must be an object",
        durationMs: performance.now() - startTime,
      };
    }

    if (!Array.isArray(keys)) {
      return {
        success: false,
        error: "Keys must be an array",
        durationMs: performance.now() - startTime,
      };
    }

    const keysSet = new Set(keys);
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (!keysSet.has(key)) {
        result[key] = value;
      }
    }

    return {
      success: true,
      output: { result },
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
 * Merge multiple objects into one.
 */
const merge = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const { objects, deep = false } = inputs as {
      objects: Record<string, unknown>[];
      deep?: boolean;
    };

    if (!Array.isArray(objects)) {
      return {
        success: false,
        error: "Objects must be an array",
        durationMs: performance.now() - startTime,
      };
    }

    const result = deep ? deepMerge(...objects) : Object.assign({}, ...objects);

    return {
      success: true,
      output: { result },
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
 * Get nested value from object using dot notation.
 */
const getNestedValue = (
  obj: Record<string, unknown>,
  path: string,
): unknown => {
  const keys = path.split(".");
  let current: unknown = obj;

  for (const key of keys) {
    if (current === null || current === undefined) {
      return undefined;
    }

    // Handle array index notation: key[0]
    const arrayMatch = key.match(/^(\w+)\[(\d+)\]$/);
    if (arrayMatch) {
      const [, arrayKey, indexStr] = arrayMatch;
      const array = (current as Record<string, unknown>)[arrayKey];
      if (!Array.isArray(array)) {
        return undefined;
      }
      current = array[Number.parseInt(indexStr, 10)];
    } else {
      current = (current as Record<string, unknown>)[key];
    }
  }

  return current;
};

/**
 * Deep merge objects recursively.
 */
const deepMerge = (
  ...objects: Record<string, unknown>[]
): Record<string, unknown> => {
  const result: Record<string, unknown> = {};

  for (const obj of objects) {
    if (!obj || typeof obj !== "object") continue;

    for (const [key, value] of Object.entries(obj)) {
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        result[key] &&
        typeof result[key] === "object" &&
        !Array.isArray(result[key])
      ) {
        result[key] = deepMerge(
          result[key] as Record<string, unknown>,
          value as Record<string, unknown>,
        );
      } else {
        result[key] = value;
      }
    }
  }

  return result;
};

/**
 * Transform built-in plugin definition.
 */
export const transformPlugin: BuiltinPlugin = {
  id: "builtin:transform",
  name: "Transform",
  description:
    "Transform and manipulate data using JSONPath, templates, and mapping",
  actions: {
    jsonPath: {
      name: "jsonPath",
      description: "Extract data using JSONPath expression",
      handler: jsonPath,
    },
    template: {
      name: "template",
      description: "Render a template string with variable substitution",
      handler: renderTemplate,
    },
    map: {
      name: "map",
      description: "Map data from source to target structure",
      handler: mapData,
    },
    pick: {
      name: "pick",
      description: "Pick specific keys from an object",
      handler: pick,
    },
    omit: {
      name: "omit",
      description: "Omit specific keys from an object",
      handler: omit,
    },
    merge: {
      name: "merge",
      description: "Merge multiple objects into one",
      handler: merge,
    },
  },
};
