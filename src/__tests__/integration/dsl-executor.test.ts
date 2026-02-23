import { describe, expect, it } from "bun:test";
import "./setup";

import {
  createExecutionContext,
  executeStep,
  findNextSteps,
  findTriggerStep,
} from "../../dsl/executor";

import type { WorkflowDefinition } from "../../dsl/types";
import type { ExecutionContext } from "../../dsl/types";

/**
 * Build a minimal workflow definition.
 * Positions are required by the schema but irrelevant to execution.
 */
const pos = { x: 0, y: 0 };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a workflow definition to completion, starting from the trigger step.
 * Returns the final execution context and an ordered list of step results.
 */
async function runWorkflow(
  def: WorkflowDefinition,
  triggerData: Record<string, unknown>,
): Promise<{
  ctx: ExecutionContext;
  results: Array<{ stepId: string; result: unknown }>;
}> {
  const trigger = findTriggerStep(def.steps);
  if (!trigger) throw new Error("No trigger step found");

  const ctx = createExecutionContext("wf-test", "run-test", triggerData);

  const results: Array<{ stepId: string; result: unknown }> = [];
  let currentSteps = [trigger as (typeof def.steps)[number]];

  // Walk the graph one step at a time (breadth-first, single-branch)
  while (currentSteps.length > 0) {
    const step = currentSteps[0];
    const { nextSteps, result } = await executeStep(def, step, ctx);
    results.push({ stepId: step.id, result });

    // Stop if step is a stop step
    if (step.type === "stop") break;

    currentSteps = nextSteps;
  }

  return { ctx, results };
}

// ---------------------------------------------------------------------------
// Test definitions
// ---------------------------------------------------------------------------

