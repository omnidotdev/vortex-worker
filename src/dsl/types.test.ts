import { describe, expect, it } from "bun:test";

import { TriggerType } from "./types";

describe("TriggerType", () => {
  it("includes graphql_subscription", () => {
    expect(TriggerType.enum.graphql_subscription).toBe("graphql_subscription");
  });
});
