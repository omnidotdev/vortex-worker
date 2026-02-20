/**
 * Convert ReactFlow nodes and edges to Vortex Workflow DSL
 *
 * This enables the worker to handle workflows saved in ReactFlow format
 * (from the UI) when triggered via API or webhook.
 */

import logger from "lib/logger";

import type {
  ActionStep,
  AggregateStep,
  CacheStep,
  CodeStep,
  ConditionStep,
  DatabaseStep,
  DelayStep,
  Edge as DslEdge,
  EventStep,
  GateStep,
  LLMStep,
  LoopStep,
  MCPStep,
  ParallelStep,
  PluginStep,
  Step,
  SubworkflowStep,
  SwitchStep,
  TriggerStep,
  WaitStep,
  WorkflowDefinition,
} from "./types";

// ReactFlow node/edge types (simplified - we only need the fields we use)
interface ReactFlowNode {
  id: string;
  type?: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
}

interface ReactFlowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  label?: string;
}

// Map ReactFlow node types to DSL step types
const nodeTypeToStepType: Record<string, string> = {
  triggerNode: "trigger",
  actionNode: "action",
  conditionNode: "condition",
  switchNode: "switch",
  loopNode: "loop",
  gateNode: "gate",
  delayNode: "delay",
  parallelNode: "parallel",
  pluginNode: "plugin",
  mcpNode: "mcp",
  llmNode: "llm",
  codeNode: "code",
  databaseNode: "database",
  subworkflowNode: "subworkflow",
  waitNode: "wait",
  eventNode: "event",
  aggregateNode: "aggregate",
  cacheNode: "cache",
};

function triggerNodeToStep(node: ReactFlowNode): TriggerStep {
  const data = node.data;
  return {
    id: node.id,
    type: "trigger",
    name: (data.label as string) || "Trigger",
    description: data.description as string | undefined,
    position: node.position,
    trigger: {
      type:
        (data.triggerType as "webhook" | "cron" | "event" | "manual") ||
        "manual",
      config: (data.config as Record<string, unknown>) || {},
    },
  };
}

function actionNodeToStep(node: ReactFlowNode): ActionStep {
  const data = node.data;

  // Merge config and inputs - inputs override config values
  // This allows UI to store defaults in config and user-entered values in inputs
  const config = (data.config as Record<string, unknown>) || {};
  const inputs = (data.inputs as Record<string, unknown>) || {};
  const mergedInputs = { ...config, ...inputs };

  return {
    id: node.id,
    type: "action",
    name: (data.label as string) || "Action",
    description: data.description as string | undefined,
    position: node.position,
    action: {
      integrationId: data.integrationId as string | undefined,
      pluginId: data.pluginId as string | undefined,
      operation:
        (data.operation as string) || (data.label as string) || "execute",
      inputs: mergedInputs,
      outputs: data.outputs as Record<string, string> | undefined,
    },
  };
}

function conditionNodeToStep(
  node: ReactFlowNode,
  edges: ReactFlowEdge[],
): ConditionStep {
  const data = node.data;

  const trueEdge = edges.find(
    (e) => e.source === node.id && e.sourceHandle === "true",
  );
  const falseEdge = edges.find(
    (e) => e.source === node.id && e.sourceHandle === "false",
  );

  return {
    id: node.id,
    type: "condition",
    name: (data.label as string) || "Condition",
    description: data.description as string | undefined,
    position: node.position,
    condition: {
      expression:
        (data.expression as string) ||
        ((data.config as Record<string, unknown>)?.expression as string) ||
        "true",
      trueBranch: trueEdge?.target || "",
      falseBranch: falseEdge?.target || "",
    },
  };
}

