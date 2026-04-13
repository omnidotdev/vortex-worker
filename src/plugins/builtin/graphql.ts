/**
 * Built-in GraphQL Plugin
 *
 * GraphQL client operations for querying and mutating GraphQL APIs.
 */

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinPlugin } from "./types";

/** GraphQL request input */
interface QueryInput {
  /** GraphQL endpoint URL */
  endpoint: string;
  /** GraphQL query or mutation */
  query: string;
  /** Variables for the query */
  variables?: Record<string, unknown>;
  /** Operation name (if multiple operations in query) */
  operationName?: string;
  /** Request headers */
  headers?: Record<string, string>;
  /** Bearer token for authorization */
  bearerToken?: string;
  /** Request timeout in ms */
  timeout?: number;
}

/** Introspection input */
interface IntrospectInput {
  /** GraphQL endpoint URL */
  endpoint: string;
  /** Request headers */
  headers?: Record<string, string>;
  /** Bearer token for authorization */
  bearerToken?: string;
}

/** Batch query input */
interface BatchInput {
  /** GraphQL endpoint URL */
  endpoint: string;
  /** Array of queries to execute */
  queries: Array<{
    query: string;
    variables?: Record<string, unknown>;
    operationName?: string;
  }>;
  /** Request headers */
  headers?: Record<string, string>;
  /** Bearer token for authorization */
  bearerToken?: string;
  /** Request timeout in ms */
  timeout?: number;
}

// Subscription and ParseSchema types reserved for future implementation.

/**
 * Standard introspection query.
 */
const INTROSPECTION_QUERY = `
  query IntrospectionQuery {
    __schema {
      queryType { name }
      mutationType { name }
      subscriptionType { name }
      types {
        kind
        name
        description
        fields(includeDeprecated: true) {
          name
          description
          args {
            name
            description
            type { ...TypeRef }
            defaultValue
          }
          type { ...TypeRef }
          isDeprecated
          deprecationReason
        }
        inputFields {
          name
          description
          type { ...TypeRef }
          defaultValue
        }
        interfaces { ...TypeRef }
        enumValues(includeDeprecated: true) {
          name
          description
          isDeprecated
          deprecationReason
        }
        possibleTypes { ...TypeRef }
      }
      directives {
        name
        description
        locations
        args {
          name
          description
          type { ...TypeRef }
          defaultValue
        }
      }
    }
  }
  fragment TypeRef on __Type {
    kind
    name
    ofType {
      kind
      name
      ofType {
        kind
        name
        ofType {
          kind
          name
        }
      }
    }
  }
`;

/**
 * Execute a GraphQL query or mutation.
 */
