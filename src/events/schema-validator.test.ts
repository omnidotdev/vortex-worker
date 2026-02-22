import { afterEach, describe, expect, it } from "bun:test";

import {
  invalidateSchemaCache,
  validateEventData,
  type SchemaEntry,
} from "./schema-validator";

const STRICT_SCHEMA: SchemaEntry = {
  name: "test.strict",
  enforcement: "strict",
  payloadSchema: {
    type: "object",
    properties: {
      userId: { type: "string" },
      amount: { type: "number" },
    },
    required: ["userId", "amount"],
    additionalProperties: false,
  },
};

const WARN_SCHEMA: SchemaEntry = {
  name: "test.warn",
  enforcement: "warn",
  payloadSchema: {
    type: "object",
    properties: {
      userId: { type: "string" },
      amount: { type: "number" },
    },
    required: ["userId", "amount"],
    additionalProperties: false,
  },
};

const NONE_SCHEMA: SchemaEntry = {
  name: "test.none",
  enforcement: "none",
  payloadSchema: {
    type: "object",
    properties: {
      userId: { type: "string" },
    },
    required: ["userId"],
  },
};

afterEach(() => {
  invalidateSchemaCache("test.strict");
  invalidateSchemaCache("test.warn");
  invalidateSchemaCache("test.none");
});

describe("validateEventData", () => {
  it("returns valid for data matching schema in strict mode", () => {
    const result = validateEventData(
      { userId: "abc", amount: 42 },
      STRICT_SCHEMA,
    );

    expect(result.valid).toBe(true);
    expect(result).not.toHaveProperty("errors");
  });

  it("rejects invalid data in strict mode", () => {
    const result = validateEventData(
      { userId: "abc", amount: "not-a-number" },
      STRICT_SCHEMA,
    );

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain("amount");
    }
  });

  it("rejects data with missing required fields in strict mode", () => {
    const result = validateEventData({ userId: "abc" }, STRICT_SCHEMA);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it("returns valid with warnings for invalid data in warn mode", () => {
    const result = validateEventData(
      { userId: "abc", amount: "not-a-number" },
      WARN_SCHEMA,
    );

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.warnings).toBeDefined();
      expect(result.warnings!.length).toBeGreaterThan(0);
      expect(result.warnings![0]).toContain("amount");
    }
  });

  it("returns valid without warnings for valid data in warn mode", () => {
    const result = validateEventData(
      { userId: "abc", amount: 42 },
      WARN_SCHEMA,
    );

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.warnings).toBeUndefined();
    }
  });

  it("skips validation entirely in none mode", () => {
    // Intentionally invalid data should pass with enforcement=none
    const result = validateEventData(
      { garbage: true, amount: "wrong" },
      NONE_SCHEMA,
    );

    expect(result.valid).toBe(true);
    expect(result).not.toHaveProperty("errors");
    expect(result).not.toHaveProperty("warnings");
  });

  it("caches compiled validators across calls", () => {
    // First call compiles the validator
    const result1 = validateEventData(
      { userId: "abc", amount: 42 },
      STRICT_SCHEMA,
    );
    // Second call uses the cache
    const result2 = validateEventData(
      { userId: "def", amount: 99 },
      STRICT_SCHEMA,
    );

    expect(result1.valid).toBe(true);
    expect(result2.valid).toBe(true);
  });

  it("recompiles after cache invalidation", () => {
    // Validate once to populate cache
    const result1 = validateEventData(
      { userId: "abc", amount: 42 },
      STRICT_SCHEMA,
    );
    expect(result1.valid).toBe(true);

    // Invalidate and use a modified schema with the same name
    invalidateSchemaCache("test.strict");

    const modifiedSchema: SchemaEntry = {
      ...STRICT_SCHEMA,
      payloadSchema: {
        type: "object",
        properties: {
          userId: { type: "string" },
          amount: { type: "number" },
          email: { type: "string" },
        },
        required: ["userId", "amount", "email"],
        additionalProperties: false,
      },
    };

    // Should now require `email` which is missing
    const result2 = validateEventData(
      { userId: "abc", amount: 42 },
      modifiedSchema,
    );
    expect(result2.valid).toBe(false);
  });

  it("rejects extra properties when additionalProperties is false", () => {
    const result = validateEventData(
      { userId: "abc", amount: 42, extra: "field" },
      STRICT_SCHEMA,
    );

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes("additional"))).toBe(true);
    }
  });
});
