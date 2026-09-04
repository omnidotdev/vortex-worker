import { describe, expect, it } from "bun:test";

import template from "./halo-order-email-send.json";

const stepById = (id: string) =>
  template.steps.find((s) => s.id === id) as Record<string, unknown>;

describe("halo-order-email-send template", () => {
  it("triggers on halo.order.confirmed from omni.halo", () => {
    const trigger = stepById("trigger") as {
      trigger: { config: { pattern: string; source: string } };
    };
    expect(trigger.trigger.config.pattern).toBe("halo.order.confirmed");
    expect(trigger.trigger.config.source).toBe("omni.halo");
  });

  it("renders via halo's internal endpoint then delivers through Herald", () => {
    const json = JSON.stringify(template);
    expect(json).toContain("/internal/commerce/render-order-emails");
    expect(json).toContain("HALO_INTERNAL_SERVICE_KEY");
    expect(json).toContain("/messages");
    expect(json).toContain("HERALD_API_URL");
    expect(json).toContain("HERALD_API_KEY");
  });

  it("has a valid, parseable code step", () => {
    const step = stepById("send-order-emails") as {
      code: { source: string };
    };
    expect(step.code.source).toContain("render-order-emails");
    // the embedded source must be syntactically valid JS
    expect(
      () => new Function("input", `return (async()=>{${step.code.source}})()`),
    ).not.toThrow();
  });
});
