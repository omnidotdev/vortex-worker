/**
 * Built-in Encrypt Plugin
 *
 * Encrypts data using AES-GCM with Web Crypto API.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

interface EncryptInput {
  input: string;
  key: string;
  algorithm?: "AES-GCM" | "AES-CBC";
}

const stringToBuffer = (str: string): ArrayBuffer => {
  return new TextEncoder().encode(str).buffer;
};

const bufferToBase64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

const deriveKey = async (
  password: string,
  salt: Uint8Array,
  algorithm: "AES-GCM" | "AES-CBC",
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
      salt: salt as BufferSource,
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: algorithm, length: 256 },
    false,
    ["encrypt"],
  );
};

const encryptData = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const {
      input,
      key,
      algorithm = "AES-GCM",
    } = inputs as unknown as EncryptInput;

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
        error: "Encryption key is required",
        durationMs: performance.now() - startTime,
      };
    }

    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cryptoKey = await deriveKey(key, salt, algorithm);

    const encrypted = await crypto.subtle.encrypt(
      { name: algorithm, iv },
      cryptoKey,
      stringToBuffer(input),
    );

    const combined = new Uint8Array(
      salt.length + iv.length + encrypted.byteLength,
    );
    combined.set(salt, 0);
    combined.set(iv, salt.length);
    combined.set(new Uint8Array(encrypted), salt.length + iv.length);

    return {
      success: true,
      output: {
        result: bufferToBase64(combined.buffer),
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

export const encryptPlugin: BuiltinPlugin = {
  id: "builtin:encrypt",
  name: "Encrypt",
  description: "Encrypt data using AES",
  actions: {
    data: {
      name: "data",
      description: "Encrypt data using AES-GCM",
      handler: encryptData,
    },
  },
};
