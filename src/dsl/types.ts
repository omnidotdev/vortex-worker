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
  // New core nodes
  "subworkflow",
  "wait",
  "event",
  "aggregate",
  "cache",
  // Extended core nodes (batch 2)
  "merge",
  "split",
  "filter",
  "set",
  "error",
  "retry",
  "timeout",
  "email",
  "webhookResponse",
  "file",
  "queue",
  "embedding",
  "vectorSearch",
  "log",
  "assert",
  "sleep",
  // Data transformation
  "map",
  "reduce",
  "sort",
  "unique",
  "template",
  // AI/ML
  "prompt",
  "chat",
  "summarize",
  "classify",
  // Human-in-the-loop
  "approval",
  "input",
  "notification",
  // Utility
  "parse",
  "validate",
  "format",
  "hash",
  // Advanced array operations
  "group",
  "flatten",
  "chunk",
  "zip",
  // Security
  "encrypt",
  "decrypt",
  "sign",
  "jwt",
  // AI extensions
  "agent",
  "rag",
  "vision",
  "audio",
  // Integration
  "spreadsheet",
  "googleSheets",
  "modelRegistry",
  "webhookVerify",
  // Tier 2
  "pdf",
  "rateLimit",
  // Flow control
  "try_catch",
  "race",
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

export const LLMMemoryConfig = z.object({
  /** Session ID for conversation isolation */
  sessionId: z.string(),
  /** Max previous messages to include */
  windowSize: z.number().default(10),
  /** Persist to database (vs in-memory) */
  persist: z.boolean().default(false),
  /** Auto-save this exchange to memory */
  autoSave: z.boolean().default(true),
});

export const LLMToolConfig = z.object({
  /** MCP server IDs whose tools are available */
  mcpServers: z.array(z.string()).optional(),
  /** Max tool call iterations before forcing response */
  maxIterations: z.number().default(5),
});

