/**
 * Built-in Regex Plugin
 *
 * Regular expression operations: match, replace, extract, validate.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/** Match input */
interface MatchInput {
  /** Text to search in */
  text: string;
  /** Regular expression pattern */
  pattern: string;
  /** Regex flags (e.g., "gi") */
  flags?: string;
  /** Return all matches */
  all?: boolean;
}

/** Replace input */
interface ReplaceInput {
  /** Text to modify */
  text: string;
  /** Regular expression pattern */
  pattern: string;
  /** Replacement string or template */
  replacement: string;
  /** Regex flags */
  flags?: string;
}

/** Extract input */
interface ExtractInput {
  /** Text to extract from */
  text: string;
  /** Regular expression pattern with capture groups */
  pattern: string;
  /** Regex flags */
  flags?: string;
  /** Return all matches */
  all?: boolean;
  /** Named group to extract */
  group?: string | number;
}

/** Test input */
interface TestInput {
  /** Text to test */
  text: string;
  /** Regular expression pattern */
  pattern: string;
  /** Regex flags */
  flags?: string;
}

/** Split input */
interface SplitInput {
  /** Text to split */
  text: string;
  /** Regular expression pattern for separator */
  pattern: string;
  /** Maximum number of splits */
  limit?: number;
}

/** Escape input */
interface EscapeInput {
  /** Text to escape */
  text: string;
}

/** Common patterns input */
interface CommonPatternInput {
  /** Pattern type */
  type:
    | "email"
    | "url"
    | "phone"
    | "ipv4"
    | "ipv6"
    | "uuid"
    | "date"
    | "creditCard"
    | "ssn"
    | "zipCode";
  /** Text to validate against pattern */
  text?: string;
}

/** Build pattern input */
interface BuildPatternInput {
  /** Base pattern or character class */
  base: string;
  /** Quantifier */
  quantifier?:
    | "one"
    | "zeroOrOne"
    | "zeroOrMore"
    | "oneOrMore"
    | "exact"
    | "range";
  /** Count for exact quantifier */
  count?: number;
  /** Min/max for range quantifier */
  min?: number;
  max?: number;
  /** Anchors */
  startAnchor?: boolean;
  endAnchor?: boolean;
  /** Flags */
  flags?: string;
}

/** Named groups input */
interface NamedGroupsInput {
  /** Text to match against */
  text: string;
  /** Pattern with named groups */
  pattern: string;
  /** Regex flags */
  flags?: string;
}

// Common regex patterns.
const COMMON_PATTERNS: Record<string, string> = {
  email: "^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$",
  url: "^(https?:\\/\\/)?([\\da-z.-]+)\\.([a-z.]{2,6})([\\/\\w .-]*)*\\/?$",
  phone: "^\\+?[1-9]\\d{1,14}$",
  ipv4: "^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$",
  ipv6: "^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$",
  uuid: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
  date: "^\\d{4}-\\d{2}-\\d{2}$",
  creditCard:
    "^(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})$",
  ssn: "^\\d{3}-\\d{2}-\\d{4}$",
  zipCode: "^\\d{5}(-\\d{4})?$",
};

/**
 * Match pattern against text.
 */
