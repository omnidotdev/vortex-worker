/**
 * SpinKube Executor Adapter Tests
 *
 * Mocks `globalThis.fetch` to simulate Kubernetes API interactions
 * without requiring a live cluster.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import {
  SpinKubeExecutor,
  buildSpinAppManifest,
  toK8sName,
} from "../executor/adapters/spinkube";

import type {
  DeployInput,
  SpinKubeConfig,
} from "../executor/adapters/spinkube";

const TEST_CONFIG: SpinKubeConfig = {
  namespace: "vortex-functions",
  runtimeClass: "wasmtime-spin-v2",
  kubeApiUrl: "https://k8s.test:6443",
};

// Store the original fetch so we can restore it after each test
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  // Provide a token via env so the adapter doesn't try to read from disk
  process.env.KUBE_TOKEN = "test-token";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.KUBE_TOKEN;
});

describe("toK8sName", () => {
  it("should lowercase and sanitize function IDs", () => {
    expect(toK8sName("MyFunc_v2")).toBe("myfunc-v2");
  });

  it("should strip leading/trailing hyphens", () => {
    expect(toK8sName("--hello--")).toBe("hello");
  });

  it("should truncate to 63 characters", () => {
    const long = "a".repeat(100);
    expect(toK8sName(long).length).toBe(63);
  });
});

describe("buildSpinAppManifest", () => {
  it("should produce a valid SpinApp manifest", () => {
    const input: DeployInput = {
      functionId: "echo-fn",
      wasmModuleUrl: "ghcr.io/omni/echo:latest",
      route: "/echo",
      replicas: 2,
      env: { LOG_LEVEL: "debug" },
    };

    const manifest = buildSpinAppManifest(input, TEST_CONFIG);

    expect(manifest.apiVersion).toBe("core.spinoperator.dev/v1alpha1");
    expect(manifest.kind).toBe("SpinApp");

    const metadata = manifest.metadata as Record<string, unknown>;
    expect(metadata.name).toBe("echo-fn");
    expect(metadata.namespace).toBe("vortex-functions");

    const spec = manifest.spec as Record<string, unknown>;
    expect(spec.image).toBe("ghcr.io/omni/echo:latest");
    expect(spec.executor).toBe("wasmtime-spin-v2");
    expect(spec.replicas).toBe(2);
    expect(spec.route).toBe("/echo");
    expect(spec.env).toEqual([{ name: "LOG_LEVEL", value: "debug" }]);
  });

  it("should default replicas to 1 and omit optional fields", () => {
    const input: DeployInput = {
      functionId: "simple",
      wasmModuleUrl: "ghcr.io/omni/simple:v1",
    };

    const manifest = buildSpinAppManifest(input, TEST_CONFIG);
    const spec = manifest.spec as Record<string, unknown>;

    expect(spec.replicas).toBe(1);
    expect(spec.route).toBeUndefined();
    expect(spec.env).toBeUndefined();
  });
});

describe("SpinKubeExecutor", () => {
  describe("deploy", () => {
    it("should POST a SpinApp CRD and return success", async () => {
      const fetchMock = mock(
        async (_url: string | URL | Request, _init?: RequestInit) =>
          new Response(JSON.stringify({ metadata: { name: "echo-fn" } }), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          }),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const executor = new SpinKubeExecutor(TEST_CONFIG);
      const result = await executor.deploy({
        functionId: "echo-fn",
        wasmModuleUrl: "ghcr.io/omni/echo:latest",
      });

      expect(result.deployed).toBe(true);
      expect(result.name).toBe("echo-fn");

      // Verify the request
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      expect(url).toContain("/apis/core.spinoperator.dev/v1alpha1");
      expect(url).toContain("namespaces/vortex-functions/spinapps");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual(
        expect.objectContaining({
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        }),
      );

      // Verify the body is a valid SpinApp manifest
      const body = JSON.parse(init!.body as string);
      expect(body.kind).toBe("SpinApp");
      expect(body.spec.image).toBe("ghcr.io/omni/echo:latest");
    });

    it("should throw on non-OK response", async () => {
      globalThis.fetch = mock(
        async () => new Response("conflict", { status: 409 }),
      ) as unknown as typeof fetch;

      const executor = new SpinKubeExecutor(TEST_CONFIG);

      expect(
        executor.deploy({
          functionId: "dup",
          wasmModuleUrl: "ghcr.io/omni/dup:v1",
        }),
      ).rejects.toThrow('Failed to deploy SpinApp "dup": 409');
    });
  });

  describe("invoke", () => {
    it("should POST to the SpinApp service URL", async () => {
      const fetchMock = mock(
        async () =>
          new Response(JSON.stringify({ result: "ok" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const executor = new SpinKubeExecutor(TEST_CONFIG);
      const result = await executor.invoke("echo-fn", {
        message: "hello",
      });

      expect(result).toEqual({ result: "ok" });

      const [url, init] = fetchMock.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      expect(url).toBe("http://echo-fn.vortex-functions.svc.cluster.local");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual(
        expect.objectContaining({
          "Content-Type": "application/json",
        }),
      );
    });

    it("should throw on non-OK response", async () => {
      globalThis.fetch = mock(
        async () => new Response("internal error", { status: 500 }),
      ) as unknown as typeof fetch;

      const executor = new SpinKubeExecutor(TEST_CONFIG);

      expect(executor.invoke("broken", { data: 1 })).rejects.toThrow(
        'SpinApp invocation failed for "broken": 500',
      );
    });
  });

  describe("undeploy", () => {
    it("should DELETE the SpinApp CRD", async () => {
      const fetchMock = mock(async () => new Response(null, { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const executor = new SpinKubeExecutor(TEST_CONFIG);
      await executor.undeploy("echo-fn");

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      expect(url).toContain("/spinapps/echo-fn");
      expect(init?.method).toBe("DELETE");
      expect(init?.headers).toEqual(
        expect.objectContaining({
          Authorization: "Bearer test-token",
        }),
      );
    });

    it("should silently succeed if resource is already gone (404)", async () => {
      globalThis.fetch = mock(
        async () => new Response("not found", { status: 404 }),
      ) as unknown as typeof fetch;

      const executor = new SpinKubeExecutor(TEST_CONFIG);

      // Should not throw
      await executor.undeploy("gone-fn");
    });

    it("should throw on unexpected errors", async () => {
      globalThis.fetch = mock(
        async () => new Response("forbidden", { status: 403 }),
      ) as unknown as typeof fetch;

      const executor = new SpinKubeExecutor(TEST_CONFIG);

      expect(executor.undeploy("forbidden-fn")).rejects.toThrow(
        'Failed to undeploy SpinApp "forbidden-fn": 403',
      );
    });
  });

  describe("healthCheck", () => {
    it("should return true when SpinApp API is accessible", async () => {
      globalThis.fetch = mock(
        async () =>
          new Response(JSON.stringify({ items: [] }), { status: 200 }),
      ) as unknown as typeof fetch;

      const executor = new SpinKubeExecutor(TEST_CONFIG);
      const healthy = await executor.healthCheck();

      expect(healthy).toBe(true);
    });

    it("should return false when SpinApp API is unavailable", async () => {
      globalThis.fetch = mock(
        async () => new Response("not found", { status: 404 }),
      ) as unknown as typeof fetch;

      const executor = new SpinKubeExecutor(TEST_CONFIG);
      const healthy = await executor.healthCheck();

      expect(healthy).toBe(false);
    });

    it("should return false when fetch throws", async () => {
      globalThis.fetch = mock(async () => {
        throw new Error("network error");
      }) as unknown as typeof fetch;

      const executor = new SpinKubeExecutor(TEST_CONFIG);
      const healthy = await executor.healthCheck();

      expect(healthy).toBe(false);
    });
  });
});
