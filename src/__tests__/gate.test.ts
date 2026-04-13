/**
 * Gate Plugin Tests
 *
 * Tests for the DB-backed approval gate plugin covering
 * execute (create request) and check (poll status) actions.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

import type { PluginContext } from "../plugins/types";

// --- Mock DB layer ---

let mockRows: Record<string, Record<string, unknown>> = {};

const mockInsert = mock(() => ({
  values: mock((row: Record<string, unknown>) => {
    const id = crypto.randomUUID();
    mockRows[id] = { id, ...row, status: "pending", createdAt: new Date() };

    return {
      returning: mock(() => [{ id }]),
    };
  }),
}));

const mockUpdate = mock(() => ({
  set: mock((values: Record<string, unknown>) => ({
    where: mock((_cond: unknown) => {
      // Apply the update to the first matching row (simplified)
      const id = Object.keys(mockRows)[0];
      if (id) {
        Object.assign(mockRows[id], values);
      }
    }),
  })),
}));

const mockFindFirst = mock(
  async ({ where: _where }: { where: unknown }) => undefined as unknown,
);

const mockDb = {
  insert: mockInsert,
  update: mockUpdate,
  query: {
    approvalRequestTable: {
      findFirst: mockFindFirst,
    },
  },
};

mock.module("db", () => ({
  getDb: () => mockDb,
}));

// Must be imported AFTER mock.module
const { gatePlugin } = await import("../plugins/builtin/gate");

const baseContext: PluginContext = {
  workflowId: "wf-001",
  runId: "run-001",
  stepId: "step-gate-1",
  organizationId: "org-123",
  config: {},
  secrets: {},
};

describe("gatePlugin", () => {
  beforeEach(() => {
    mockRows = {};
    mockFindFirst.mockReset();
    mockInsert.mockClear();
    mockUpdate.mockClear();
  });

  describe("execute action", () => {
    it("should create an approval request and return pending status", async () => {
      const result = await gatePlugin.actions.execute.handler(
        { gateType: "approval", title: "Deploy to prod" },
        baseContext,
      );

      expect(result.success).toBe(true);
      expect(result.output?.status).toBe("pending");
      expect(result.output?.gateType).toBe("approval");
      expect(result.output?.requestId).toBeDefined();
      expect(typeof result.output?.requestId).toBe("string");
    });

    it("should fail when context is missing", async () => {
      const result = await gatePlugin.actions.execute.handler(
        { gateType: "approval" },
        undefined,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("context is required");
    });

    it("should default gateType to approval", async () => {
      const result = await gatePlugin.actions.execute.handler({}, baseContext);

      expect(result.success).toBe(true);
      expect(result.output?.gateType).toBe("approval");
    });
  });

  describe("check action", () => {
    it("should return the correct status for a found request", async () => {
      mockFindFirst.mockResolvedValueOnce({
        id: "req-001",
        status: "approved",
        decidedBy: "user-42",
        reason: "LGTM",
        signalData: null,
        timeoutMs: null,
        timeoutAction: "reject",
        createdAt: new Date(),
      });

      const result = await gatePlugin.actions.check.handler({
        requestId: "req-001",
      });

      expect(result.success).toBe(true);
      expect(result.output?.status).toBe("approved");
      expect(result.output?.passed).toBe(true);
      expect(result.output?.decidedBy).toBe("user-42");
      expect(result.output?.reason).toBe("LGTM");
    });

    it("should return error for a not-found request", async () => {
      mockFindFirst.mockResolvedValueOnce(undefined);

      const result = await gatePlugin.actions.check.handler({
        requestId: "does-not-exist",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });

    it("should fail when requestId is missing", async () => {
      const result = await gatePlugin.actions.check.handler({});

      expect(result.success).toBe(false);
      expect(result.error).toContain("requestId is required");
    });

    it("should auto-decide when timeout has elapsed", async () => {
      const pastDate = new Date(Date.now() - 60_000);

      mockFindFirst.mockResolvedValueOnce({
        id: "req-timeout",
        status: "pending",
        decidedBy: null,
        reason: null,
        signalData: null,
        timeoutMs: "30000",
        timeoutAction: "approve",
        createdAt: pastDate,
      });

      const result = await gatePlugin.actions.check.handler({
        requestId: "req-timeout",
      });

      expect(result.success).toBe(true);
      expect(result.output?.status).toBe("approved");
      expect(result.output?.passed).toBe(true);
      expect(result.output?.decidedBy).toBe("system:timeout");
      expect(result.output?.reason).toContain("Auto-approve");
    });

    it("should auto-reject when timeout elapses with reject action", async () => {
      const pastDate = new Date(Date.now() - 60_000);

      mockFindFirst.mockResolvedValueOnce({
        id: "req-reject",
        status: "pending",
        decidedBy: null,
        reason: null,
        signalData: null,
        timeoutMs: "5000",
        timeoutAction: "reject",
        createdAt: pastDate,
      });

      const result = await gatePlugin.actions.check.handler({
        requestId: "req-reject",
      });

      expect(result.success).toBe(true);
      expect(result.output?.status).toBe("rejected");
      expect(result.output?.passed).toBe(false);
      expect(result.output?.decidedBy).toBe("system:timeout");
    });

    it("should not auto-decide when timeout has not elapsed", async () => {
      const recentDate = new Date();

      mockFindFirst.mockResolvedValueOnce({
        id: "req-waiting",
        status: "pending",
        decidedBy: null,
        reason: null,
        signalData: null,
        timeoutMs: "300000",
        timeoutAction: "reject",
        createdAt: recentDate,
      });

      const result = await gatePlugin.actions.check.handler({
        requestId: "req-waiting",
      });

      expect(result.success).toBe(true);
      expect(result.output?.status).toBe("pending");
      expect(result.output?.passed).toBe(false);
    });
  });
});
