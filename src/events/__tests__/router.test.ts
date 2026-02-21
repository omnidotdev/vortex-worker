import { describe, expect, it } from "bun:test";
import { evaluateCondition } from "../router";

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
});
