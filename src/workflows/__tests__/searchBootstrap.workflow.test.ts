import { describe, expect, it } from "bun:test";

import { searchBootstrapWorkflow } from "../searchBootstrap.workflow";

describe("searchBootstrapWorkflow", () => {
  it("is a v1 workflow declaration named search-bootstrap", () => {
    expect(searchBootstrapWorkflow.name).toBe("search-bootstrap");
    expect(
      (searchBootstrapWorkflow as unknown as { steps?: unknown }).steps,
    ).toBeUndefined();
  });
});