const query = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as QueryInput;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...input.headers,
    };

    if (input.bearerToken) {
      headers.Authorization = `Bearer ${input.bearerToken}`;
    }

    const body: Record<string, unknown> = {
      query: input.query,
    };

    if (input.variables) {
      body.variables = input.variables;
    }

    if (input.operationName) {
      body.operationName = input.operationName;
    }

    const controller = new AbortController();
    const timeout = input.timeout ?? 30000;
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(input.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const result = (await response.json()) as {
        data?: Record<string, unknown>;
        errors?: Array<{
          message: string;
          path?: string[];
          locations?: Array<{ line: number; column: number }>;
        }>;
      };

      if (result.errors && result.errors.length > 0) {
        return {
          success: false,
          output: {
            data: result.data,
            errors: result.errors,
          },
          error: result.errors.map((e) => e.message).join("; "),
          durationMs: performance.now() - startTime,
        };
      }

      return {
        success: true,
        output: {
          data: result.data,
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
 * Execute a GraphQL mutation (alias for query, semantic distinction).
 */
const mutate = async (
  inputs: Record<string, unknown>,
  context?: PluginContext,
): Promise<PluginCallResult> => {
  return query(inputs, context);
};

/**
 * Introspect a GraphQL schema.
 */
const introspect = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as IntrospectInput;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...input.headers,
    };

    if (input.bearerToken) {
      headers.Authorization = `Bearer ${input.bearerToken}`;
    }

    const response = await fetch(input.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: INTROSPECTION_QUERY }),
    });

    const result = (await response.json()) as {
      data?: { __schema: Record<string, unknown> };
      errors?: Array<{ message: string }>;
    };

    if (result.errors) {
      return {
        success: false,
        error: result.errors.map((e) => e.message).join("; "),
        durationMs: performance.now() - startTime,
      };
    }

    const schema = result.data?.__schema;

    // Extract useful summary.
    const types =
      (schema?.types as Array<{ kind: string; name: string }>) ?? [];
    const queryType = schema?.queryType as { name: string } | undefined;
    const mutationType = schema?.mutationType as { name: string } | undefined;
    const subscriptionType = schema?.subscriptionType as
      | { name: string }
      | undefined;

    const summary = {
      queryType: queryType?.name,
      mutationType: mutationType?.name,
      subscriptionType: subscriptionType?.name,
      typeCount: types.length,
      objectTypes: types.filter(
        (t) => t.kind === "OBJECT" && !t.name.startsWith("__"),
      ).length,
      inputTypes: types.filter((t) => t.kind === "INPUT_OBJECT").length,
      enumTypes: types.filter(
        (t) => t.kind === "ENUM" && !t.name.startsWith("__"),
      ).length,
      interfaceTypes: types.filter((t) => t.kind === "INTERFACE").length,
      unionTypes: types.filter((t) => t.kind === "UNION").length,
    };

    return {
      success: true,
      output: {
        schema,
        summary,
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
 * Execute multiple queries in a batch.
 */
const batch = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as BatchInput;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...input.headers,
    };

    if (input.bearerToken) {
      headers.Authorization = `Bearer ${input.bearerToken}`;
    }

    const body = input.queries.map((q) => ({
      query: q.query,
      variables: q.variables,
      operationName: q.operationName,
    }));

    const controller = new AbortController();
    const timeout = input.timeout ?? 30000;
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(input.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const results = (await response.json()) as Array<{
        data?: Record<string, unknown>;
        errors?: Array<{ message: string }>;
      }>;

      const hasErrors = results.some((r) => r.errors && r.errors.length > 0);

      return {
        success: !hasErrors,
        output: {
          results: results.map((r, i) => ({
            index: i,
            data: r.data,
            errors: r.errors,
          })),
          successCount: results.filter(
            (r) => !r.errors || r.errors.length === 0,
          ).length,
          errorCount: results.filter((r) => r.errors && r.errors.length > 0)
            .length,
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
 * Parse and validate a GraphQL query string.
 */
const parseQuery = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as { query: string };

    // Basic query parsing (extract operations, fields, variables).
    const query = input.query;

    // Extract operation type and name.
    const operationMatch = query.match(
      /^\s*(query|mutation|subscription)\s+(\w+)?/m,
    );
    const operationType = operationMatch?.[1] ?? "query";
    const operationName = operationMatch?.[2];

    // Extract variables.
    const variablesMatch = query.match(/\(([^)]+)\)/);
    const variables: Array<{ name: string; type: string }> = [];

    if (variablesMatch) {
      const varDefs = variablesMatch[1].split(",");
      for (const def of varDefs) {
        const match = def.trim().match(/\$(\w+)\s*:\s*(.+)/);
        if (match) {
          variables.push({ name: match[1], type: match[2].trim() });
        }
      }
    }

    // Extract top-level fields.
    const fieldsMatch = query.match(/\{\s*([^{}]+(?:\{[^{}]*\}[^{}]*)*)\s*\}/);
    const fields: string[] = [];

    if (fieldsMatch) {
      const fieldContent = fieldsMatch[1];
      const fieldNames = fieldContent.match(/^\s*(\w+)/gm);
      if (fieldNames) {
        fields.push(...fieldNames.map((f) => f.trim()));
      }
    }

    return {
      success: true,
      output: {
        operationType,
        operationName,
        variables,
        topLevelFields: fields,
        valid: true,
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
 * Build a simple GraphQL query from parameters.
 */
const buildQuery = async (
  inputs: Record<string, unknown>,
  _context?: PluginContext,
): Promise<PluginCallResult> => {
  const startTime = performance.now();

  try {
    const input = inputs as unknown as {
      operationType?: "query" | "mutation" | "subscription";
      operationName?: string;
      fields: string | string[] | Record<string, unknown>;
      variables?: Record<string, { type: string; value?: unknown }>;
    };

    const opType = input.operationType ?? "query";
    const opName = input.operationName ?? "";

    // Build variable definitions.
    let varDefs = "";
    const varValues: Record<string, unknown> = {};

    if (input.variables) {
      const defs: string[] = [];
      for (const [name, def] of Object.entries(input.variables)) {
        defs.push(`$${name}: ${def.type}`);
        if (def.value !== undefined) {
          varValues[name] = def.value;
        }
      }
      if (defs.length > 0) {
        varDefs = `(${defs.join(", ")})`;
      }
    }

    // Build fields.
    const buildFields = (
      fields: string | string[] | Record<string, unknown>,
      indent = 2,
    ): string => {
      const pad = " ".repeat(indent);

      if (typeof fields === "string") {
        return `${pad}${fields}`;
      }

      if (Array.isArray(fields)) {
        return fields.map((f) => `${pad}${f}`).join("\n");
      }

      const lines: string[] = [];
      for (const [key, value] of Object.entries(fields)) {
        if (typeof value === "object" && value !== null) {
          lines.push(`${pad}${key} {`);
          lines.push(buildFields(value as Record<string, unknown>, indent + 2));
          lines.push(`${pad}}`);
        } else {
          lines.push(`${pad}${key}`);
        }
      }
      return lines.join("\n");
    };

    const fieldsStr = buildFields(input.fields);

    const query = `${opType} ${opName}${varDefs} {\n${fieldsStr}\n}`;

    return {
      success: true,
      output: {
        query,
        variables: Object.keys(varValues).length > 0 ? varValues : undefined,
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
 * GraphQL built-in plugin definition.
 */
export const graphqlPlugin: BuiltinPlugin = {
  id: "builtin:graphql",
  name: "GraphQL",
  description: "GraphQL client operations",
  actions: {
    query: {
      name: "query",
      description: "Execute a GraphQL query",
      handler: query,
    },
    mutate: {
      name: "mutate",
      description: "Execute a GraphQL mutation",
      handler: mutate,
    },
    introspect: {
      name: "introspect",
      description: "Introspect a GraphQL schema",
      handler: introspect,
    },
    batch: {
      name: "batch",
      description: "Execute multiple queries in a batch",
      handler: batch,
    },
    parseQuery: {
      name: "parseQuery",
      description: "Parse and analyze a GraphQL query",
      handler: parseQuery,
    },
    buildQuery: {
      name: "buildQuery",
      description: "Build a GraphQL query from parameters",
      handler: buildQuery,
    },
  },
};
