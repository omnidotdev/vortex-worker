/**
 * DSL Executor Tests
 *
 * Tests for the core workflow execution engine.
 */

import { describe, expect, it } from "bun:test";

import {
  createExecutionContext,
  executeStep,
  findNextSteps,
  findTriggerStep,
} from "../dsl/executor";

import type {
  ConditionStep,
  DelayStep,
  Edge,
  LoopStep,
  Step,
  SwitchStep,
  TriggerStep,
  WorkflowDefinition,
} from "../dsl/types";

// Helper to create a minimal workflow definition
function createWorkflow(steps: Step[], edges: Edge[] = []): WorkflowDefinition {
  return {
    version: "1.0",
    steps,
    edges,
  };
}

// Helper to create a trigger step
function createTriggerStep(id = "trigger-1"): TriggerStep {
  return {
    id,
    type: "trigger",
    name: "Test Trigger",
    position: { x: 0, y: 0 },
    trigger: {
      type: "manual",
      config: {},
    },
  };
}

describe("findTriggerStep", () => {
  it("should find trigger step in workflow", () => {
    const trigger = createTriggerStep();
    const steps: Step[] = [trigger];

    const result = findTriggerStep(steps);

    expect(result).toBeDefined();
    expect(result?.id).toBe("trigger-1");
    expect(result?.type).toBe("trigger");
  });

  it("should return undefined when no trigger exists", () => {
    const steps: Step[] = [];

    const result = findTriggerStep(steps);

    expect(result).toBeUndefined();
  });

  it("should find first trigger when multiple exist", () => {
    const trigger1 = createTriggerStep("trigger-1");
    const trigger2 = createTriggerStep("trigger-2");
    const steps: Step[] = [trigger1, trigger2];

    const result = findTriggerStep(steps);

    expect(result?.id).toBe("trigger-1");
  });
});

describe("findNextSteps", () => {
  it("should find next steps based on edges", () => {
    const trigger = createTriggerStep("trigger-1");
    const delay: DelayStep = {
      id: "delay-1",
      type: "delay",
      name: "Wait",
      position: { x: 100, y: 0 },
      delay: { duration: 1, unit: "seconds" },
    };

    const edges: Edge[] = [
      { id: "e1", source: "trigger-1", target: "delay-1" },
    ];

    const def = createWorkflow([trigger, delay], edges);
    const nextSteps = findNextSteps(def, "trigger-1");

    expect(nextSteps).toHaveLength(1);
    expect(nextSteps[0].id).toBe("delay-1");
  });

  it("should find multiple next steps for parallel branches", () => {
    const trigger = createTriggerStep("trigger-1");
    const delay1: DelayStep = {
      id: "delay-1",
      type: "delay",
      name: "Wait 1",
      position: { x: 100, y: 0 },
      delay: { duration: 1, unit: "seconds" },
    };
    const delay2: DelayStep = {
      id: "delay-2",
      type: "delay",
      name: "Wait 2",
      position: { x: 100, y: 100 },
      delay: { duration: 2, unit: "seconds" },
    };

    const edges: Edge[] = [
      { id: "e1", source: "trigger-1", target: "delay-1" },
      { id: "e2", source: "trigger-1", target: "delay-2" },
    ];

    const def = createWorkflow([trigger, delay1, delay2], edges);
    const nextSteps = findNextSteps(def, "trigger-1");

    expect(nextSteps).toHaveLength(2);
  });

  it("should filter by sourceHandle when provided", () => {
    const condition: ConditionStep = {
      id: "cond-1",
      type: "condition",
      name: "Check",
      position: { x: 0, y: 0 },
      condition: {
        expression: "true",
        trueBranch: "delay-1",
        falseBranch: "delay-2",
      },
    };
    const delay1: DelayStep = {
      id: "delay-1",
      type: "delay",
      name: "True Branch",
      position: { x: 100, y: 0 },
      delay: { duration: 1, unit: "seconds" },
    };
    const delay2: DelayStep = {
      id: "delay-2",
      type: "delay",
      name: "False Branch",
      position: { x: 100, y: 100 },
      delay: { duration: 2, unit: "seconds" },
    };

    const edges: Edge[] = [
      { id: "e1", source: "cond-1", target: "delay-1", sourceHandle: "true" },
      { id: "e2", source: "cond-1", target: "delay-2", sourceHandle: "false" },
    ];

    const def = createWorkflow([condition, delay1, delay2], edges);

    const trueNext = findNextSteps(def, "cond-1", "true");
    expect(trueNext).toHaveLength(1);
    expect(trueNext[0].id).toBe("delay-1");

    const falseNext = findNextSteps(def, "cond-1", "false");
    expect(falseNext).toHaveLength(1);
    expect(falseNext[0].id).toBe("delay-2");
  });

  it("should return empty array when no edges exist", () => {
    const trigger = createTriggerStep();
    const def = createWorkflow([trigger], []);

    const nextSteps = findNextSteps(def, "trigger-1");

    expect(nextSteps).toHaveLength(0);
  });
});

