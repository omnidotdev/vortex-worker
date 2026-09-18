/**
 * Built-in Expression Plugin
 *
 * Evaluates workflow-authored expressions in a genuinely locked-down
 * interpreter (CEL, via cel-js). CEL is a non-Turing-complete expression
 * language with no host bindings: `process`, `require`, dynamic `import()`,
 * the `Function` constructor, and `globalThis` are simply not part of its
 * grammar or runtime, so an expression can never reach host state or execute
 * arbitrary code. This replaces the previous in-process `new Function(...)`
 * evaluator, which exposed all of the above (RCE + secret exfiltration).
 *
 * The same CEL engine backs event routing (see `events/cel-evaluator.ts`), so
 * expression semantics are consistent across the product. Note this is a
 * deliberate security narrowing: the `execute` action no longer runs arbitrary
 * multi-statement JavaScript, only a single CEL expression. Use a `code` step
 * (isolated sandbox) for real scripting.
 */

import { evaluate as celEvaluate, parse as celParse } from "cel-js";

import type { Success as CelParseSuccess } from "cel-js";
import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/** Parsed CEL expression tree (the `cst` of a successful parse) */
type CelCst = CelParseSuccess["cst"];

/** Evaluate expression input */
interface EvalInput {
  /** CEL expression to evaluate */
  expression: string;
  /** Context variables available in the expression */
  context?: Record<string, unknown>;
  /** Timeout in ms (accepted for compatibility; CEL evaluation is bounded) */
  timeout?: number;
}

/** Execute script input */
interface ScriptInput {
  /** CEL expression to evaluate (multi-statement JS is no longer supported) */
  code: string;
  /** Context variables */
  context?: Record<string, unknown>;
  /** Timeout in ms (accepted for compatibility) */
  timeout?: number;
}

/** Template input */
interface TemplateInput {
  /** Template string with ${} placeholders */
  template: string;
  /** Context variables */
  context: Record<string, unknown>;
}

/** Conditional input */
interface ConditionalInput {
  /** Condition expression */
  condition: string;
  /** Context variables */
  context?: Record<string, unknown>;
  /** Value if true */
  ifTrue?: unknown;
  /** Value if false */
  ifFalse?: unknown;
}

/** Map expression input */
interface MapExprInput {
  /** Array to map over */
  array: unknown[];
  /** Expression to apply (item available as 'item', index as 'index') */
  expression: string;
  /** Additional context */
  context?: Record<string, unknown>;
}

/** Filter expression input */
interface FilterExprInput {
  /** Array to filter */
  array: unknown[];
  /** Predicate expression (item available as 'item', index as 'index') */
  predicate: string;
  /** Additional context */
  context?: Record<string, unknown>;
}

/** Math expression input */
interface MathInput {
  /** Math expression */
  expression: string;
  /** Variables */
  variables?: Record<string, number>;
}

/**
 * Helper functions available to every expression. These are host-defined and
 * pure; user input can only reference them by name, never redefine them.
 */
const EXPRESSION_FUNCTIONS: Record<string, CallableFunction> = {
  // String helpers (mirror events/cel-evaluator so semantics match routing)
  startsWith: (str: string, prefix: string) =>
    typeof str === "string" && str.startsWith(prefix),
  endsWith: (str: string, suffix: string) =>
    typeof str === "string" && str.endsWith(suffix),
  contains: (str: string, sub: string) =>
    typeof str === "string" && str.includes(sub),
  matches: (str: string, pattern: string) => {
    if (typeof str !== "string") return false;
    try {
      return new RegExp(pattern).test(str);
    } catch {
      return false;
    }
  },
  // Numeric helpers (CEL has no Math namespace)
  pow: (base: number, exp: number) => base ** exp,
  sqrt: (x: number) => Math.sqrt(x),
  abs: (x: number) => Math.abs(x),
  round: (x: number) => Math.round(x),
  floor: (x: number) => Math.floor(x),
  ceil: (x: number) => Math.ceil(x),
  min: (...xs: number[]) => Math.min(...xs),
  max: (...xs: number[]) => Math.max(...xs),
  sin: (x: number) => Math.sin(x),
  cos: (x: number) => Math.cos(x),
  tan: (x: number) => Math.tan(x),
  log: (x: number) => Math.log(x),
  log10: (x: number) => Math.log10(x),
  exp: (x: number) => Math.exp(x),
};

/** Math constants exposed to expressions as context values */
const MATH_CONSTANTS: Record<string, number> = {
  PI: Math.PI,
  E: Math.E,
};

/** Cache of parsed CEL expression trees, keyed by expression string */
const cstCache = new Map<string, CelCst>();

/**
 * Evaluate a single CEL expression against a context. Throws on parse or
 * evaluation errors so callers can surface a safe failure. There is no path
 * from here to host globals: CEL only sees the provided context and the
 * host-defined helper functions.
 */
