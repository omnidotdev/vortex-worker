import { match } from "ts-pattern";

import { executeConnectorAction } from "../connectors/executor";
import { getIntegrationCredentials } from "../integrations/credentials";
import { connectMCPServer, getMCPClient } from "../mcp";
import {
  executeBuiltinAction,
  getPluginHost,
  isBuiltinPlugin,
} from "../plugins";

import type { PluginCallResult } from "../plugins/types";
import type {
  ActionStep,
  CodeStep,
  ConditionStep,
  DatabaseStep,
  DelayStep,
  ExecutionContext,
  GateStep,
  LLMStep,
  LoopStep,
  MCPStep,
  ParallelStep,
  PluginStep,
  Step,
  SwitchStep,
  TriggerStep,
  WorkflowDefinition,
} from "./types";

/**
 * Map integration IDs to Activepieces connector package IDs.
 */
const INTEGRATION_TO_CONNECTOR: Record<string, string> = {
  discord: "@activepieces/piece-discord",
  slack: "@activepieces/piece-slack",
  github: "@activepieces/piece-github",
  gitlab: "@activepieces/piece-gitlab",
  linear: "@activepieces/piece-linear",
  notion: "@activepieces/piece-notion",
  "google-sheets": "@activepieces/piece-google-sheets",
  airtable: "@activepieces/piece-airtable",
  hubspot: "@activepieces/piece-hubspot",
  mailchimp: "@activepieces/piece-mailchimp",
  stripe: "@activepieces/piece-stripe",
  openai: "@activepieces/piece-openai",
  telegram: "@activepieces/piece-telegram-bot",
};

export function findTriggerStep(steps: Step[]): TriggerStep | undefined {
  return steps.find((s): s is TriggerStep => s.type === "trigger");
}

export function findNextSteps(
  def: WorkflowDefinition,
  currentStepId: string,
  sourceHandle?: string,
): Step[] {
  const outgoingEdges = def.edges.filter((e) => {
    if (e.source !== currentStepId) return false;
    if (sourceHandle && e.sourceHandle !== sourceHandle) return false;
    return true;
  });

  return outgoingEdges
    .map((e) => def.steps.find((s) => s.id === e.target))
    .filter((s): s is Step => s !== undefined);
}

export function createExecutionContext(
  workflowId: string,
  runId: string,
  triggerData: Record<string, unknown>,
  organizationId?: string,
): ExecutionContext {
  return {
    workflowId,
    runId,
    organizationId,
    triggerData,
    variables: {},
    stepResults: {},
  };
}

export async function executeStep(
  def: WorkflowDefinition,
  step: Step,
  ctx: ExecutionContext,
): Promise<{ nextSteps: Step[]; result: unknown }> {
  const result = await match(step)
    .with({ type: "trigger" }, (s) => executeTrigger(s, ctx))
    .with({ type: "action" }, (s) => executeAction(s, ctx))
    .with({ type: "condition" }, (s) => executeCondition(s, ctx, def))
    .with({ type: "switch" }, (s) => executeSwitch(s, ctx, def))
    .with({ type: "delay" }, (s) => executeDelay(s, ctx))
    .with({ type: "loop" }, (s) => executeLoop(s, ctx, def))
    .with({ type: "parallel" }, (s) => executeParallel(s, ctx, def))
    .with({ type: "gate" }, (s) => executeGate(s, ctx))
    .with({ type: "plugin" }, (s) => executePlugin(s, ctx))
    .with({ type: "mcp" }, (s) => executeMCP(s, ctx))
    .with({ type: "llm" }, (s) => executeLLM(s, ctx))
    .with({ type: "code" }, (s) => executeCode(s, ctx))
    .with({ type: "database" }, (s) => executeDatabase(s, ctx))
    .exhaustive();

  ctx.stepResults[step.id] = result;

  // Determine the source handle for finding next steps
  const sourceHandle = match(step)
    .with({ type: "condition" }, () => {
      const condResult = result as { branch: string };
      return condResult.branch;
    })
    .with({ type: "switch" }, () => {
      const switchResult = result as { case: string };
      return switchResult.case;
    })
    .otherwise(() => undefined);

  const nextSteps = findNextSteps(def, step.id, sourceHandle);

  return { nextSteps, result };
}