function switchNodeToStep(
  node: ReactFlowNode,
  edges: ReactFlowEdge[],
): SwitchStep {
  const data = node.data;

  const cases = (
    (data.cases as Array<{ value: string; label: string }>) || []
  ).map((c, index) => {
    const caseEdge = edges.find(
      (e) => e.source === node.id && e.sourceHandle === `case_${index}`,
    );
    return {
      value: c.value,
      label: c.label,
      next: caseEdge?.target || "",
    };
  });

  const defaultEdge = edges.find(
    (e) => e.source === node.id && e.sourceHandle === "default",
  );

  return {
    id: node.id,
    type: "switch",
    name: (data.label as string) || "Switch",
    description: data.description as string | undefined,
    position: node.position,
    switch: {
      expression:
        (data.expression as string) ||
        ((data.config as Record<string, unknown>)?.expression as string) ||
        "",
      cases,
      default: defaultEdge?.target,
    },
  };
}

function loopNodeToStep(node: ReactFlowNode): LoopStep {
  const data = node.data;
  return {
    id: node.id,
    type: "loop",
    name: (data.label as string) || "Loop",
    description: data.description as string | undefined,
    position: node.position,
    loop: {
      type: (data.loopType as "forEach" | "while" | "times") || "forEach",
      collection: data.collection as string | undefined,
      condition: data.condition as string | undefined,
      count: data.count as number | undefined,
      itemVariable: (data.itemVariable as string) || "item",
      indexVariable: (data.indexVariable as string) || "index",
      body: (data.body as string[]) || [],
      maxIterations: data.maxIterations as number | undefined,
    },
  };
}

function gateNodeToStep(node: ReactFlowNode): GateStep {
  const data = node.data;
  return {
    id: node.id,
    type: "gate",
    name: (data.label as string) || "Gate",
    description: data.description as string | undefined,
    position: node.position,
    gate: {
      type: (data.gateType as "approval" | "signal") || "approval",
      approvers: data.approvers as string[] | undefined,
      signalName: data.signalName as string | undefined,
      timeout: data.timeout as string | undefined,
      timeoutAction: data.timeoutAction as
        | "approve"
        | "reject"
        | "continue"
        | undefined,
    },
  };
}

function delayNodeToStep(node: ReactFlowNode): DelayStep {
  const data = node.data;
  return {
    id: node.id,
    type: "delay",
    name: (data.label as string) || "Delay",
    description: data.description as string | undefined,
    position: node.position,
    delay: {
      duration: (data.duration as number) || 1,
      unit:
        (data.unit as "seconds" | "minutes" | "hours" | "days") || "minutes",
    },
  };
}

function parallelNodeToStep(node: ReactFlowNode): ParallelStep {
  const data = node.data;
  return {
    id: node.id,
    type: "parallel",
    name: (data.label as string) || "Parallel",
    description: data.description as string | undefined,
    position: node.position,
    parallel: {
      branches: (data.branches as string[][]) || [],
      waitFor: (data.waitFor as "all" | "any" | number) || "all",
    },
  };
}

function pluginNodeToStep(node: ReactFlowNode): PluginStep {
  const data = node.data;
  return {
    id: node.id,
    type: "plugin",
    name: (data.label as string) || "Plugin",
    description: data.description as string | undefined,
    position: node.position,
    plugin: {
      pluginId: (data.pluginId as string) || "",
      function: (data.function as string) || "execute",
      inputs: (data.inputs as Record<string, unknown>) || {},
      outputs: data.outputs as Record<string, string> | undefined,
      timeout: data.timeout as number | undefined,
      memoryLimit: data.memoryLimit as number | undefined,
    },
  };
}

function mcpNodeToStep(node: ReactFlowNode): MCPStep {
  const data = node.data;
  return {
    id: node.id,
    type: "mcp",
    name: (data.label as string) || "MCP Tool",
    description: data.description as string | undefined,
    position: node.position,
    mcp: {
      serverId: (data.serverId as string) || "",
      tool: (data.toolName as string) || (data.tool as string) || "",
      inputs: (data.inputs as Record<string, unknown>) || {},
      outputs: data.outputs as Record<string, string> | undefined,
    },
  };
}

