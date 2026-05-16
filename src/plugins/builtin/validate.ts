/**
 * Built-in Validate Plugin
 *
 * Schema-based validation for data objects.
 * Supports basic JSON Schema-like validation rules.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/** Schema property definition */
interface SchemaProperty {
  /** Expected type */
  type?: "string" | "number" | "boolean" | "object" | "array" | "null";
  /** Whether the field is required */
  required?: boolean;
  /** Minimum value (numbers) */
  min?: number;
  /** Maximum value (numbers) */
  max?: number;
  /** Minimum string length */
  minLength?: number;
  /** Maximum string length */
  maxLength?: number;
  /** Allowed values */
  enum?: unknown[];
  /** Regex pattern for strings */
  pattern?: string;
  /** Nested properties for objects */
  properties?: Record<string, SchemaProperty>;
  /** Schema for array items */
  items?: SchemaProperty;
}

/** Validation schema */
interface ValidationSchema {
  /** Schema properties */
  properties?: Record<string, SchemaProperty>;
  /** List of required field names */
  required?: string[];
}

/** Validate schema input */
interface ValidateSchemaInput {
  /** Data to validate */
  input: unknown;
  /** Validation schema */
  schema: ValidationSchema;
  /** If true, fail on any unknown properties (default: false) */
  strict?: boolean;
}

/** Validation result */
interface ValidationResult {
  /** Whether validation passed */
  valid: boolean;
  /** List of validation errors */
  errors: string[];
  /** Number of errors found */
  errorCount: number;
}

/**
 * Get the type of a value.
 */
const getType = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
};

/**
 * Validate a value against a schema property.
 */
const validateProperty = (
  value: unknown,
  schema: SchemaProperty,
  path: string,
  errors: string[],
): void => {
  // Type check
  if (schema.type !== undefined) {
    const actualType = getType(value);
    if (actualType !== schema.type) {
      errors.push(
        `${path}: expected type "${schema.type}", got "${actualType}"`,
      );
      return;
    }
  }

  // Enum check
  if (schema.enum !== undefined) {
    if (!schema.enum.includes(value)) {
      errors.push(
        `${path}: value must be one of [${schema.enum.map((v) => JSON.stringify(v)).join(", ")}]`,
      );
    }
  }

  // String validations
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(
        `${path}: string length ${value.length} is less than minimum ${schema.minLength}`,
      );
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(
        `${path}: string length ${value.length} exceeds maximum ${schema.maxLength}`,
      );
    }
    if (schema.pattern !== undefined) {
      const regex = new RegExp(schema.pattern);
      if (!regex.test(value)) {
        errors.push(
          `${path}: string does not match pattern "${schema.pattern}"`,
        );
      }
    }
  }

  // Number validations
  if (typeof value === "number") {
    if (schema.min !== undefined && value < schema.min) {
      errors.push(`${path}: value ${value} is less than minimum ${schema.min}`);
    }
    if (schema.max !== undefined && value > schema.max) {
      errors.push(`${path}: value ${value} exceeds maximum ${schema.max}`);
    }
  }

  // Object validations
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    if (schema.properties) {
      const obj = value as Record<string, unknown>;
      for (const [propKey, propSchema] of Object.entries(schema.properties)) {
        const propPath = `${path}.${propKey}`;
        const propValue = obj[propKey];

        if (propSchema.required && propValue === undefined) {
          errors.push(`${propPath}: required field is missing`);
          continue;
        }

        if (propValue !== undefined) {
          validateProperty(propValue, propSchema, propPath, errors);
        }
      }
    }
  }

  // Array validations
  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      validateProperty(value[i], schema.items, `${path}[${i}]`, errors);
    }
  }
};

/**
 * Validate data against a schema.
 */
const validateSchema = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const {
      input,
      schema,
      strict = false,
    } = inputs as unknown as ValidateSchemaInput;

    if (!schema) {
      return {
        success: false,
        error: "Schema is required",
        durationMs: performance.now() - startTime,
      };
    }

    const errors: string[] = [];

    // Check required fields at root level
    if (schema.required && typeof input === "object" && input !== null) {
      const obj = input as Record<string, unknown>;
      for (const field of schema.required) {
        if (obj[field] === undefined) {
          errors.push(`$.${field}: required field is missing`);
        }
      }
    }

    // Validate properties
    if (schema.properties && typeof input === "object" && input !== null) {
      const obj = input as Record<string, unknown>;

      for (const [key, propSchema] of Object.entries(schema.properties)) {
        const value = obj[key];
        const path = `$.${key}`;

        if (value !== undefined) {
          validateProperty(value, propSchema, path, errors);
        }
      }

      // Strict mode: check for unknown properties
      if (strict) {
        const knownKeys = new Set(Object.keys(schema.properties));
        for (const key of Object.keys(obj)) {
          if (!knownKeys.has(key)) {
            errors.push(
              `$.${key}: unknown property not allowed in strict mode`,
            );
          }
        }
      }
    }

    const result: ValidationResult = {
      valid: errors.length === 0,
      errors,
      errorCount: errors.length,
    };

    return {
      success: true,
      output: result as unknown as Record<string, unknown>,
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
 * Validate built-in plugin definition.
 */
export const validatePlugin: BuiltinPlugin = {
  id: "builtin:validate",
  name: "Validate",
  description: "Schema-based data validation",
  actions: {
    schema: {
      name: "schema",
      description: "Validate data against a JSON Schema-like schema",
      handler: validateSchema,
    },
  },
};
