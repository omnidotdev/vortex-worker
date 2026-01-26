/**
 * Built-in Generator Plugin
 *
 * Data generation utilities: UUIDs, random data, sequences, mock data.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/** UUID generation input */
interface UuidInput {
  /** Version (4 = random, 7 = time-ordered) */
  version?: 4 | 7;
  /** Number of UUIDs to generate */
  count?: number;
}

/** Random string input */
interface RandomStringInput {
  /** Length of string */
  length: number;
  /** Character set */
  charset?: "alphanumeric" | "alpha" | "numeric" | "hex" | "base64" | "custom";
  /** Custom characters (when charset is 'custom') */
  characters?: string;
  /** Number of strings to generate */
  count?: number;
}

/** Random number input */
interface RandomNumberInput {
  /** Minimum value (inclusive) */
  min?: number;
  /** Maximum value (inclusive) */
  max?: number;
  /** Integer or float */
  type?: "integer" | "float";
  /** Decimal places for float */
  decimals?: number;
  /** Number of values to generate */
  count?: number;
}

/** Sequence input */
interface SequenceInput {
  /** Starting value */
  start?: number;
  /** Step increment */
  step?: number;
  /** Number of values */
  count: number;
  /** Prefix for string sequences */
  prefix?: string;
  /** Suffix for string sequences */
  suffix?: string;
  /** Padding length for numbers */
  padding?: number;
}

/** Lorem ipsum input */
interface LoremInput {
  /** Type of content */
  type: "words" | "sentences" | "paragraphs";
  /** Number of units */
  count?: number;
}

/** Mock data input */
interface MockInput {
  /** Schema defining the mock data structure */
  schema: Record<string, MockField>;
  /** Number of records to generate */
  count?: number;
  /** Locale for localized data */
  locale?: string;
}

/** Mock field definition */
interface MockField {
  type: "string" | "number" | "boolean" | "date" | "email" | "name" | "phone" | "address" | "uuid" | "enum" | "array" | "object";
  /** Min/max for numbers or lengths */
  min?: number;
  max?: number;
  /** Enum values */
  values?: unknown[];
  /** Array item type */
  items?: MockField;
  /** Object properties */
  properties?: Record<string, MockField>;
}

/** Date input */
interface DateInput {
  /** Start date range */
  start?: string;
  /** End date range */
  end?: string;
  /** Output format */
  format?: "iso" | "timestamp" | "date" | "datetime";
  /** Number of dates to generate */
  count?: number;
}

/** Password input */
interface PasswordInput {
  /** Length */
  length?: number;
  /** Include uppercase */
  uppercase?: boolean;
  /** Include lowercase */
  lowercase?: boolean;
  /** Include numbers */
  numbers?: boolean;
  /** Include symbols */
  symbols?: boolean;
  /** Exclude ambiguous characters */
  excludeAmbiguous?: boolean;
  /** Number of passwords to generate */
  count?: number;
}

/** Slug input */
interface SlugInput {
  /** Text to slugify */
  text: string;
  /** Separator character */
  separator?: string;
  /** Convert to lowercase */
  lowercase?: boolean;
}

// Character sets.
const CHARSETS = {
  alphanumeric: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
  alpha: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
  numeric: "0123456789",
  hex: "0123456789abcdef",
  base64: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",
};

// Lorem ipsum words.
const LOREM_WORDS = [
  "lorem", "ipsum", "dolor", "sit", "amet", "consectetur", "adipiscing", "elit",
  "sed", "do", "eiusmod", "tempor", "incididunt", "ut", "labore", "et", "dolore",
  "magna", "aliqua", "enim", "ad", "minim", "veniam", "quis", "nostrud",
  "exercitation", "ullamco", "laboris", "nisi", "aliquip", "ex", "ea", "commodo",
  "consequat", "duis", "aute", "irure", "in", "reprehenderit", "voluptate",
  "velit", "esse", "cillum", "fugiat", "nulla", "pariatur", "excepteur", "sint",
  "occaecat", "cupidatat", "non", "proident", "sunt", "culpa", "qui", "officia",
  "deserunt", "mollit", "anim", "id", "est", "laborum",
];

