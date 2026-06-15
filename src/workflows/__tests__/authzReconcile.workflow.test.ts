import { describe, expect, it } from "bun:test";

import { authzReconcileWorkflow } from "../authzReconcile.workflow";

describe("authzReconcileWorkflow", () => {
  it("is a v1 task declaration named authz-reconcile", () => {
    expect(authzReconcileWorkflow.name).toBe("authz-reconcile");
    expect(
      (authzReconcileWorkflow as unknown as { steps?: unknown }).steps,
    ).toBeUndefined();
  });
});
