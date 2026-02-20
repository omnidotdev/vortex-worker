/**
 * Built-in HTML Plugin
 *
 * HTML parsing, web scraping, and DOM manipulation.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/** Parse HTML input */
interface ParseInput {
  /** HTML content or URL to fetch */
  source: string;
  /** Whether source is a URL */
  isUrl?: boolean;
  /** CSS selectors to extract */
  selectors?: Record<string, string>;
  /** Extract all text content */
  extractText?: boolean;
  /** Extract all links */
  extractLinks?: boolean;
  /** Extract all images */
  extractImages?: boolean;
  /** Extract meta tags */
  extractMeta?: boolean;
}

/** Query HTML input */
interface QueryInput {
  /** HTML content */
  html: string;
  /** CSS selector */
  selector: string;
  /** Get attribute value instead of text */
  attribute?: string;
  /** Return all matches or just first */
  all?: boolean;
}

/** Extract table input */
interface ExtractTableInput {
  /** HTML content */
  html: string;
  /** CSS selector for table (default: "table") */
  selector?: string;
  /** Use first row as headers */
  hasHeaders?: boolean;
}

/** Scrape input */
interface ScrapeInput {
  /** URL to scrape */
  url: string;
  /** CSS selectors to extract */
  selectors: Record<string, string>;
  /** Request headers */
  headers?: Record<string, string>;
  /** Wait for selector before scraping (for JS-rendered pages) */
  waitFor?: string;
  /** Request timeout in ms */
  timeout?: number;
}

/** Convert to text input */
interface ToTextInput {
  /** HTML content */
  html: string;
  /** Preserve whitespace */
  preserveWhitespace?: boolean;
  /** Preserve line breaks from block elements */
  preserveLineBreaks?: boolean;
}

/** Sanitize input */
interface SanitizeInput {
  /** HTML content to sanitize */
  html: string;
  /** Allowed tags (empty = strip all) */
  allowedTags?: string[];
  /** Allowed attributes per tag */
  allowedAttributes?: Record<string, string[]>;
  /** Strip all HTML and return plain text */
  stripAll?: boolean;
}

/**
 * Parse HTML using fast regex-based extraction.
 * For complex needs, cheerio would be used in production.
 */