function llmNodeToStep(node: ReactFlowNode): LLMStep {
  const data = node.data;
  return {
    id: node.id,
    type: "llm",
    name: (data.label as string) || "LLM",
    description: data.description as string | undefined,
    position: node.position,
    llm: {
      serverId: (data.serverId as string) || "",
      model: (data.model as string) || "gpt-4",
      systemPrompt: data.systemPrompt as string | undefined,
      userPrompt: (data.userPrompt as string) || "",
      images: data.images as string[] | undefined,
      temperature: data.temperature as number | undefined,
      maxTokens: data.maxTokens as number | undefined,
      outputs: data.outputs as Record<string, string> | undefined,
    },
  };
}

function codeNodeToStep(node: ReactFlowNode): CodeStep {
  const data = node.data;
  return {
    id: node.id,
    type: "code",
    name: (data.label as string) || "Code",
    description: data.description as string | undefined,
    position: node.position,
    code: {
      serverId: (data.serverId as string) || "",
      source: (data.code as string) || (data.source as string) || "",
      dependencies: data.dependencies as string[] | undefined,
      inputs: data.inputs as Record<string, string> | undefined,
      outputs: data.outputs as Record<string, string> | undefined,
      timeout: data.timeout as number | undefined,
    },
  };
}

function databaseNodeToStep(node: ReactFlowNode): DatabaseStep {
  const data = node.data;
  return {
    id: node.id,
    type: "database",
    name: (data.label as string) || "Database",
    description: data.description as string | undefined,
    position: node.position,
    database: {
      serverId: (data.serverId as string) || "",
      operation:
        (data.operation as "query" | "insert" | "update" | "delete") || "query",
      query: (data.query as string) || "",
      params: data.params as Record<string, unknown> | undefined,
      outputs: data.outputs as Record<string, string> | undefined,
    },
  };
}

function subworkflowNodeToStep(node: ReactFlowNode): SubworkflowStep {
  const data = node.data;
  return {
    id: node.id,
    type: "subworkflow",
    name: (data.label as string) || "Subworkflow",
    description: data.description as string | undefined,
    position: node.position,
    subworkflow: {
      workflowId: (data.workflowId as string) || "",
      inputs: (data.inputs as Record<string, unknown>) || {},
      outputs: data.outputs as Record<string, string> | undefined,
      waitForCompletion: (data.waitForCompletion as boolean) ?? true,
      timeout: data.timeout as number | undefined,
    },
  };
}

function waitNodeToStep(node: ReactFlowNode): WaitStep {
  const data = node.data;
  return {
    id: node.id,
    type: "wait",
    name: (data.label as string) || "Wait",
    description: data.description as string | undefined,
    position: node.position,
    wait: {
      resumeOn: (data.resumeOn as "webhook" | "event" | "timeout") || "timeout",
      webhookSuffix: data.webhookSuffix as string | undefined,
      eventName: data.eventName as string | undefined,
      timeout: data.timeout as number | undefined,
      timeoutUnit: data.timeoutUnit as
        | "seconds"
        | "minutes"
        | "hours"
        | "days"
        | undefined,
      timeoutAction: (data.timeoutAction as "continue" | "error") || "error",
      outputs: data.outputs as Record<string, string> | undefined,
    },
  };
}

function eventNodeToStep(node: ReactFlowNode): EventStep {
  const data = node.data;
  return {
    id: node.id,
    type: "event",
    name: (data.label as string) || "Event",
    description: data.description as string | undefined,
    position: node.position,
    event: {
      operation: "emit",
      eventName: (data.eventName as string) || "",
      payload: data.payload as Record<string, unknown> | undefined,
    },
  };
}

function aggregateNodeToStep(node: ReactFlowNode): AggregateStep {
  const data = node.data;
  return {
    id: node.id,
    type: "aggregate",
    name: (data.label as string) || "Aggregate",
    description: data.description as string | undefined,
    position: node.position,
    aggregate: {
      mode:
        (data.mode as
          | "collect"
          | "merge"
          | "concat"
          | "sum"
          | "first"
          | "last") || "collect",
      source: (data.source as string) || "",
      groupBy: data.groupBy as string | undefined,
      outputVariable: (data.outputVariable as string) || "aggregated",
    },
  };
}

