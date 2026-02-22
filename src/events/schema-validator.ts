/**
 * Event schema validation using Ajv (JSON Schema draft 2020-12).
 */
import Ajv from "ajv";

import logger from "lib/logger";

const ajv = new Ajv({ allErrors: true });

export type Enforcement = "strict" | "warn" | "none";

export type SchemaEntry = {
  name: string;
  enforcement: Enforcement;
  payloadSchema: Record<string, unknown>;
};

type ValidationResult =
  | { valid: true; warnings?: string[] }
  | { valid: false; errors: string[] };

/** Cache compiled validators by schema name */
const validatorCache = new Map<string, ReturnType<typeof ajv.compile>>();

function getValidator(schema: SchemaEntry) {
  const cached = validatorCache.get(schema.name);
  if (cached) return cached;
  const compiled = ajv.compile(schema.payloadSchema);
  validatorCache.set(schema.name, compiled);
  return compiled;
}

/**
 * Validate event data against a registered schema.
 * @param data - Event payload to validate
 * @param schema - Schema entry with enforcement level
 * @returns Validation result with errors or warnings
 */
function validateEventData(
  data: Record<string, unknown>,
  schema: SchemaEntry,
): ValidationResult {
  if (schema.enforcement === "none") return { valid: true };

  const validate = getValidator(schema);
  const isValid = validate(data);

  if (isValid) return { valid: true };

  const errorMessages =
    validate.errors?.map((e) => `${e.instancePath || "/"} ${e.message}`) ?? [];

  if (schema.enforcement === "warn") {
    logger.warn("Event schema validation warnings", {
      schemaName: schema.name,
      errors: errorMessages,
    });
    return { valid: true, warnings: errorMessages };
  }

  // strict
  return { valid: false, errors: errorMessages };
}

/** Remove a cached compiled validator so the next call recompiles */
function invalidateSchemaCache(name: string): void {
  validatorCache.delete(name);
}

export { invalidateSchemaCache, validateEventData };
