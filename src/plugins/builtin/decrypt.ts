/**
 * Built-in Decrypt Plugin
 *
 * Decrypts data using AES-GCM with Web Crypto API.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

interface DecryptInput {
  input: string;
  key: string;
  algorithm?: "AES-GCM" | "AES-CBC";
}

const stringToBuffer = (str: string): ArrayBuffer => {
  return new TextEncoder().encode(str).buffer;
};

const base64ToBuffer = (base64: string): ArrayBuffer => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
};

const deriveKey = async (
  password: string,
  salt: Uint8Array,
  algorithm: string,
): Promise<CryptoKey> => {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    stringToBuffer(password),
    "PBKDF2",
    false,
    ["deriveBits", "deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: algorithm, length: 256 },
    false,
    ["decrypt"],
  );
};

const decryptData = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const {
      input,
      key,
      algorithm = "AES-GCM",
    } = inputs as unknown as DecryptInput;

    if (!input) {
      return {
        success: false,
        error: "Encrypted input is required",
        durationMs: performance.now() - startTime,
      };
    }

    if (!key) {
      return {
        success: false,
        error: "Decryption key is required",
        durationMs: performance.now() - startTime,
      };
    }

    const combined = new Uint8Array(base64ToBuffer(input));
    const salt = combined.slice(0, 16);
    const iv = combined.slice(16, 28);
    const ciphertext = combined.slice(28);

    const cryptoKey = await deriveKey(key, salt, algorithm);

    const decrypted = await crypto.subtle.decrypt(
      { name: algorithm, iv },
      cryptoKey,
      ciphertext,
    );

    const result = new TextDecoder().decode(decrypted);

    return {
      success: true,
      output: {
        result,
        algorithm,
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

export const decryptPlugin: BuiltinPlugin = {
  id: "builtin:decrypt",
  name: "Decrypt",
  description: "Decrypt data using AES",
  actions: {
    data: {
      name: "data",
      description: "Decrypt data using AES-GCM",
      handler: decryptData,
    },
  },
};
