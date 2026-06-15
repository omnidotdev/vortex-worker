import { describe, expect, it } from "bun:test";

import { WorkflowDefinition } from "../../dsl/types";
import template from "./gatekeeper-email-send.json";

/**
 * gatekeeper-email-send renders an identity email template via the
 * builtin:emailRender action and sends it through the first-class email step
 * (Herald). Suppression is handled by Herald, so the in-template suppression
 * check and Resend send path are gone.
 */

const stepById = (id: string) =>
  template.steps.find((s: { id: string }) => s.id === id) as Record<
    string,
    unknown
  >;

describe("gatekeeper-email-send template", () => {
  it("is a valid workflow definition on the hatchet executor", () => {
    expect(WorkflowDefinition.safeParse(template).success).toBe(true);
    expect(template.executor).toBe("hatchet");
  });

  it("triggers on gatekeeper.email.* from omni.gatekeeper", () => {
    const trigger = stepById("trigger") as {
      trigger: { config: { pattern: string; source: string } };
    };
    expect(trigger.trigger.config.pattern).toBe("gatekeeper.email.*");
    expect(trigger.trigger.config.source).toBe("omni.gatekeeper");
  });

  it("renders via the builtin:emailRender action", () => {
    const render = stepById("render") as {
      type: string;
      action: {
        pluginId: string;
        operation: string;
        inputs: Record<string, unknown>;
      };
    };
    expect(render.type).toBe("action");
    expect(render.action.pluginId).toBe("builtin:emailRender");
    expect(render.action.inputs.templateId).toBe("{{trigger.data.templateId}}");
  });

  it("sends via the email step from a verified send.omni.dev sender", () => {
    const send = stepById("send") as {
      type: string;
      email: {
        to: string;
        from: string;
        subject: string;
        body: string;
        contentType: string;
      };
    };
    expect(send.type).toBe("email");
    expect(send.email.to).toBe("{{trigger.data.to}}");
    expect(send.email.from).toBe("noreply@send.omni.dev");
    expect(send.email.subject).toBe("{{steps['render'].output.subject}}");
    expect(send.email.body).toBe("{{steps['render'].output.html}}");
    expect(send.email.contentType).toBe("html");
  });

  it("has no sandboxed fetch or Resend send path", () => {
    const json = JSON.stringify(template);
    expect(json).not.toContain("resend.com");
    expect(json).not.toContain("process.env");
  });
});
