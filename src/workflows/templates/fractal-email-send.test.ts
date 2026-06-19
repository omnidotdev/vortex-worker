import { describe, expect, it } from "bun:test";

import template from "./fractal-email-send.json";

/**
 * fractal-email-send notifies workspace members of Fractal build/deploy/crash
 * events. It loops over recipients (render + send per member), so it uses code
 * steps rather than the first-class email step, but it sends through Herald's
 * POST /messages.
 */

const stepById = (id: string) =>
  template.steps.find((s: { id: string }) => s.id === id) as Record<
    string,
    unknown
  >;

describe("fractal-email-send template", () => {
  it("triggers on fractal.* from omni.fractal", () => {
    const trigger = stepById("trigger") as {
      trigger: { config: { pattern: string; source: string } };
    };
    expect(trigger.trigger.config.pattern).toBe("fractal.*");
    expect(trigger.trigger.config.source).toBe("omni.fractal");
  });

  it("sends through Herald", () => {
    const json = JSON.stringify(template);
    // delivery goes through Herald's POST /messages
    expect(json).toContain("/messages");
    expect(json).toContain("HERALD_API_URL");
    expect(json).toContain("HERALD_API_KEY");
  });
});