const evaluateExpression = (
  expression: string,
  context: Record<string, unknown>,
): unknown => {
  let cst = cstCache.get(expression);
  if (!cst) {
    const parseResult = celParse(expression);
    if (!parseResult.isSuccess) {
      throw new Error(`Failed to parse expression: ${expression}`);
    }
    cst = parseResult.cst;
    cstCache.set(expression, cst);
  }

  return celEvaluate(
    cst,
    { ...MATH_CONSTANTS, ...context },
    EXPRESSION_FUNCTIONS,
  );
};

/**
 * Evaluate a CEL expression.
 */
const evaluate = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as EvalInput;
    const result = evaluateExpression(input.expression, input.context ?? {});

    return {
      success: true,
      output: { result },
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

/**
 * Evaluate a CEL expression (retained for compatibility with the previous
 * "execute a script" action). Arbitrary multi-statement JavaScript is no
 * longer supported; the input is treated as a single CEL expression.
 */
const execute = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as ScriptInput;
    const result = evaluateExpression(input.code, input.context ?? {});

    return {
      success: true,
      output: { result },
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

/**
 * Interpolate template string with context.
 */
const template = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as TemplateInput;

    // Replace ${...} with evaluated expressions
    const result = input.template.replace(/\$\{([^}]+)\}/g, (_, expr) => {
      try {
        const value = evaluateExpression(expr, input.context ?? {});
        return String(value ?? "");
      } catch {
        return `\${${expr}}`; // Keep original if evaluation fails
      }
    });

    return {
      success: true,
      output: { result },
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

/**
 * Evaluate a conditional expression.
 */
const conditional = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as ConditionalInput;
    const conditionResult = Boolean(
      evaluateExpression(input.condition, input.context ?? {}),
    );

    const result = conditionResult ? input.ifTrue : input.ifFalse;

    return {
      success: true,
      output: {
        condition: conditionResult,
        result,
      },
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

/**
 * Map an expression over an array.
 */
const mapExpr = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as MapExprInput;

    const results: unknown[] = [];

    for (let i = 0; i < input.array.length; i++) {
      const value = evaluateExpression(input.expression, {
        ...input.context,
        item: input.array[i],
        index: i,
        array: input.array,
      });
      results.push(value);
    }

    return {
      success: true,
      output: { results },
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

/**
 * Filter an array with a predicate expression.
 */
const filterExpr = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as FilterExprInput;

    const results: unknown[] = [];

    for (let i = 0; i < input.array.length; i++) {
      const keep = Boolean(
        evaluateExpression(input.predicate, {
          ...input.context,
          item: input.array[i],
          index: i,
          array: input.array,
        }),
      );

      if (keep) {
        results.push(input.array[i]);
      }
    }

    return {
      success: true,
      output: {
        results,
        originalCount: input.array.length,
        filteredCount: results.length,
      },
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

/**
 * Evaluate a math expression.
 */
const math = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as MathInput;

    // Restrict to math-shaped characters before evaluation
    const safeExpr = input.expression.replace(
      /[^0-9+\-*/%().^a-zA-Z_,\s]/g,
      "",
    );

    const result = evaluateExpression(safeExpr, {
      ...(input.variables ?? {}),
    });

    if (typeof result !== "number" || Number.isNaN(result)) {
      return {
        success: false,
        error: "Expression did not evaluate to a valid number",
        durationMs: performance.now() - startTime,
      };
    }

    return {
      success: true,
      output: { result },
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

/**
 * Access nested object path.
 */
const get = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as {
      object: Record<string, unknown>;
      path: string;
      defaultValue?: unknown;
    };

    const parts = input.path.split(/[.[\]]+/).filter(Boolean);
    let current: unknown = input.object;

    for (const part of parts) {
      if (current === null || current === undefined) {
        return {
          success: true,
          output: { value: input.defaultValue, found: false },
          durationMs: performance.now() - startTime,
        };
      }

      current = (current as Record<string, unknown>)[part];
    }

    return {
      success: true,
      output: {
        value: current ?? input.defaultValue,
        found: current !== undefined,
      },
      durationMs: performance.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

/**
 * Expression built-in plugin definition.
 */
export const expressionPlugin: BuiltinPlugin = {
  id: "builtin:expression",
  name: "Expression",
  description: "CEL expression evaluation (sandboxed, no host access)",
  actions: {
    evaluate: {
      name: "evaluate",
      description: "Evaluate a CEL expression",
      handler: evaluate,
    },
    execute: {
      name: "execute",
      description: "Evaluate a CEL expression (single expression only)",
      handler: execute,
    },
    template: {
      name: "template",
      description: "Interpolate template string with context",
      handler: template,
    },
    conditional: {
      name: "conditional",
      description: "Evaluate a conditional expression",
      handler: conditional,
    },
    map: {
      name: "map",
      description: "Map an expression over an array",
      handler: mapExpr,
    },
    filter: {
      name: "filter",
      description: "Filter an array with a predicate expression",
      handler: filterExpr,
    },
    math: {
      name: "math",
      description: "Evaluate a math expression",
      handler: math,
    },
    get: {
      name: "get",
      description: "Access nested object path",
      handler: get,
    },
  },
};
