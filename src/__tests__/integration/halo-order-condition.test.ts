import { describe, expect, it } from "bun:test";
import "./setup";

import {
  createExecutionContext,
  executeStep,
  findTriggerStep,
} from "../../dsl/executor";

import type { WorkflowDefinition } from "../../dsl/types";

/**
 * Regression test for the halo-order-confirmed seller-notification branch.
 *
 * The seeded workflow gated the seller email on a condition step. The original
 * expression embedded the comparison INSIDE the template braces
 * (`{{ steps['build-emails'].output.hasSeller === true }}`). The executor's
 * template regex grabs everything between `{{ }}` as a single path, so the
 * whole `... === true` was fed to getValueByPath, resolved to undefined, and
 * the condition was always false: the seller was never emailed even when a
 * seller existed. The fix moves the comparison outside the braces
 * (`{{steps['build-emails'].output.hasSeller}} === true`).
 */

const pos = { x: 0, y: 0 };

/** Build a trigger -> build-emails -> check-seller -> (true|false) workflow. */
const buildDefinition = (expression: string): WorkflowDefinition => ({
  version: "1.0",
  steps: [
    {
      id: "trigger",
      type: "trigger",
      name: "Order Confirmed",
      position: pos,
      trigger: { type: "webhook", config: {} },
    },
    {
      id: "build-emails",
      type: "code",
      name: "Build Order Emails",
      position: pos,
      code: {
        inputs: {},
        // Mirror the real workflow: hasSeller is a boolean derived from the payload
        source: "return { hasSeller: true };",
        sandbox: "worker",
      },
    },
    {
      id: "check-seller",
      type: "condition",
      name: "Has Seller?",
      position: pos,
      condition: {
        expression,
        trueBranch: "send-seller",
        falseBranch: "end",
      },
    },
    {
      id: "send-seller",
      type: "noop",
      name: "Email Seller",
      position: pos,
    },
    {
      id: "end",
      type: "stop",
      name: "Done",
      position: pos,
      stop: { reason: "done", status: "success" },
    },
  ],
  edges: [
    { id: "e1", source: "trigger", target: "build-emails" },
    { id: "e2", source: "build-emails", target: "check-seller" },
    {
      id: "e3",
      source: "check-seller",
      target: "send-seller",
      sourceHandle: "true",
    },
    { id: "e4", source: "check-seller", target: "end", sourceHandle: "false" },
    { id: "e5", source: "send-seller", target: "end" },
  ],
});

/** Return the id the condition step routes to (its single next step). */
const routedTargetAfterCondition = async (
  expression: string,
): Promise<string | undefined> => {
  const def = buildDefinition(expression);
  const trigger = findTriggerStep(def.steps);
  if (!trigger) throw new Error("no trigger");
  const ctx = createExecutionContext("wf", "run", {});

  let current = [trigger as (typeof def.steps)[number]];
  while (current.length > 0) {
    const step = current[0];
    const { nextSteps } = await executeStep(def, step, ctx);
    if (step.id === "check-seller") return nextSteps[0]?.id;
    if (step.type === "stop") break;
    current = nextSteps;
  }
  return undefined;
};

describe("halo-order-confirmed seller-notification condition", () => {
  it("regression: comparison inside the braces always routes to the false branch", async () => {
    const target = await routedTargetAfterCondition(
      "{{ steps['build-emails'].output.hasSeller === true }}",
    );
    expect(target).toBe("end");
  });

  it("fixed: comparison outside the braces routes to the seller branch when hasSeller is true", async () => {
    const target = await routedTargetAfterCondition(
      "{{steps['build-emails'].output.hasSeller}} === true",
    );
    expect(target).toBe("send-seller");
  });
});
