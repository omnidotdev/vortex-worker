import { describe, expect, it } from "bun:test";

import { getHatchet } from "../lib/hatchet";

describe("shared hatchet client", () => {
  it("exposes a lazy client accessor", () => {
    expect(typeof getHatchet).toBe("function");
  });
});
