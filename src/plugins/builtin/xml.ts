/**
 * Built-in XML Plugin
 *
 * XML parsing, building, and transformation.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/** Parse XML input */
interface ParseInput {
  /** XML content */
  xml: string;
  /** Preserve CDATA sections */
  preserveCdata?: boolean;
  /** Parse attributes */
  parseAttributes?: boolean;
  /** Attribute prefix (default: "@_") */
  attributePrefix?: string;
  /** Text node name (default: "#text") */
  textNodeName?: string;
}

/** Build XML input */
interface BuildInput {
  /** JavaScript object to convert */
  data: Record<string, unknown>;
  /** Root element name */
  rootName?: string;
  /** Attribute prefix (default: "@_") */
  attributePrefix?: string;
  /** Text node name (default: "#text") */
  textNodeName?: string;
  /** Format output with indentation */
  format?: boolean;
  /** Indentation string (default: "  ") */
  indent?: string;
  /** Include XML declaration */
  declaration?: boolean;
}

/** Query XML input */
interface QueryInput {
  /** XML content */
  xml: string;
  /** XPath-like query (simplified) */
  path: string;
  /** Return all matches */
  all?: boolean;
}

// TransformInput reserved for future XSLT implementation.

/** Validate XML input */
interface ValidateInput {
  /** XML content */
  xml: string;
  /** XSD schema content */
  schema?: string;
  /** Just check well-formedness */
  wellFormedOnly?: boolean;
}

/** Convert to JSON input */
interface ToJsonInput {
  /** XML content */
  xml: string;
  /** Preserve attributes */
  preserveAttributes?: boolean;
  /** Compact format (no arrays for single elements) */
  compact?: boolean;
}

/** Convert from JSON input */
interface FromJsonInput {
  /** JSON object to convert */
  json: Record<string, unknown>;
  /** Root element name */
  rootName?: string;
  /** Format output */
  format?: boolean;
}

/**
 * Simple XML parser using regex (for basic use cases).
 * For production, use fast-xml-parser or similar.
 */
const simpleXmlParse = (
  xml: string,
  options: { attributePrefix?: string; textNodeName?: string } = {},
): Record<string, unknown> => {
  const attrPrefix = options.attributePrefix ?? "@_";
  const textName = options.textNodeName ?? "#text";

  // Remove XML declaration and comments.
  let cleaned = xml.replace(/<\?xml[^?]*\?>/gi, "");
  cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, "");
  cleaned = cleaned.trim();

  const parseElement = (content: string): Record<string, unknown> | string => {
    // Check if it's just text.
    if (!content.includes("<")) {
      return content.trim();
    }

    const result: Record<string, unknown> = {};

    // Match tags.
    const tagRegex = /<(\w+)([^>]*)>([\s\S]*?)<\/\1>|<(\w+)([^/>]*)\/>/g;
    let hasElements = false;

    for (const match of content.matchAll(tagRegex)) {
      hasElements = true;
      const tagName = match[1] ?? match[4];
      const attrs = match[2] ?? match[5] ?? "";
      const innerContent = match[3] ?? "";

      // Parse attributes.
      const attrMatch = [...attrs.matchAll(/(\w+)=["']([^"']*)["']/g)];
      const attributes: Record<string, string> = {};
      for (const [, name, value] of attrMatch) {
        attributes[`${attrPrefix}${name}`] = value;
      }

      // Parse inner content.
      const parsed = innerContent ? parseElement(innerContent) : null;

      // Build element value.
      let elementValue: unknown;
      if (Object.keys(attributes).length > 0) {
        if (typeof parsed === "string") {
          elementValue = { ...attributes, [textName]: parsed };
        } else if (parsed && typeof parsed === "object") {
          elementValue = { ...attributes, ...parsed };
        } else {
          elementValue = attributes;
        }
      } else {
        elementValue = parsed;
      }

      // Handle repeated elements.
      if (result[tagName] !== undefined) {
        if (Array.isArray(result[tagName])) {
          (result[tagName] as unknown[]).push(elementValue);
        } else {
          result[tagName] = [result[tagName], elementValue];
        }
      } else {
        result[tagName] = elementValue;
      }
    }

    // If no elements found, return text content.
    if (!hasElements) {
      const textContent = content.replace(/<[^>]+>/g, "").trim();
      if (textContent) {
        return textContent;
      }
    }

    return result;
  };

  return parseElement(cleaned) as Record<string, unknown>;
};