async function executeTrigger(
  _step: TriggerStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  return ctx.triggerData;
}

const executeAction = async (
  step: ActionStep,
  ctx: ExecutionContext,
): Promise<unknown> => {
  const { action } = step;

  // Resolve input expressions from context
  const resolvedInputs = resolveInputs(action.inputs, ctx);

  const pluginContext = {
    workflowId: ctx.workflowId,
    runId: ctx.runId,
    stepId: step.id,
    config: {},
    secrets: {},
  };

  let output: Record<string, unknown>;
  let durationMs: number;

  // Handle integrationId (vendor integrations via Activepieces connectors)
  if (action.integrationId) {
    const connectorId = INTEGRATION_TO_CONNECTOR[action.integrationId];
    if (!connectorId) {
      throw new Error(`Unknown integration: ${action.integrationId}`);
    }

    // Fetch credentials from database if organizationId is available
    let auth: import("../connectors/types").DecryptedCredentialValue | undefined;
    if (ctx.organizationId) {
      auth = await getIntegrationCredentials(
        ctx.organizationId,
        action.integrationId,
      );
      if (auth) {
        console.log(
          `[Executor] Loaded credentials for integration=${action.integrationId} org=${ctx.organizationId} type=${auth.type}`,
        );
      } else {
        console.log(
          `[Executor] No credentials found for integration=${action.integrationId} org=${ctx.organizationId}`,
        );
      }
    } else {
      console.log(
        `[Executor] No organizationId in context, skipping credential lookup for integration=${action.integrationId}`,
      );
    }

    const callResult = await executeConnectorAction(
      connectorId,
      action.operation,
      resolvedInputs,
      pluginContext,
      auth,
    );

    if (!callResult.success) {
      throw new Error(`Integration action failed: ${callResult.error}`);
    }

    output = callResult.output || { success: true };
    durationMs = callResult.durationMs;
  } else if (action.pluginId) {
    // Handle pluginId (builtin or WASM plugins)
    if (isBuiltinPlugin(action.pluginId)) {
      const callResult = await executeBuiltinAction(
        action.pluginId,
        action.operation,
        resolvedInputs,
        pluginContext,
      );

      if (!callResult.success) {
        throw new Error(`Action execution failed: ${callResult.error}`);
      }

      output = callResult.output || { success: true };
      durationMs = callResult.durationMs;
    } else {
      // WASM plugin
      const host = getPluginHost();
      const loadedPlugin = host.get(action.pluginId);

      if (!loadedPlugin) {
        throw new Error(`Plugin not loaded: ${action.pluginId}`);
      }

      const callResult = await loadedPlugin.call(
        action.operation,
        resolvedInputs,
        pluginContext,
      );

      if (!callResult.success) {
        throw new Error(`Action execution failed: ${callResult.error}`);
      }

      output = callResult.output || { success: true };
      durationMs = callResult.durationMs;
    }
  } else {
    throw new Error(
      `Action step "${step.name || step.id}" is missing both integrationId and pluginId. ` +
        "All action nodes must specify either an integration or a plugin to execute.",
    );
  }

  const result = {
    operation: action.operation,
    inputs: resolvedInputs,
    integrationId: action.integrationId,
    pluginId: action.pluginId,
    executedAt: new Date().toISOString(),
    output,
    durationMs,
  };

  // Map outputs to context variables if specified
  if (action.outputs) {
    for (const [outputKey, variableName] of Object.entries(action.outputs)) {
      ctx.variables[String(variableName)] = output[outputKey];
    }
  }

  return result;
};

