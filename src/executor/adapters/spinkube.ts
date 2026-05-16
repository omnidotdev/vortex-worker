/**
 * SpinKube Executor Adapter
 *
 * Deploys WASM modules as Spin apps on Kubernetes via the SpinApp CRD
 * and invokes them over cluster-internal HTTP. Mosaic (IaC) provisions
 * the SpinKube infrastructure (cert-manager, spin-operator,
 * wasmtime-spin-v2 RuntimeClass) on the Fractal cluster; this adapter
 * wires Vortex functions to that infrastructure.
 *
 * Kubernetes API calls use native `fetch` -- no external k8s client
 * library required. Auth tokens and CA certs are read from the
 * standard in-cluster service-account mount or from environment
 * variables for out-of-cluster use.
 */

import { readFileSync } from "node:fs";

const IN_CLUSTER_TOKEN_PATH =
  "/var/run/secrets/kubernetes.io/serviceaccount/token";
const IN_CLUSTER_API_URL = "https://kubernetes.default.svc";

const SPINAPP_API_GROUP = "core.spinoperator.dev";
const SPINAPP_API_VERSION = "v1alpha1";
const SPINAPP_PLURAL = "spinapps";

/** Configuration for the SpinKube executor */
type SpinKubeConfig = {
  /** Kubernetes namespace for Spin apps */
  namespace: string;
  /** RuntimeClass name, e.g. "wasmtime-spin-v2" */
  runtimeClass: string;
  /** Optional k8s API URL (in-cluster by default) */
  kubeApiUrl?: string;
};

/** Input for deploying a WASM module as a SpinApp */
type DeployInput = {
  functionId: string;
  /** OCI image reference for the WASM module */
  wasmModuleUrl: string;
  /** HTTP route, default "/" */
  route?: string;
  /** Desired replica count, default 1 */
  replicas?: number;
  /** Environment variables for the Spin app */
  env?: Record<string, string>;
};

/**
 * Resolve the Kubernetes API base URL.
 * Prefers explicit config, then `KUBE_API_URL` env var, then
 * the standard in-cluster DNS name.
 */
function resolveApiUrl(config: SpinKubeConfig): string {
  return config.kubeApiUrl || process.env.KUBE_API_URL || IN_CLUSTER_API_URL;
}

/**
 * Resolve a bearer token for Kubernetes API auth.
 * Prefers `KUBE_TOKEN` env var, then the mounted service-account token.
 */
function resolveToken(): string {
  if (process.env.KUBE_TOKEN) {
    return process.env.KUBE_TOKEN;
  }

  try {
    return readFileSync(IN_CLUSTER_TOKEN_PATH, "utf-8").trim();
  } catch {
    throw new Error(
      "No Kubernetes token available: set KUBE_TOKEN or run inside a pod",
    );
  }
}

/**
 * Build the base URL for SpinApp CRD operations in a given namespace.
 */
function spinAppBaseUrl(apiUrl: string, namespace: string): string {
  return `${apiUrl}/apis/${SPINAPP_API_GROUP}/${SPINAPP_API_VERSION}/namespaces/${namespace}/${SPINAPP_PLURAL}`;
}

/**
 * Sanitize a function ID into a valid Kubernetes resource name.
 * K8s names must be lowercase RFC 1123 labels.
 */
function toK8sName(functionId: string): string {
  return functionId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 63);
}

/**
 * Build a SpinApp CRD manifest from deploy input.
 */
function buildSpinAppManifest(
  input: DeployInput,
  config: SpinKubeConfig,
): Record<string, unknown> {
  const name = toK8sName(input.functionId);

  const envVars = input.env
    ? Object.entries(input.env).map(([envName, value]) => ({
        name: envName,
        value,
      }))
    : undefined;

  return {
    apiVersion: `${SPINAPP_API_GROUP}/${SPINAPP_API_VERSION}`,
    kind: "SpinApp",
    metadata: {
      name,
      namespace: config.namespace,
      labels: {
        "app.kubernetes.io/managed-by": "vortex",
        "vortex.omni.dev/function-id": input.functionId,
      },
    },
    spec: {
      image: input.wasmModuleUrl,
      executor: config.runtimeClass,
      replicas: input.replicas ?? 1,
      ...(input.route && { route: input.route }),
      ...(envVars && { env: envVars }),
    },
  };
}

class SpinKubeExecutor {
  private readonly config: SpinKubeConfig;
  private readonly apiUrl: string;

  constructor(config: SpinKubeConfig) {
    this.config = config;
    this.apiUrl = resolveApiUrl(config);
  }

  /**
   * Deploy a WASM module as a SpinApp CRD.
   * @param input - Deploy configuration
   * @returns Whether the deployment succeeded and the resource name
   */
  async deploy(
    input: DeployInput,
  ): Promise<{ deployed: boolean; name: string }> {
    const token = resolveToken();
    const manifest = buildSpinAppManifest(input, this.config);
    const name = toK8sName(input.functionId);
    const baseUrl = spinAppBaseUrl(this.apiUrl, this.config.namespace);

    const response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(manifest),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Failed to deploy SpinApp "${name}": ${response.status} ${body}`,
      );
    }

    return { deployed: true, name };
  }

  /**
   * Invoke a deployed SpinApp via cluster-internal HTTP.
   *
   * TODO: `svc.cluster.local` DNS is only reachable from inside the
   * Kubernetes cluster. While vortex-worker runs on Railway this method
   * will fail at runtime. Deferred until Omni infra migrates from
   * Railway to k8s (Fractal), at which point the worker pod will have
   * native cluster DNS access.
   *
   * @param functionId - The function ID (maps to a k8s service name)
   * @param input - Payload to POST to the Spin app
   * @returns Response body from the Spin app
   */
  async invoke(
    functionId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const name = toK8sName(functionId);
    const serviceUrl = `http://${name}.${this.config.namespace}.svc.cluster.local`;

    const response = await fetch(serviceUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `SpinApp invocation failed for "${name}": ${response.status} ${body}`,
      );
    }

    return (await response.json()) as Record<string, unknown>;
  }

  /**
   * Remove a deployed SpinApp CRD.
   * @param functionId - The function ID to undeploy
   */
  async undeploy(functionId: string): Promise<void> {
    const token = resolveToken();
    const name = toK8sName(functionId);
    const baseUrl = spinAppBaseUrl(this.apiUrl, this.config.namespace);

    const response = await fetch(`${baseUrl}/${name}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok && response.status !== 404) {
      const body = await response.text();
      throw new Error(
        `Failed to undeploy SpinApp "${name}": ${response.status} ${body}`,
      );
    }
  }

  /**
   * Check if SpinKube is available in the cluster by listing SpinApp
   * resources.
   * @returns True if the SpinApp CRD is accessible
   */
  async healthCheck(): Promise<boolean> {
    try {
      const token = resolveToken();
      const baseUrl = spinAppBaseUrl(this.apiUrl, this.config.namespace);

      const response = await fetch(`${baseUrl}?limit=1`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      return response.ok;
    } catch {
      return false;
    }
  }
}

export type { DeployInput, SpinKubeConfig };
export { SpinKubeExecutor, buildSpinAppManifest, toK8sName };