// Sample names for mock data.
const FIRST_NAMES = ["James", "Mary", "John", "Patricia", "Robert", "Jennifer", "Michael", "Linda", "William", "Elizabeth"];
const LAST_NAMES = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Rodriguez", "Martinez"];
const DOMAINS = ["example.com", "test.org", "sample.net", "demo.io", "mock.dev"];

/**
 * Generate random bytes.
 */
const randomBytes = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
};

/**
 * Generate random integer in range.
 */
const randomInt = (min: number, max: number): number => {
  return Math.floor(Math.random() * (max - min + 1)) + min;
};

/**
 * Generate UUID v4 or v7.
 */
const uuid = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as UuidInput;
    const count = input.count ?? 1;
    const version = input.version ?? 4;

    const uuids: string[] = [];

    for (let i = 0; i < count; i++) {
      if (version === 7) {
        // UUID v7: time-ordered.
        const now = Date.now();
        const bytes = randomBytes(16);

        // Set timestamp (first 48 bits).
        bytes[0] = (now >> 40) & 0xff;
        bytes[1] = (now >> 32) & 0xff;
        bytes[2] = (now >> 24) & 0xff;
        bytes[3] = (now >> 16) & 0xff;
        bytes[4] = (now >> 8) & 0xff;
        bytes[5] = now & 0xff;

        // Set version 7.
        bytes[6] = (bytes[6] & 0x0f) | 0x70;
        // Set variant.
        bytes[8] = (bytes[8] & 0x3f) | 0x80;

        const hex = Array.from(bytes)
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");

        uuids.push(
          `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
        );
      } else {
        // UUID v4: random.
        uuids.push(crypto.randomUUID());
      }
    }

    return {
      success: true,
      output: count === 1 ? { uuid: uuids[0] } : { uuids },
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
 * Generate random string.
 */
const randomString = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as RandomStringInput;
    const count = input.count ?? 1;
    const charset = input.charset ?? "alphanumeric";
    const characters = charset === "custom" ? (input.characters ?? "") : CHARSETS[charset];

    if (!characters) {
      return {
        success: false,
        error: "No characters specified for random string generation",
        durationMs: performance.now() - startTime,
      };
    }

    const strings: string[] = [];

    for (let i = 0; i < count; i++) {
      let result = "";
      for (let j = 0; j < input.length; j++) {
        result += characters[randomInt(0, characters.length - 1)];
      }
      strings.push(result);
    }

    return {
      success: true,
      output: count === 1 ? { string: strings[0] } : { strings },
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
 * Generate random number.
 */
const randomNumber = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as RandomNumberInput;
    const count = input.count ?? 1;
    const min = input.min ?? 0;
    const max = input.max ?? 100;
    const type = input.type ?? "integer";

    const numbers: number[] = [];

    for (let i = 0; i < count; i++) {
      if (type === "integer") {
        numbers.push(randomInt(min, max));
      } else {
        const value = Math.random() * (max - min) + min;
        const decimals = input.decimals ?? 2;
        numbers.push(Number(value.toFixed(decimals)));
      }
    }

    return {
      success: true,
      output: count === 1 ? { number: numbers[0] } : { numbers },
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
 * Generate a sequence of values.
 */
const sequence = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as SequenceInput;
    const start = input.start ?? 1;
    const step = input.step ?? 1;

    const values: (number | string)[] = [];

    for (let i = 0; i < input.count; i++) {
      const num = start + i * step;

      if (input.prefix || input.suffix || input.padding) {
        const numStr = input.padding ? String(num).padStart(input.padding, "0") : String(num);
        values.push(`${input.prefix ?? ""}${numStr}${input.suffix ?? ""}`);
      } else {
        values.push(num);
      }
    }

    return {
      success: true,
      output: { sequence: values },
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
 * Generate lorem ipsum text.
 */
const lorem = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as LoremInput;
    const count = input.count ?? 1;

    const generateSentence = (): string => {
      const length = randomInt(8, 15);
      const words: string[] = [];
      for (let i = 0; i < length; i++) {
        words.push(LOREM_WORDS[randomInt(0, LOREM_WORDS.length - 1)]);
      }
      words[0] = words[0].charAt(0).toUpperCase() + words[0].slice(1);
      return words.join(" ") + ".";
    };

    const generateParagraph = (): string => {
      const sentences: string[] = [];
      const sentenceCount = randomInt(4, 8);
      for (let i = 0; i < sentenceCount; i++) {
        sentences.push(generateSentence());
      }
      return sentences.join(" ");
    };

    let result: string;

    switch (input.type) {
      case "words": {
        const words: string[] = [];
        for (let i = 0; i < count; i++) {
          words.push(LOREM_WORDS[randomInt(0, LOREM_WORDS.length - 1)]);
        }
        result = words.join(" ");
        break;
      }
      case "sentences": {
        const sentences: string[] = [];
        for (let i = 0; i < count; i++) {
          sentences.push(generateSentence());
        }
        result = sentences.join(" ");
        break;
      }
      case "paragraphs": {
        const paragraphs: string[] = [];
        for (let i = 0; i < count; i++) {
          paragraphs.push(generateParagraph());
        }
        result = paragraphs.join("\n\n");
        break;
      }
      default:
        result = "";
    }

    return {
      success: true,
      output: { text: result },
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
 * Generate mock data based on schema.
 */
const mock = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as MockInput;
    const count = input.count ?? 1;

    const generateField = (field: MockField): unknown => {
      switch (field.type) {
        case "string":
          const len = randomInt(field.min ?? 5, field.max ?? 20);
          return Array.from({ length: len }, () =>
            CHARSETS.alpha[randomInt(0, CHARSETS.alpha.length - 1)],
          ).join("");

        case "number":
          return randomInt(field.min ?? 0, field.max ?? 100);

        case "boolean":
          return Math.random() > 0.5;

        case "date": {
          const start = field.min ? new Date(field.min).getTime() : Date.now() - 365 * 24 * 60 * 60 * 1000;
          const end = field.max ? new Date(field.max).getTime() : Date.now();
          return new Date(randomInt(start, end)).toISOString();
        }

        case "email": {
          const first = FIRST_NAMES[randomInt(0, FIRST_NAMES.length - 1)].toLowerCase();
          const last = LAST_NAMES[randomInt(0, LAST_NAMES.length - 1)].toLowerCase();
          const domain = DOMAINS[randomInt(0, DOMAINS.length - 1)];
          return `${first}.${last}@${domain}`;
        }

        case "name": {
          const first = FIRST_NAMES[randomInt(0, FIRST_NAMES.length - 1)];
          const last = LAST_NAMES[randomInt(0, LAST_NAMES.length - 1)];
          return `${first} ${last}`;
        }

        case "phone":
          return `+1${randomInt(200, 999)}${randomInt(100, 999)}${randomInt(1000, 9999)}`;

        case "address":
          return `${randomInt(1, 9999)} ${LAST_NAMES[randomInt(0, LAST_NAMES.length - 1)]} St`;

        case "uuid":
          return crypto.randomUUID();

        case "enum":
          return field.values?.[randomInt(0, (field.values?.length ?? 1) - 1)];

        case "array": {
          const len = randomInt(field.min ?? 1, field.max ?? 5);
          return Array.from({ length: len }, () =>
            field.items ? generateField(field.items) : null,
          );
        }

        case "object": {
          const obj: Record<string, unknown> = {};
          if (field.properties) {
            for (const [key, prop] of Object.entries(field.properties)) {
              obj[key] = generateField(prop);
            }
          }
          return obj;
        }

        default:
          return null;
      }
    };

    const records: Record<string, unknown>[] = [];

    for (let i = 0; i < count; i++) {
      const record: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(input.schema)) {
        record[key] = generateField(field);
      }
      records.push(record);
    }

    return {
      success: true,
      output: count === 1 ? { record: records[0] } : { records },
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
 * Generate random date.
 */
const date = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as DateInput;
    const count = input.count ?? 1;
    const format = input.format ?? "iso";

    const startDate = input.start ? new Date(input.start).getTime() : Date.now() - 365 * 24 * 60 * 60 * 1000;
    const endDate = input.end ? new Date(input.end).getTime() : Date.now();

    const dates: (string | number)[] = [];

    for (let i = 0; i < count; i++) {
      const timestamp = randomInt(startDate, endDate);
      const d = new Date(timestamp);

      switch (format) {
        case "timestamp":
          dates.push(timestamp);
          break;
        case "date":
          dates.push(d.toISOString().split("T")[0]);
          break;
        case "datetime":
          dates.push(d.toISOString().replace("T", " ").split(".")[0]);
          break;
        default:
          dates.push(d.toISOString());
      }
    }

    return {
      success: true,
      output: count === 1 ? { date: dates[0] } : { dates },
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
 * Generate password.
 */
const password = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as PasswordInput;
    const count = input.count ?? 1;
    const length = input.length ?? 16;

    let charset = "";
    if (input.uppercase !== false) charset += "ABCDEFGHJKLMNPQRSTUVWXYZ";
    if (input.lowercase !== false) charset += "abcdefghjkmnpqrstuvwxyz";
    if (input.numbers !== false) charset += "23456789";
    if (input.symbols) charset += "!@#$%^&*()_+-=[]{}|;:,.<>?";

    if (input.excludeAmbiguous) {
      charset = charset.replace(/[0OIl1]/g, "");
    }

    if (!charset) {
      charset = CHARSETS.alphanumeric;
    }

    const passwords: string[] = [];

    for (let i = 0; i < count; i++) {
      let pwd = "";
      for (let j = 0; j < length; j++) {
        pwd += charset[randomInt(0, charset.length - 1)];
      }
      passwords.push(pwd);
    }

    return {
      success: true,
      output: count === 1 ? { password: passwords[0] } : { passwords },
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
 * Generate URL-safe slug from text.
 */
const slug = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as SlugInput;
    const separator = input.separator ?? "-";

    let result = input.text
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "") // Remove diacritics.
      .replace(/[^a-zA-Z0-9\s-]/g, "") // Remove special chars.
      .replace(/\s+/g, separator) // Replace spaces.
      .replace(new RegExp(`${separator}+`, "g"), separator) // Remove duplicate separators.
      .replace(new RegExp(`^${separator}|${separator}$`, "g"), ""); // Trim separators.

    if (input.lowercase !== false) {
      result = result.toLowerCase();
    }

    return {
      success: true,
      output: { slug: result },
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
 * Generator built-in plugin definition.
 */
export const generatorPlugin: BuiltinPlugin = {
  id: "builtin:generator",
  name: "Generator",
  description: "Data generation: UUIDs, random data, sequences, mock data",
  actions: {
    uuid: {
      name: "uuid",
      description: "Generate UUID v4 or v7",
      handler: uuid,
    },
    randomString: {
      name: "randomString",
      description: "Generate random string",
      handler: randomString,
    },
    randomNumber: {
      name: "randomNumber",
      description: "Generate random number",
      handler: randomNumber,
    },
    sequence: {
      name: "sequence",
      description: "Generate a sequence of values",
      handler: sequence,
    },
    lorem: {
      name: "lorem",
      description: "Generate lorem ipsum text",
      handler: lorem,
    },
    mock: {
      name: "mock",
      description: "Generate mock data from schema",
      handler: mock,
    },
    date: {
      name: "date",
      description: "Generate random date",
      handler: date,
    },
    password: {
      name: "password",
      description: "Generate secure password",
      handler: password,
    },
    slug: {
      name: "slug",
      description: "Generate URL-safe slug from text",
      handler: slug,
    },
  },
};