async function executeCondition(
  step: ConditionStep,
  ctx: ExecutionContext,
  _def: WorkflowDefinition,
): Promise<{ branch: string; value: boolean }> {
  const { condition } = step;

  // Evaluate the expression
  const value = evaluateExpression(condition.expression, ctx);

  return {
    branch: value ? "true" : "false",
    value,
  };
}

async function executeSwitch(
  step: SwitchStep,
  ctx: ExecutionContext,
  _def: WorkflowDefinition,
): Promise<{ case: string; matchedValue: unknown }> {
  const { switch: switchConfig } = step;

  // Resolve the expression to get the actual value (not a boolean)
  const value = resolveValue(switchConfig.expression, ctx);

  // Find matching case
  const matchedCase = switchConfig.cases.find((c) => c.value === value);

  if (matchedCase) {
    return {
      case: `case_${switchConfig.cases.indexOf(matchedCase)}`,
      matchedValue: value,
    };
  }

  return { case: "default", matchedValue: value };
}

async function executeDelay(
  step: DelayStep,
  _ctx: ExecutionContext,
): Promise<{ delayed: boolean; duration: number; unit: string }> {
  const { delay } = step;
  const ms = convertToMs(delay.duration, delay.unit);

  await new Promise((resolve) => setTimeout(resolve, ms));

  return { delayed: true, duration: delay.duration, unit: delay.unit };
}

async function executeLoop(
  step: LoopStep,
  ctx: ExecutionContext,
  _def: WorkflowDefinition,
): Promise<{ iterations: number; results: unknown[] }> {
  const { loop } = step;

  const results: unknown[] = [];
  let iterations = 0;
  const maxIterations = loop.maxIterations ?? 1000;

  switch (loop.type) {
    case "forEach": {
      const collection = resolveValue(
        loop.collection || "[]",
        ctx,
      ) as unknown[];
      if (Array.isArray(collection)) {
        for (let i = 0; i < collection.length && i < maxIterations; i++) {
          ctx.variables[loop.itemVariable || "item"] = collection[i];
          ctx.variables[loop.indexVariable || "index"] = i;
          results.push({ index: i, item: collection[i] });
          iterations++;
        }
      }
      break;
    }
    case "times": {
      const count = loop.count ?? 0;
      for (let i = 0; i < count && i < maxIterations; i++) {
        ctx.variables[loop.indexVariable || "index"] = i;
        results.push({ index: i });
        iterations++;
      }
      break;
    }
    case "while": {
      while (iterations < maxIterations) {
        const continueLoop = evaluateExpression(loop.condition || "false", ctx);
        if (!continueLoop) break;
        ctx.variables[loop.indexVariable || "index"] = iterations;
        results.push({ index: iterations });
        iterations++;
      }
      break;
    }
  }

  return { iterations, results };
}

async function executeParallel(
  step: ParallelStep,
  _ctx: ExecutionContext,
  _def: WorkflowDefinition,
): Promise<{ branches: number; results: unknown[] }> {
  const { parallel } = step;

  // Execute each branch and collect results
  const branchPromises = parallel.branches.map(async (branchStepIds, index) => {
    return { branch: index, stepIds: branchStepIds, completed: true };
  });

  const waitFor = parallel.waitFor;
  let results: unknown[];

  if (waitFor === "any") {
    // Return as soon as one branch completes
    const first = await Promise.race(branchPromises);
    results = [first];
  } else if (typeof waitFor === "number") {
    // Wait for N branches to complete
    const allResults = await Promise.all(branchPromises);
    results = allResults.slice(0, waitFor);
  } else {
    // Wait for all branches
    results = await Promise.all(branchPromises);
  }

  return { branches: parallel.branches.length, results };
}

async function executeGate(
  step: GateStep,
  _ctx: ExecutionContext,
): Promise<{ passed: boolean; gateType: string }> {
  const { gate } = step;

  // For now, auto-approve gates
  // In the future, this would wait for external signals or approvals
  if (gate.type === "approval") {
    return { passed: true, gateType: "approval" };
  }

  if (gate.type === "signal") {
    return { passed: true, gateType: "signal" };
  }

  return { passed: true, gateType: gate.type };
}

