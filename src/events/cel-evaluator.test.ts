import { afterEach, describe, expect, it } from "bun:test";

import { evaluateCel, invalidateCelCache } from "./cel-evaluator";

import type { OmniEvent } from "./types";

const sampleEvent: OmniEvent = {
  id: "evt-1",
  type: "payment.completed",
  source: "billing",
  data: {
    amount: 150,
    currency: "USD",
    items: [1, 2, 3],
  },
  timestamp: "2026-02-22T00:00:00Z",
  organizationId: "org-1",
};

afterEach(() => {
  invalidateCelCache("event.data.amount > 100");
  invalidateCelCache('startsWith(event.type, "payment.")');
  invalidateCelCache('event.data.amount > 100 && event.source == "billing"');
  invalidateCelCache('event.source == "auth" || event.source == "billing"');
  invalidateCelCache('event.data.currency != "EUR"');
  invalidateCelCache("size(event.data.items) > 0");
  invalidateCelCache("invalid %%% syntax");
  invalidateCelCache('contains(event.type, "payment")');
  invalidateCelCache('endsWith(event.type, ".completed")');
  invalidateCelCache('matches(event.type, "^payment\\..*")');
  invalidateCelCache("has(event.data.amount)");
  invalidateCelCache("has(event.data.missing)");
  invalidateCelCache("event.data.amount > 200 ? false : true");
});

describe("evaluateCel", () => {
  it("evaluates a simple comparison", () => {
    expect(evaluateCel("event.data.amount > 100", sampleEvent)).toBe(true);
    expect(evaluateCel("event.data.amount > 200", sampleEvent)).toBe(false);
  });

  it("evaluates startsWith via custom function", () => {
    expect(evaluateCel('startsWith(event.type, "payment.")', sampleEvent)).toBe(
      true,
    );
    expect(evaluateCel('startsWith(event.type, "order.")', sampleEvent)).toBe(
      false,
    );
  });

  it("evaluates contains via custom function", () => {
    expect(evaluateCel('contains(event.type, "payment")', sampleEvent)).toBe(
      true,
    );
    expect(evaluateCel('contains(event.type, "order")', sampleEvent)).toBe(
      false,
    );
  });

  it("evaluates endsWith via custom function", () => {
    expect(evaluateCel('endsWith(event.type, ".completed")', sampleEvent)).toBe(
      true,
    );
  });

  it("evaluates matches via custom function", () => {
    expect(
      evaluateCel('matches(event.type, "^payment\\..*")', sampleEvent),
    ).toBe(true);
  });

  it("evaluates AND logic", () => {
    expect(
      evaluateCel(
        'event.data.amount > 100 && event.source == "billing"',
        sampleEvent,
      ),
    ).toBe(true);
    expect(
      evaluateCel(
        'event.data.amount > 200 && event.source == "billing"',
        sampleEvent,
      ),
    ).toBe(false);
  });

  it("evaluates OR logic", () => {
    expect(
      evaluateCel(
        'event.source == "auth" || event.source == "billing"',
        sampleEvent,
      ),
    ).toBe(true);
    expect(
      evaluateCel(
        'event.source == "auth" || event.source == "payments"',
        sampleEvent,
      ),
    ).toBe(false);
  });

  it("evaluates NOT (!=)", () => {
    expect(evaluateCel('event.data.currency != "EUR"', sampleEvent)).toBe(true);
    expect(evaluateCel('event.data.currency != "USD"', sampleEvent)).toBe(
      false,
    );
  });

  it("evaluates size()", () => {
    expect(evaluateCel("size(event.data.items) > 0", sampleEvent)).toBe(true);
    expect(evaluateCel("size(event.data.items) > 5", sampleEvent)).toBe(false);
  });

  it("evaluates has() macro", () => {
    expect(evaluateCel("has(event.data.amount)", sampleEvent)).toBe(true);
    expect(evaluateCel("has(event.data.missing)", sampleEvent)).toBe(false);
  });

  it("evaluates ternary expressions", () => {
    expect(
      evaluateCel("event.data.amount > 200 ? false : true", sampleEvent),
    ).toBe(true);
  });

  it("returns false for invalid expression (fail-closed)", () => {
    expect(evaluateCel("invalid %%% syntax", sampleEvent)).toBe(false);
  });

  it("returns false for non-boolean result", () => {
    expect(evaluateCel("event.data.amount", sampleEvent)).toBe(false);
  });

  it("caches parsed expressions across calls", () => {
    // First call compiles and caches
    expect(evaluateCel("event.data.amount > 100", sampleEvent)).toBe(true);
    // Second call uses cached CST
    expect(evaluateCel("event.data.amount > 100", sampleEvent)).toBe(true);
  });

  it("re-parses after cache invalidation", () => {
    expect(evaluateCel("event.data.amount > 100", sampleEvent)).toBe(true);

    invalidateCelCache("event.data.amount > 100");

    // Should re-parse and still work
    expect(evaluateCel("event.data.amount > 100", sampleEvent)).toBe(true);
  });
});
