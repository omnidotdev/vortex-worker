/**
 * Built-in Sign Plugin
 *
 * Creates HMAC signatures using Web Crypto API.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

interface SignInput {
  input: string;
  key: string;
  algorithm?: "SHA-256" | "SHA-384" | "SHA-512";
  encoding?: "hex" | "base64";
}

const bufferToHex = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

const bufferToBase64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

const signData = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const {
      input,
      key,
      algorithm = "SHA-256",
      encoding = "hex",
    } = inputs as unknown as SignInput;

    if (!input) {
      return {
        success: false,
        error: "Input is required",
        durationMs: performance.now() - startTime,
      };
    }

    if (!key) {
      return {
        success: false,
        error: "Signing key is required",
        durationMs: performance.now() - startTime,
      };
    }

    const encoder = new TextEncoder();

    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      encoder.encode(key),
      { name: "HMAC", hash: algorithm },
      false,
      ["sign"],
    );

    const signature = await crypto.subtle.sign(
      "HMAC",
      cryptoKey,
      encoder.encode(input),
    );

    const result =
      encoding === "hex" ? bufferToHex(signature) : bufferToBase64(signature);

    return {
      success: true,
      output: {
        signature: result,
        algorithm,
        encoding,
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

export const signPlugin: BuiltinPlugin = {
  id: "builtin:sign",
  name: "Sign",
  description: "Create HMAC signatures",
  actions: {
    data: {
      name: "data",
      description: "Create HMAC signature",
      handler: signData,
    },
  },
};
