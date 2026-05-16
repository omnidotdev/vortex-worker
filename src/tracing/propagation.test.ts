/**
 * Trace context propagation tests.
 *
 * OTEL API returns noop spans/contexts when no SDK is configured,
 * which is fine for verifying the API contract.
 */

import { describe, expect, it } from "bun:test";

import {
  endSpan,
  extractTraceContext,
  injectTraceContext,
  startRouterSpan,
  startStepSpan,
  startWorkflowSpan,
} from "./propagation";

describe("extractTraceContext", () => {
  it("returns a context when given a trace context", () => {
    const ctx = extractTraceContext({
      traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    });

    expect(ctx).toBeDefined();
  });

  it("returns active context when given undefined", () => {
    const ctx = extractTraceContext(undefined);

    expect(ctx).toBeDefined();
  });

  it("returns active context when given empty object", () => {
    const ctx = extractTraceContext({});

    expect(ctx).toBeDefined();
  });
});

describe("injectTraceContext", () => {
  it("returns an object", () => {
    const carrier = injectTraceContext();

    expect(carrier).toBeDefined();
    expect(typeof carrier).toBe("object");
  });
});

describe("startRouterSpan", () => {
  it("returns a span", () => {
    const ctx = extractTraceContext(undefined);
    const span = startRouterSpan("user.created", "auth-service", ctx);

    expect(span).toBeDefined();
    expect(typeof span.end).toBe("function");

    span.end();
  });
});

describe("startWorkflowSpan", () => {
  it("returns a span", () => {
    const ctx = extractTraceContext(undefined);
    const span = startWorkflowSpan("wf-1", "run-1", ctx);

    expect(span).toBeDefined();
    expect(typeof span.end).toBe("function");

    span.end();
  });
});

describe("startStepSpan", () => {
  it("returns a span", () => {
    const span = startStepSpan("step-1", "action");

    expect(span).toBeDefined();
    expect(typeof span.end).toBe("function");

    span.end();
  });

  it("accepts an optional step name", () => {
    const span = startStepSpan("step-1", "action", "Send email");

    expect(span).toBeDefined();

    span.end();
  });
});

describe("endSpan", () => {
  it("ends a span without error", () => {
    const ctx = extractTraceContext(undefined);
    const span = startRouterSpan("test.event", "test", ctx);

    expect(() => endSpan(span)).not.toThrow();
  });

  it("ends a span with an Error", () => {
    const ctx = extractTraceContext(undefined);
    const span = startRouterSpan("test.event", "test", ctx);

    expect(() => endSpan(span, new Error("test failure"))).not.toThrow();
  });

  it("ends a span with a string error", () => {
    const ctx = extractTraceContext(undefined);
    const span = startRouterSpan("test.event", "test", ctx);

    expect(() => endSpan(span, "something went wrong")).not.toThrow();
  });
});
