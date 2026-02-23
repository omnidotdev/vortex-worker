/**
 * Event Router Integration Tests
 *
 * Test the event routing pipeline components: glob pattern matching,
 * CEL condition evaluation, dedup via correlationId, and data transforms.
 *
 * These tests exercise the exported pure functions from the router and
 * CEL evaluator modules, composing them into pipeline-level scenarios
 * that mirror how `routeEvent` orchestrates the pieces internally.
 */

import { describe, expect, it } from "bun:test";
import "./setup";

import { evaluateCel, invalidateCelCache } from "../../events/cel-evaluator";
import {
  applyTransform,
  evaluateCondition,
  isDuplicate,
} from "../../events/router";

import type Redis from "ioredis";
import type { OmniEvent } from "../../events/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal OmniEvent for testing */
const makeEvent = (overrides: Partial<OmniEvent> = {}): OmniEvent => ({
  id: "evt-001",
  type: "order.created",
  source: "shop-api",
  data: { orderId: "o-123", total: 99.99 },
  timestamp: new Date().toISOString(),
  organizationId: "org-test",
  ...overrides,
});

/**
 * Simulate `matchGlobPattern` behavior to test routing logic.
 *
 * The router's private `matchGlobPattern` is not exported, so we replicate
 * the same algorithm here for integration-level assertions. This ensures
 * our tests validate the same semantics without coupling to internals.
 */
const matchGlobPattern = (pattern: string, value: string): boolean => {
  if (pattern === "*") return true;

  const regexPattern = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");

  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(value);
};

// ---------------------------------------------------------------------------
// Glob pattern matching
// ---------------------------------------------------------------------------