const parseHtml = (html: string) => {
  return {
    querySelector: (
      selector: string,
    ): {
      text: string;
      html: string;
      attr: (name: string) => string | null;
    } | null => {
      // Simple tag selector.
      const tagMatch = selector.match(/^(\w+)$/);
      if (tagMatch) {
        const tag = tagMatch[1];
        const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
        const match = html.match(regex);
        if (match) {
          return {
            text: match[1].replace(/<[^>]+>/g, "").trim(),
            html: match[0],
            attr: (name: string) => {
              const attrMatch = match[0].match(
                new RegExp(`${name}=["']([^"']*)["']`),
              );
              return attrMatch ? attrMatch[1] : null;
            },
          };
        }
      }

      // Class selector.
      const classMatch = selector.match(/^(\w+)?\.([a-zA-Z0-9_-]+)$/);
      if (classMatch) {
        const tag = classMatch[1] || "\\w+";
        const className = classMatch[2];
        const regex = new RegExp(
          `<(${tag})[^>]*class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)</\\1>`,
          "i",
        );
        const match = html.match(regex);
        if (match) {
          return {
            text: match[2].replace(/<[^>]+>/g, "").trim(),
            html: match[0],
            attr: (name: string) => {
              const attrMatch = match[0].match(
                new RegExp(`${name}=["']([^"']*)["']`),
              );
              return attrMatch ? attrMatch[1] : null;
            },
          };
        }
      }

      // ID selector.
      const idMatch = selector.match(/^(\w+)?#([a-zA-Z0-9_-]+)$/);
      if (idMatch) {
        const tag = idMatch[1] || "\\w+";
        const id = idMatch[2];
        const regex = new RegExp(
          `<(${tag})[^>]*id=["']${id}["'][^>]*>([\\s\\S]*?)</\\1>`,
          "i",
        );
        const match = html.match(regex);
        if (match) {
          return {
            text: match[2].replace(/<[^>]+>/g, "").trim(),
            html: match[0],
            attr: (name: string) => {
              const attrMatch = match[0].match(
                new RegExp(`${name}=["']([^"']*)["']`),
              );
              return attrMatch ? attrMatch[1] : null;
            },
          };
        }
      }

      return null;
    },
    querySelectorAll: (
      selector: string,
    ): Array<{
      text: string;
      html: string;
      attr: (name: string) => string | null;
    }> => {
      const results: Array<{
        text: string;
        html: string;
        attr: (name: string) => string | null;
      }> = [];

      // Simple tag selector.
      const tagMatch = selector.match(/^(\w+)$/);
      if (tagMatch) {
        const tag = tagMatch[1];
        const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
        for (const match of html.matchAll(regex)) {
          const matchHtml = match[0];
          results.push({
            text: match[1].replace(/<[^>]+>/g, "").trim(),
            html: matchHtml,
            attr: (name: string) => {
              const attrMatch = matchHtml.match(
                new RegExp(`${name}=["']([^"']*)["']`),
              );
              return attrMatch ? attrMatch[1] : null;
            },
          });
        }
      }

      return results;
    },
  };
};

/**
 * Extract all links from HTML.
 */
const extractAllLinks = (
  html: string,
): Array<{ href: string; text: string }> => {
  const links: Array<{ href: string; text: string }> = [];
  const regex = /<a[^>]*href=["']([^"']*)["'][^>]*>([^<]*)<\/a>/gi;
  for (const match of html.matchAll(regex)) {
    links.push({ href: match[1] ?? "", text: (match[2] ?? "").trim() });
  }
  return links;
};

/**
 * Extract all images from HTML.
 */
const extractAllImages = (
  html: string,
): Array<{ src: string; alt: string }> => {
  const images: Array<{ src: string; alt: string }> = [];
  const regex =
    /<img[^>]*src=["']([^"']*)["'][^>]*(?:alt=["']([^"']*)["'])?[^>]*>/gi;
  for (const match of html.matchAll(regex)) {
    images.push({ src: match[1] ?? "", alt: match[2] ?? "" });
  }
  return images;
};

/**
 * Extract meta tags from HTML.
 */
const extractMetaTags = (html: string): Record<string, string> => {
  const meta: Record<string, string> = {};
  const regex =
    /<meta[^>]*(?:name|property)=["']([^"']*)["'][^>]*content=["']([^"']*)["'][^>]*>/gi;
  for (const match of html.matchAll(regex)) {
    meta[match[1] ?? ""] = match[2] ?? "";
  }

  // Also try content before name.
  const regex2 =
    /<meta[^>]*content=["']([^"']*)["'][^>]*(?:name|property)=["']([^"']*)["'][^>]*>/gi;
  for (const match of html.matchAll(regex2)) {
    meta[match[2] ?? ""] = match[1] ?? "";
  }

  return meta;
};

/**
 * Parse HTML and extract data.
 */
const parse = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as ParseInput;
    let html = input.source;

    // Fetch URL if needed.
    if (input.isUrl) {
      const response = await fetch(input.source);
      if (!response.ok) {
        throw new Error(
          `Failed to fetch URL: ${response.status} ${response.statusText}`,
        );
      }
      html = await response.text();
    }

    const doc = parseHtml(html);
    const result: Record<string, unknown> = {};

    // Extract by selectors.
    if (input.selectors) {
      result.selectors = {};
      for (const [key, selector] of Object.entries(input.selectors)) {
        const el = doc.querySelector(selector);
        (result.selectors as Record<string, string | null>)[key] =
          el?.text ?? null;
      }
    }

    // Extract all text.
    if (input.extractText) {
      result.text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }

    // Extract links.
    if (input.extractLinks) {
      result.links = extractAllLinks(html);
    }

    // Extract images.
    if (input.extractImages) {
      result.images = extractAllImages(html);
    }

    // Extract meta tags.
    if (input.extractMeta) {
      result.meta = extractMetaTags(html);
    }

    return {
      success: true,
      output: result,
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
 * Query HTML with CSS selector.
 */
const query = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as QueryInput;
    const doc = parseHtml(input.html);

    if (input.all) {
      const elements = doc.querySelectorAll(input.selector);
      const results = elements.map((el) =>
        input.attribute ? el.attr(input.attribute) : el.text,
      );

      return {
        success: true,
        output: { matches: results, count: results.length },
        durationMs: performance.now() - startTime,
      };
    }

    const element = doc.querySelector(input.selector);
    if (!element) {
      return {
        success: true,
        output: { value: null, found: false },
        durationMs: performance.now() - startTime,
      };
    }

    const value = input.attribute
      ? element.attr(input.attribute)
      : element.text;

    return {
      success: true,
      output: { value, found: true },
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
 * Extract table data from HTML.
 */
const extractTable = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as ExtractTableInput;
    const tableSelector = input.selector || "table";

    // Find table.
    const tableMatch =
      input.html.match(
        new RegExp(
          `<${tableSelector}[^>]*>([\\s\\S]*?)<\\/${tableSelector}>`,
          "i",
        ),
      ) || input.html.match(/<table[^>]*>([\s\S]*?)<\/table>/i);

    if (!tableMatch) {
      return {
        success: true,
        output: { rows: [], headers: null },
        durationMs: performance.now() - startTime,
      };
    }

    const tableHtml = tableMatch[1];

    // Extract rows.
    const rows: string[][] = [];
    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;

    for (const rowMatch of tableHtml.matchAll(rowRegex)) {
      const cells: string[] = [];
      const cellRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;

      for (const cellMatch of (rowMatch[1] ?? "").matchAll(cellRegex)) {
        cells.push((cellMatch[1] ?? "").replace(/<[^>]+>/g, "").trim());
      }

      if (cells.length > 0) {
        rows.push(cells);
      }
    }

    let headers: string[] | null = null;
    let dataRows = rows;

    if (input.hasHeaders && rows.length > 0) {
      headers = rows[0];
      dataRows = rows.slice(1);
    }

    return {
      success: true,
      output: {
        headers,
        rows: dataRows,
        rowCount: dataRows.length,
        columnCount: rows[0]?.length ?? 0,
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
 * Scrape a web page.
 */
const scrape = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as ScrapeInput;

    const controller = new AbortController();
    const timeout = input.timeout ?? 30000;
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(input.url, {
        headers: input.headers,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(
          `Failed to fetch: ${response.status} ${response.statusText}`,
        );
      }

      const html = await response.text();
      const doc = parseHtml(html);

      const result: Record<string, string | null> = {};

      for (const [key, selector] of Object.entries(input.selectors)) {
        const el = doc.querySelector(selector);
        result[key] = el?.text ?? null;
      }

      return {
        success: true,
        output: {
          data: result,
          url: input.url,
          status: response.status,
        },
        durationMs: performance.now() - startTime,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startTime,
    };
  }
};

/**
 * Convert HTML to plain text.
 */
const toText = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as ToTextInput;
    let text = input.html;

    // Remove scripts and styles.
    text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
    text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");

    // Convert block elements to line breaks.
    if (input.preserveLineBreaks) {
      text = text.replace(/<\/?(p|div|br|h[1-6]|li|tr)[^>]*>/gi, "\n");
    }

    // Remove remaining tags.
    text = text.replace(/<[^>]+>/g, " ");

    // Handle whitespace.
    if (!input.preserveWhitespace) {
      text = text.replace(/[ \t]+/g, " ");
      text = text.replace(/\n\s*\n/g, "\n\n");
    }

    text = text.trim();

    return {
      success: true,
      output: { text, length: text.length },
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
 * Sanitize HTML by removing dangerous elements.
 */
const sanitize = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as SanitizeInput;

    if (input.stripAll) {
      const text = input.html.replace(/<[^>]+>/g, "");
      return {
        success: true,
        output: { html: text, stripped: true },
        durationMs: performance.now() - startTime,
      };
    }

    let html = input.html;

    // Always remove script, style, and event handlers.
    html = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
    html = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
    html = html.replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, "");
    html = html.replace(/javascript:/gi, "");

    // Filter tags if allowedTags specified.
    if (input.allowedTags && input.allowedTags.length > 0) {
      const allowedSet = new Set(input.allowedTags.map((t) => t.toLowerCase()));
      html = html.replace(/<\/?(\w+)[^>]*>/gi, (match, tag) => {
        return allowedSet.has(tag.toLowerCase()) ? match : "";
      });
    }

    return {
      success: true,
      output: { html, sanitized: true },
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
 * HTML built-in plugin definition.
 */
export const htmlPlugin: BuiltinPlugin = {
  id: "builtin:html",
  name: "HTML",
  description: "HTML parsing, web scraping, and DOM manipulation",
  actions: {
    parse: {
      name: "parse",
      description: "Parse HTML and extract data using selectors",
      handler: parse,
    },
    query: {
      name: "query",
      description: "Query HTML with CSS selector",
      handler: query,
    },
    extractTable: {
      name: "extractTable",
      description: "Extract table data from HTML",
      handler: extractTable,
    },
    scrape: {
      name: "scrape",
      description: "Scrape a web page and extract data",
      handler: scrape,
    },
    toText: {
      name: "toText",
      description: "Convert HTML to plain text",
      handler: toText,
    },
    sanitize: {
      name: "sanitize",
      description: "Sanitize HTML by removing dangerous elements",
      handler: sanitize,
    },
  },
};