describe("createExecutionContext", () => {
  it("should create context with initial values", () => {
    const ctx = createExecutionContext("wf-123", "run-456", { foo: "bar" });

    expect(ctx.workflowId).toBe("wf-123");
    expect(ctx.runId).toBe("run-456");
    expect(ctx.triggerData).toEqual({ foo: "bar" });
    expect(ctx.variables).toEqual({});
    expect(ctx.stepResults).toEqual({});
  });
});

describe("executeStep", () => {
  describe("trigger step", () => {
    it("should return trigger data", async () => {
      const trigger = createTriggerStep();
      const def = createWorkflow([trigger]);
      const ctx = createExecutionContext("wf-1", "run-1", {
        event: "test",
        data: { value: 42 },
      });

      const { result } = await executeStep(def, trigger, ctx);

      expect(result).toEqual({ event: "test", data: { value: 42 } });
    });

    it("should store result in stepResults", async () => {
      const trigger = createTriggerStep();
      const def = createWorkflow([trigger]);
      const ctx = createExecutionContext("wf-1", "run-1", { test: true });

      await executeStep(def, trigger, ctx);

      expect(ctx.stepResults["trigger-1"]).toEqual({ test: true });
    });
  });

  describe("delay step", () => {
    it("should delay execution and return result", async () => {
      const delay: DelayStep = {
        id: "delay-1",
        type: "delay",
        name: "Short Wait",
        position: { x: 0, y: 0 },
        delay: { duration: 10, unit: "seconds" },
      };
      const def = createWorkflow([delay]);
      const ctx = createExecutionContext("wf-1", "run-1", {});

      // Mock setTimeout to avoid actual delay
      const originalSetTimeout = global.setTimeout;
      global.setTimeout = ((fn: () => void) => {
        fn();
        return 0;
      }) as typeof setTimeout;

      const start = Date.now();
      const { result } = await executeStep(def, delay, ctx);
      const elapsed = Date.now() - start;

      global.setTimeout = originalSetTimeout;

      expect(result).toEqual({
        delayed: true,
        duration: 10,
        unit: "seconds",
      });
      // Should be nearly instant with mocked setTimeout
      expect(elapsed).toBeLessThan(100);
    });
  });

  describe("condition step", () => {
    it("should evaluate true expression", async () => {
      const condition: ConditionStep = {
        id: "cond-1",
        type: "condition",
        name: "Is True",
        position: { x: 0, y: 0 },
        condition: {
          expression: "true",
          trueBranch: "next-true",
          falseBranch: "next-false",
        },
      };
      const def = createWorkflow([condition]);
      const ctx = createExecutionContext("wf-1", "run-1", {});

      const { result } = await executeStep(def, condition, ctx);

      expect(result).toEqual({ branch: "true", value: true });
    });

    it("should evaluate false expression", async () => {
      const condition: ConditionStep = {
        id: "cond-1",
        type: "condition",
        name: "Is False",
        position: { x: 0, y: 0 },
        condition: {
          expression: "false",
          trueBranch: "next-true",
          falseBranch: "next-false",
        },
      };
      const def = createWorkflow([condition]);
      const ctx = createExecutionContext("wf-1", "run-1", {});

      const { result } = await executeStep(def, condition, ctx);

      expect(result).toEqual({ branch: "false", value: false });
    });

    it("should evaluate comparison expressions", async () => {
      const condition: ConditionStep = {
        id: "cond-1",
        type: "condition",
        name: "Compare",
        position: { x: 0, y: 0 },
        condition: {
          expression: "{{trigger.value}} > 10",
          trueBranch: "next-true",
          falseBranch: "next-false",
        },
      };
      const def = createWorkflow([condition]);
      const ctx = createExecutionContext("wf-1", "run-1", { value: 15 });

      const { result } = await executeStep(def, condition, ctx);

      expect(result).toEqual({ branch: "true", value: true });
    });
  });

  describe("switch step", () => {
    it("should match case and return correct branch", async () => {
      const switchStep: SwitchStep = {
        id: "switch-1",
        type: "switch",
        name: "Route",
        position: { x: 0, y: 0 },
        switch: {
          expression: "{{trigger.status}}",
          cases: [
            { value: "pending", label: "Pending", next: "handle-pending" },
            { value: "active", label: "Active", next: "handle-active" },
          ],
          default: "handle-default",
        },
      };
      const def = createWorkflow([switchStep]);
      const ctx = createExecutionContext("wf-1", "run-1", { status: "active" });

      const { result } = await executeStep(def, switchStep, ctx);

      expect(result).toEqual({ case: "case_1", matchedValue: "active" });
    });

    it("should return default when no case matches", async () => {
      const switchStep: SwitchStep = {
        id: "switch-1",
        type: "switch",
        name: "Route",
        position: { x: 0, y: 0 },
        switch: {
          expression: "{{trigger.status}}",
          cases: [
            { value: "pending", label: "Pending", next: "handle-pending" },
          ],
          default: "handle-default",
        },
      };
      const def = createWorkflow([switchStep]);
      const ctx = createExecutionContext("wf-1", "run-1", {
        status: "unknown",
      });

      const { result } = await executeStep(def, switchStep, ctx);

      expect(result).toEqual({ case: "default", matchedValue: "unknown" });
    });
  });

  describe("loop step", () => {
    it("should iterate forEach loop", async () => {
      const loop: LoopStep = {
        id: "loop-1",
        type: "loop",
        name: "Iterate",
        position: { x: 0, y: 0 },
        loop: {
          type: "forEach",
          collection: "{{trigger.items}}",
          itemVariable: "item",
          indexVariable: "i",
          body: [],
        },
      };
      const def = createWorkflow([loop]);
      const ctx = createExecutionContext("wf-1", "run-1", {
        items: ["a", "b", "c"],
      });

      const { result } = await executeStep(def, loop, ctx);

      expect(result).toEqual({
        iterations: 3,
        results: [
          { index: 0, item: "a" },
          { index: 1, item: "b" },
          { index: 2, item: "c" },
        ],
      });
    });

    it("should iterate times loop", async () => {
      const loop: LoopStep = {
        id: "loop-1",
        type: "loop",
        name: "Repeat",
        position: { x: 0, y: 0 },
        loop: {
          type: "times",
          count: 3,
          indexVariable: "i",
          body: [],
        },
      };
      const def = createWorkflow([loop]);
      const ctx = createExecutionContext("wf-1", "run-1", {});

      const { result } = await executeStep(def, loop, ctx);

      expect(result).toEqual({
        iterations: 3,
        results: [{ index: 0 }, { index: 1 }, { index: 2 }],
      });
    });

    it("should respect maxIterations limit", async () => {
      const loop: LoopStep = {
        id: "loop-1",
        type: "loop",
        name: "Limited",
        position: { x: 0, y: 0 },
        loop: {
          type: "times",
          count: 100,
          maxIterations: 5,
          body: [],
        },
      };
      const def = createWorkflow([loop]);
      const ctx = createExecutionContext("wf-1", "run-1", {});

      const { result } = await executeStep(def, loop, ctx);

      const loopResult = result as { iterations: number };
      expect(loopResult.iterations).toBe(5);
    });
  });
});

describe("template expression resolution", () => {
  it("should resolve trigger data in expressions", async () => {
    const condition: ConditionStep = {
      id: "cond-1",
      type: "condition",
      name: "Check Trigger",
      position: { x: 0, y: 0 },
      condition: {
        expression: '{{trigger.type}} === "webhook"',
        trueBranch: "yes",
        falseBranch: "no",
      },
    };
    const def = createWorkflow([condition]);
    const ctx = createExecutionContext("wf-1", "run-1", { type: "webhook" });

    const { result } = await executeStep(def, condition, ctx);

    expect(result).toEqual({ branch: "true", value: true });
  });

  it("should resolve nested trigger data", async () => {
    const condition: ConditionStep = {
      id: "cond-1",
      type: "condition",
      name: "Check Nested",
      position: { x: 0, y: 0 },
      condition: {
        expression: '{{trigger.user.role}} === "admin"',
        trueBranch: "admin",
        falseBranch: "user",
      },
    };
    const def = createWorkflow([condition]);
    const ctx = createExecutionContext("wf-1", "run-1", {
      user: { role: "admin", name: "Test" },
    });

    const { result } = await executeStep(def, condition, ctx);

    expect(result).toEqual({ branch: "true", value: true });
  });
});
