import { describe, expect, it } from "bun:test";

import { authzSyncWorkflow } from "../authz.workflow";

describe("authzSyncWorkflow", () => {
  it("is a v1 task declaration named authz-sync", () => {
    expect(authzSyncWorkflow.name).toBe("authz-sync");
    expect(
      (authzSyncWorkflow as unknown as { steps?: unknown }).steps,
    ).toBeUndefined();
  });
});
