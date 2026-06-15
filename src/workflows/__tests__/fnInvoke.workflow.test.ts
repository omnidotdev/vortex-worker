import { describe, expect, it } from "bun:test";

import { fnInvokeWorkflow } from "../fnInvoke.workflow";

describe("fnInvokeWorkflow", () => {
  it("is a v1 task declaration named fn-invoke", () => {
    expect(fnInvokeWorkflow.name).toBe("fn-invoke");
    expect(
      (fnInvokeWorkflow as unknown as { steps?: unknown }).steps,
    ).toBeUndefined();
  });
});
