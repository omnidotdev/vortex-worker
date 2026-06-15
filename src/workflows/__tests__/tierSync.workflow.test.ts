import { describe, expect, it } from "bun:test";

import { tierSyncWorkflow } from "../tierSync.workflow";

describe("tierSyncWorkflow", () => {
  it("is a v1 task declaration named tier-sync", () => {
    expect(tierSyncWorkflow.name).toBe("tier-sync");
    // legacy objects have a `steps` array; v1 declarations do not
    expect(
      (tierSyncWorkflow as unknown as { steps?: unknown }).steps,
    ).toBeUndefined();
  });
});
