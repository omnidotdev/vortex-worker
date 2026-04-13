/**
 * AMQP Trigger Runner Tests
 */

import { describe, expect, it, mock } from "bun:test";

// Stub db
const mockInsert = mock(() => ({
  values: mock(() => ({
    returning: mock(() =>
      Promise.resolve([{ id: "run-1", engineWorkflowId: "amqp-wf-1-123" }]),
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

// Stub adapters - provide a minimal AmqpAdapter stub
class MockAmqpAdapter {
  name = "amqp";
  source = "amqp";

  onEvent(_handler: unknown) {}
  async start() {}
  async stop() {}
}

mock.module("adapters", () => ({
  AmqpAdapter: MockAmqpAdapter,
}));

// Stub amqplib
mock.module("amqplib", () => ({
  default: {
    connect: mock(() =>
      Promise.resolve({
        createChannel: mock(() =>
          Promise.resolve({
            assertQueue: mock(() => Promise.resolve()),
            bindQueue: mock(() => Promise.resolve()),
            consume: mock(() => Promise.resolve()),
            prefetch: mock(() => Promise.resolve()),
            ack: mock(() => undefined),
            nack: mock(() => undefined),
            close: mock(() => Promise.resolve()),
          }),
        ),
        close: mock(() => Promise.resolve()),
      }),
    ),
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

import { buildActiveAmqpAdapters } from "./amqp";

import type { Workflow } from "db/schema";

describe("AMQP trigger runner", () => {
  describe("extractAmqpConfig (via buildActiveAmqpAdapters)", () => {
    it("returns adapter for workflow with valid amqp trigger config", async () => {
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
                  type: "amqp",
                  config: {
                    url: "amqp://localhost:5672",
                    queue: "events",
                  },
                },
              },
            ],
          },
        },
      ];

      const adapters = await buildActiveAmqpAdapters(workflows);
      expect(adapters.size).toBe(1);
      expect(adapters.has("wf-1")).toBe(true);
    });

    it("returns empty map for workflow with non-amqp trigger", async () => {
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
                trigger: { type: "webhook", config: {} },
              },
            ],
          },
        },
      ];
      const adapters = await buildActiveAmqpAdapters(workflows);
      expect(adapters.size).toBe(0);
    });

    it("returns empty map when url is missing", async () => {
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
                  type: "amqp",
                  config: { queue: "events" },
                },
              },
            ],
          },
        },
      ];
      const adapters = await buildActiveAmqpAdapters(workflows);
      expect(adapters.size).toBe(0);
    });

    it("returns empty map when queue is missing", async () => {
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
                  type: "amqp",
                  config: { url: "amqp://localhost:5672" },
                },
              },
            ],
          },
        },
      ];
      const adapters = await buildActiveAmqpAdapters(workflows);
      expect(adapters.size).toBe(0);
    });

    it("handles workflows without steps", async () => {
      const workflows: Pick<
        Workflow,
        "id" | "organizationId" | "definition"
      >[] = [{ id: "wf-5", organizationId: "org-1", definition: {} }];
      const adapters = await buildActiveAmqpAdapters(workflows);
      expect(adapters.size).toBe(0);
    });

    it("handles multiple workflows, only returns amqp ones", async () => {
      const workflows: Pick<
        Workflow,
        "id" | "organizationId" | "definition"
      >[] = [
        {
          id: "wf-amqp",
          organizationId: "org-1",
          definition: {
            steps: [
              {
                type: "trigger",
                trigger: {
                  type: "amqp",
                  config: {
                    url: "amqp://localhost:5672",
                    queue: "events",
                  },
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
      const adapters = await buildActiveAmqpAdapters(workflows);
      expect(adapters.size).toBe(1);
      expect(adapters.has("wf-amqp")).toBe(true);
      expect(adapters.has("wf-kafka")).toBe(false);
    });
  });
});
