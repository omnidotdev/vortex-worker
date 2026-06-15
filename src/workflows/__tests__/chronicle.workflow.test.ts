import { describe, expect, it } from "bun:test";

import { chronicleAuditWorkflow } from "../chronicle.workflow";

describe("chronicleAuditWorkflow", () => {
  it("is a v1 task declaration named chronicle-audit", () => {
    expect(chronicleAuditWorkflow.name).toBe("chronicle-audit");
    expect(
      (chronicleAuditWorkflow as unknown as { steps?: unknown }).steps,
    ).toBeUndefined();
  });
});