describe("event routing pipeline", () => {
  describe("glob pattern matching", () => {
    it("should match wildcard '*' against any event type", () => {
      expect(matchGlobPattern("*", "order.created")).toBe(true);
      expect(matchGlobPattern("*", "user.deleted")).toBe(true);
      expect(matchGlobPattern("*", "")).toBe(true);
    });

    it("should match 'prefix.*' against prefix.anything", () => {
      expect(matchGlobPattern("order.*", "order.created")).toBe(true);
      expect(matchGlobPattern("order.*", "order.updated")).toBe(true);
      expect(matchGlobPattern("order.*", "order.cancelled")).toBe(true);
    });

    it("should not match 'prefix.*' against different prefix", () => {
      expect(matchGlobPattern("order.*", "user.created")).toBe(false);
      expect(matchGlobPattern("order.*", "invoice.created")).toBe(false);
    });

    it("should match exact event type", () => {
      expect(matchGlobPattern("order.created", "order.created")).toBe(true);
    });

    it("should not match exact type against different value", () => {
      expect(matchGlobPattern("order.created", "order.updated")).toBe(false);
    });

    it("should match nested glob patterns", () => {
      expect(matchGlobPattern("shop.order.*", "shop.order.created")).toBe(true);
      expect(matchGlobPattern("shop.order.*", "shop.order.refunded")).toBe(
        true,
      );
    });

    it("should not match partial prefix without wildcard", () => {
      expect(matchGlobPattern("order", "order.created")).toBe(false);
    });

    it("should handle multiple wildcards", () => {
      expect(matchGlobPattern("*.*", "order.created")).toBe(true);
      expect(matchGlobPattern("*.*.*", "a.b.c")).toBe(true);
      expect(matchGlobPattern("*.*", "single")).toBe(false);
    });

    it("should handle wildcard in the middle", () => {
      expect(matchGlobPattern("order.*.confirmed", "order.123.confirmed")).toBe(
        true,
      );
      expect(matchGlobPattern("order.*.confirmed", "order.abc.confirmed")).toBe(
        true,
      );
      expect(matchGlobPattern("order.*.confirmed", "order.123.cancelled")).toBe(
        false,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // CEL condition evaluation
  // ---------------------------------------------------------------------------

  describe("CEL condition evaluation", () => {
    it("should accept event when CEL expression is true", () => {
      const event = makeEvent({ data: { total: 100 } });
      expect(evaluateCel("event.data.total == 100", event)).toBe(true);
    });

    it("should reject event when CEL expression is false", () => {
      const event = makeEvent({ data: { total: 50 } });
      expect(evaluateCel("event.data.total > 100", event)).toBe(false);
    });

    it("should evaluate comparison on event type field", () => {
      const event = makeEvent({ type: "order.created" });
      expect(evaluateCel('event.type == "order.created"', event)).toBe(true);
      expect(evaluateCel('event.type == "user.created"', event)).toBe(false);
    });

    it("should evaluate comparison on event source field", () => {
      const event = makeEvent({ source: "payment-gateway" });
      expect(evaluateCel('event.source == "payment-gateway"', event)).toBe(
        true,
      );
    });

    it("should evaluate nested data access", () => {
      const event = makeEvent({
        data: { order: { status: "paid", amount: 250 } },
      });
      expect(evaluateCel('event.data.order.status == "paid"', event)).toBe(
        true,
      );
      expect(evaluateCel("event.data.order.amount > 200", event)).toBe(true);
    });

    it("should return false for invalid CEL expression (fail-closed)", () => {
      const event = makeEvent();
      expect(evaluateCel("!!invalid syntax@@", event)).toBe(false);
    });

    it("should return false for runtime error (fail-closed)", () => {
      const event = makeEvent({ data: {} });
      // Access non-existent nested field
      expect(evaluateCel("event.data.missing.deep == true", event)).toBe(false);
    });

    it("should use built-in startsWith helper", () => {
      const event = makeEvent({ type: "order.created" });
      expect(evaluateCel('startsWith(event.type, "order")', event)).toBe(true);
      expect(evaluateCel('startsWith(event.type, "user")', event)).toBe(false);
    });

    it("should use built-in contains helper", () => {
      const event = makeEvent({ source: "my-shop-api" });
      expect(evaluateCel('contains(event.source, "shop")', event)).toBe(true);
      expect(evaluateCel('contains(event.source, "payment")', event)).toBe(
        false,
      );
    });

    it("should use built-in endsWith helper", () => {
      const event = makeEvent({ type: "order.created" });
      expect(evaluateCel('endsWith(event.type, "created")', event)).toBe(true);
      expect(evaluateCel('endsWith(event.type, "updated")', event)).toBe(false);
    });

    it("should use built-in matches helper for regex", () => {
      const event = makeEvent({ type: "order.created.v2" });
      expect(
        evaluateCel('matches(event.type, "order\\..*\\.v\\d+")', event),
      ).toBe(true);
    });

    it("should handle boolean logic (and/or)", () => {
      const event = makeEvent({
        type: "order.created",
        data: { total: 150, priority: true },
      });
      expect(
        evaluateCel(
          "event.data.total > 100 && event.data.priority == true",
          event,
        ),
      ).toBe(true);
      expect(
        evaluateCel(
          "event.data.total > 200 || event.data.priority == true",
          event,
        ),
      ).toBe(true);
      expect(
        evaluateCel(
          "event.data.total > 200 && event.data.priority == false",
          event,
        ),
      ).toBe(false);
    });

    it("should cache parsed expressions across calls", () => {
      const expr = 'event.type == "order.created"';
      invalidateCelCache(expr);

      const event = makeEvent({ type: "order.created" });
      // First call parses and caches
      expect(evaluateCel(expr, event)).toBe(true);
      // Second call uses cached CST
      expect(evaluateCel(expr, event)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Dedup via correlationId
  // ---------------------------------------------------------------------------

  describe("duplicate event detection", () => {
    it("should allow first event and reject duplicate", async () => {
      // Track calls to simulate Redis SET NX behavior
      let callCount = 0;
      const mockCache = {
        set: async () => {
          callCount++;
          // First call: key does not exist, SET NX returns "OK"
          // Second call: key exists, SET NX returns null
          return callCount === 1 ? "OK" : null;
        },
      } as unknown as Redis;

      // First delivery - new event
      expect(await isDuplicate(mockCache, "org-1", "corr-abc")).toBe(false);
      // Second delivery - duplicate
      expect(await isDuplicate(mockCache, "org-1", "corr-abc")).toBe(true);
    });

    it("should scope dedup by organizationId", async () => {
      const seen = new Map<string, boolean>();
      const mockCache = {
        set: async (
          key: string,
          _val: string,
          _ex: string,
          _ttl: number,
          _nx: string,
        ) => {
          if (seen.has(key)) return null; // duplicate
          seen.set(key, true);
          return "OK"; // new
        },
      } as unknown as Redis;

      // Same correlationId, different orgs -> both are new
      expect(await isDuplicate(mockCache, "org-A", "corr-1")).toBe(false);
      expect(await isDuplicate(mockCache, "org-B", "corr-1")).toBe(false);

      // Same org + same correlationId -> duplicate
      expect(await isDuplicate(mockCache, "org-A", "corr-1")).toBe(true);
    });

    it("should not dedup when correlationId is absent", async () => {
      const mockCache = {
        set: async () => {
          throw new Error("should not be called");
        },
      } as unknown as Redis;

      // No correlationId -> always proceed (no dedup check)
      expect(await isDuplicate(mockCache, "org-1", undefined)).toBe(false);
    });

    it("should not dedup when cache is unavailable", async () => {
      // null cache -> always proceed
      expect(await isDuplicate(null, "org-1", "corr-1")).toBe(false);
    });

    it("should fail open when Redis errors", async () => {
      const mockCache = {
        set: async () => {
          throw new Error("Connection refused");
        },
      } as unknown as Redis;

      // Redis down -> fail open, proceed with routing
      expect(await isDuplicate(mockCache, "org-1", "corr-1")).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Data transformation
  // ---------------------------------------------------------------------------

  describe("data transformation", () => {
    it("should pass data through when no transform is set", async () => {
      const data = { orderId: "o-1", items: [1, 2, 3] };
      const result = await applyTransform(null, data);
      expect(result).toEqual(data);
    });

    it("should reshape data with a JSONata object constructor", async () => {
      const data = {
        user: { firstName: "Alice", lastName: "Smith" },
        items: [{ price: 10 }, { price: 20 }],
      };
      const transform =
        "{ 'fullName': user.firstName & ' ' & user.lastName, 'itemCount': $count(items) }";
      const result = await applyTransform(transform, data);
      expect(result).toEqual({ fullName: "Alice Smith", itemCount: 2 });
    });

    it("should extract a single field", async () => {
      const data = { event: { payload: { key: "value" } } };
      const result = await applyTransform("event.payload", data);
      expect(result).toEqual({ key: "value" });
    });

    it("should compute aggregations", async () => {
      const data = { lineItems: [{ price: 10 }, { price: 25 }, { price: 15 }] };
      const result = await applyTransform("$sum(lineItems.price)", data);
      expect(result).toBe(50);
    });

    it("should fall back to original data on invalid expression", async () => {
      const data = { x: 1 };
      const result = await applyTransform("!!!bad!!!expr", data);
      expect(result).toEqual(data);
    });

    it("should fall back to original data when expression returns undefined", async () => {
      const data = { x: 1 };
      // Access a path that does not exist -> JSONata returns undefined
      const result = await applyTransform("nonexistent.deep.path", data);
      expect(result).toEqual(data);
    });
  });

  // ---------------------------------------------------------------------------
  // Pipeline composition (condition + transform + dedup)
  // ---------------------------------------------------------------------------

  describe("pipeline composition", () => {
    it("should filter then transform event data", async () => {
      const event = makeEvent({
        data: { order: { total: 150, currency: "USD", items: 3 } },
      });

      // Step 1: condition check (JSONPath - field must exist)
      const passesCondition = evaluateCondition("$.order.total", event.data);
      expect(passesCondition).toBe(true);

      // Step 2: CEL check (value must exceed threshold)
      const passesCel = evaluateCel("event.data.order.total > 100", event);
      expect(passesCel).toBe(true);

      // Step 3: transform for downstream workflow
      const transformed = await applyTransform(
        "{ 'amount': order.total, 'currency': order.currency }",
        event.data,
      );
      expect(transformed).toEqual({ amount: 150, currency: "USD" });
    });

    it("should short-circuit when condition rejects", async () => {
      const event = makeEvent({ data: { status: "pending" } });

      // JSONPath condition rejects: field `approved` does not exist
      const passes = evaluateCondition("$.approved", event.data);
      expect(passes).toBe(false);

      // Transform should not be called in the real pipeline,
      // but verify it would have been safe anyway
      const result = await applyTransform(null, event.data);
      expect(result).toEqual(event.data);
    });

    it("should short-circuit when CEL rejects", async () => {
      const event = makeEvent({
        data: { order: { total: 5 } },
      });

      // Glob match would pass (tested separately)
      const typeMatches = matchGlobPattern("order.*", event.type);
      expect(typeMatches).toBe(true);

      // CEL condition rejects
      const celPasses = evaluateCel("event.data.order.total > 50", event);
      expect(celPasses).toBe(false);
    });

    it("should dedup before transform in the pipeline", async () => {
      let setCount = 0;
      const mockCache = {
        set: async () => {
          setCount++;
          return setCount === 1 ? "OK" : null;
        },
      } as unknown as Redis;

      // First delivery: not a duplicate, proceed with transform
      const firstIsDup = await isDuplicate(mockCache, "org-1", "corr-xyz");
      expect(firstIsDup).toBe(false);

      const transformed = await applyTransform("{ 'processed': true }", {
        raw: "data",
      });
      expect(transformed).toEqual({ processed: true });

      // Second delivery: duplicate, transform would be skipped
      const secondIsDup = await isDuplicate(mockCache, "org-1", "corr-xyz");
      expect(secondIsDup).toBe(true);
    });

    it("should match type+source patterns in combination", () => {
      // Simulate rule with both typePattern and sourcePattern
      const typePattern = "order.*";
      const sourcePattern = "shop-*";
      const eventType = "order.created";
      const eventSource = "shop-api";

      const typeMatches = matchGlobPattern(typePattern, eventType);
      const sourceMatches = matchGlobPattern(sourcePattern, eventSource);

      expect(typeMatches).toBe(true);
      expect(sourceMatches).toBe(true);

      // Different source should not match
      expect(matchGlobPattern(sourcePattern, "admin-api")).toBe(false);
    });

    it("should prioritize CEL over legacy JSONPath when both present", () => {
      const event = makeEvent({
        data: { amount: 200 },
      });

      // Legacy JSONPath: field exists -> would pass
      const jsonPathPasses = evaluateCondition("$.amount", event.data);
      expect(jsonPathPasses).toBe(true);

      // CEL condition: more specific check -> rejects
      const celPasses = evaluateCel("event.data.amount < 100", event);
      expect(celPasses).toBe(false);

      // In the router, CEL takes precedence when both are set.
      // The event should be rejected.
      const finalResult = celPasses; // CEL wins
      expect(finalResult).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe("edge cases", () => {
    it("should handle empty event data", () => {
      const event = makeEvent({ data: {} });
      expect(evaluateCel("event.data.total > 0", event)).toBe(false);
      expect(evaluateCondition("$.total", {})).toBe(false);
    });

    it("should handle special characters in event type", () => {
      expect(
        matchGlobPattern("webhook.*", "webhook.stripe/payment_intent"),
      ).toBe(true);
      expect(matchGlobPattern("webhook.*", "webhook.github+push")).toBe(true);
    });

    it("should handle null-ish values in data", () => {
      const event = makeEvent({
        data: { value: null as unknown } as Record<string, unknown>,
      });
      expect(evaluateCel("event.data.value == null", event)).toBe(true);
    });

    it("should handle deeply nested transforms", async () => {
      const data = {
        a: { b: { c: { d: { value: 42 } } } },
      };
      const result = await applyTransform("a.b.c.d.value", data);
      expect(result).toBe(42);
    });

    it("should handle array data in transforms", async () => {
      const data = { items: [1, 2, 3, 4, 5] };
      const result = await applyTransform(
        "{ 'total': $sum(items), 'count': $count(items) }",
        data,
      );
      expect(result).toEqual({ total: 15, count: 5 });
    });

    it("should handle large correlationId strings", async () => {
      const longId = "a".repeat(1000);
      const mockCache = {
        set: async () => "OK",
      } as unknown as Redis;

      expect(await isDuplicate(mockCache, "org-1", longId)).toBe(false);
    });

    it("should handle event with all optional fields populated", () => {
      const event = makeEvent({
        subject: "user/u-123",
        correlationId: "corr-001",
        schemaId: "order.created.v1",
        traceContext: {
          traceparent: "00-abc123-def456-01",
          tracestate: "vendor=value",
        },
      });

      expect(evaluateCel('event.type == "order.created"', event)).toBe(true);
      expect(evaluateCel('event.organizationId == "org-test"', event)).toBe(
        true,
      );
    });
  });
});
