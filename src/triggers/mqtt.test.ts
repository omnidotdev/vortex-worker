/**
 * MQTT Trigger Runner Tests
 */

import { describe, expect, it, mock } from "bun:test";

// Stub db
const mockInsert = mock(() => ({
  values: mock(() => ({
    returning: mock(() =>
      Promise.resolve([{ id: "run-1", engineWorkflowId: "mqtt-wf-1-123" }]),
    ),
  })),
}));

const mockUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => Promise.resolve()),
  })),
}));

const mockFindMany = mock(() => Promise.resolve([]));

mock.module("db", () => ({
  getDb: () => ({
    insert: mockInsert,
    update: mockUpdate,
    query: {
      workflowTable: {
        findMany: mockFindMany,
      },
    },
  }),
}));

// Stub hatchet
const mockEventPush = mock(() => Promise.resolve());
mock.module("@hatchet-dev/typescript-sdk", () => ({
  default: {
    init: () => ({
      event: { push: mockEventPush },
    }),
  },
}));

// Stub adapters - provide a minimal MqttAdapter stub
class MockMqttAdapter {
  name = "mqtt";
  source = "mqtt";

  onEvent(_handler: unknown) {}
  async start() {}
  async stop() {}
}

mock.module("adapters", () => ({
  MqttAdapter: MockMqttAdapter,
}));

// Stub mqtt
mock.module("mqtt", () => ({
  default: {
    connect: mock(() => ({
      once: mock(() => {}),
      on: mock(() => {}),
      subscribe: mock(() => {}),
      end: mock((_f: boolean, _o: unknown, cb: () => void) => cb()),
    })),
  },
}));

// Stub db/schema
mock.module("db/schema", () => ({
  workflowTable: {},
  workflowRunTable: {},
}));

// Stub drizzle-orm
mock.module("drizzle-orm", () => ({
  eq: mock((col: unknown, val: unknown) => ({ col, val })),
}));

// Stub lib/logger
mock.module("lib/logger", () => ({
  default: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
  },
}));

import { buildActiveMqttAdapters } from "./mqtt";

import type { Workflow } from "db/schema";

describe("MQTT trigger runner", () => {
  describe("extractMqttConfig (via buildActiveMqttAdapters)", () => {
    it("returns adapter for workflow with valid mqtt trigger config", async () => {
      const workflows: Pick<
        Workflow,
        "id" | "organizationId" | "definition"
      >[] = [
        {
          id: "wf-1",
          organizationId: "org-1",
          definition: {
            steps: [
              {
                type: "trigger",
                trigger: {
                  type: "mqtt",
                  config: {
                    brokerUrl: "mqtt://broker:1883",
                    topic: "sensors/temperature",
                  },
                },
              },
            ],
          },
        },
      ];

      const adapters = await buildActiveMqttAdapters(workflows);
      expect(adapters.size).toBe(1);
      expect(adapters.has("wf-1")).toBe(true);
    });

    it("returns empty map for workflow with non-mqtt trigger", async () => {
      const workflows: Pick<
        Workflow,
        "id" | "organizationId" | "definition"
      >[] = [
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

      const adapters = await buildActiveMqttAdapters(workflows);
      expect(adapters.size).toBe(0);
    });

    it("returns empty map when brokerUrl is missing", async () => {
      const workflows: Pick<
        Workflow,
        "id" | "organizationId" | "definition"
      >[] = [
        {
          id: "wf-3",
          organizationId: "org-1",
          definition: {
            steps: [
              {
                type: "trigger",
                trigger: {
                  type: "mqtt",
                  config: { topic: "test/topic" }, // missing brokerUrl
                },
              },
            ],
          },
        },
      ];

      const adapters = await buildActiveMqttAdapters(workflows);
      expect(adapters.size).toBe(0);
    });

    it("returns empty map when topic is missing", async () => {
      const workflows: Pick<
        Workflow,
        "id" | "organizationId" | "definition"
      >[] = [
        {
          id: "wf-4",
          organizationId: "org-1",
          definition: {
            steps: [
              {
                type: "trigger",
                trigger: {
                  type: "mqtt",
                  config: { brokerUrl: "mqtt://broker:1883" }, // missing topic
                },
              },
            ],
          },
        },
      ];

      const adapters = await buildActiveMqttAdapters(workflows);
      expect(adapters.size).toBe(0);
    });

    it("handles workflows without steps", async () => {
      const workflows: Pick<
        Workflow,
        "id" | "organizationId" | "definition"
      >[] = [
        {
          id: "wf-5",
          organizationId: "org-1",
          definition: {},
        },
      ];

      const adapters = await buildActiveMqttAdapters(workflows);
      expect(adapters.size).toBe(0);
    });

    it("handles multiple workflows, only returns mqtt ones", async () => {
      const workflows: Pick<
        Workflow,
        "id" | "organizationId" | "definition"
      >[] = [
        {
          id: "wf-mqtt",
          organizationId: "org-1",
          definition: {
            steps: [
              {
                type: "trigger",
                trigger: {
                  type: "mqtt",
                  config: { brokerUrl: "mqtt://broker:1883", topic: "test" },
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

      const adapters = await buildActiveMqttAdapters(workflows);
      expect(adapters.size).toBe(1);
      expect(adapters.has("wf-mqtt")).toBe(true);
      expect(adapters.has("wf-kafka")).toBe(false);
    });
  });
});