/**
 * Build XML from object.
 */
const buildXml = (
  obj: Record<string, unknown>,
  options: {
    attributePrefix?: string;
    textNodeName?: string;
    indent?: string;
    level?: number;
  } = {},
): string => {
  const attrPrefix = options.attributePrefix ?? "@_";
  const textName = options.textNodeName ?? "#text";
  const indent = options.indent ?? "";
  const level = options.level ?? 0;
  const prefix = indent.repeat(level);

  const lines: string[] = [];

  for (const [key, value] of Object.entries(obj)) {
    // Skip attribute keys and text nodes at this level.
    if (key.startsWith(attrPrefix) || key === textName) continue;

    const values = Array.isArray(value) ? value : [value];

    for (const v of values) {
      if (v === null || v === undefined) {
        lines.push(`${prefix}<${key}/>`);
      } else if (typeof v === "object") {
        const attrs: string[] = [];
        let textContent = "";
        let hasChildren = false;

        for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
          if (k.startsWith(attrPrefix)) {
            attrs.push(`${k.slice(attrPrefix.length)}="${val}"`);
          } else if (k === textName) {
            textContent = String(val);
          } else {
            hasChildren = true;
          }
        }

        const attrStr = attrs.length > 0 ? ` ${attrs.join(" ")}` : "";

        if (hasChildren) {
          const children = buildXml(v as Record<string, unknown>, {
            ...options,
            level: level + 1,
          });
          if (indent) {
            lines.push(`${prefix}<${key}${attrStr}>`);
            lines.push(children);
            lines.push(`${prefix}</${key}>`);
          } else {
            lines.push(`<${key}${attrStr}>${children}</${key}>`);
          }
        } else if (textContent) {
          lines.push(`${prefix}<${key}${attrStr}>${textContent}</${key}>`);
        } else {
          lines.push(`${prefix}<${key}${attrStr}/>`);
        }
      } else {
        lines.push(`${prefix}<${key}>${v}</${key}>`);
      }
    }
  }

  return lines.join(indent ? "\n" : "");
};

/**
 * Parse XML to JavaScript object.
 */
