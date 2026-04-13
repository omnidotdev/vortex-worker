/**
 * CEL expression evaluator for event routing.
 *
 * Compiles and caches parsed expression trees. Evaluates CEL expressions
 * against OmniEvent envelopes for boolean filtering in routing rules.
 */

import { evaluate, parse } from "cel-js";

import logger from "lib/logger";

import type { CstNode } from "chevrotain";
import type { OmniEvent } from "./types";

/** Cache of successfully parsed CEL expression trees, keyed by expression string */
const cstCache = new Map<string, CstNode>();

/**
 * Built-in helper functions available in CEL expressions.
 *
 * These supplement the cel-js standard library which does not include
 * common string methods like `startsWith`, `endsWith`, `contains`, or
 * regex `matches`.
 */
const celFunctions: Record<string, CallableFunction> = {
  /** Check if a string starts with a prefix */
  startsWith: (str: string, prefix: string) =>
    typeof str === "string" && str.startsWith(prefix),
  /** Check if a string ends with a suffix */
  endsWith: (str: string, suffix: string) =>
    typeof str === "string" && str.endsWith(suffix),
  /** Check if a string contains a substring */
  contains: (str: string, sub: string) =>
    typeof str === "string" && str.includes(sub),
  /** Check if a string matches a regex pattern */
  matches: (str: string, pattern: string) => {
    if (typeof str !== "string") return false;
    try {
      return new RegExp(pattern).test(str);
    } catch {
      return false;
    }
  },
};

/**
 * Evaluate a CEL expression against an OmniEvent envelope.
 *
 * Parses the expression (cached after first parse) and evaluates it
 * with the full event accessible as `event.*` in the CEL context.
 * Returns `false` on parse or evaluation errors (fail-closed).
 * @param expression - CEL expression string
 * @param event - OmniEvent to evaluate against
 * @returns Boolean result of the expression, or `false` on error
 */
export const evaluateCel = (expression: string, event: OmniEvent): boolean => {
  try {
    let cst = cstCache.get(expression);

    if (!cst) {
      const parseResult = parse(expression);

      if (!parseResult.isSuccess) {
        logger.warn("Failed to parse CEL expression", {
          expression,
          errors: parseResult.errors,
        });
        return false;
      }

      cst = parseResult.cst;
      cstCache.set(expression, cst);
    }

    const result = evaluate(cst, { event }, celFunctions);

    return result === true;
  } catch (err) {
    logger.warn("Failed to evaluate CEL expression", {
      expression,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
};

/**
 * Remove a cached expression tree for the given expression.
 * @param expression - CEL expression string to invalidate
 */
export const invalidateCelCache = (expression: string): void => {
  cstCache.delete(expression);
};
