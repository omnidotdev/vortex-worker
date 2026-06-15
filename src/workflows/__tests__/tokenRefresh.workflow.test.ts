import { describe, expect, it } from "bun:test";

import { tokenRefreshWorkflow } from "../tokenRefresh.workflow";

describe("tokenRefreshWorkflow", () => {
  it("is a v1 task declaration named oauth-token-refresh", () => {
    expect(tokenRefreshWorkflow.name).toBe("oauth-token-refresh");
    expect(
      (tokenRefreshWorkflow as unknown as { steps?: unknown }).steps,
    ).toBeUndefined();
  });
});
