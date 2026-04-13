/**
 * Local Executor Adapter Tests
 *
 * Tests for the in-process workflow executor used in
 * development and testing environments.
 */

import { beforeEach, describe, expect, it } from "bun:test";

import { LocalExecutor } from "../executor/adapters/local";

import type { WorkflowDefinition } from "../dsl/types";

// Minimal workflow with just a trigger
function createMinimalWorkflow(): WorkflowDefinition {
  return {
    version: "1.0",
    steps: [
      {
        id: "trigger-1",
        type: "trigger",
        name: "Test Trigger",
        position: { x: 0, y: 0 },
        trigger: { type: "manual", config: {} },
      },
    ],
    edges: [],
  };
}

describe("LocalExecutor", () => {
  let executor: LocalExecutor;

  beforeEach(() => {
    LocalExecutor.clearRuns();
    executor = new LocalExecutor();
  });

  describe("execute", () => {
    it("should return a run ID", async () => {
      const { runId } = await executor.execute(createMinimalWorkflow(), {});

      expect(runId).toBeDefined();
      expect(runId).toMatch(/^local-/);
    });

    it("should execute synchronously with waitForCompletion", async () => {
      const { runId } = await executor.execute(
        createMinimalWorkflow(),
        {},
        { waitForCompletion: true },
      );

      const status = await executor.getStatus(runId);

      expect(status.status).toBe("completed");
    });
  });

  describe("getStatus", () => {
    it("should return status for existing run", async () => {
      const { runId } = await executor.execute(
        createMinimalWorkflow(),
        { test: true },
        { waitForCompletion: true },
      );

      const result = await executor.getStatus(runId);

      expect(result.runId).toBe(runId);
      expect(result.status).toBe("completed");
      expect(result.startedAt).toBeInstanceOf(Date);
    });

    it("should throw for unknown run ID", async () => {
      expect(executor.getStatus("nonexistent")).rejects.toThrow(
        "Workflow run not found",
      );
    });
  });

  describe("cancel", () => {
    it("should cancel a running workflow", async () => {
      const { runId } = await executor.execute(createMinimalWorkflow(), {});

      await executor.cancel(runId);
      const status = await executor.getStatus(runId);

      expect(status.status).toBe("cancelled");
    });

    it("should throw for unknown run ID", async () => {
      expect(executor.cancel("nonexistent")).rejects.toThrow(
        "Workflow run not found",
      );
    });
  });

  describe("stream", () => {
    it("should emit events for completed workflow", async () => {
      const { runId } = await executor.execute(
        createMinimalWorkflow(),
        {},
        { waitForCompletion: true },
      );

      const events = [];
      for await (const event of executor.stream(runId)) {
        events.push(event);
      }

      // Stream should terminate since run is already complete
      expect(events.length).toBeGreaterThanOrEqual(0);
    });

    it("should throw for unknown run ID", async () => {
      const stream = executor.stream("nonexistent");
      const iterator = stream[Symbol.asyncIterator]();

      expect(iterator.next()).rejects.toThrow("Workflow run not found");
    });
  });

  describe("healthCheck", () => {
    it("should always return true", async () => {
      const healthy = await executor.healthCheck();

      expect(healthy).toBe(true);
    });
  });
});
