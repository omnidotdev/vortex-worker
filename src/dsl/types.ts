import { z } from "zod";

export const StepType = z.enum([
  "trigger",
  "action",
  "condition",
  "switch",
  "delay",
  "loop",
  "parallel",
  "gate",
  "plugin",
  "mcp",
  "llm",
  "code",
  "database",
]);
export type StepType = z.infer<typeof StepType>;

export const TriggerType = z.enum(["webhook", "cron", "event", "manual"]);
export type TriggerType = z.infer<typeof TriggerType>;

export const Position = z.object({
  x: z.number(),
  y: z.number(),
});
export type Position = z.infer<typeof Position>;

export const ErrorHandler = z.object({
  action: z.enum(["continue", "stop", "retry", "goto"]),
  retryCount: z.number().optional(),
  retryDelayMs: z.number().optional(),
  retryBackoff: z.enum(["linear", "exponential"]).optional(),
  gotoStepId: z.string().optional(),
});
export type ErrorHandler = z.infer<typeof ErrorHandler>;

export const BaseStep = z.object({
  id: z.string(),
  type: StepType,
  name: z.string(),
  description: z.string().optional(),
  position: Position,
  next: z.union([z.string(), z.array(z.string())]).optional(),
  onError: ErrorHandler.optional(),
});

export const TriggerStep = BaseStep.extend({
  type: z.literal("trigger"),
  trigger: z.object({
    type: TriggerType,
    config: z.record(z.string(), z.unknown()),
  }),
});
export type TriggerStep = z.infer<typeof TriggerStep>;

export const ActionStep = BaseStep.extend({
  type: z.literal("action"),
  action: z.object({
    integrationId: z.string().optional(),
    pluginId: z.string().optional(),
    operation: z.string(),
    inputs: z.record(z.string(), z.unknown()),
    outputs: z.record(z.string(), z.string()).optional(),
  }),
});
export type ActionStep = z.infer<typeof ActionStep>;

export const ConditionStep = BaseStep.extend({
  type: z.literal("condition"),
  condition: z.object({
    expression: z.string(),
    trueBranch: z.string(),
    falseBranch: z.string(),
  }),
});
export type ConditionStep = z.infer<typeof ConditionStep>;

export const SwitchCase = z.object({
  value: z.union([z.string(), z.number(), z.boolean()]),
  label: z.string(),
  next: z.string(),
});
export type SwitchCase = z.infer<typeof SwitchCase>;

export const SwitchStep = BaseStep.extend({
  type: z.literal("switch"),
  switch: z.object({
    expression: z.string(),
    cases: z.array(SwitchCase),
    default: z.string().optional(),
  }),
});
export type SwitchStep = z.infer<typeof SwitchStep>;

export const DelayStep = BaseStep.extend({
  type: z.literal("delay"),
  delay: z.object({
    duration: z.number(),
    unit: z.enum(["seconds", "minutes", "hours", "days"]),
  }),
});
export type DelayStep = z.infer<typeof DelayStep>;

export const LoopStep = BaseStep.extend({
  type: z.literal("loop"),
  loop: z.object({
    type: z.enum(["forEach", "while", "times"]),
    collection: z.string().optional(),
    condition: z.string().optional(),
    count: z.number().optional(),
    itemVariable: z.string().optional(),
    indexVariable: z.string().optional(),
    body: z.array(z.string()),
    maxIterations: z.number().optional(),
  }),
});
export type LoopStep = z.infer<typeof LoopStep>;

export const ParallelStep = BaseStep.extend({
  type: z.literal("parallel"),
  parallel: z.object({
    branches: z.array(z.array(z.string())),
    waitFor: z.union([z.literal("all"), z.literal("any"), z.number()]),
  }),
});
export type ParallelStep = z.infer<typeof ParallelStep>;

export const GateStep = BaseStep.extend({
  type: z.literal("gate"),
  gate: z.object({
    type: z.enum(["approval", "signal"]),
    approvers: z.array(z.string()).optional(),
    signalName: z.string().optional(),
    timeout: z.string().optional(),
    timeoutAction: z.enum(["approve", "reject", "continue"]).optional(),
  }),
});
export type GateStep = z.infer<typeof GateStep>;

export const PluginStep = BaseStep.extend({
  type: z.literal("plugin"),
  plugin: z.object({
    pluginId: z.string(),
    function: z.string(),
    inputs: z.record(z.string(), z.unknown()),
    outputs: z.record(z.string(), z.string()).optional(),
    timeout: z.number().optional(),
    memoryLimit: z.number().optional(),
  }),
});
export type PluginStep = z.infer<typeof PluginStep>;