const executePlugin = async (
  step: PluginStep,
  ctx: ExecutionContext,
): Promise<unknown> => {
  const { plugin } = step;

  const resolvedInputs = resolveInputs(plugin.inputs, ctx);

  const pluginContext = {
    workflowId: ctx.workflowId,
    runId: ctx.runId,
    stepId: step.id,
    config: {},
    secrets: {},
  };

  let callResult: PluginCallResult;

  if (isBuiltinPlugin(plugin.pluginId)) {
    // Execute built-in plugin
    callResult = await executeBuiltinAction(
      plugin.pluginId,
      plugin.function,
      resolvedInputs,
      pluginContext,
    );
  } else {
    // Execute WASM plugin via Extism
    const host = getPluginHost();
    const loadedPlugin = host.get(plugin.pluginId);

    if (!loadedPlugin) {
      throw new Error(`Plugin not loaded: ${plugin.pluginId}`);
    }

    callResult = await loadedPlugin.call(
      plugin.function,
      resolvedInputs,
      pluginContext,
    );
  }

  if (!callResult.success) {
    throw new Error(`Plugin execution failed: ${callResult.error}`);
  }

  const result = {
    pluginId: plugin.pluginId,
    function: plugin.function,
    inputs: resolvedInputs,
    executedAt: new Date().toISOString(),
    output: callResult.output,
    durationMs: callResult.durationMs,
  };

  // Map outputs to context variables if specified
  if (plugin.outputs && callResult.output) {
    for (const [outputKey, variableName] of Object.entries(plugin.outputs)) {
      ctx.variables[String(variableName)] = callResult.output[outputKey];
    }
  }

  return result;
};

/**
 * Execute an MCP step - calls a tool on an MCP server
 */
const executeMCP = async (
  step: MCPStep,
  ctx: ExecutionContext,
): Promise<unknown> => {
  const { mcp } = step;
  const mcpClient = getMCPClient();

  // Check if server is connected
  if (!mcpClient.isConnected(mcp.serverId)) {
    throw new Error(`MCP server not connected: ${mcp.serverId}`);
  }

  // Resolve input expressions from context
  const resolvedInputs = resolveInputs(mcp.inputs, ctx);

  // Call the MCP tool
  const callResult = await mcpClient.callTool(
    mcp.serverId,
    mcp.tool,
    resolvedInputs,
  );

  if (!callResult.success) {
    throw new Error(`MCP tool execution failed: ${callResult.error}`);
  }

  // Extract text content from result
  const textContent = callResult.content
    ?.filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");

  // Try to parse as JSON, otherwise use raw text
  let output: Record<string, unknown>;
  try {
    output = textContent ? JSON.parse(textContent) : {};
  } catch {
    output = { text: textContent };
  }

  const result = {
    serverId: mcp.serverId,
    tool: mcp.tool,
    inputs: resolvedInputs,
    executedAt: new Date().toISOString(),
    output,
    isError: callResult.isError,
  };

  // Map outputs to context variables if specified
  if (mcp.outputs) {
    for (const [outputKey, variableName] of Object.entries(mcp.outputs)) {
      ctx.variables[String(variableName)] = output[outputKey];
    }
  }

  return result;
};

/**
 * Execute an LLM step - calls an LLM via MCP server
 *
 * Uses the any-chat-completions-mcp server to call OpenAI-compatible APIs.
 * The MCP server should expose a tool like "chat_completion" or "complete".
 */
