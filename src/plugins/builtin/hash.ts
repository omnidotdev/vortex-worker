/**
 * Built-in Hash Plugin
 *
 * Compute cryptographic hashes using the Web Crypto API.
 * Supports SHA-1, SHA-256, and SHA-512 algorithms.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/** Supported hash algorithms */
type HashAlgorithm = "md5" | "sha1" | "sha256" | "sha512" | "xxhash";

/** Supported output encodings */
type HashEncoding = "hex" | "base64" | "base64url";

/** Hash compute input */
interface HashComputeInput {
  /** Input string to hash */
  input: string;
  /** Hash algorithm */
  algorithm: HashAlgorithm;
  /** Output encoding (default: "hex") */
  encoding?: HashEncoding;
}

/**
 * Map algorithm names to Web Crypto API names.
 */
const ALGORITHM_MAP: Record<string, string> = {
  sha1: "SHA-1",
  sha256: "SHA-256",
  sha512: "SHA-512",
};

/**
 * Encode an ArrayBuffer to the specified encoding.
 */
const encodeHash = (buffer: ArrayBuffer, encoding: HashEncoding): string => {
  const bytes = new Uint8Array(buffer);

  switch (encoding) {
    case "hex": {
      return Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    }

    case "base64": {
      // Convert bytes to binary string, then to base64.
      let binary = "";
      for (const byte of bytes) {
        binary += String.fromCharCode(byte);
      }
      return btoa(binary);
    }

    case "base64url": {
      // Convert to base64, then make URL-safe.
      let binary = "";
      for (const byte of bytes) {
        binary += String.fromCharCode(byte);
      }
      return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }

    default:
      throw new Error(`Unsupported encoding: ${encoding}`);
  }
};

/**
 * Compute a hash of the input string.
 */
const computeHash = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const {
      input,
      algorithm,
      encoding = "hex",
    } = inputs as unknown as HashComputeInput;

    if (typeof input !== "string") {
      return {
        success: false,
        error: "Input must be a string",
        durationMs: performance.now() - startTime,
      };
    }

    if (!algorithm) {
      return {
        success: false,
        error: "Algorithm is required",
        durationMs: performance.now() - startTime,
      };
    }

    // Check for unsupported algorithms.
    if (algorithm === "md5") {
      return {
        success: false,
        error: "MD5 requires external library",
        durationMs: performance.now() - startTime,
      };
    }

    if (algorithm === "xxhash") {
      return {
        success: false,
        error: "xxhash requires external library",
        durationMs: performance.now() - startTime,
      };
    }

    const cryptoAlgorithm = ALGORITHM_MAP[algorithm];
    if (!cryptoAlgorithm) {
      return {
        success: false,
        error: `Unsupported algorithm: ${algorithm}`,
        durationMs: performance.now() - startTime,
      };
    }

    // Convert input string to bytes.
    const encoder = new TextEncoder();
    const data = encoder.encode(input);

    // Compute hash using Web Crypto API.
    const hashBuffer = await crypto.subtle.digest(cryptoAlgorithm, data);

    // Encode the result.
    const hash = encodeHash(hashBuffer, encoding);

    return {
      success: true,
      output: {
        hash,
        algorithm,
        encoding,
        inputLength: input.length,
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
 * Hash built-in plugin definition.
 */
export const hashPlugin: BuiltinPlugin = {
  id: "builtin:hash",
  name: "Hash",
  description: "Compute cryptographic hashes using SHA algorithms",
  actions: {
    compute: {
      name: "compute",
      description: "Compute a hash of the input string",
      handler: computeHash,
    },
  },
};
