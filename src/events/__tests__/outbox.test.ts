import { afterEach, describe, expect, it, mock } from "bun:test";

// -- Module mocks (must be before imports that use them) --

const mockPublish = mock(() => Promise.resolve({ id: "evt-1" }));

mock.module("lib/logger", () => ({
  default: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
    debug: mock(() => undefined),
  },
}));

// Track rows that the sweeper will "select"
let pendingRows: {
  id: string;
  topic: string;
  payload: unknown;
  createdAt: Date;
  publishedAt: Date | null;
}[] = [];

const createMockUpdate = () => ({
  set: (_values: Record<string, unknown>) => ({
    where: (_condition: unknown) => Promise.resolve(),
  }),
});

mock.module("db", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => ({
            orderBy: () => Promise.resolve(pendingRows),
          }),
        }),
      }),
    }),
    update: () => createMockUpdate(),
  }),
}));

mock.module("db/schema", () => ({
  outboxTable: {
    publishedAt: "published_at",
    createdAt: "created_at",
    id: "id",
  },
}));

mock.module("../publisher", () => ({
  publish: mockPublish,
}));

import OutboxSweeper from "../outbox";

afterEach(() => {
  pendingRows = [];
  mockPublish.mockClear();
  mockPublish.mockImplementation(() => Promise.resolve({ id: "evt-1" }));
});

describe("OutboxSweeper", () => {
  describe("sweep", () => {
    it("publishes pending events and returns count", async () => {
      pendingRows = [
        {
          id: "row-1",
          topic: "org-abc",
          payload: { type: "user.created", source: "test", organizationId: "org-abc", data: {} },
          createdAt: new Date(),
          publishedAt: null,
        },
        {
          id: "row-2",
          topic: "org-abc",
          payload: { type: "user.updated", source: "test", organizationId: "org-abc", data: {} },
          createdAt: new Date(),
          publishedAt: null,
        },
      ];

      const sweeper = new OutboxSweeper();
      const count = await sweeper.sweep();

      expect(count).toBe(2);
      expect(mockPublish).toHaveBeenCalledTimes(2);
      expect(mockPublish).toHaveBeenNthCalledWith(1, pendingRows[0].payload);
      expect(mockPublish).toHaveBeenNthCalledWith(2, pendingRows[1].payload);
    });

    it("returns 0 when no pending events exist", async () => {
      pendingRows = [];

      const sweeper = new OutboxSweeper();
      const count = await sweeper.sweep();

      expect(count).toBe(0);
      expect(mockPublish).not.toHaveBeenCalled();
    });

    it("logs warning and skips failed publishes without marking as published", async () => {
      const warnMock = mock(() => undefined);

      // Re-mock logger to capture warn calls
      mock.module("lib/logger", () => ({
        default: {
          info: mock(() => undefined),
          warn: warnMock,
          error: mock(() => undefined),
          debug: mock(() => undefined),
        },
      }));

      pendingRows = [
        {
          id: "row-fail",
          topic: "org-xyz",
          payload: { type: "order.placed", source: "test", organizationId: "org-xyz", data: {} },
          createdAt: new Date(),
          publishedAt: null,
        },
      ];

      // Make publish throw for this test
      mockPublish.mockImplementation(() => Promise.reject(new Error("Iggy unavailable")));

      const sweeper = new OutboxSweeper();
      const count = await sweeper.sweep();

      expect(count).toBe(0);
      expect(mockPublish).toHaveBeenCalledTimes(1);
    });

    it("continues processing remaining rows after a single publish failure", async () => {
      let callCount = 0;
      mockPublish.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.reject(new Error("transient"));
        return Promise.resolve({ id: `evt-${callCount}` });
      });

      pendingRows = [
        {
          id: "row-a",
          topic: "org-1",
          payload: { type: "a", source: "test", organizationId: "org-1", data: {} },
          createdAt: new Date(),
          publishedAt: null,
        },
        {
          id: "row-b",
          topic: "org-1",
          payload: { type: "b", source: "test", organizationId: "org-1", data: {} },
          createdAt: new Date(),
          publishedAt: null,
        },
      ];

      const sweeper = new OutboxSweeper();
      const count = await sweeper.sweep();

      // First row fails, second succeeds
      expect(count).toBe(1);
      expect(mockPublish).toHaveBeenCalledTimes(2);
    });
  });

  describe("start/stop", () => {
    it("starts and stops the sweep interval without throwing", () => {
      const sweeper = new OutboxSweeper();

      // Should not throw
      sweeper.start();
      sweeper.stop();
    });

    it("is idempotent when called multiple times", () => {
      const sweeper = new OutboxSweeper();

      sweeper.start();
      sweeper.start(); // Second call should be a no-op
      sweeper.stop();
      sweeper.stop(); // Second call should be a no-op
    });
  });
});