const executeLLM = async (
  step: LLMStep,
  ctx: ExecutionContext,
): Promise<unknown> => {
  const { llm } = step;
  const mcpClient = getMCPClient();

  // Try to connect if not already connected
  if (!mcpClient.isConnected(llm.serverId)) {
    const connected = await connectMCPServer(llm.serverId);
    if (!connected) {
      throw new Error(`LLM MCP server not available: ${llm.serverId}`);
    }
  }

  // Resolve prompts with template expressions
  const systemPrompt = llm.systemPrompt
    ? String(resolveValue(llm.systemPrompt, ctx))
    : undefined;
  const userPrompt = String(resolveValue(llm.userPrompt, ctx));

  // Resolve image inputs if any
  const images = llm.images
    ? llm.images.map((img) => String(resolveValue(img, ctx)))
    : undefined;

  // Build messages array for chat completion
  const messages: Array<{ role: string; content: string | unknown[] }> = [];

  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }

  // Build user message with optional images
  if (images && images.length > 0) {
    // Vision request with images
    const content: unknown[] = [{ type: "text", text: userPrompt }];
    for (const image of images) {
      content.push({
        type: "image_url",
        image_url: { url: image },
      });
    }
    messages.push({ role: "user", content });
  } else {
    messages.push({ role: "user", content: userPrompt });
  }

  // Build tool arguments
  const toolArgs: Record<string, unknown> = {
    model: llm.model,
    messages,
  };

  if (llm.temperature !== undefined) {
    toolArgs.temperature = llm.temperature;
  }
  if (llm.maxTokens !== undefined) {
    toolArgs.max_tokens = llm.maxTokens;
  }

  // Call the LLM via MCP
  // Common tool names: "chat_completion", "complete", "chat"
  const toolNames = ["chat_completion", "complete", "chat", "generate"];
  let callResult = null;

  for (const toolName of toolNames) {
    callResult = await mcpClient.callTool(llm.serverId, toolName, toolArgs);
    if (callResult.success) break;
  }

  if (!callResult || !callResult.success) {
    throw new Error(
      `LLM execution failed: ${callResult?.error || "No compatible tool found"}`,
    );
  }

  // Extract text content from result
  const textContent = callResult.content
    ?.filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");

  // Try to parse as JSON if the response looks like JSON
  let output: Record<string, unknown>;
  try {
    if (
      textContent?.trim().startsWith("{") ||
      textContent?.trim().startsWith("[")
    ) {
      output = { content: JSON.parse(textContent), raw: textContent };
    } else {
      output = { content: textContent, raw: textContent };
    }
  } catch {
    output = { content: textContent, raw: textContent };
  }

  const result = {
    serverId: llm.serverId,
    model: llm.model,
    systemPrompt,
    userPrompt,
    executedAt: new Date().toISOString(),
    output,
  };

  // Map outputs to context variables if specified
  if (llm.outputs) {
    for (const [outputKey, variableName] of Object.entries(llm.outputs)) {
      ctx.variables[String(variableName)] = output[outputKey];
    }
  }

  // Also store the raw content as the default output
  ctx.variables[`${step.id}_output`] = output.content;

  return result;
};

/**
 * Execute a Code step - runs JavaScript in a sandboxed MCP server
 *
 * Uses node-code-sandbox-mcp to execute JavaScript code in a Docker container.
 */
