import { describe, expect, it } from "bun:test";

import { WorkflowDefinition } from "../../dsl/types";
import template from "./halo-order-confirmed.json";

/**
 * The halo-order-confirmed workflow builds a buyer receipt and an optional
 * seller notification from a halo.order.confirmed event and sends them via the
 * first-class email step (Herald). The HTML is built in a pure, I/O-free code
 * step (sandbox-safe); sending and suppression are handled by the email step
 * and Herald, not by hand-rolled fetch in the template.
 */

const sampleData = {
  orderId: "o1",
  orderNumber: "ORD-ABC",
  storeName: "Hike & Heal",
  buyerEmail: "buyer@example.com",
  sellerEmail: "seller@example.com",
  currency: "USD",
  subtotal: 5000,
  discountTotal: 500,
  shippingTotal: 599,
  taxTotal: 413,
  total: 5512,
  lines: [
    { title: "Trail Balm", variantTitle: "2oz", quantity: 2, total: 5000 },
  ],
};

const stepById = (id: string) =>
  template.steps.find((s: { id: string }) => s.id === id) as Record<
    string,
    unknown
  >;

const buildEmailsSource = () =>
  (stepById("build-emails").code as { source: string }).source;

/** Execute the pure build-emails code with a trigger payload. */
const runBuildEmails = (data: Record<string, unknown>) => {
  const fn = new Function(
    "trigger",
    `return (async () => { ${buildEmailsSource()} })()`,
  );
  return fn({ data }) as Promise<Record<string, string | boolean>>;
};

describe("halo-order-confirmed template", () => {
  it("is a valid workflow definition", () => {
    const result = WorkflowDefinition.safeParse(template);
    expect(result.success).toBe(true);
  });

  it("runs on the hatchet executor", () => {
    expect(template.executor).toBe("hatchet");
  });

  it("triggers on halo.order.confirmed from omni.halo", () => {
    const trigger = stepById("trigger") as {
      trigger: { config: { pattern: string; source: string } };
    };
    expect(trigger.trigger.config.pattern).toBe("halo.order.confirmed");
    expect(trigger.trigger.config.source).toBe("omni.halo");
  });

  it("sends via the first-class email step, not hand-rolled fetch", () => {
    // The build step must be pure: no network, no secrets in the sandbox
    const source = buildEmailsSource();
    expect(source).not.toContain("fetch");
    expect(source).not.toContain("process.env");
    expect(source).not.toContain("resend");

    // Buyer + seller are sent via email steps with rendered HTML bodies
    const buyer = stepById("send-buyer") as {
      type: string;
      email: { to: string; body: string; contentType: string };
    };
    expect(buyer.type).toBe("email");
    expect(buyer.email.contentType).toBe("html");
    expect(buyer.email.to).toBe("{{steps['build-emails'].output.buyerEmail}}");
    expect(buyer.email.body).toBe("{{steps['build-emails'].output.buyerHtml}}");

    const seller = stepById("send-seller") as { type: string };
    expect(seller.type).toBe("email");
  });

  it("only emails the seller when a seller address is present", () => {
    const cond = stepById("check-seller") as {
      condition: { trueBranch: string; falseBranch: string };
    };
    expect(cond.condition.trueBranch).toBe("send-seller");
    expect(cond.condition.falseBranch).toBe("end");
  });

  it("builds a buyer receipt and seller notification with order details", async () => {
    const out = await runBuildEmails(sampleData);

    expect(out.buyerEmail).toBe("buyer@example.com");
    expect(out.buyerSubject).toBe("Your Hike & Heal order ORD-ABC");
    expect(out.buyerHtml).toContain("ORD-ABC");
    expect(out.buyerHtml).toContain("$55.12");
    expect(out.buyerHtml).toContain("Trail Balm");

    expect(out.sellerEmail).toBe("seller@example.com");
    expect(out.sellerSubject).toBe("New order ORD-ABC - Hike & Heal");
    expect(out.hasSeller).toBe(true);
  });

  it("marks hasSeller false when no seller email is present", async () => {
    const out = await runBuildEmails({ ...sampleData, sellerEmail: null });
    expect(out.hasSeller).toBe(false);
    expect(out.buyerEmail).toBe("buyer@example.com");
  });
});
