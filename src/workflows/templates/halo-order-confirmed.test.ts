import { describe, expect, it } from "bun:test";

import template from "./halo-order-confirmed.json";

/**
 * The halo-order-confirmed workflow renders and sends a buyer receipt and an
 * optional seller notification from a halo.order.confirmed event, entirely
 * from the event payload (no callback into halo).
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
    {
      title: "Trail Balm",
      variantTitle: "2oz",
      quantity: 2,
      unitPrice: 2500,
      total: 5000,
    },
  ],
};

const codeSource = () => {
  const step = template.steps.find(
    (s: { id: string }) => s.id === "send-order-emails",
  ) as {
    code: { source: string };
  };
  return step.code.source;
};

interface SendCall {
  url: string;
  body: { to: string[]; subject: string; html: string };
}

const runWorkflowCode = async (
  data: Record<string, unknown>,
  env: Record<string, string>,
) => {
  const calls: SendCall[] = [];
  const fetchMock = async (url: string, opts: { body: string }) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, body });
    if (url.includes("resend.com")) {
      return { ok: true, json: async () => ({ id: `msg_${calls.length}` }) };
    }
    // Vortex suppression query
    return {
      ok: true,
      json: async () => ({ data: { emailSuppressions: { totalCount: 0 } } }),
      text: async () => "",
    };
  };
  const fn = new Function(
    "trigger",
    "process",
    "fetch",
    "console",
    `return (async () => { ${codeSource()} })()`,
  );
  const result = await fn({ data }, { env }, fetchMock, console);
  const sends = calls.filter((c) => c.url.includes("resend.com"));
  return { result, sends };
};

const fullEnv = {
  RESEND_API_KEY: "re_test",
  SENDER_EMAIL_ADDRESS: "orders@omni.dev",
  VORTEX_API_URL: "https://vortex.test/graphql",
  VORTEX_API_KEY: "vk_test",
};

describe("halo-order-confirmed template", () => {
  it("uses the temporal executor", () => {
    expect(template.executor).toBe("temporal");
  });

  it("triggers on halo.order.confirmed from omni.halo", () => {
    const trigger = template.steps.find(
      (s: { type: string }) => s.type === "trigger",
    ) as { trigger: { config: { pattern: string; source: string } } };
    expect(trigger.trigger.config.pattern).toBe("halo.order.confirmed");
    expect(trigger.trigger.config.source).toBe("omni.halo");
  });

  it("ends with a stop step", () => {
    expect(
      template.steps.some((s: { type: string }) => s.type === "stop"),
    ).toBe(true);
  });

  it("sends a buyer receipt and a seller notification with order details", async () => {
    const { result, sends } = await runWorkflowCode(sampleData, fullEnv);

    expect(result).toEqual({ sent: 2 });
    expect(sends).toHaveLength(2);

    // The workflow emits the buyer receipt first, then the seller notification
    const [buyer, seller] = sends;
    expect(buyer.body.to).toEqual(["buyer@example.com"]);
    expect(buyer.body.subject).toBe("Your Hike & Heal order ORD-ABC");
    expect(buyer.body.html).toContain("ORD-ABC");
    expect(buyer.body.html).toContain("$55.12");
    expect(buyer.body.html).toContain("Trail Balm");

    expect(seller.body.to).toEqual(["seller@example.com"]);
    expect(seller.body.subject).toBe("New order ORD-ABC - Hike & Heal");
  });

  it("sends only the buyer receipt when no seller email is configured", async () => {
    const { result, sends } = await runWorkflowCode(
      { ...sampleData, sellerEmail: null },
      fullEnv,
    );
    expect(result).toEqual({ sent: 1 });
    expect(sends).toHaveLength(1);
    expect(sends[0].body.to).toEqual(["buyer@example.com"]);
  });

  it("does nothing when Resend is not configured", async () => {
    const { result, sends } = await runWorkflowCode(sampleData, {
      ...fullEnv,
      RESEND_API_KEY: "",
    });
    expect(result).toMatchObject({ sent: 0 });
    expect(sends).toHaveLength(0);
  });

  it("skips a suppressed recipient", async () => {
    const calls: string[] = [];
    const fetchMock = async (url: string, opts: { body: string }) => {
      calls.push(url);
      if (url.includes("resend.com")) {
        return { ok: true, json: async () => ({ id: "msg" }) };
      }
      const body = JSON.parse(opts.body);
      const email = body.variables?.email;
      // Suppress the buyer only
      const total = email === "buyer@example.com" ? 1 : 0;
      return {
        ok: true,
        json: async () => ({
          data: { emailSuppressions: { totalCount: total } },
        }),
        text: async () => "",
      };
    };
    const fn = new Function(
      "trigger",
      "process",
      "fetch",
      "console",
      `return (async () => { ${codeSource()} })()`,
    );
    const result = await fn(
      { data: sampleData },
      { env: fullEnv },
      fetchMock,
      console,
    );

    expect(result).toEqual({ sent: 1 });
    const sends = calls.filter((u) => u.includes("resend.com"));
    expect(sends).toHaveLength(1);
  });
});