const executeCode = async (
  step: CodeStep,
  ctx: ExecutionContext,
): Promise<unknown> => {
  const { code } = step;
  const mcpClient = getMCPClient();

  // Try to connect if not already connected
  if (!mcpClient.isConnected(code.serverId)) {
    const connected = await connectMCPServer(code.serverId);
    if (!connected) {
      throw new Error(
        `Code sandbox MCP server not available: ${code.serverId}`,
      );
    }
  }

  // Resolve input mappings
  const inputData: Record<string, unknown> = {};
  if (code.inputs) {
    for (const [varName, expression] of Object.entries(code.inputs)) {
      inputData[varName] = resolveValue(expression, ctx);
    }
  }

  // Wrap the user code to receive inputs and return output
  const wrappedCode = `
    const input = ${JSON.stringify(inputData)};
    ${code.source}
  `;

  // Build tool arguments
  const toolArgs: Record<string, unknown> = {
    code: wrappedCode,
  };

  if (code.dependencies && code.dependencies.length > 0) {
    toolArgs.dependencies = code.dependencies;
  }

  if (code.timeout) {
    toolArgs.timeout = code.timeout;
  }

  // Call the code sandbox via MCP
  // Common tool names: "run_code", "execute", "run"
  const toolNames = ["run_code", "execute", "run", "eval"];
  let callResult = null;

  for (const toolName of toolNames) {
    callResult = await mcpClient.callTool(code.serverId, toolName, toolArgs);
    if (callResult.success) break;
  }

  if (!callResult || !callResult.success) {
    throw new Error(
      `Code execution failed: ${callResult?.error || "No compatible tool found"}`,
    );
  }

  // Extract output from result
  const textContent = callResult.content
    ?.filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");

  // Try to parse as JSON
  let output: Record<string, unknown>;
  try {
    output = textContent ? JSON.parse(textContent) : {};
  } catch {
    output = { result: textContent };
  }

  const result = {
    serverId: code.serverId,
    executedAt: new Date().toISOString(),
    inputs: inputData,
    output,
  };

  // Map outputs to context variables if specified
  if (code.outputs) {
    for (const [outputKey, variableName] of Object.entries(code.outputs)) {
      ctx.variables[String(variableName)] = output[outputKey];
    }
  }

  return result;
};

/**
 * Execute a Database step - runs SQL queries via MCP server
 *
 * Uses @modelcontextprotocol/server-postgres or similar database MCP server.
 */
const executeDatabase = async (
  step: DatabaseStep,
  ctx: ExecutionContext,
): Promise<unknown> => {
  const { database } = step;
  const mcpClient = getMCPClient();

  // Try to connect if not already connected
  if (!mcpClient.isConnected(database.serverId)) {
    const connected = await connectMCPServer(database.serverId);
    if (!connected) {
      throw new Error(
        `Database MCP server not available: ${database.serverId}`,
      );
    }
  }

  // Resolve query and parameters
  const query = String(resolveValue(database.query, ctx));
  const params = database.params
    ? resolveInputs(database.params, ctx)
    : undefined;

  // Build tool arguments based on operation
  const toolArgs: Record<string, unknown> = {
    query,
  };

  if (params) {
    toolArgs.params = Object.values(params);
  }

  // Determine tool name based on operation
  // For read operations: "query", "read_query", "select"
  // For write operations: "execute", "write_query", "run"
  let toolNames: string[];
  if (database.operation === "query") {
    toolNames = ["query", "read_query", "select", "execute"];
  } else {
    toolNames = ["execute", "write_query", "run", "query"];
  }

  let callResult = null;

  for (const toolName of toolNames) {
    callResult = await mcpClient.callTool(
      database.serverId,
      toolName,
      toolArgs,
    );
    if (callResult.success) break;
  }

  if (!callResult || !callResult.success) {
    throw new Error(
      `Database operation failed: ${callResult?.error || "No compatible tool found"}`,
    );
  }

  // Extract output from result
  const textContent = callResult.content
    ?.filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");

  // Try to parse as JSON (query results are typically JSON)
  let output: Record<string, unknown>;
  try {
    const parsed = textContent ? JSON.parse(textContent) : {};
    output = Array.isArray(parsed) ? { rows: parsed } : parsed;
  } catch {
    output = { raw: textContent };
  }

  const result = {
    serverId: database.serverId,
    operation: database.operation,
    query,
    params,
    executedAt: new Date().toISOString(),
    output,
  };

  // Map outputs to context variables if specified
  if (database.outputs) {
    for (const [outputKey, variableName] of Object.entries(database.outputs)) {
      ctx.variables[String(variableName)] = output[outputKey];
    }
  }

  return result;
};

// Helper functions

function resolveInputs(
  inputs: Record<string, unknown>,
  ctx: ExecutionContext,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(inputs)) {
    resolved[key] = resolveValue(value, ctx);
  }
  return resolved;
}