export const MCPStep = BaseStep.extend({
  type: z.literal("mcp"),
  mcp: z.object({
    /** MCP server ID (references stored server config) */
    serverId: z.string(),
    /** Tool name to call */
    tool: z.string(),
    /** Input arguments for the tool */
    inputs: z.record(z.string(), z.unknown()),
    /** Map tool outputs to workflow variables */
    outputs: z.record(z.string(), z.string()).optional(),
  }),
});
export type MCPStep = z.infer<typeof MCPStep>;

export const LLMStep = BaseStep.extend({
  type: z.literal("llm"),
  llm: z.object({
    /** MCP server ID for the LLM provider */
    serverId: z.string(),
    /** Model identifier (e.g., "gpt-4", "claude-3-opus") */
    model: z.string(),
    /** System prompt for the LLM */
    systemPrompt: z.string().optional(),
    /** User prompt template (supports {{variable}} interpolation) */
    userPrompt: z.string(),
    /** Array of image URLs or base64 data for vision models */
    images: z.array(z.string()).optional(),
    /** Temperature for response generation */
    temperature: z.number().min(0).max(2).optional(),
    /** Maximum tokens in response */
    maxTokens: z.number().optional(),
    /** Map outputs to workflow variables */
    outputs: z.record(z.string(), z.string()).optional(),
  }),
});
export type LLMStep = z.infer<typeof LLMStep>;

export const CodeStep = BaseStep.extend({
  type: z.literal("code"),
  code: z.object({
    /** MCP server ID for the code sandbox */
    serverId: z.string(),
    /** JavaScript code to execute */
    source: z.string(),
    /** npm dependencies to install before execution */
    dependencies: z.array(z.string()).optional(),
    /** Map workflow variables to code inputs */
    inputs: z.record(z.string(), z.string()).optional(),
    /** Map code outputs to workflow variables */
    outputs: z.record(z.string(), z.string()).optional(),
    /** Timeout in milliseconds */
    timeout: z.number().optional(),
  }),
});
export type CodeStep = z.infer<typeof CodeStep>;

export const DatabaseStep = BaseStep.extend({
  type: z.literal("database"),
  database: z.object({
    /** MCP server ID for the database */
    serverId: z.string(),
    /** Operation type */
    operation: z.enum(["query", "insert", "update", "delete"]),
    /** SQL query or table name */
    query: z.string(),
    /** Query parameters (supports {{variable}} interpolation) */
    params: z.record(z.string(), z.unknown()).optional(),
    /** Map query results to workflow variables */
    outputs: z.record(z.string(), z.string()).optional(),
  }),
});
export type DatabaseStep = z.infer<typeof DatabaseStep>;

export const Step = z.discriminatedUnion("type", [
  TriggerStep,
  ActionStep,
  ConditionStep,
  SwitchStep,
  DelayStep,
  LoopStep,
  ParallelStep,
  GateStep,
  PluginStep,
  MCPStep,
  LLMStep,
  CodeStep,
  DatabaseStep,
]);
export type Step = z.infer<typeof Step>;

export const Edge = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  sourceHandle: z.string().optional(),
  targetHandle: z.string().optional(),
  label: z.string().optional(),
});
export type Edge = z.infer<typeof Edge>;

export const VariableDefinition = z.object({
  type: z.enum(["string", "number", "boolean", "object", "array"]),
  default: z.unknown().optional(),
  description: z.string().optional(),
});
export type VariableDefinition = z.infer<typeof VariableDefinition>;

export const WorkflowSettings = z.object({
  timeout: z.string().optional(),
  retryPolicy: z
    .object({
      maxAttempts: z.number(),
      backoffCoefficient: z.number(),
      initialInterval: z.string(),
      maxInterval: z.string(),
    })
    .optional(),
});
export type WorkflowSettings = z.infer<typeof WorkflowSettings>;

export const WorkflowDefinition = z.object({
  version: z.literal("1.0"),
  steps: z.array(Step),
  edges: z.array(Edge),
  variables: z.record(z.string(), VariableDefinition).optional(),
  settings: WorkflowSettings.optional(),
  /** Mapping from human-readable step names to step IDs for template resolution */
  stepNameToId: z.record(z.string(), z.string()).optional(),
});
export type WorkflowDefinition = z.infer<typeof WorkflowDefinition>;

export interface ExecutionContext {
  workflowId: string;
  runId: string;
  organizationId?: string;
  triggerData: Record<string, unknown>;
  variables: Record<string, unknown>;
  stepResults: Record<string, unknown>;
  /** Mapping from human-readable step names to step IDs (node IDs) */
  stepNameToId: Record<string, string>;
}