describe("DSL executor integration", () => {
  describe("linear workflow execution", () => {
    it("should execute trigger -> noop -> stop", async () => {
      const def: WorkflowDefinition = {
        version: "1.0",
        steps: [
          {
            id: "trigger-1",
            type: "trigger",
            name: "Webhook Trigger",
            position: pos,
            trigger: {
              type: "webhook",
              config: {},
            },
          },
          {
            id: "noop-1",
            type: "noop",
            name: "Pass Through",
            position: pos,
          },
          {
            id: "stop-1",
            type: "stop",
            name: "End",
            position: pos,
            stop: {
              status: "success",
              reason: "Workflow completed",
            },
          },
        ],
        edges: [
          { id: "e1", source: "trigger-1", target: "noop-1" },
          { id: "e2", source: "noop-1", target: "stop-1" },
        ],
      };

      const { ctx, results } = await runWorkflow(def, { message: "hello" });

      // Three steps should have executed
      expect(results).toHaveLength(3);

      // Trigger returns the trigger data
      expect(results[0].stepId).toBe("trigger-1");
      expect(results[0].result).toEqual({ message: "hello" });

      // Noop returns a skip marker
      expect(results[1].stepId).toBe("noop-1");
      expect(results[1].result).toEqual({ skipped: true, type: "noop" });

      // Stop returns its config
      expect(results[2].stepId).toBe("stop-1");
      expect(results[2].result).toMatchObject({
        stopped: true,
        status: "success",
      });

      // Step results should be recorded in context
      expect(ctx.stepResults["trigger-1"]).toEqual({ message: "hello" });
      expect(ctx.stepResults["noop-1"]).toEqual({ skipped: true, type: "noop" });
    });

    it("should execute trigger -> comment -> noop (comment is skipped)", async () => {
      const def: WorkflowDefinition = {
        version: "1.0",
        steps: [
          {
            id: "trigger-1",
            type: "trigger",
            name: "Manual Trigger",
            position: pos,
            trigger: {
              type: "manual",
              config: {},
            },
          },
          {
            id: "comment-1",
            type: "comment",
            name: "Documentation Note",
            position: pos,
            comment: { note: "This is a documentation comment" },
          },
          {
            id: "noop-1",
            type: "noop",
            name: "End Noop",
            position: pos,
          },
        ],
        edges: [
          { id: "e1", source: "trigger-1", target: "comment-1" },
          { id: "e2", source: "comment-1", target: "noop-1" },
        ],
      };

      const { results } = await runWorkflow(def, {});

      expect(results).toHaveLength(3);

      // Comment step is executed but returns a skip marker
      expect(results[1].stepId).toBe("comment-1");
      expect(results[1].result).toEqual({ skipped: true, type: "comment" });
    });

    it("should propagate trigger data into execution context", async () => {
      const def: WorkflowDefinition = {
        version: "1.0",
        steps: [
          {
            id: "trigger-1",
            type: "trigger",
            name: "Event Trigger",
            position: pos,
            trigger: {
              type: "event",
              config: { eventName: "user.created" },
            },
          },
        ],
        edges: [],
      };

      const triggerPayload = {
        userId: "u-123",
        email: "test@example.com",
        nested: { deep: { value: 42 } },
      };

      const { ctx, results } = await runWorkflow(def, triggerPayload);

      expect(results).toHaveLength(1);
      expect(ctx.stepResults["trigger-1"]).toEqual(triggerPayload);
      expect(ctx.triggerData).toEqual(triggerPayload);
    });
  });

  describe("condition branching", () => {
    /**
     * Build a condition workflow that branches on an expression.
     * True branch -> noop-true, False branch -> noop-false.
     */
    function buildConditionWorkflow(expression: string): WorkflowDefinition {
      return {
        version: "1.0",
        steps: [
          {
            id: "trigger-1",
            type: "trigger",
            name: "Webhook Trigger",
            position: pos,
            trigger: {
              type: "webhook",
              config: {},
            },
          },
          {
            id: "condition-1",
            type: "condition",
            name: "Check Condition",
            position: pos,
            condition: {
              expression,
              trueBranch: "noop-true",
              falseBranch: "noop-false",
            },
          },
          {
            id: "noop-true",
            type: "noop",
            name: "True Branch",
            position: pos,
          },
          {
            id: "noop-false",
            type: "noop",
            name: "False Branch",
            position: pos,
          },
        ],
        edges: [
          { id: "e1", source: "trigger-1", target: "condition-1" },
          {
            id: "e2",
            source: "condition-1",
            target: "noop-true",
            sourceHandle: "true",
          },
          {
            id: "e3",
            source: "condition-1",
            target: "noop-false",
            sourceHandle: "false",
          },
        ],
      };
    }

    it("should take the true branch when expression evaluates to true", async () => {
      const def = buildConditionWorkflow("true");
      const { results } = await runWorkflow(def, {});

      // trigger -> condition -> true branch
      expect(results).toHaveLength(3);
      expect(results[0].stepId).toBe("trigger-1");
      expect(results[1].stepId).toBe("condition-1");
      expect(results[1].result).toEqual({ branch: "true", value: true });
      expect(results[2].stepId).toBe("noop-true");
    });

    it("should take the false branch when expression evaluates to false", async () => {
      const def = buildConditionWorkflow("false");
      const { results } = await runWorkflow(def, {});

      // trigger -> condition -> false branch
      expect(results).toHaveLength(3);
      expect(results[0].stepId).toBe("trigger-1");
      expect(results[1].stepId).toBe("condition-1");
      expect(results[1].result).toEqual({ branch: "false", value: false });
      expect(results[2].stepId).toBe("noop-false");
    });

    it("should evaluate comparison expressions from trigger data", async () => {
      const def = buildConditionWorkflow("{{triggerData.score}} > 50");
      const { results } = await runWorkflow(def, { score: 75 });

      expect(results).toHaveLength(3);
      expect(results[1].result).toEqual({ branch: "true", value: true });
      expect(results[2].stepId).toBe("noop-true");
    });

    it("should take false branch when comparison fails", async () => {
      const def = buildConditionWorkflow("{{triggerData.score}} > 50");
      const { results } = await runWorkflow(def, { score: 25 });

      expect(results).toHaveLength(3);
      expect(results[1].result).toEqual({ branch: "false", value: false });
      expect(results[2].stepId).toBe("noop-false");
    });

    it("should evaluate equality expressions", async () => {
      const def = buildConditionWorkflow(
        '{{triggerData.status}} === "active"',
      );
      const { results } = await runWorkflow(def, { status: "active" });

      expect(results).toHaveLength(3);
      expect(results[1].result).toEqual({ branch: "true", value: true });
      expect(results[2].stepId).toBe("noop-true");
    });

    it("should evaluate inequality expressions", async () => {
      const def = buildConditionWorkflow(
        '{{triggerData.status}} !== "active"',
      );
      const { results } = await runWorkflow(def, { status: "inactive" });

      expect(results).toHaveLength(3);
      expect(results[1].result).toEqual({ branch: "true", value: true });
      expect(results[2].stepId).toBe("noop-true");
    });
  });

  describe("switch branching", () => {
    it("should route to the matched case", async () => {
      const def: WorkflowDefinition = {
        version: "1.0",
        steps: [
          {
            id: "trigger-1",
            type: "trigger",
            name: "Trigger",
            position: pos,
            trigger: { type: "webhook", config: {} },
          },
          {
            id: "switch-1",
            type: "switch",
            name: "Route by Type",
            position: pos,
            switch: {
              expression: "{{triggerData.type}}",
              cases: [
                { value: "email", label: "Email", next: "noop-email" },
                { value: "sms", label: "SMS", next: "noop-sms" },
              ],
              default: "noop-default",
            },
          },
          {
            id: "noop-email",
            type: "noop",
            name: "Email Branch",
            position: pos,
          },
          {
            id: "noop-sms",
            type: "noop",
            name: "SMS Branch",
            position: pos,
          },
          {
            id: "noop-default",
            type: "noop",
            name: "Default Branch",
            position: pos,
          },
        ],
        edges: [
          { id: "e1", source: "trigger-1", target: "switch-1" },
          {
            id: "e2",
            source: "switch-1",
            target: "noop-email",
            sourceHandle: "case_0",
          },
          {
            id: "e3",
            source: "switch-1",
            target: "noop-sms",
            sourceHandle: "case_1",
          },
          {
            id: "e4",
            source: "switch-1",
            target: "noop-default",
            sourceHandle: "default",
          },
        ],
      };

      // Match "sms" -> case_1
      const { results } = await runWorkflow(def, { type: "sms" });

      expect(results).toHaveLength(3);
      expect(results[1].stepId).toBe("switch-1");
      expect(results[1].result).toEqual({
        case: "case_1",
        matchedValue: "sms",
      });
      expect(results[2].stepId).toBe("noop-sms");
    });

    it("should route to default when no case matches", async () => {
      const def: WorkflowDefinition = {
        version: "1.0",
        steps: [
          {
            id: "trigger-1",
            type: "trigger",
            name: "Trigger",
            position: pos,
            trigger: { type: "webhook", config: {} },
          },
          {
            id: "switch-1",
            type: "switch",
            name: "Route by Type",
            position: pos,
            switch: {
              expression: "{{triggerData.type}}",
              cases: [
                { value: "email", label: "Email", next: "noop-email" },
              ],
              default: "noop-default",
            },
          },
          {
            id: "noop-email",
            type: "noop",
            name: "Email Branch",
            position: pos,
          },
          {
            id: "noop-default",
            type: "noop",
            name: "Default Branch",
            position: pos,
          },
        ],
        edges: [
          { id: "e1", source: "trigger-1", target: "switch-1" },
          {
            id: "e2",
            source: "switch-1",
            target: "noop-email",
            sourceHandle: "case_0",
          },
          {
            id: "e3",
            source: "switch-1",
            target: "noop-default",
            sourceHandle: "default",
          },
        ],
      };

      const { results } = await runWorkflow(def, { type: "push" });

      expect(results).toHaveLength(3);
      expect(results[1].result).toEqual({
        case: "default",
        matchedValue: "push",
      });
      expect(results[2].stepId).toBe("noop-default");
    });
  });

  describe("step result accumulation", () => {
    it("should record all step results in context.stepResults", async () => {
      const def: WorkflowDefinition = {
        version: "1.0",
        steps: [
          {
            id: "trigger-1",
            type: "trigger",
            name: "Trigger",
            position: pos,
            trigger: { type: "webhook", config: {} },
          },
          {
            id: "noop-1",
            type: "noop",
            name: "Step 1",
            position: pos,
          },
          {
            id: "noop-2",
            type: "noop",
            name: "Step 2",
            position: pos,
          },
          {
            id: "stop-1",
            type: "stop",
            name: "End",
            position: pos,
            stop: { status: "success" },
          },
        ],
        edges: [
          { id: "e1", source: "trigger-1", target: "noop-1" },
          { id: "e2", source: "noop-1", target: "noop-2" },
          { id: "e3", source: "noop-2", target: "stop-1" },
        ],
      };

      const { ctx } = await runWorkflow(def, { key: "value" });

      expect(Object.keys(ctx.stepResults)).toHaveLength(4);
      expect(ctx.stepResults["trigger-1"]).toEqual({ key: "value" });
      expect(ctx.stepResults["noop-1"]).toEqual({ skipped: true, type: "noop" });
      expect(ctx.stepResults["noop-2"]).toEqual({ skipped: true, type: "noop" });
      expect(ctx.stepResults["stop-1"]).toMatchObject({ stopped: true });
    });
  });

  describe("helper functions", () => {
    it("findTriggerStep should return the trigger step", () => {
      const steps = [
        {
          id: "noop-1",
          type: "noop" as const,
          name: "Noop",
          position: pos,
        },
        {
          id: "trigger-1",
          type: "trigger" as const,
          name: "Trigger",
          position: pos,
          trigger: { type: "webhook" as const, config: {} },
        },
      ];

      const trigger = findTriggerStep(steps);
      expect(trigger).toBeDefined();
      expect(trigger?.id).toBe("trigger-1");
    });

    it("findTriggerStep should return undefined when no trigger exists", () => {
      const steps = [
        {
          id: "noop-1",
          type: "noop" as const,
          name: "Noop",
          position: pos,
        },
      ];

      const trigger = findTriggerStep(steps);
      expect(trigger).toBeUndefined();
    });

    it("findNextSteps should follow edges from a step", () => {
      const def: WorkflowDefinition = {
        version: "1.0",
        steps: [
          {
            id: "trigger-1",
            type: "trigger",
            name: "Trigger",
            position: pos,
            trigger: { type: "webhook", config: {} },
          },
          {
            id: "noop-1",
            type: "noop",
            name: "Step A",
            position: pos,
          },
          {
            id: "noop-2",
            type: "noop",
            name: "Step B",
            position: pos,
          },
        ],
        edges: [
          { id: "e1", source: "trigger-1", target: "noop-1" },
          { id: "e2", source: "trigger-1", target: "noop-2" },
        ],
      };

      const nextSteps = findNextSteps(def, "trigger-1");
      expect(nextSteps).toHaveLength(2);
      expect(nextSteps.map((s) => s.id)).toContain("noop-1");
      expect(nextSteps.map((s) => s.id)).toContain("noop-2");
    });

    it("findNextSteps should filter by sourceHandle", () => {
      const def: WorkflowDefinition = {
        version: "1.0",
        steps: [
          {
            id: "condition-1",
            type: "condition",
            name: "Condition",
            position: pos,
            condition: {
              expression: "true",
              trueBranch: "noop-true",
              falseBranch: "noop-false",
            },
          },
          {
            id: "noop-true",
            type: "noop",
            name: "True",
            position: pos,
          },
          {
            id: "noop-false",
            type: "noop",
            name: "False",
            position: pos,
          },
        ],
        edges: [
          {
            id: "e1",
            source: "condition-1",
            target: "noop-true",
            sourceHandle: "true",
          },
          {
            id: "e2",
            source: "condition-1",
            target: "noop-false",
            sourceHandle: "false",
          },
        ],
      };

      const trueSteps = findNextSteps(def, "condition-1", "true");
      expect(trueSteps).toHaveLength(1);
      expect(trueSteps[0].id).toBe("noop-true");

      const falseSteps = findNextSteps(def, "condition-1", "false");
      expect(falseSteps).toHaveLength(1);
      expect(falseSteps[0].id).toBe("noop-false");
    });

    it("createExecutionContext should initialize with correct structure", () => {
      const ctx = createExecutionContext(
        "wf-1",
        "run-1",
        { foo: "bar" },
        "org-1",
        { "My Step": "step-id-1" },
      );

      expect(ctx.workflowId).toBe("wf-1");
      expect(ctx.runId).toBe("run-1");
      expect(ctx.organizationId).toBe("org-1");
      expect(ctx.triggerData).toEqual({ foo: "bar" });
      expect(ctx.variables).toEqual({});
      expect(ctx.stepResults).toEqual({});
      expect(ctx.stepNameToId).toEqual({ "My Step": "step-id-1" });
    });
  });
});
