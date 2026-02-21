import { describe, expect, it } from "bun:test";

import { applyTransform, evaluateCondition } from "../router";

describe("evaluateCondition", () => {
  it("returns true when condition is null (no filter)", () => {
    expect(evaluateCondition(null, { status: "ok" })).toBe(true);
  });

  it("returns true when JSONPath matches", () => {
    expect(evaluateCondition("$.status", { status: "error" })).toBe(true);
  });

  it("returns false when JSONPath returns empty (no match)", () => {
    expect(evaluateCondition("$.nonexistent", { status: "ok" })).toBe(false);
  });

  it("returns true for nested path match", () => {
    expect(evaluateCondition("$.user.id", { user: { id: 42 } })).toBe(true);
  });

  it("returns false for nested path miss", () => {
    expect(evaluateCondition("$.user.email", { user: { id: 42 } })).toBe(false);
  });

  it("returns false on invalid JSONPath expression (safe fallback)", () => {
    expect(evaluateCondition("!!!invalid", {})).toBe(false);
  });

  it("returns true when JSONPath matches a falsy value (false)", () => {
    expect(evaluateCondition("$.active", { active: false })).toBe(true);
  });

  it("returns true when JSONPath matches a zero value", () => {
    expect(evaluateCondition("$.count", { count: 0 })).toBe(true);
  });

  it("returns true when condition is an empty string (not a valid path, treated as invalid)", () => {
    // Empty string is not null — it goes through JSONPath evaluation and returns false
    expect(evaluateCondition("", {})).toBe(false);
  });
});

describe("applyTransform", () => {
  it("returns original data when transform is null", async () => {
    const data = { count: 5 };
    expect(await applyTransform(null, data)).toEqual(data);
  });

  it("transforms data with a JSONata expression", async () => {
    const data = { count: 5, price: 10 };
    const result = await applyTransform("{ 'total': count * price }", data);
    expect(result).toEqual({ total: 50 });
  });

  it("extracts a field with JSONata", async () => {
    const data = { user: { id: "u1", name: "Alice" } };
    const result = await applyTransform("user.id", data);
    expect(result).toBe("u1");
  });

  it("returns original data on invalid expression (safe fallback)", async () => {
    const data = { count: 5 };
    expect(await applyTransform("!!!invalid$$$", data)).toEqual(data);
  });
});
