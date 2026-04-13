/**
 * Security Step Tests
 *
 * Tests for built-in security plugins (encrypt, decrypt, hash, jwt)
 * via executeBuiltinAction.
 */

import { describe, expect, it } from "bun:test";

import { executeBuiltinAction } from "../plugins/builtin/index";

describe("security steps", () => {
  describe("encrypt/decrypt", () => {
    it("should encrypt and decrypt data roundtrip", async () => {
      const testKey = "test-encryption-key-32chars!!!!!";
      const plaintext = "sensitive data";

      const encryptResult = await executeBuiltinAction(
        "builtin:encrypt",
        "data",
        {
          input: plaintext,
          key: testKey,
          algorithm: "AES-GCM",
        },
      );

      expect(encryptResult.success).toBe(true);
      expect(encryptResult.output).toBeDefined();

      const encrypted = (encryptResult.output as Record<string, unknown>)
        .result;
      expect(encrypted).toBeDefined();
      expect(encrypted).not.toBe(plaintext);

      const decryptResult = await executeBuiltinAction(
        "builtin:decrypt",
        "data",
        {
          input: String(encrypted),
          key: testKey,
          algorithm: "AES-GCM",
        },
      );

      expect(decryptResult.success).toBe(true);
    });
  });

  describe("hash", () => {
    it("should compute hash of input", async () => {
      const result = await executeBuiltinAction("builtin:hash", "compute", {
        input: "hello world",
        algorithm: "sha256",
        encoding: "hex",
      });

      expect(result.success).toBe(true);
      expect(result.output).toBeDefined();
    });

    it("should produce consistent hashes", async () => {
      const result1 = await executeBuiltinAction("builtin:hash", "compute", {
        input: "test",
        algorithm: "sha256",
        encoding: "hex",
      });

      const result2 = await executeBuiltinAction("builtin:hash", "compute", {
        input: "test",
        algorithm: "sha256",
        encoding: "hex",
      });

      expect(result1.output).toEqual(result2.output);
    });
  });

  describe("jwt", () => {
    it("should sign a JWT token", async () => {
      const result = await executeBuiltinAction("builtin:jwt", "token", {
        operation: "create",
        input: JSON.stringify({ sub: "user-123", role: "admin" }),
        secret: "test-jwt-secret",
        algorithm: "HS256",
        expiresIn: 3600,
      });

      expect(result.success).toBe(true);
      expect(result.output).toBeDefined();
    });

    it("should verify a signed JWT token", async () => {
      const secret = "test-jwt-secret";

      const signResult = await executeBuiltinAction("builtin:jwt", "token", {
        operation: "create",
        input: JSON.stringify({ sub: "user-123" }),
        secret,
        algorithm: "HS256",
        expiresIn: 3600,
      });

      expect(signResult.success).toBe(true);

      const token = (signResult.output as Record<string, unknown>).token;
      if (token) {
        const verifyResult = await executeBuiltinAction(
          "builtin:jwt",
          "token",
          {
            operation: "verify",
            input: String(token),
            secret,
            algorithm: "HS256",
          },
        );

        expect(verifyResult.success).toBe(true);
      }
    });
  });
});