function resolveValue(value: unknown, ctx: ExecutionContext): unknown {
  if (typeof value !== "string") {
    // Recursively resolve objects and arrays
    if (Array.isArray(value)) {
      return value.map((v) => resolveValue(v, ctx));
    }
    if (value && typeof value === "object") {
      const resolved: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        resolved[k] = resolveValue(v, ctx);
      }
      return resolved;
    }
    return value;
  }

  // Handle template expressions like {{trigger.data}} or {{steps.http_1.body}}
  if (value.startsWith("{{") && value.endsWith("}}")) {
    const path = value.slice(2, -2).trim();
    return getValueByPath(ctx, path);
  }

  // Handle strings with embedded templates like "Hello {{name}}"
  if (value.includes("{{") && value.includes("}}")) {
    return value.replace(/\{\{([^}]+)\}\}/g, (_match, path) => {
      const resolved = getValueByPath(ctx, path.trim());
      return resolved === undefined ? "" : String(resolved);
    });
  }

  return value;
}

function getValueByPath(ctx: ExecutionContext, path: string): unknown {
  const parts = path.split(".");
  const root = parts[0];

  // Build a context object with all accessible paths
  const accessibleContext: Record<string, unknown> = {
    trigger: ctx.triggerData,
    variables: ctx.variables,
    steps: {} as Record<string, unknown>,
    // Also expose stepResults directly for backwards compatibility
    stepResults: ctx.stepResults,
  };

  // Map step results to be accessible as steps.{stepId}.{field}
  // Step results contain the output from each step
  for (const [stepId, result] of Object.entries(ctx.stepResults)) {
    const stepResult = result as Record<string, unknown>;
    // The output field contains the actual result data
    (accessibleContext.steps as Record<string, unknown>)[stepId] =
      stepResult.output || stepResult;
  }

  let current: unknown = accessibleContext[root];
  if (current === undefined) {
    // Try direct access on context
    current = (ctx as unknown as Record<string, unknown>)[root];
  }

  // Navigate the rest of the path
  for (let i = 1; i < parts.length; i++) {
    if (current === null || current === undefined) return undefined;
    if (typeof current === "object") {
      current = (current as Record<string, unknown>)[parts[i]];
    } else {
      return undefined;
    }
  }

  return current;
}

function evaluateExpression(
  expression: string,
  ctx: ExecutionContext,
): boolean {
  // Simple expression evaluator
  // Handles: true, false, comparisons, and variable references

  const trimmed = expression.trim();

  // Boolean literals
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;

  // Resolve template expressions first
  let resolved = trimmed;
  const templateRegex = /\{\{([^}]+)\}\}/g;
  resolved = resolved.replace(templateRegex, (_match, path) => {
    const value = getValueByPath(ctx, path.trim());
    return JSON.stringify(value);
  });

  // Simple comparisons
  const comparisonMatch = resolved.match(
    /(.+?)\s*(===|!==|==|!=|>=|<=|>|<)\s*(.+)/,
  );
  if (comparisonMatch) {
    const [, left, op, right] = comparisonMatch;
    const leftVal = parseValue(left.trim());
    const rightVal = parseValue(right.trim());

    switch (op) {
      case "===":
      case "==":
        return leftVal === rightVal;
      case "!==":
      case "!=":
        return leftVal !== rightVal;
      case ">":
        return Number(leftVal) > Number(rightVal);
      case "<":
        return Number(leftVal) < Number(rightVal);
      case ">=":
        return Number(leftVal) >= Number(rightVal);
      case "<=":
        return Number(leftVal) <= Number(rightVal);
    }
  }

  // Truthy check
  const value = resolveValue(trimmed, ctx);
  return Boolean(value);
}

function parseValue(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

function convertToMs(duration: number, unit: string): number {
  const multipliers: Record<string, number> = {
    seconds: 1000,
    minutes: 60 * 1000,
    hours: 60 * 60 * 1000,
    days: 24 * 60 * 60 * 1000,
  };

  return duration * (multipliers[unit] ?? 1000);
}