export const LLMStep = BaseStep.extend({
  type: z.literal("llm"),
  llm: z.object({
    /** MCP server ID for the LLM provider */
    serverId: z.string(),
    /** Model identifier */
    model: z.string(),
    /** System prompt */
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
    /** Conversation memory configuration */
    memory: LLMMemoryConfig.optional(),
    /** Tool use configuration for agentic behavior */
    tools: LLMToolConfig.optional(),
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

export const SubworkflowStep = BaseStep.extend({
  type: z.literal("subworkflow"),
  subworkflow: z.object({
    /** Workflow ID to execute */
    workflowId: z.string(),
    /** Input mapping: workflow variable → subworkflow input */
    inputs: z.record(z.string(), z.unknown()),
    /** Output mapping: subworkflow output → workflow variable */
    outputs: z.record(z.string(), z.string()).optional(),
    /** Wait for completion or fire-and-forget */
    waitForCompletion: z.boolean().default(true),
    /** Timeout in milliseconds */
    timeout: z.number().optional(),
  }),
});
export type SubworkflowStep = z.infer<typeof SubworkflowStep>;

export const WaitStep = BaseStep.extend({
  type: z.literal("wait"),
  wait: z.object({
    /** Resume condition */
    resumeOn: z.enum(["webhook", "event", "timeout"]),
    /** Webhook path suffix for unique callback URLs */
    webhookSuffix: z.string().optional(),
    /** Event name to wait for */
    eventName: z.string().optional(),
    /** Timeout duration */
    timeout: z.number().optional(),
    timeoutUnit: z.enum(["seconds", "minutes", "hours", "days"]).optional(),
    /** Action on timeout */
    timeoutAction: z.enum(["continue", "error"]).default("error"),
    /** Map callback payload to workflow variables */
    outputs: z.record(z.string(), z.string()).optional(),
  }),
});
export type WaitStep = z.infer<typeof WaitStep>;

export const EventStep = BaseStep.extend({
  type: z.literal("event"),
  event: z.object({
    /** Emit or subscribe */
    operation: z.enum(["emit"]),
    /** Event name/channel */
    eventName: z.string(),
    /** Payload to emit (supports {{variable}} interpolation) */
    payload: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type EventStep = z.infer<typeof EventStep>;

export const AggregateStep = BaseStep.extend({
  type: z.literal("aggregate"),
  aggregate: z.object({
    /** Aggregation mode */
    mode: z.enum(["collect", "merge", "concat", "sum", "first", "last"]),
    /** Source expression (array or step results) */
    source: z.string(),
    /** Group by expression */
    groupBy: z.string().optional(),
    /** Output variable name */
    outputVariable: z.string(),
  }),
});
export type AggregateStep = z.infer<typeof AggregateStep>;

export const CacheStep = BaseStep.extend({
  type: z.literal("cache"),
  cache: z.object({
    /** Operation */
    operation: z.enum(["get", "set", "delete", "getOrSet"]),
    /** Cache key (supports {{variable}} interpolation) */
    key: z.string(),
    /** Value to cache (for set/getOrSet) */
    value: z.unknown().optional(),
    /** TTL in seconds */
    ttl: z.number().optional(),
    /** For getOrSet: step ID to execute on cache miss */
    fallbackStep: z.string().optional(),
    /** Output variable for retrieved value */
    outputVariable: z.string().optional(),
  }),
});
export type CacheStep = z.infer<typeof CacheStep>;

export const MergeStep = BaseStep.extend({
  type: z.literal("merge"),
  merge: z.object({
    mode: z.enum(["object", "array", "deep"]),
    sources: z.array(z.string()),
    conflictStrategy: z.enum(["first", "last", "error"]).default("last"),
    outputVariable: z.string(),
  }),
});
export type MergeStep = z.infer<typeof MergeStep>;

export const SplitStep = BaseStep.extend({
  type: z.literal("split"),
  split: z.object({
    source: z.string(),
    batchSize: z.number().default(1),
    itemVariable: z.string().default("item"),
    indexVariable: z.string().default("index"),
    maxItems: z.number().optional(),
  }),
});
export type SplitStep = z.infer<typeof SplitStep>;

export const FilterStep = BaseStep.extend({
  type: z.literal("filter"),
  filter: z.object({
    source: z.string(),
    expression: z.string(),
    itemVariable: z.string().default("item"),
    outputVariable: z.string(),
  }),
});
export type FilterStep = z.infer<typeof FilterStep>;

export const SetStep = BaseStep.extend({
  type: z.literal("set"),
  set: z.object({
    variables: z.record(z.string(), z.unknown()),
    scope: z.enum(["workflow", "step"]).default("workflow"),
  }),
});
export type SetStep = z.infer<typeof SetStep>;

export const ErrorStep = BaseStep.extend({
  type: z.literal("error"),
  error: z.object({
    errorType: z.string(),
    message: z.string(),
    data: z.record(z.string(), z.unknown()).optional(),
    fatal: z.boolean().default(false),
  }),
});
export type ErrorStep = z.infer<typeof ErrorStep>;

export const RetryStep = BaseStep.extend({
  type: z.literal("retry"),
  retry: z.object({
    stepId: z.string(),
    maxAttempts: z.number().default(3),
    initialDelayMs: z.number().default(1000),
    backoff: z.enum(["fixed", "linear", "exponential"]).default("exponential"),
    maxDelayMs: z.number().default(30000),
    retryOn: z.array(z.string()).optional(),
  }),
});
export type RetryStep = z.infer<typeof RetryStep>;

export const TimeoutStep = BaseStep.extend({
  type: z.literal("timeout"),
  timeout: z.object({
    stepId: z.string(),
    durationMs: z.number(),
    onTimeout: z.enum(["error", "continue", "fallback"]).default("error"),
    fallbackStepId: z.string().optional(),
    fallbackValue: z.unknown().optional(),
  }),
});
export type TimeoutStep = z.infer<typeof TimeoutStep>;

export const EmailStep = BaseStep.extend({
  type: z.literal("email"),
  email: z.object({
    serverId: z.string().optional(),
    to: z.union([z.string(), z.array(z.string())]),
    cc: z.union([z.string(), z.array(z.string())]).optional(),
    bcc: z.union([z.string(), z.array(z.string())]).optional(),
    subject: z.string(),
    body: z.string(),
    contentType: z.enum(["text", "html"]).default("text"),
    attachments: z
      .array(
        z.object({
          filename: z.string(),
          content: z.string(),
          contentType: z.string().optional(),
        }),
      )
      .optional(),
  }),
});
export type EmailStep = z.infer<typeof EmailStep>;

export const WebhookResponseStep = BaseStep.extend({
  type: z.literal("webhookResponse"),
  webhookResponse: z.object({
    statusCode: z.number().default(200),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.unknown(),
    contentType: z.string().default("application/json"),
  }),
});
export type WebhookResponseStep = z.infer<typeof WebhookResponseStep>;

export const FileStep = BaseStep.extend({
  type: z.literal("file"),
  file: z.object({
    operation: z.enum(["read", "write", "delete", "list", "exists"]),
    provider: z.enum(["local", "s3", "gcs", "azure"]).default("local"),
    providerConfig: z.record(z.string(), z.unknown()).optional(),
    path: z.string(),
    content: z.unknown().optional(),
    encoding: z.string().default("utf-8"),
    outputVariable: z.string().optional(),
  }),
});
export type FileStep = z.infer<typeof FileStep>;

export const QueueStep = BaseStep.extend({
  type: z.literal("queue"),
  queue: z.object({
    operation: z.enum(["push", "pull", "peek", "ack", "nack"]),
    provider: z.enum(["memory", "redis", "sqs", "rabbitmq"]).default("memory"),
    providerConfig: z.record(z.string(), z.unknown()).optional(),
    queueName: z.string(),
    message: z.unknown().optional(),
    priority: z.number().optional(),
    delayMs: z.number().optional(),
    outputVariable: z.string().optional(),
    timeoutMs: z.number().optional(),
  }),
});
export type QueueStep = z.infer<typeof QueueStep>;

export const EmbeddingStep = BaseStep.extend({
  type: z.literal("embedding"),
  embedding: z.object({
    serverId: z.string(),
    model: z.string(),
    input: z.union([z.string(), z.array(z.string())]),
    dimensions: z.number().optional(),
    outputVariable: z.string(),
  }),
});
export type EmbeddingStep = z.infer<typeof EmbeddingStep>;

export const VectorSearchStep = BaseStep.extend({
  type: z.literal("vectorSearch"),
  vectorSearch: z.object({
    provider: z.enum(["pinecone", "pgvector", "qdrant", "weaviate", "chroma"]),
    providerConfig: z.record(z.string(), z.unknown()).optional(),
    indexName: z.string(),
    queryVector: z.union([z.array(z.number()), z.string()]),
    topK: z.number().default(10),
    minScore: z.number().optional(),
    filter: z.record(z.string(), z.unknown()).optional(),
    includeVectors: z.boolean().default(false),
    includeMetadata: z.boolean().default(true),
    outputVariable: z.string(),
  }),
});
export type VectorSearchStep = z.infer<typeof VectorSearchStep>;

export const LogStep = BaseStep.extend({
  type: z.literal("log"),
  log: z.object({
    level: z.enum(["debug", "info", "warn", "error"]).default("info"),
    message: z.string(),
    data: z.record(z.string(), z.unknown()).optional(),
    tags: z.array(z.string()).optional(),
  }),
});
export type LogStep = z.infer<typeof LogStep>;

export const AssertStep = BaseStep.extend({
  type: z.literal("assert"),
  assert: z.object({
    expression: z.string(),
    message: z.string().optional(),
    softFail: z.boolean().default(false),
    outputVariable: z.string().optional(),
  }),
});
export type AssertStep = z.infer<typeof AssertStep>;

export const SleepStep = BaseStep.extend({
  type: z.literal("sleep"),
  sleep: z.object({
    duration: z.number(),
    unit: z.enum(["ms", "seconds", "minutes"]).default("seconds"),
  }),
});
export type SleepStep = z.infer<typeof SleepStep>;

// Data transformation steps

export const MapStep = BaseStep.extend({
  type: z.literal("map"),
  map: z.object({
    source: z.string().describe("Source array expression"),
    expression: z.string().describe("Transform expression for each item"),
    itemVariable: z.string().default("item"),
    indexVariable: z.string().default("index"),
    outputVariable: z.string(),
  }),
});
export type MapStep = z.infer<typeof MapStep>;

export const ReduceStep = BaseStep.extend({
  type: z.literal("reduce"),
  reduce: z.object({
    source: z.string(),
    expression: z.string(),
    initialValue: z.unknown(),
    accumulatorVariable: z.string().default("acc"),
    itemVariable: z.string().default("item"),
    outputVariable: z.string(),
  }),
});
export type ReduceStep = z.infer<typeof ReduceStep>;

export const SortStep = BaseStep.extend({
  type: z.literal("sort"),
  sort: z.object({
    source: z.string(),
    key: z.string().optional(),
    direction: z.enum(["asc", "desc"]).default("asc"),
    outputVariable: z.string(),
  }),
});
export type SortStep = z.infer<typeof SortStep>;

export const UniqueStep = BaseStep.extend({
  type: z.literal("unique"),
  unique: z.object({
    source: z.string(),
    key: z.string().optional(),
    outputVariable: z.string(),
  }),
});
export type UniqueStep = z.infer<typeof UniqueStep>;

export const TemplateStep = BaseStep.extend({
  type: z.literal("template"),
  template: z.object({
    content: z.string(),
    variables: z.record(z.unknown()).optional(),
    outputVariable: z.string(),
  }),
});
export type TemplateStep = z.infer<typeof TemplateStep>;

// AI/ML steps

export const PromptStep = BaseStep.extend({
  type: z.literal("prompt"),
  prompt: z.object({
    serverId: z.string().optional(),
    model: z.string(),
    template: z.string(),
    variables: z.record(z.unknown()).optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().positive().optional(),
    outputVariable: z.string(),
  }),
});
export type PromptStep = z.infer<typeof PromptStep>;

export const ChatStep = BaseStep.extend({
  type: z.literal("chat"),
  chat: z.object({
    serverId: z.string().optional(),
    model: z.string(),
    messages: z.array(
      z.object({
        role: z.enum(["system", "user", "assistant"]),
        content: z.string(),
      }),
    ),
    historyVariable: z.string().optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().positive().optional(),
    outputVariable: z.string(),
  }),
});
export type ChatStep = z.infer<typeof ChatStep>;

export const SummarizeStep = BaseStep.extend({
  type: z.literal("summarize"),
  summarize: z.object({
    serverId: z.string().optional(),
    model: z.string().optional(),
    input: z.string(),
    maxLength: z.number().positive().optional(),
    style: z.enum(["brief", "detailed", "bullets"]).default("brief"),
    outputVariable: z.string(),
  }),
});
export type SummarizeStep = z.infer<typeof SummarizeStep>;

export const ClassifyStep = BaseStep.extend({
  type: z.literal("classify"),
  classify: z.object({
    serverId: z.string().optional(),
    model: z.string().optional(),
    input: z.string(),
    categories: z.array(z.string()),
    multiLabel: z.boolean().default(false),
    outputVariable: z.string(),
  }),
});
export type ClassifyStep = z.infer<typeof ClassifyStep>;

// Human-in-the-loop steps

export const ApprovalStep = BaseStep.extend({
  type: z.literal("approval"),
  approval: z.object({
    title: z.string(),
    message: z.string(),
    approvers: z.array(z.string()).optional(),
    timeout: z.number().positive().optional(),
    timeoutAction: z.enum(["approve", "reject", "error"]).default("error"),
    outputVariable: z.string().optional(),
  }),
});
export type ApprovalStep = z.infer<typeof ApprovalStep>;

export const InputStep = BaseStep.extend({
  type: z.literal("input"),
  input: z.object({
    title: z.string(),
    message: z.string().optional(),
    fields: z.array(
      z.object({
        name: z.string(),
        label: z.string(),
        type: z.enum([
          "text",
          "number",
          "email",
          "textarea",
          "select",
          "checkbox",
        ]),
        required: z.boolean().default(false),
        options: z.array(z.string()).optional(),
        default: z.unknown().optional(),
      }),
    ),
    assignees: z.array(z.string()).optional(),
    timeout: z.number().positive().optional(),
    outputVariable: z.string(),
  }),
});
export type InputStep = z.infer<typeof InputStep>;

export const NotificationStep = BaseStep.extend({
  type: z.literal("notification"),
  notification: z.object({
    channel: z.enum(["email", "slack", "webhook", "push"]),
    recipients: z.array(z.string()),
    title: z.string(),
    message: z.string(),
    priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
    data: z.record(z.unknown()).optional(),
  }),
});
export type NotificationStep = z.infer<typeof NotificationStep>;

// Utility steps

export const ParseStep = BaseStep.extend({
  type: z.literal("parse"),
  parse: z.object({
    input: z.string(),
    format: z.enum(["json", "xml", "csv", "yaml", "querystring"]),
    options: z
      .object({
        delimiter: z.string().optional(),
        headers: z.boolean().optional(),
      })
      .optional(),
    outputVariable: z.string(),
  }),
});
export type ParseStep = z.infer<typeof ParseStep>;

export const ValidateStep = BaseStep.extend({
  type: z.literal("validate"),
  validate: z.object({
    input: z.string(),
    schema: z.record(z.unknown()),
    strict: z.boolean().default(true),
    outputVariable: z.string().optional(),
  }),
});
export type ValidateStep = z.infer<typeof ValidateStep>;

export const FormatStep = BaseStep.extend({
  type: z.literal("format"),
  format: z.object({
    input: z.string(),
    type: z.enum(["date", "number", "currency", "percentage", "bytes"]),
    options: z
      .object({
        locale: z.string().optional(),
        pattern: z.string().optional(),
        currency: z.string().optional(),
        decimals: z.number().optional(),
        timezone: z.string().optional(),
      })
      .optional(),
    outputVariable: z.string(),
  }),
});
export type FormatStep = z.infer<typeof FormatStep>;

export const HashStep = BaseStep.extend({
  type: z.literal("hash"),
  hash: z.object({
    input: z.string(),
    algorithm: z
      .enum(["md5", "sha1", "sha256", "sha512", "xxhash"])
      .default("sha256"),
    encoding: z.enum(["hex", "base64", "base64url"]).default("hex"),
    outputVariable: z.string(),
  }),
});
export type HashStep = z.infer<typeof HashStep>;

// Advanced array operation steps

/** Group array items by a key. */
export const GroupStep = BaseStep.extend({
  type: z.literal("group"),
  group: z.object({
    source: z.string(),
    keyExpression: z.string(),
    itemVariable: z.string().default("item"),
    outputVariable: z.string().optional(),
  }),
});
export type GroupStep = z.infer<typeof GroupStep>;

/** Flatten nested arrays. */
export const FlattenStep = BaseStep.extend({
  type: z.literal("flatten"),
  flatten: z.object({
    source: z.string(),
    depth: z.number().default(1),
    outputVariable: z.string().optional(),
  }),
});
export type FlattenStep = z.infer<typeof FlattenStep>;

/** Split array into chunks. */
export const ChunkStep = BaseStep.extend({
  type: z.literal("chunk"),
  chunk: z.object({
    source: z.string(),
    size: z.number().min(1),
    outputVariable: z.string().optional(),
  }),
});
export type ChunkStep = z.infer<typeof ChunkStep>;

/** Combine multiple arrays element-wise. */
export const ZipStep = BaseStep.extend({
  type: z.literal("zip"),
  zip: z.object({
    sources: z.array(z.string()),
    outputVariable: z.string().optional(),
  }),
});
export type ZipStep = z.infer<typeof ZipStep>;

// Security steps

/** Encrypt data using AES-GCM. */
export const EncryptStep = BaseStep.extend({
  type: z.literal("encrypt"),
  encrypt: z.object({
    input: z.string(),
    key: z.string(),
    algorithm: z.enum(["AES-GCM", "AES-CBC"]).default("AES-GCM"),
    outputVariable: z.string().optional(),
  }),
});
export type EncryptStep = z.infer<typeof EncryptStep>;

/** Decrypt data using AES-GCM. */
export const DecryptStep = BaseStep.extend({
  type: z.literal("decrypt"),
  decrypt: z.object({
    input: z.string(),
    key: z.string(),
    algorithm: z.enum(["AES-GCM", "AES-CBC"]).default("AES-GCM"),
    outputVariable: z.string().optional(),
  }),
});
export type DecryptStep = z.infer<typeof DecryptStep>;

/** Create digital signature using HMAC. */
export const SignStep = BaseStep.extend({
  type: z.literal("sign"),
  sign: z.object({
    input: z.string(),
    key: z.string(),
    algorithm: z.enum(["SHA-256", "SHA-384", "SHA-512"]).default("SHA-256"),
    encoding: z.enum(["hex", "base64"]).default("hex"),
    outputVariable: z.string().optional(),
  }),
});
export type SignStep = z.infer<typeof SignStep>;

/** JWT token operations. */
export const JwtStep = BaseStep.extend({
  type: z.literal("jwt"),
  jwt: z.object({
    operation: z.enum(["create", "verify", "decode"]),
    input: z.string(),
    secret: z.string().optional(),
    algorithm: z.enum(["HS256", "HS384", "HS512"]).default("HS256"),
    expiresIn: z.number().optional(),
    outputVariable: z.string().optional(),
  }),
});
export type JwtStep = z.infer<typeof JwtStep>;

// AI extension steps

/** Autonomous AI agent execution. */
export const AgentStep = BaseStep.extend({
  type: z.literal("agent"),
  agent: z.object({
    serverId: z.string(),
    model: z.string().optional(),
    goal: z.string(),
    tools: z.array(z.string()).optional(),
    maxIterations: z.number().default(10),
    outputVariable: z.string().optional(),
  }),
});
export type AgentStep = z.infer<typeof AgentStep>;

/** Retrieval-augmented generation. */
export const RagStep = BaseStep.extend({
  type: z.literal("rag"),
  rag: z.object({
    serverId: z.string(),
    model: z.string().optional(),
    query: z.string(),
    collection: z.string(),
    topK: z.number().default(5),
    promptTemplate: z.string().optional(),
    outputVariable: z.string().optional(),
  }),
});
export type RagStep = z.infer<typeof RagStep>;

/** Image analysis and OCR. */
export const VisionStep = BaseStep.extend({
  type: z.literal("vision"),
  vision: z.object({
    serverId: z.string(),
    model: z.string().optional(),
    image: z.string(),
    task: z.enum(["describe", "ocr", "detect", "classify"]),
    prompt: z.string().optional(),
    outputVariable: z.string().optional(),
  }),
});
export type VisionStep = z.infer<typeof VisionStep>;

/** Audio processing - speech-to-text and text-to-speech. */
export const AudioStep = BaseStep.extend({
  type: z.literal("audio"),
  audio: z.object({
    serverId: z.string(),
    model: z.string().optional(),
    task: z.enum(["transcribe", "synthesize"]),
    input: z.string(),
    language: z.string().optional(),
    voice: z.string().optional(),
    outputVariable: z.string().optional(),
  }),
});
export type AudioStep = z.infer<typeof AudioStep>;

// Integration steps

/** Spreadsheet (Excel/CSV) operations. */
export const SpreadsheetStep = BaseStep.extend({
  type: z.literal("spreadsheet"),
  spreadsheet: z.object({
    operation: z.enum([
      "read",
      "write",
      "cell",
      "query",
      "create",
      "listSheets",
      "addSheet",
      "deleteSheet",
      "renameSheet",
    ]),
    path: z.string(),
    format: z.enum(["xlsx", "xls", "csv", "auto"]).default("auto"),
    sheet: z.union([z.string(), z.number()]).optional(),
    startRow: z.number().optional(),
    endRow: z.number().optional(),
    columns: z.union([z.string(), z.array(z.string())]).optional(),
    headers: z.boolean().default(true),
    data: z.unknown().optional(),
    cell: z.string().optional(),
    value: z.unknown().optional(),
    formula: z.string().optional(),
    filter: z.string().optional(),
    sortBy: z.union([z.string(), z.array(z.string())]).optional(),
    sortDirection: z
      .union([z.enum(["asc", "desc"]), z.array(z.enum(["asc", "desc"]))])
      .optional(),
    limit: z.number().optional(),
    offset: z.number().optional(),
    outputVariable: z.string().optional(),
  }),
});
export type SpreadsheetStep = z.infer<typeof SpreadsheetStep>;

/** Google Sheets operations. */
export const GoogleSheetsStep = BaseStep.extend({
  type: z.literal("googleSheets"),
  googleSheets: z.object({
    operation: z.enum([
      "read",
      "write",
      "append",
      "update",
      "delete",
      "clear",
      "listSheets",
      "addSheet",
      "deleteSheet",
    ]),
    connectionId: z.string(),
    spreadsheetId: z.string(),
    sheet: z.string().optional(),
    range: z.string().optional(),
    data: z.unknown().optional(),
    valueInputOption: z.enum(["RAW", "USER_ENTERED"]).default("USER_ENTERED"),
    includeHeaders: z.boolean().default(true),
    filter: z.string().optional(),
    sortBy: z.string().optional(),
    outputVariable: z.string().optional(),
  }),
});
export type GoogleSheetsStep = z.infer<typeof GoogleSheetsStep>;

/** Unified AI model registry - BYOK for multiple providers. */
export const ModelRegistryStep = BaseStep.extend({
  type: z.literal("modelRegistry"),
  modelRegistry: z.object({
    provider: z.enum([
      "openai",
      "anthropic",
      "huggingface",
      "ollama",
      "replicate",
      "together",
      "groq",
      "mistral",
      "cohere",
    ]),
    connectionId: z.string().optional(),
    apiKey: z.string().optional(),
    model: z.string(),
    operation: z
      .enum(["chat", "complete", "embed", "generate"])
      .default("chat"),
    messages: z
      .array(
        z.object({
          role: z.enum(["system", "user", "assistant"]),
          content: z.string(),
        }),
      )
      .optional(),
    prompt: z.string().optional(),
    input: z.union([z.string(), z.array(z.string())]).optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().positive().optional(),
    topP: z.number().min(0).max(1).optional(),
    stop: z.array(z.string()).optional(),
    baseUrl: z.string().optional(),
    outputVariable: z.string().optional(),
  }),
});
export type ModelRegistryStep = z.infer<typeof ModelRegistryStep>;

/** Webhook signature verification. */
export const WebhookVerifyStep = BaseStep.extend({
  type: z.literal("webhookVerify"),
  webhookVerify: z.object({
    provider: z.enum([
      "stripe",
      "github",
      "slack",
      "twilio",
      "shopify",
      "sendgrid",
      "paddle",
      "linear",
      "custom",
    ]),
    payload: z.string(),
    signature: z.string(),
    secret: z.string(),
    timestamp: z.string().optional(),
    tolerance: z.number().default(300),
    algorithm: z.enum(["sha256", "sha1", "sha512"]).optional(),
    outputVariable: z.string().optional(),
  }),
});
export type WebhookVerifyStep = z.infer<typeof WebhookVerifyStep>;

/** PDF generation and manipulation. */
export const PdfStep = BaseStep.extend({
  type: z.literal("pdf"),
  pdf: z.object({
    operation: z.enum([
      "create",
      "parse",
      "merge",
      "split",
      "watermark",
      "extractPages",
      "info",
    ]),
    input: z.union([z.string(), z.array(z.string())]).optional(),
    pages: z
      .array(
        z.object({
          width: z.number().optional(),
          height: z.number().optional(),
          content: z.array(
            z.object({
              type: z.enum(["text", "image", "rectangle", "line"]),
              x: z.number().optional(),
              y: z.number().optional(),
              text: z.string().optional(),
              fontSize: z.number().optional(),
              color: z.string().optional(),
              font: z.enum(["helvetica", "times", "courier"]).optional(),
              bold: z.boolean().optional(),
              italic: z.boolean().optional(),
              image: z.string().optional(),
              width: z.number().optional(),
              height: z.number().optional(),
              x2: z.number().optional(),
              y2: z.number().optional(),
              fill: z.boolean().optional(),
              lineWidth: z.number().optional(),
            }),
          ),
        }),
      )
      .optional(),
    pageRanges: z
      .array(z.union([z.number(), z.tuple([z.number(), z.number()])]))
      .optional(),
    watermarkText: z.string().optional(),
    watermarkOptions: z
      .object({
        fontSize: z.number().optional(),
        color: z.string().optional(),
        opacity: z.number().optional(),
        rotation: z.number().optional(),
      })
      .optional(),
    outputVariable: z.string().optional(),
  }),
});
export type PdfStep = z.infer<typeof PdfStep>;

/** Rate limiting and throttling. */
export const RateLimitStep = BaseStep.extend({
  type: z.literal("rateLimit"),
  rateLimit: z.object({
    operation: z.enum(["acquire", "check", "reset", "throttle", "configure"]),
    key: z.string(),
    limit: z.number().optional(),
    windowSeconds: z.number().optional(),
    algorithm: z
      .enum(["token_bucket", "sliding_window", "fixed_window"])
      .optional(),
    burstCapacity: z.number().optional(),
    refillRate: z.number().optional(),
    tokens: z.number().optional(),
    wait: z.boolean().optional(),
    maxWaitMs: z.number().optional(),
    maxRetries: z.number().optional(),
    outputVariable: z.string().optional(),
  }),
});
export type RateLimitStep = z.infer<typeof RateLimitStep>;

// Flow control steps

/** Try/catch error handling with optional retries */
export const TryCatchStep = BaseStep.extend({
  type: z.literal("try_catch"),
  tryCatch: z.object({
    /** Step IDs to execute in the try branch */
    tryBranch: z.array(z.string()),
    /** Step IDs to execute if try branch fails */
    catchBranch: z.array(z.string()),
    /** Variable name to store error information */
    errorOutput: z.string(),
    /** Number of retry attempts before running catch branch */
    retries: z.number().optional(),
    /** Delay between retry attempts (e.g., "1s", "500ms", "2m") */
    retryDelay: z.string().optional(),
  }),
});
export type TryCatchStep = z.infer<typeof TryCatchStep>;

/** Race multiple branches, first to complete wins */
export const RaceStep = BaseStep.extend({
  type: z.literal("race"),
  race: z.object({
    /** Array of branches, each branch is an array of step IDs */
    branches: z.array(z.array(z.string())),
    /** Optional timeout for the race */
    timeout: z.string().optional(),
    /** Variable name to store the winning result */
    output: z.string(),
    /** Variable name to store the index of winning branch */
    winnerIndex: z.string(),
  }),
});
export type RaceStep = z.infer<typeof RaceStep>;

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
  SubworkflowStep,
  WaitStep,
  EventStep,
  AggregateStep,
  CacheStep,
  MergeStep,
  SplitStep,
  FilterStep,
  SetStep,
  ErrorStep,
  RetryStep,
  TimeoutStep,
  EmailStep,
  WebhookResponseStep,
  FileStep,
  QueueStep,
  EmbeddingStep,
  VectorSearchStep,
  LogStep,
  AssertStep,
  SleepStep,
  // Data transformation
  MapStep,
  ReduceStep,
  SortStep,
  UniqueStep,
  TemplateStep,
  // AI/ML
  PromptStep,
  ChatStep,
  SummarizeStep,
  ClassifyStep,
  // Human-in-the-loop
  ApprovalStep,
  InputStep,
  NotificationStep,
  // Utility
  ParseStep,
  ValidateStep,
  FormatStep,
  HashStep,
  // Advanced array operations
  GroupStep,
  FlattenStep,
  ChunkStep,
  ZipStep,
  // Security
  EncryptStep,
  DecryptStep,
  SignStep,
  JwtStep,
  // AI extensions
  AgentStep,
  RagStep,
  VisionStep,
  AudioStep,
  // Integration
  SpreadsheetStep,
  GoogleSheetsStep,
  ModelRegistryStep,
  WebhookVerifyStep,
  // Tier 2
  PdfStep,
  RateLimitStep,
  // Flow control
  TryCatchStep,
  RaceStep,
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