const match = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as MatchInput;
    const regex = new RegExp(input.pattern, input.flags);

    if (input.all) {
      const matches: Array<{
        match: string;
        index: number;
        groups?: Record<string, string>;
      }> = [];
      // Ensure global flag for matchAll.
      const globalRegex = regex.global
        ? regex
        : new RegExp(input.pattern, `${input.flags ?? ""}g`);

      for (const m of input.text.matchAll(globalRegex)) {
        matches.push({
          match: m[0],
          index: m.index,
          groups: m.groups as Record<string, string> | undefined,
        });
      }

      return {
        success: true,
        output: {
          matches,
          count: matches.length,
          found: matches.length > 0,
        },
        durationMs: performance.now() - startTime,
      };
    }

    const m = regex.exec(input.text);

    if (!m) {
      return {
        success: true,
        output: { found: false },
        durationMs: performance.now() - startTime,
      };
    }

    return {
      success: true,
      output: {
        match: m[0],
        index: m.index,
        groups: m.groups,
        captures: m.slice(1),
        found: true,
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
 * Replace pattern matches.
 */
const replace = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as ReplaceInput;
    const regex = new RegExp(input.pattern, input.flags);

    const result = input.text.replace(regex, input.replacement);
    const changed = result !== input.text;

    return {
      success: true,
      output: {
        result,
        changed,
        originalLength: input.text.length,
        resultLength: result.length,
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
 * Extract captured groups.
 */
const extract = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as ExtractInput;
    const regex = new RegExp(input.pattern, input.flags);

    if (input.all) {
      const results: Array<string | Record<string, string>> = [];
      const globalRegex = regex.global
        ? regex
        : new RegExp(input.pattern, `${input.flags ?? ""}g`);
      for (const m of input.text.matchAll(globalRegex)) {
        if (input.group !== undefined) {
          if (typeof input.group === "string" && m.groups) {
            results.push(m.groups[input.group] ?? "");
          } else if (typeof input.group === "number") {
            results.push(m[input.group] ?? "");
          }
        } else if (m.groups) {
          results.push(m.groups as Record<string, string>);
        } else {
          results.push(m.slice(1).join(""));
        }
      }

      return {
        success: true,
        output: { extracted: results, count: results.length },
        durationMs: performance.now() - startTime,
      };
    }

    const m = regex.exec(input.text);

    if (!m) {
      return {
        success: true,
        output: { found: false },
        durationMs: performance.now() - startTime,
      };
    }

    let extracted: unknown;

    if (input.group !== undefined) {
      if (typeof input.group === "string" && m.groups) {
        extracted = m.groups[input.group];
      } else if (typeof input.group === "number") {
        extracted = m[input.group];
      }
    } else if (m.groups) {
      extracted = m.groups;
    } else {
      extracted = m.slice(1);
    }

    return {
      success: true,
      output: {
        extracted,
        found: true,
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
 * Test if pattern matches.
 */
const test = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as TestInput;
    const regex = new RegExp(input.pattern, input.flags);
    const matches = regex.test(input.text);

    return {
      success: true,
      output: { matches },
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
 * Split text by pattern.
 */
const split = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as SplitInput;
    const regex = new RegExp(input.pattern);
    const parts = input.limit
      ? input.text.split(regex, input.limit)
      : input.text.split(regex);

    return {
      success: true,
      output: {
        parts,
        count: parts.length,
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
 * Escape special regex characters.
 */
const escapePattern = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as EscapeInput;
    const escaped = input.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    return {
      success: true,
      output: { escaped },
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
 * Get or validate against common patterns.
 */
const commonPattern = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as CommonPatternInput;
    const pattern = COMMON_PATTERNS[input.type];

    if (!pattern) {
      return {
        success: false,
        error: `Unknown pattern type: ${input.type}`,
        durationMs: performance.now() - startTime,
      };
    }

    if (input.text !== undefined) {
      const regex = new RegExp(pattern);
      const matches = regex.test(input.text);

      return {
        success: true,
        output: {
          pattern,
          type: input.type,
          matches,
          text: input.text,
        },
        durationMs: performance.now() - startTime,
      };
    }

    return {
      success: true,
      output: {
        pattern,
        type: input.type,
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
 * Build a regex pattern programmatically.
 */
const buildPattern = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as BuildPatternInput;
    let pattern = input.base;

    // Add quantifier.
    switch (input.quantifier) {
      case "one":
        // No quantifier needed.
        break;
      case "zeroOrOne":
        pattern += "?";
        break;
      case "zeroOrMore":
        pattern += "*";
        break;
      case "oneOrMore":
        pattern += "+";
        break;
      case "exact":
        pattern += `{${input.count ?? 1}}`;
        break;
      case "range":
        pattern += `{${input.min ?? 0},${input.max ?? ""}}`;
        break;
    }

    // Add anchors.
    if (input.startAnchor) {
      pattern = `^${pattern}`;
    }
    if (input.endAnchor) {
      pattern = `${pattern}$`;
    }

    // Validate pattern.
    try {
      new RegExp(pattern, input.flags);
    } catch (e) {
      return {
        success: false,
        error: `Invalid pattern: ${e instanceof Error ? e.message : String(e)}`,
        durationMs: performance.now() - startTime,
      };
    }

    return {
      success: true,
      output: {
        pattern,
        flags: input.flags,
        regex: input.flags ? `/${pattern}/${input.flags}` : `/${pattern}/`,
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
 * Extract named groups from pattern.
 */
const namedGroups = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as NamedGroupsInput;
    const regex = new RegExp(input.pattern, input.flags);
    const m = regex.exec(input.text);

    if (!m || !m.groups) {
      return {
        success: true,
        output: {
          found: false,
          groups: {},
        },
        durationMs: performance.now() - startTime,
      };
    }

    return {
      success: true,
      output: {
        found: true,
        groups: m.groups,
        match: m[0],
        index: m.index,
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
 * Regex built-in plugin definition.
 */
export const regexPlugin: BuiltinPlugin = {
  id: "builtin:regex",
  name: "Regex",
  description: "Regular expression operations",
  actions: {
    match: {
      name: "match",
      description: "Match pattern against text",
      handler: match,
    },
    replace: {
      name: "replace",
      description: "Replace pattern matches",
      handler: replace,
    },
    extract: {
      name: "extract",
      description: "Extract captured groups",
      handler: extract,
    },
    test: {
      name: "test",
      description: "Test if pattern matches",
      handler: test,
    },
    split: {
      name: "split",
      description: "Split text by pattern",
      handler: split,
    },
    escape: {
      name: "escape",
      description: "Escape special regex characters",
      handler: escapePattern,
    },
    commonPattern: {
      name: "commonPattern",
      description: "Get or validate against common patterns",
      handler: commonPattern,
    },
    buildPattern: {
      name: "buildPattern",
      description: "Build a regex pattern programmatically",
      handler: buildPattern,
    },
    namedGroups: {
      name: "namedGroups",
      description: "Extract named groups from pattern",
      handler: namedGroups,
    },
  },
};
