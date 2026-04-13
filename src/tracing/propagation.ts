/**
 * W3C Trace Context propagation helpers.
 *
 * Uses `@opentelemetry/api` only (no SDK dependencies). The SDK is configured
 * in `instrumentation.ts` and loaded via `--import` before the worker starts.
 */

import {
  SpanKind,
  SpanStatusCode,
  context,
  propagation,
  trace,
} from "@opentelemetry/api";

import type { Context, Span } from "@opentelemetry/api";

const tracer = trace.getTracer("vortex-worker");

type TraceContext = { traceparent?: string; tracestate?: string };

/**
 * Extract a `Context` from an event's trace context fields.
 *
 * If `traceCtx` is undefined or empty, returns the current active context
 * so downstream spans still attach to whatever is already active.
 * @param traceCtx - W3C Trace Context carrier from the event envelope
 * @returns Extracted OTEL context
 */
const extractTraceContext = (traceCtx?: TraceContext): Context => {
  if (!traceCtx) return context.active();

  return propagation.extract(context.active(), traceCtx);
};

/**
 * Inject the current active context into a carrier object.
 * @returns Carrier with `traceparent` and optionally `tracestate`
 */
const injectTraceContext = (): TraceContext => {
  const carrier: TraceContext = {};
  propagation.inject(context.active(), carrier);

  return carrier;
};

/**
 * Start a CONSUMER span for event routing.
 * @param eventType - Event type being routed (e.g. `user.created`)
 * @param eventSource - Event source identifier
 * @param parentCtx - Parent context extracted from the event
 * @returns New span (caller must end it)
 */
const startRouterSpan = (
  eventType: string,
  eventSource: string,
  parentCtx: Context,
): Span => {
  return tracer.startSpan(
    "vortex.event.route",
    {
      kind: SpanKind.CONSUMER,
      attributes: {
        "vortex.event.type": eventType,
        "vortex.event.source": eventSource,
      },
    },
    parentCtx,
  );
};

/**
 * Start an INTERNAL span for workflow execution.
 * @param workflowId - Workflow identifier
 * @param runId - Workflow run identifier
 * @param parentCtx - Parent context
 * @returns New span (caller must end it)
 */
const startWorkflowSpan = (
  workflowId: string,
  runId: string,
  parentCtx: Context,
): Span => {
  return tracer.startSpan(
    "vortex.workflow.execute",
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        "vortex.workflow.id": workflowId,
        "vortex.workflow.run_id": runId,
      },
    },
    parentCtx,
  );
};

/**
 * Start an INTERNAL span for step execution.
 * @param stepId - Step identifier
 * @param stepType - Step type (e.g. `action`, `condition`)
 * @param stepName - Optional human-readable step name
 * @returns New span (caller must end it)
 */
const startStepSpan = (
  stepId: string,
  stepType: string,
  stepName?: string,
): Span => {
  return tracer.startSpan("vortex.step.execute", {
    kind: SpanKind.INTERNAL,
    attributes: {
      "vortex.step.id": stepId,
      "vortex.step.type": stepType,
      ...(stepName && { "vortex.step.name": stepName }),
    },
  });
};

/**
 * End a span, optionally recording an error.
 *
 * When `error` is provided the span status is set to ERROR, the exception
 * is recorded, and the span is ended. Otherwise the span is ended normally.
 * @param span - Span to end
 * @param error - Optional error to record
 */
const endSpan = (span: Span, error?: unknown): void => {
  if (error) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error instanceof Error ? error.message : String(error),
    });
    span.recordException(
      error instanceof Error ? error : new Error(String(error)),
    );
  }

  span.end();
};

export type { TraceContext };
export {
  endSpan,
  extractTraceContext,
  injectTraceContext,
  startRouterSpan,
  startStepSpan,
  startWorkflowSpan,
};