function cacheNodeToStep(node: ReactFlowNode): CacheStep {
  const data = node.data;
  return {
    id: node.id,
    type: "cache",
    name: (data.label as string) || "Cache",
    description: data.description as string | undefined,
    position: node.position,
    cache: {
      operation:
        (data.operation as "get" | "set" | "delete" | "getOrSet") || "get",
      key: (data.key as string) || "",
      value: data.value,
      ttl: data.ttl as number | undefined,
      fallbackStep: data.fallbackStep as string | undefined,
      outputVariable: data.outputVariable as string | undefined,
    },
  };
}

function nodeToStep(node: ReactFlowNode, edges: ReactFlowEdge[]): Step | null {
  const stepType = nodeTypeToStepType[node.type || ""] || node.type;

  switch (stepType) {
    case "trigger":
      return triggerNodeToStep(node);
    case "action":
      return actionNodeToStep(node);
    case "condition":
      return conditionNodeToStep(node, edges);
    case "switch":
      return switchNodeToStep(node, edges);
    case "loop":
      return loopNodeToStep(node);
    case "gate":
      return gateNodeToStep(node);
    case "delay":
      return delayNodeToStep(node);
    case "parallel":
      return parallelNodeToStep(node);
    case "plugin":
      return pluginNodeToStep(node);
    case "mcp":
      return mcpNodeToStep(node);
    case "llm":
      return llmNodeToStep(node);
    case "code":
      return codeNodeToStep(node);
    case "database":
      return databaseNodeToStep(node);
    case "subworkflow":
      return subworkflowNodeToStep(node);
    case "wait":
      return waitNodeToStep(node);
    case "event":
      return eventNodeToStep(node);
    case "aggregate":
      return aggregateNodeToStep(node);
    case "cache":
      return cacheNodeToStep(node);
    default:
      logger.warn("Unknown node type", { nodeType: node.type });
      return null;
  }
}

function edgeToDslEdge(edge: ReactFlowEdge): DslEdge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle || undefined,
    label: typeof edge.label === "string" ? edge.label : undefined,
  };
}

/**
 * Generate a unique step name for a node
 */
function generateStepName(node: ReactFlowNode, usedNames: Set<string>): string {
  // Use existing stepName if present
  if (node.data?.stepName) {
    const name = node.data.stepName as string;
    usedNames.add(name);
    return name;
  }

  // Generate from label or integration type
  const baseName =
    (node.data?.label as string) ||
    (node.data?.integrationDefinitionId
      ? (node.data.integrationDefinitionId as string).charAt(0).toUpperCase() +
        (node.data.integrationDefinitionId as string).slice(1)
      : null) ||
    (node.data?.pluginId === "builtin:http" ? "HTTP Request" : null) ||
    node.type?.replace("Node", "") ||
    "Step";

  // Ensure uniqueness
  let stepName = baseName;
  let counter = 2;
  while (usedNames.has(stepName)) {
    stepName = `${baseName} ${counter}`;
    counter++;
  }

  usedNames.add(stepName);
  return stepName;
}

/**
 * Convert ReactFlow nodes and edges to a workflow definition
 */
export function reactFlowToDsl(
  nodes: ReactFlowNode[],
  edges: ReactFlowEdge[],
): WorkflowDefinition {
  const steps: Step[] = [];
  const stepNameToId: Record<string, string> = {};
  const usedNames = new Set<string>();

  for (const node of nodes) {
    // Skip trigger nodes for step name mapping (they don't produce outputs to reference)
    if (node.type !== "triggerNode") {
      const stepName = generateStepName(node, usedNames);
      stepNameToId[stepName] = node.id;
    }

    const step = nodeToStep(node, edges);
    if (step) {
      steps.push(step);
    }
  }

  const dslEdges = edges.map(edgeToDslEdge);

  return {
    version: "1.0",
    steps,
    edges: dslEdges,
    stepNameToId,
  };
}

/**
 * Check if a definition is in ReactFlow format (has nodes instead of steps)
 */
export function isReactFlowFormat(definition: unknown): boolean {
  if (!definition || typeof definition !== "object") return false;
  const def = definition as Record<string, unknown>;
  return Array.isArray(def.nodes) && !Array.isArray(def.steps);
}
