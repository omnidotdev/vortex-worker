import { describe, expect, it, mock } from "bun:test";

// Mock WebSocket global
const mockWs = {
  addEventListener: mock(
    (event: string, handler: (...args: unknown[]) => void) => {
      if (event === "open") {
        setTimeout(() => handler({}), 0);
      }
    },
  ),
  send: mock(() => {}),
  close: mock(() => {}),
  readyState: 1, // OPEN
};

const MockWebSocket = mock(() => mockWs) as unknown as typeof WebSocket;
(MockWebSocket as unknown as { OPEN: number }).OPEN = 1;
globalThis.WebSocket = MockWebSocket;

// Mock db and hatchet
mock.module("db", () => ({
  getDb: () => ({
    query: {
      workflowTable: {
        findMany: mock(async () => []),
      },
    },
    insert: mock(() => ({
      values: () => ({
        returning: async () => [{ id: "run-1", engineWorkflowId: "eng-1" }],
      }),
    })),
    update: mock(() => ({
      set: () => ({ where: async () => [] }),
    })),
  }),
}));

mock.module("db/schema", () => ({
  workflowTable: { isActive: "isActive" },
  workflowRunTable: {},
}));

mock.module("drizzle-orm", () => ({
  eq: mock(() => ({})),
}));

mock.module("lib/logger", () => ({
  default: {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  },
}));

mock.module("@hatchet-dev/typescript-sdk", () => ({
  default: {
    init: mock(() => ({
      event: {
        push: mock(async () => {}),
      },
    })),
  },
}));

mock.module("adapters", () => {
  const { WebSocketAdapter } = require("../adapters/websocket.adapter");
  return { WebSocketAdapter };
});

import { buildActiveWebSocketAdapters } from "./websocket";

describe("WebSocket trigger runner", () => {
  describe("extractWebSocketConfig (via buildActiveWebSocketAdapters)", () => {
    it("returns adapter for workflow with valid websocket trigger config", async () => {
      const workflows = [
        {
          id: "wf-1",
          organizationId: "org-1",
          definition: {
            steps: [
              {
                type: "trigger",
                trigger: {
                  type: "websocket",
                  config: { url: "wss://example.com/ws" },
                },
              },
            ],
          },
        },
      ];

      const adapters = await buildActiveWebSocketAdapters(workflows);
      expect(adapters.size).toBe(1);
      expect(adapters.has("wf-1")).toBe(true);
    });

    it("returns empty map for workflow with non-websocket trigger", async () => {
      const workflows = [
        {
          id: "wf-2",
          organizationId: "org-1",
          definition: {
            steps: [
              {
                type: "trigger",
                trigger: {
                  type: "webhook",
                  config: {},
                },
              },
            ],
          },
        },
      ];

      const adapters = await buildActiveWebSocketAdapters(workflows);
      expect(adapters.size).toBe(0);
    });

    it("returns empty map when url is missing", async () => {
      const workflows = [
        {
          id: "wf-3",
          organizationId: "org-1",
          definition: {
            steps: [
              {
                type: "trigger",
                trigger: {
                  type: "websocket",
                  config: { messageFormat: "json" }, // missing url
                },
              },
            ],
          },
        },
      ];

      const adapters = await buildActiveWebSocketAdapters(workflows);
      expect(adapters.size).toBe(0);
    });

    it("handles workflows without steps", async () => {
      const workflows = [
        {
          id: "wf-4",
          organizationId: "org-1",
          definition: {},
        },
      ];

      const adapters = await buildActiveWebSocketAdapters(workflows);
      expect(adapters.size).toBe(0);
    });

    it("handles multiple workflows, only returns websocket ones", async () => {
      const workflows = [
        {
          id: "wf-ws",
          organizationId: "org-1",
          definition: {
            steps: [
              {
                type: "trigger",
                trigger: {
                  type: "websocket",
                  config: { url: "wss://example.com/ws" },
                },
              },
            ],
          },
        },
        {
          id: "wf-kafka",
          organizationId: "org-1",
          definition: {
            steps: [
              {
                type: "trigger",
                trigger: {
                  type: "kafka",
                  config: {
                    brokers: ["localhost:9092"],
                    topic: "events",
                    groupId: "g1",
                  },
                },
              },
            ],
          },
        },
      ];

      const adapters = await buildActiveWebSocketAdapters(workflows);
      expect(adapters.size).toBe(1);
      expect(adapters.has("wf-ws")).toBe(true);
      expect(adapters.has("wf-kafka")).toBe(false);
    });
  });
});