const parse = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as ParseInput;

    const result = simpleXmlParse(input.xml, {
      attributePrefix: input.attributePrefix,
      textNodeName: input.textNodeName,
    });

    return {
      success: true,
      output: { data: result },
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
 * Build XML from JavaScript object.
 */
const build = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as BuildInput;

    let data = input.data;
    if (input.rootName) {
      data = { [input.rootName]: input.data };
    }

    let xml = buildXml(data, {
      attributePrefix: input.attributePrefix,
      textNodeName: input.textNodeName,
      indent: input.format ? (input.indent ?? "  ") : "",
    });

    if (input.declaration !== false) {
      const decl = '<?xml version="1.0" encoding="UTF-8"?>';
      xml = input.format ? `${decl}\n${xml}` : `${decl}${xml}`;
    }

    return {
      success: true,
      output: { xml },
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
 * Query XML with simple path expression.
 */
const query = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as QueryInput;

    const parsed = simpleXmlParse(input.xml);

    // Simple path traversal (e.g., "root.item.name").
    const parts = input.path.split(/[./]/);
    let current: unknown = parsed;

    for (const part of parts) {
      if (current === null || current === undefined) break;

      // Handle array index.
      const indexMatch = part.match(/^(\w+)\[(\d+)\]$/);
      if (indexMatch) {
        const [, name, index] = indexMatch;
        current = (current as Record<string, unknown>)[name];
        if (Array.isArray(current)) {
          current = current[Number.parseInt(index, 10)];
        }
      } else {
        current = (current as Record<string, unknown>)[part];
      }
    }

    // Return all matches if requested.
    if (input.all && current !== undefined) {
      const results = Array.isArray(current) ? current : [current];
      return {
        success: true,
        output: { results, count: results.length },
        durationMs: performance.now() - startTime,
      };
    }

    return {
      success: true,
      output: {
        result: current,
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
 * Validate XML well-formedness.
 */
const validate = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as ValidateInput;

    // Basic well-formedness check.
    const errors: string[] = [];

    // Check for matching tags.
    const tagStack: string[] = [];
    const tagRegex = /<\/?(\w+)[^>]*>/g;

    for (const match of input.xml.matchAll(tagRegex)) {
      const fullMatch = match[0];
      const tagName = match[1];

      if (fullMatch.startsWith("</")) {
        // Closing tag.
        if (tagStack.length === 0) {
          errors.push(`Unexpected closing tag: </${tagName}>`);
        } else if (tagStack[tagStack.length - 1] !== tagName) {
          errors.push(
            `Mismatched tags: expected </${tagStack[tagStack.length - 1]}>, found </${tagName}>`,
          );
        } else {
          tagStack.pop();
        }
      } else if (!fullMatch.endsWith("/>")) {
        // Opening tag (not self-closing).
        tagStack.push(tagName);
      }
    }

    if (tagStack.length > 0) {
      errors.push(`Unclosed tags: ${tagStack.join(", ")}`);
    }

    // Check for basic XML declaration.
    const hasDeclaration = input.xml.trim().startsWith("<?xml");

    return {
      success: true,
      output: {
        valid: errors.length === 0,
        wellFormed: errors.length === 0,
        hasDeclaration,
        errors: errors.length > 0 ? errors : undefined,
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
 * Convert XML to JSON.
 */
const toJson = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as ToJsonInput;

    const parsed = simpleXmlParse(input.xml, {
      attributePrefix: input.preserveAttributes ? "@_" : undefined,
    });

    return {
      success: true,
      output: { json: parsed },
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
 * Convert JSON to XML.
 */
const fromJson = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as FromJsonInput;

    let data = input.json;
    if (input.rootName) {
      data = { [input.rootName]: input.json };
    }

    const xml = buildXml(data, {
      indent: input.format ? "  " : "",
    });

    const decl = '<?xml version="1.0" encoding="UTF-8"?>';
    const result = input.format ? `${decl}\n${xml}` : `${decl}${xml}`;

    return {
      success: true,
      output: { xml: result },
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
 * Format/prettify XML.
 */
const format = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as { xml: string; indent?: string };

    // Parse and rebuild with formatting.
    const parsed = simpleXmlParse(input.xml);
    const formatted = buildXml(parsed, {
      indent: input.indent ?? "  ",
    });

    // Preserve declaration if present.
    const declMatch = input.xml.match(/<\?xml[^?]*\?>/);
    const decl = declMatch
      ? declMatch[0]
      : '<?xml version="1.0" encoding="UTF-8"?>';

    return {
      success: true,
      output: { xml: `${decl}\n${formatted}` },
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
 * Minify XML (remove whitespace).
 */
const minify = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as { xml: string };

    // Remove whitespace between tags.
    const minified = input.xml
      .replace(/>\s+</g, "><")
      .replace(/\s+/g, " ")
      .trim();

    return {
      success: true,
      output: {
        xml: minified,
        originalLength: input.xml.length,
        minifiedLength: minified.length,
        savings: input.xml.length - minified.length,
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
 * XML built-in plugin definition.
 */
export const xmlPlugin: BuiltinPlugin = {
  id: "builtin:xml",
  name: "XML",
  description: "XML parsing, building, and transformation",
  actions: {
    parse: {
      name: "parse",
      description: "Parse XML to JavaScript object",
      handler: parse,
    },
    build: {
      name: "build",
      description: "Build XML from JavaScript object",
      handler: build,
    },
    query: {
      name: "query",
      description: "Query XML with simple path expression",
      handler: query,
    },
    validate: {
      name: "validate",
      description: "Validate XML well-formedness",
      handler: validate,
    },
    toJson: {
      name: "toJson",
      description: "Convert XML to JSON",
      handler: toJson,
    },
    fromJson: {
      name: "fromJson",
      description: "Convert JSON to XML",
      handler: fromJson,
    },
    format: {
      name: "format",
      description: "Format/prettify XML",
      handler: format,
    },
    minify: {
      name: "minify",
      description: "Minify XML (remove whitespace)",
      handler: minify,
    },
  },
};
