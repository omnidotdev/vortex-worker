import { describe, expect, it } from "bun:test";

import { dslWorkflow } from "../dsl.workflow";

describe("dslWorkflow", () => {
  it("is a v1 task declaration named dsl-workflow", () => {
    expect(dslWorkflow.name).toBe("dsl-workflow");
    expect(
      (dslWorkflow as unknown as { steps?: unknown }).steps,
    ).toBeUndefined();
  });
});
