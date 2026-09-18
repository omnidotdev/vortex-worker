/**
 * Expression builtin security + behavior tests.
 *
 * The expression plugin previously evaluated user input with an in-process
 * `new Function(...)`, which exposed `process`, `require`, dynamic `import()`,
 * and `globalThis` to arbitrary workflow-authored expressions (RCE + secret
 * exfiltration). These tests assert those escapes are now unreachable and that
 * ordinary expression evaluation still works.
 */

import { describe, expect, it } from "bun:test";

import { expressionPlugin } from "./expression";

const evaluate = expressionPlugin.actions.evaluate.handler;
const execute = expressionPlugin.actions.execute.handler;
const conditional = expressionPlugin.actions.conditional.handler;
const template = expressionPlugin.actions.template.handler;
const mapExpr = expressionPlugin.actions.map.handler;
const filterExpr = expressionPlugin.actions.filter.handler;
const math = expressionPlugin.actions.math.handler;

// Set a real host secret so a successful escape would visibly leak it
process.env.__EXPRESSION_SECRET_PROBE = "top-secret-value";

describe("expression builtin isolation (RCE repro)", () => {
  it("cannot reach process.env", async () => {
    const result = await evaluate({
      expression: "process.env.__EXPRESSION_SECRET_PROBE",
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.output ?? {})).not.toContain(
      "top-secret-value",
    );
  });

  it("cannot reach globalThis", async () => {
    const result = await evaluate({ expression: "globalThis" });
    expect(result.success).toBe(false);
  });

  it("cannot escape via the Function constructor", async () => {
    const result = await evaluate({
      expression: "(function(){}).constructor('return globalThis')()",
    });
    expect(result.success).toBe(false);
  });

  it("cannot reach require", async () => {
    const result = await evaluate({ expression: "require('node:fs')" });
    expect(result.success).toBe(false);
  });

  it("cannot use dynamic import", async () => {
    const result = await evaluate({ expression: "import('node:fs')" });
    expect(result.success).toBe(false);
  });

  it("execute cannot run arbitrary host JS to read secrets", async () => {
    const result = await execute({
      code: "__result__ = process.env.__EXPRESSION_SECRET_PROBE;",
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.output ?? {})).not.toContain(
      "top-secret-value",
    );
  });

  it("template interpolation cannot leak secrets", async () => {
    const result = await template({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the ${} is template plugin syntax, not a JS template literal
      template: "value=${process.env.__EXPRESSION_SECRET_PROBE}",
      context: {},
    });
    expect(result.success).toBe(true);
    expect(JSON.stringify(result.output ?? {})).not.toContain(
      "top-secret-value",
    );
  });
});

describe("expression builtin evaluation", () => {
  it("evaluates arithmetic with context", async () => {
    const result = await evaluate({
      expression: "a + b * 2",
      context: { a: 1, b: 3 },
    });
    expect(result.success).toBe(true);
    expect(result.output?.result).toBe(7);
  });

  it("evaluates comparisons", async () => {
    const result = await evaluate({
      expression: "value > 10",
      context: { value: 42 },
    });
    expect(result.success).toBe(true);
    expect(result.output?.result).toBe(true);
  });

  it("evaluates a conditional", async () => {
    const result = await conditional({
      condition: "score >= 50",
      context: { score: 75 },
      ifTrue: "pass",
      ifFalse: "fail",
    });
    expect(result.success).toBe(true);
    expect(result.output?.result).toBe("pass");
  });

  it("interpolates a template", async () => {
    const result = await template({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the ${} is template plugin syntax, not a JS template literal
      template: "Hello, ${name}!",
      context: { name: "Vortex" },
    });
    expect(result.success).toBe(true);
    expect(result.output?.result).toBe("Hello, Vortex!");
  });

  it("maps an expression over an array", async () => {
    const result = await mapExpr({
      array: [1, 2, 3],
      expression: "item * 10",
    });
    expect(result.success).toBe(true);
    expect(result.output?.results).toEqual([10, 20, 30]);
  });

  it("filters an array with a predicate", async () => {
    const result = await filterExpr({
      array: [1, 2, 3, 4],
      predicate: "item > 2",
    });
    expect(result.success).toBe(true);
    expect(result.output?.results).toEqual([3, 4]);
  });

  it("evaluates a math expression with helpers", async () => {
    const result = await math({ expression: "pow(2, 3) + 1" });
    expect(result.success).toBe(true);
    expect(result.output?.result).toBe(9);
  });
});
