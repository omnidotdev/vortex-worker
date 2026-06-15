import Hatchet from "@hatchet-dev/typescript-sdk";
import { eq } from "drizzle-orm";
import { match } from "ts-pattern";

import {
  CancelledError,
  ConfigError,
  ExecutionError,
  IntegrationError,
  MCPError,
  NotFoundError,
  PluginError,
  TimeoutError,
  ValidationError,
} from "lib/errors";
import logger from "lib/logger";
import { executeConnectorAction } from "../connectors/executor";
import { getDb } from "../db";
import { createWorkflowRun } from "../db/runLogger";
import { rivetGraphTable, workflowRunTable, workflowTable } from "../db/schema";
import { isInitialized, publish } from "../events/publisher";
import { getIntegrationCredentials } from "../integrations/credentials";
import { connectMCPServer, getMCPClient } from "../mcp";
import {
  executeBuiltinAction,
  getPluginHost,
  isBuiltinPlugin,
} from "../plugins";
import { getPluginRegistry } from "../plugins/registry";
import { runExtismSandbox } from "../sandbox/extism";
import { runSandboxedCode } from "../sandbox/runner";
import { stateStore } from "../state";
import { endSpan, startStepSpan } from "../tracing/propagation";
import { registerCollect } from "./collect-state";
import executeSaga from "./saga-executor";
import WindowStateManager from "./window-state";

import type { PluginCallResult } from "../plugins/types";
import type {
  ActionStep,
  AgentStep,
  AggregateStep,
  AiGuardrailsStep,
  AiTransformStep,
  ApprovalStep,
  AssertStep,
  AudioStep,
  CacheStep,
  ChangeDetectorStep,
  ChatStep,
  ChunkStep,
  ClassifyStep,
  CodeStep,
  CollectStep,
  ConditionStep,
  DatabaseStep,
  DebounceStep,
  DecryptStep,
  DelayStep,
  DiffStep,
  EmailStep,
  EmbeddingStep,
  EncryptStep,
  ErrorStep,
  EventStep,
  ExecutionContext,
  FileStep,
  FilterStep,
  FlattenStep,
  FormatStep,
  GateStep,
  GoogleSheetsStep,
  GroupStep,
  HashStep,
  InputStep,
  JwtStep,
  LLMStep,
  LogStep,
  LoopStep,
  MCPStep,
  MapStep,
  MergeStep,
  ModelRegistryStep,
  NotificationStep,
  ParallelStep,
  ParseStep,
  PdfStep,
  PluginStep,
  PromptStep,
  QueueStep,
  RaceStep,
  RagStep,
  RateLimitStep,
  ReduceStep,
  RetryStep,
  RivetStep,
  SetStep,
  SignStep,
  SleepStep,
  SortStep,
  SplitStep,
  SpreadsheetStep,
  StateGetStep,
  StateSetStep,
  StateWaitStep,
  Step,
  SubworkflowStep,
  SummarizeStep,
  SwitchStep,
  TemplateStep,
  TimeWindowStep,
  TimeoutStep,
  TriggerStep,
  TryCatchStep,
  UniqueStep,
  ValidateStep,
  VectorSearchStep,
  VisionStep,
  WaitStep,
  WebhookResponseStep,
  WebhookVerifyStep,
  WindowStep,
  WorkflowDefinition,
  ZipStep,
} from "./types";

/**
 * Map integration IDs to Activepieces connector package IDs.
 *
 * Most integrations follow the pattern: id -> @activepieces/piece-{id}
 * Exceptions are noted with comments.
 *
 * Note: "claude" is the Activepieces package name for Anthropic's Claude API.
 * We map both "claude" and "anthropic" to the same package for user convenience.
 */
const INTEGRATION_TO_CONNECTOR: Record<string, string> = {
  // ===== Communication =====
  discord: "@activepieces/piece-discord",
  slack: "@activepieces/piece-slack",
  telegram: "@activepieces/piece-telegram-bot", // note: -bot suffix
  twilio: "@activepieces/piece-twilio",
  whatsapp: "@activepieces/piece-whatsapp",
  "whatsapp-business": "@activepieces/piece-whatsapp-business",
  intercom: "@activepieces/piece-intercom",
  "facebook-messenger": "@activepieces/piece-facebook-messenger",
  pushover: "@activepieces/piece-pushover",
  ntfy: "@activepieces/piece-ntfy",
  "matrix-chat": "@activepieces/piece-matrix",
  mattermost: "@activepieces/piece-mattermost",

  // ===== Email =====
  gmail: "@activepieces/piece-gmail",
  "microsoft-outlook": "@activepieces/piece-microsoft-outlook",
  sendgrid: "@activepieces/piece-sendgrid",
  mailchimp: "@activepieces/piece-mailchimp",
  mailgun: "@activepieces/piece-mailgun",
  sendinblue: "@activepieces/piece-sendinblue",
  postmark: "@activepieces/piece-postmark",
  resend: "@activepieces/piece-resend",
  smtp: "@activepieces/piece-smtp",
  imap: "@activepieces/piece-imap",

  // ===== Developer Tools =====
  github: "@activepieces/piece-github",
  gitlab: "@activepieces/piece-gitlab",
  bitbucket: "@activepieces/piece-bitbucket",
  linear: "@activepieces/piece-linear",
  jira: "@activepieces/piece-jira-cloud",
  "jira-cloud": "@activepieces/piece-jira-cloud",
  sentry: "@activepieces/piece-sentry",
  datadog: "@activepieces/piece-datadog",
  pagerduty: "@activepieces/piece-pagerduty",
  vercel: "@activepieces/piece-vercel",
  netlify: "@activepieces/piece-netlify",
  "render-deploy": "@activepieces/piece-render",
  heroku: "@activepieces/piece-heroku",
  cloudflare: "@activepieces/piece-cloudflare",
  "digitalocean-spaces": "@activepieces/piece-digitalocean-spaces",

  // ===== Productivity & Project Management =====
  notion: "@activepieces/piece-notion",
  asana: "@activepieces/piece-asana",
  trello: "@activepieces/piece-trello",
  todoist: "@activepieces/piece-todoist",
  clickup: "@activepieces/piece-clickup",
  monday: "@activepieces/piece-monday",
  basecamp: "@activepieces/piece-basecamp",
  "microsoft-to-do": "@activepieces/piece-microsoft-todo",
  coda: "@activepieces/piece-coda",

  // ===== Spreadsheets & Databases =====
  "google-sheets": "@activepieces/piece-google-sheets",
  airtable: "@activepieces/piece-airtable",
  "microsoft-excel": "@activepieces/piece-microsoft-excel-365",
  supabase: "@activepieces/piece-supabase",
  firebase: "@activepieces/piece-firebase",
  mongodb: "@activepieces/piece-mongodb",
  mysql: "@activepieces/piece-mysql",
  postgres: "@activepieces/piece-postgres",
  redis: "@activepieces/piece-redis",
  snowflake: "@activepieces/piece-snowflake",

  // ===== Cloud Storage =====
  "google-drive": "@activepieces/piece-google-drive",
  dropbox: "@activepieces/piece-dropbox",
  box: "@activepieces/piece-box",
  onedrive: "@activepieces/piece-microsoft-onedrive",
  "microsoft-onedrive": "@activepieces/piece-microsoft-onedrive",
  "amazon-s3": "@activepieces/piece-s3",
  s3: "@activepieces/piece-s3",

  // ===== CRM & Marketing =====
  hubspot: "@activepieces/piece-hubspot",
  salesforce: "@activepieces/piece-salesforce",
  pipedrive: "@activepieces/piece-pipedrive",
  zoho: "@activepieces/piece-zoho-crm",
  "zoho-crm": "@activepieces/piece-zoho-crm",
  freshdesk: "@activepieces/piece-freshdesk",
  freshsales: "@activepieces/piece-freshsales",
  zendesk: "@activepieces/piece-zendesk",
  "active-campaign": "@activepieces/piece-activecampaign",
  activecampaign: "@activepieces/piece-activecampaign",
  klaviyo: "@activepieces/piece-klaviyo",
  convertkit: "@activepieces/piece-convertkit",
  drip: "@activepieces/piece-drip",
  "constant-contact": "@activepieces/piece-constant-contact",
  beehiiv: "@activepieces/piece-beehiiv",

  // ===== Forms & Surveys =====
  typeform: "@activepieces/piece-typeform",
  "google-forms": "@activepieces/piece-google-forms",
  jotform: "@activepieces/piece-jotform",
  surveymonkey: "@activepieces/piece-surveymonkey",
  tally: "@activepieces/piece-tally",

  // ===== Payments & Finance =====
  stripe: "@activepieces/piece-stripe",
  paypal: "@activepieces/piece-paypal",
  square: "@activepieces/piece-square",
  quickbooks: "@activepieces/piece-quickbooks",
  "quickbooks-online": "@activepieces/piece-quickbooks",
  xero: "@activepieces/piece-xero",
  plaid: "@activepieces/piece-plaid",
  lemonsqueezy: "@activepieces/piece-lemonsqueezy",
  gumroad: "@activepieces/piece-gumroad",
  paddle: "@activepieces/piece-paddle",

  // ===== Calendar & Scheduling =====
  "google-calendar": "@activepieces/piece-google-calendar",
  "microsoft-teams": "@activepieces/piece-microsoft-teams",
  calendly: "@activepieces/piece-calendly",
  zoom: "@activepieces/piece-zoom",
  cal: "@activepieces/piece-cal-com",
  "cal-com": "@activepieces/piece-cal-com",

  // ===== AI & Machine Learning =====
  openai: "@activepieces/piece-openai",
  claude: "@activepieces/piece-claude",
  anthropic: "@activepieces/piece-claude", // alias - Activepieces uses "claude" as package name
  "google-gemini": "@activepieces/piece-google-gemini",
  groq: "@activepieces/piece-groq",
  perplexity: "@activepieces/piece-perplexity-ai",
  "stability-ai": "@activepieces/piece-stability-ai",
  replicate: "@activepieces/piece-replicate",
  huggingface: "@activepieces/piece-huggingface",
  cohere: "@activepieces/piece-cohere",
  mistral: "@activepieces/piece-mistral-ai",
  deepl: "@activepieces/piece-deepl",
  elevenlabs: "@activepieces/piece-elevenlabs",
  assemblyai: "@activepieces/piece-assemblyai",
  "amazon-bedrock": "@activepieces/piece-amazon-bedrock",
  "azure-openai": "@activepieces/piece-azure-openai",
  ollama: "@activepieces/piece-ollama",

  // ===== E-commerce =====
  shopify: "@activepieces/piece-shopify",
  woocommerce: "@activepieces/piece-woocommerce",
  bigcommerce: "@activepieces/piece-bigcommerce",
  magento: "@activepieces/piece-magento",
  etsy: "@activepieces/piece-etsy",
  printful: "@activepieces/piece-printful",

  // ===== Social Media =====
  twitter: "@activepieces/piece-twitter",
  x: "@activepieces/piece-twitter", // alias - X is the new name for Twitter
  facebook: "@activepieces/piece-facebook-pages",
  "facebook-pages": "@activepieces/piece-facebook-pages",
  instagram: "@activepieces/piece-instagram-business",
  "instagram-business": "@activepieces/piece-instagram-business",
  linkedin: "@activepieces/piece-linkedin",
  youtube: "@activepieces/piece-youtube",
  tiktok: "@activepieces/piece-tiktok",
  pinterest: "@activepieces/piece-pinterest",
  reddit: "@activepieces/piece-reddit",
  mastodon: "@activepieces/piece-mastodon",
  bluesky: "@activepieces/piece-bsky",
  bsky: "@activepieces/piece-bsky",

  // ===== Analytics =====
  "google-analytics": "@activepieces/piece-google-analytics",
  mixpanel: "@activepieces/piece-mixpanel",
  segment: "@activepieces/piece-segment",
  amplitude: "@activepieces/piece-amplitude",
  posthog: "@activepieces/piece-posthog",
  plausible: "@activepieces/piece-plausible",
  "google-search-console": "@activepieces/piece-google-search-console",

  // ===== Content Management =====
  wordpress: "@activepieces/piece-wordpress",
  webflow: "@activepieces/piece-webflow",
  contentful: "@activepieces/piece-contentful",
  strapi: "@activepieces/piece-strapi",
  ghost: "@activepieces/piece-ghost",
  medium: "@activepieces/piece-medium",
  hashnode: "@activepieces/piece-hashnode",
  "dev-to": "@activepieces/piece-dev-to",

  // ===== Automation & Integration =====
  http: "@activepieces/piece-http",
  webhook: "@activepieces/piece-webhook",
  webhooks: "@activepieces/piece-webhook",
  "schedule-trigger": "@activepieces/piece-schedule",
  schedule: "@activepieces/piece-schedule",
  rss: "@activepieces/piece-rss",
  xml: "@activepieces/piece-xml",
  csv: "@activepieces/piece-csv",
  json: "@activepieces/piece-json",
  sftp: "@activepieces/piece-sftp",
  ftp: "@activepieces/piece-ftp",

  // ===== Document & File Processing =====
  "google-docs": "@activepieces/piece-google-docs",
  pdf: "@activepieces/piece-pdf",
  "pdf-co": "@activepieces/piece-pdf-co",
  docusign: "@activepieces/piece-docusign",
  pandadoc: "@activepieces/piece-pandadoc",

  // ===== Customer Support =====
  freshchat: "@activepieces/piece-freshchat",
  crisp: "@activepieces/piece-crisp",
  "help-scout": "@activepieces/piece-help-scout",
  helpscout: "@activepieces/piece-help-scout",
  front: "@activepieces/piece-front",
  "live-chat": "@activepieces/piece-livechat",
  livechat: "@activepieces/piece-livechat",
  drift: "@activepieces/piece-drift",

  // ===== HR & Recruitment =====
  bamboohr: "@activepieces/piece-bamboo-hr",
  "bamboo-hr": "@activepieces/piece-bamboo-hr",
  lever: "@activepieces/piece-lever",
  greenhouse: "@activepieces/piece-greenhouse",
  workable: "@activepieces/piece-workable",

  // ===== No-code / Low-code Tools =====
  "google-apps-script": "@activepieces/piece-google-apps-script",
  retool: "@activepieces/piece-retool",
  bubble: "@activepieces/piece-bubble",
  glide: "@activepieces/piece-glide",

  // ===== Miscellaneous =====
  "open-router": "@activepieces/piece-open-router",
  openrouter: "@activepieces/piece-open-router",
  "ip-geo-location": "@activepieces/piece-ip-geolocation",
  "text-helper": "@activepieces/piece-text-helper",
  "date-helper": "@activepieces/piece-date-helper",
  math: "@activepieces/piece-math-helper",
  "math-helper": "@activepieces/piece-math-helper",
  "data-mapper": "@activepieces/piece-data-mapper",
  "store-piece": "@activepieces/piece-store",
  store: "@activepieces/piece-store",
  "delay-piece": "@activepieces/piece-delay",
  delay: "@activepieces/piece-delay",
  approval: "@activepieces/piece-approval",
  "generate-banner": "@activepieces/piece-generatebanners",
  qrcode: "@activepieces/piece-qrcode",
  "image-helper": "@activepieces/piece-image-helper",
  pastebin: "@activepieces/piece-pastebin",
  "crypto-utils": "@activepieces/piece-crypto",
  crypto: "@activepieces/piece-crypto",
};

export function findTriggerStep(steps: Step[]): TriggerStep | undefined {
  return steps.find((s): s is TriggerStep => s.type === "trigger");
}

/**
 * Find root steps (steps with no incoming edges) for workflows without a
 * trigger node, such as manually dispatched workflows
 */
export function findRootSteps(def: WorkflowDefinition): Step[] {
  const edges = def.edges ?? [];
  const targets = new Set(edges.map((e) => e.target));

  return (def.steps ?? []).filter((s) => !targets.has(s.id));
}

export function findNextSteps(
  def: WorkflowDefinition,
  currentStepId: string,
  sourceHandle?: string,
): Step[] {
  const edges = def.edges ?? [];
  const outgoingEdges = edges.filter((e) => {
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
  stepNameToId?: Record<string, string>,
): ExecutionContext {
  return {
    workflowId,
    runId,
    organizationId,
    triggerData,
    variables: {},
    stepResults: {},
    stepNameToId: stepNameToId || {},
  };
}

export async function executeStep(
  def: WorkflowDefinition,
  step: Step,
  ctx: ExecutionContext,
): Promise<{ nextSteps: Step[]; result: unknown }> {
  const span = startStepSpan(step.id, step.type, step.name);

  try {
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
      .with({ type: "subworkflow" }, (s) => executeSubworkflow(s, ctx))
      .with({ type: "wait" }, (s) => executeWait(s, ctx))
      .with({ type: "event" }, (s) => executeEvent(s, ctx))
      .with({ type: "aggregate" }, (s) => executeAggregate(s, ctx))
      .with({ type: "cache" }, (s) => executeCache(s, ctx))
      .with({ type: "merge" }, (s) => executeMerge(s, ctx))
      .with({ type: "split" }, (s) => executeSplit(s, ctx))
      .with({ type: "filter" }, (s) => executeFilter(s, ctx))
      .with({ type: "set" }, (s) => executeSet(s, ctx))
      .with({ type: "error" }, (s) => executeError(s, ctx))
      .with({ type: "retry" }, (s) => executeRetry(s, ctx))
      .with({ type: "timeout" }, (s) => executeTimeout(s, ctx))
      .with({ type: "email" }, (s) => executeEmail(s, ctx))
      .with({ type: "webhookResponse" }, (s) => executeWebhookResponse(s, ctx))
      .with({ type: "file" }, (s) => executeFile(s, ctx))
      .with({ type: "queue" }, (s) => executeQueue(s, ctx))
      .with({ type: "embedding" }, (s) => executeEmbedding(s, ctx))
      .with({ type: "vectorSearch" }, (s) => executeVectorSearch(s, ctx))
      .with({ type: "log" }, (s) => executeLog(s, ctx))
      .with({ type: "assert" }, (s) => executeAssert(s, ctx))
      .with({ type: "sleep" }, (s) => executeSleep(s, ctx))
      // Additional core nodes - Data Transformation
      .with({ type: "map" }, (s) => executeMap(s, ctx))
      .with({ type: "reduce" }, (s) => executeReduce(s, ctx))
      .with({ type: "sort" }, (s) => executeSort(s, ctx))
      .with({ type: "unique" }, (s) => executeUnique(s, ctx))
      .with({ type: "template" }, (s) => executeTemplate(s, ctx))
      // Additional core nodes - AI/ML
      .with({ type: "prompt" }, (s) => executePrompt(s, ctx))
      .with({ type: "chat" }, (s) => executeChat(s, ctx))
      .with({ type: "summarize" }, (s) => executeSummarize(s, ctx))
      .with({ type: "classify" }, (s) => executeClassify(s, ctx))
      // Additional core nodes - Human-in-the-Loop
      .with({ type: "approval" }, (s) => executeApproval(s, ctx))
      .with({ type: "input" }, (s) => executeInput(s, ctx))
      .with({ type: "notification" }, (s) => executeNotification(s, ctx))
      // Additional core nodes - Utility
      .with({ type: "parse" }, (s) => executeParse(s, ctx))
      .with({ type: "validate" }, (s) => executeValidate(s, ctx))
      .with({ type: "format" }, (s) => executeFormat(s, ctx))
      .with({ type: "hash" }, (s) => executeHash(s, ctx))
      // Advanced core nodes - Array Operations
      .with({ type: "group" }, (s) => executeGroup(s, ctx))
      .with({ type: "flatten" }, (s) => executeFlatten(s, ctx))
      .with({ type: "chunk" }, (s) => executeChunk(s, ctx))
      .with({ type: "zip" }, (s) => executeZip(s, ctx))
      // Advanced core nodes - Security
      .with({ type: "encrypt" }, (s) => executeEncrypt(s, ctx))
      .with({ type: "decrypt" }, (s) => executeDecrypt(s, ctx))
      .with({ type: "sign" }, (s) => executeSign(s, ctx))
      .with({ type: "jwt" }, (s) => executeJwt(s, ctx))
      // Advanced core nodes - AI Extensions
      .with({ type: "agent" }, (s) => executeAgent(s, ctx))
      .with({ type: "rag" }, (s) => executeRag(s, ctx))
      .with({ type: "vision" }, (s) => executeVision(s, ctx))
      .with({ type: "audio" }, (s) => executeAudio(s, ctx))
      // Integration steps
      .with({ type: "spreadsheet" }, (s) => executeSpreadsheet(s, ctx))
      .with({ type: "googleSheets" }, (s) => executeGoogleSheets(s, ctx))
      .with({ type: "modelRegistry" }, (s) => executeModelRegistry(s, ctx))
      .with({ type: "webhookVerify" }, (s) => executeWebhookVerify(s, ctx))
      .with({ type: "pdf" }, (s) => executePdf(s, ctx))
      .with({ type: "rateLimit" }, (s) => executeRateLimit(s, ctx))
      // Flow control
      .with({ type: "try_catch" }, (s) => executeTryCatch(s, ctx, def))
      .with({ type: "race" }, (s) => executeRace(s, ctx, def))
      // Documentation (skip during execution)
      .with({ type: "comment" }, () => ({ skipped: true, type: "comment" }))
      // State management
      .with({ type: "state_get" }, (s) => executeStateGet(s, ctx))
      .with({ type: "state_set" }, (s) => executeStateSet(s, ctx))
      .with({ type: "state_wait" }, (s) => executeStateWait(s, ctx))
      // Workflow primitives
      .with({ type: "stop" }, (s) => ({ stopped: true, ...s.stop }))
      .with({ type: "noop" }, () => ({ skipped: true, type: "noop" }))
      .with({ type: "debounce" }, (s) => executeDebounce(s, ctx))
      .with({ type: "diff" }, (s) => executeDiff(s, ctx))
      .with({ type: "change_detector" }, (s) => executeChangeDetector(s, ctx))
      .with({ type: "time_window" }, (s) => executeTimeWindow(s, ctx))
      .with({ type: "ai_transform" }, (s) => executeAiTransform(s, ctx))
      .with({ type: "ai_guardrails" }, (s) => executeAiGuardrails(s, ctx))
      .with({ type: "window" }, async (windowStep: WindowStep) => {
        const raw = ctx.variables.events ?? [];
        const events = Array.isArray(raw) ? raw : [raw];

        const mgr = new WindowStateManager(windowStep.window);

        for (const event of events) {
          mgr.add(event);
        }

        const frames = mgr.flush();

        return {
          windowType: windowStep.window.windowType,
          frames,
          events: frames.flatMap((f) => f.events),
          duration: windowStep.window.duration,
          groupBy: windowStep.window.groupBy,
        };
      })
      // Rivet AI agent graphs
      .with({ type: "rivet" }, (s) => executeRivet(s, ctx))
      // Distributed transactions
      .with({ type: "saga" }, (s) => executeSaga(s, ctx))
      // Cross-service event collection
      .with({ type: "collect" }, (s) => executeCollect(s, ctx))
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
      .with({ type: "loop" }, () => {
        // After loop completes, follow "done" handle
        // First try "done", then fall back to default (no handle)
        const doneSteps = findNextSteps(def, step.id, "done");
        return doneSteps.length > 0 ? "done" : undefined;
      })
      .with({ type: "parallel" }, () => {
        // After parallel completes, follow "done" handle
        const doneSteps = findNextSteps(def, step.id, "done");
        return doneSteps.length > 0 ? "done" : undefined;
      })
      .otherwise(() => undefined);

    const nextSteps = findNextSteps(def, step.id, sourceHandle);

    span.setAttribute("vortex.step.status", "completed");
    endSpan(span);

    return { nextSteps, result };
  } catch (err) {
    endSpan(span, err);
    throw err;
  }
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
      throw new IntegrationError("Unknown integration", {
        integrationId: action.integrationId,
      });
    }

    // Fetch credentials from database if organizationId is available
    let auth:
      | import("../connectors/types").DecryptedCredentialValue
      | undefined;
    if (ctx.organizationId) {
      auth = await getIntegrationCredentials(
        ctx.organizationId,
        action.integrationId,
      );
      if (auth) {
        logger.debug("Loaded credentials", {
          integrationId: action.integrationId,
          organizationId: ctx.organizationId,
          authType: auth.type,
        });
      } else {
        logger.debug("No credentials found", {
          integrationId: action.integrationId,
          organizationId: ctx.organizationId,
        });
      }
    } else {
      logger.debug("No organizationId in context, skipping credential lookup", {
        integrationId: action.integrationId,
      });
    }

    const callResult = await executeConnectorAction(
      connectorId,
      action.operation,
      resolvedInputs,
      pluginContext,
      auth,
    );

    if (!callResult.success) {
      throw new IntegrationError("Integration action failed", {
        integrationId: action.integrationId,
        operation: action.operation,
        error: callResult.error,
      });
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
        throw new ExecutionError("Action execution failed", {
          pluginId: action.pluginId,
          operation: action.operation,
          error: callResult.error,
        });
      }

      output = callResult.output || { success: true };
      durationMs = callResult.durationMs;
    } else {
      // WASM plugin
      const host = getPluginHost();
      const loadedPlugin = host.get(action.pluginId);

      if (!loadedPlugin) {
        throw new PluginError("Plugin not loaded", {
          pluginId: action.pluginId,
        });
      }

      const callResult = await loadedPlugin.call(
        action.operation,
        resolvedInputs,
        pluginContext,
      );

      if (!callResult.success) {
        throw new ExecutionError("Action execution failed", {
          pluginId: action.pluginId,
          operation: action.operation,
          error: callResult.error,
        });
      }

      output = callResult.output || { success: true };
      durationMs = callResult.durationMs;
    }
  } else {
    throw new ConfigError(
      "Action step is missing both integrationId and pluginId",
      { stepId: step.id, stepName: step.name },
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
  def: WorkflowDefinition,
): Promise<{ iterations: number; results: unknown[] }> {
  const { loop } = step;

  const results: unknown[] = [];
  let iterations = 0;
  const maxIterations = Math.min(loop.maxIterations ?? 1000, 10000);

  // Find body steps - steps connected from loop node via "body" or default handle
  const bodySteps = findNextSteps(def, step.id, "body");
  // If no "body" handle, try default connection (for simpler loop setups)
  const defaultBodySteps =
    bodySteps.length > 0 ? bodySteps : findNextSteps(def, step.id);

  // Helper to execute body steps for one iteration
  const executeBodyOnce = async (
    iterationIndex: number,
    item?: unknown,
  ): Promise<unknown> => {
    // Set loop variables
    ctx.variables[loop.indexVariable || "index"] = iterationIndex;
    if (item !== undefined) {
      ctx.variables[loop.itemVariable || "item"] = item;
    }
    // Also expose as loop.index and loop.item for convenience
    ctx.variables.loop = {
      index: iterationIndex,
      item,
      iteration: iterationIndex + 1,
    };

    // Execute body steps in sequence (BFS within body)
    const bodyResults: unknown[] = [];
    const bodyQueue = [...defaultBodySteps];
    const bodyVisited = new Set<string>();

    while (bodyQueue.length > 0) {
      const bodyStep = bodyQueue.shift()!;

      // Stop if we hit a step that's not part of the loop body
      // (detected by checking if it has "loop-exit" marker or is the loop step itself)
      if (bodyVisited.has(bodyStep.id) || bodyStep.id === step.id) {
        continue;
      }

      // Check if this step exits the loop (connected via "done" or "exit" handle from loop)
      const exitSteps = findNextSteps(def, step.id, "done");
      if (exitSteps.some((s) => s.id === bodyStep.id)) {
        continue; // Skip exit steps during body execution
      }

      bodyVisited.add(bodyStep.id);

      const { nextSteps, result } = await executeStepInternal(
        def,
        bodyStep,
        ctx,
      );
      bodyResults.push(result);

      // Only continue to next steps that are still within the loop body
      // Don't add steps that would exit the loop
      for (const nextStep of nextSteps) {
        if (!exitSteps.some((s) => s.id === nextStep.id)) {
          bodyQueue.push(nextStep);
        }
      }
    }

    return bodyResults;
  };

  switch (loop.type) {
    case "forEach": {
      const collection = resolveValue(
        loop.collection || "[]",
        ctx,
      ) as unknown[];
      if (Array.isArray(collection)) {
        for (let i = 0; i < collection.length && i < maxIterations; i++) {
          const iterationResult = await executeBodyOnce(i, collection[i]);
          const entry: Record<string, unknown> = {
            index: i,
            item: collection[i],
          };
          if (Array.isArray(iterationResult) && iterationResult.length > 0) {
            entry.result = iterationResult;
          }
          results.push(entry);
          iterations++;
        }
      }
      break;
    }
    case "times": {
      const count = loop.count ?? 0;
      for (let i = 0; i < count && i < maxIterations; i++) {
        const iterationResult = await executeBodyOnce(i);
        const entry: Record<string, unknown> = { index: i };
        if (Array.isArray(iterationResult) && iterationResult.length > 0) {
          entry.result = iterationResult;
        }
        results.push(entry);
        iterations++;
      }
      break;
    }
    case "while": {
      while (iterations < maxIterations) {
        const continueLoop = evaluateExpression(loop.condition || "false", ctx);
        if (!continueLoop) break;
        const iterationResult = await executeBodyOnce(iterations);
        const entry: Record<string, unknown> = { index: iterations };
        if (Array.isArray(iterationResult) && iterationResult.length > 0) {
          entry.result = iterationResult;
        }
        results.push(entry);
        iterations++;
      }
      break;
    }
  }

  // Clean up loop context variable
  delete ctx.variables.loop;

  return { iterations, results };
}

/**
 * Internal step execution without modifying stepResults (for nested execution)
 */
async function executeStepInternal(
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
    .with({ type: "subworkflow" }, (s) => executeSubworkflow(s, ctx))
    .with({ type: "wait" }, (s) => executeWait(s, ctx))
    .with({ type: "event" }, (s) => executeEvent(s, ctx))
    .with({ type: "aggregate" }, (s) => executeAggregate(s, ctx))
    .with({ type: "cache" }, (s) => executeCache(s, ctx))
    .with({ type: "merge" }, (s) => executeMerge(s, ctx))
    .with({ type: "split" }, (s) => executeSplit(s, ctx))
    .with({ type: "filter" }, (s) => executeFilter(s, ctx))
    .with({ type: "set" }, (s) => executeSet(s, ctx))
    .with({ type: "error" }, (s) => executeError(s, ctx))
    .with({ type: "retry" }, (s) => executeRetry(s, ctx))
    .with({ type: "timeout" }, (s) => executeTimeout(s, ctx))
    .with({ type: "email" }, (s) => executeEmail(s, ctx))
    .with({ type: "webhookResponse" }, (s) => executeWebhookResponse(s, ctx))
    .with({ type: "file" }, (s) => executeFile(s, ctx))
    .with({ type: "queue" }, (s) => executeQueue(s, ctx))
    .with({ type: "embedding" }, (s) => executeEmbedding(s, ctx))
    .with({ type: "vectorSearch" }, (s) => executeVectorSearch(s, ctx))
    .with({ type: "log" }, (s) => executeLog(s, ctx))
    .with({ type: "assert" }, (s) => executeAssert(s, ctx))
    .with({ type: "sleep" }, (s) => executeSleep(s, ctx))
    // Additional core nodes - Data Transformation
    .with({ type: "map" }, (s) => executeMap(s, ctx))
    .with({ type: "reduce" }, (s) => executeReduce(s, ctx))
    .with({ type: "sort" }, (s) => executeSort(s, ctx))
    .with({ type: "unique" }, (s) => executeUnique(s, ctx))
    .with({ type: "template" }, (s) => executeTemplate(s, ctx))
    // Additional core nodes - AI/ML
    .with({ type: "prompt" }, (s) => executePrompt(s, ctx))
    .with({ type: "chat" }, (s) => executeChat(s, ctx))
    .with({ type: "summarize" }, (s) => executeSummarize(s, ctx))
    .with({ type: "classify" }, (s) => executeClassify(s, ctx))
    // Additional core nodes - Human-in-the-Loop
    .with({ type: "approval" }, (s) => executeApproval(s, ctx))
    .with({ type: "input" }, (s) => executeInput(s, ctx))
    .with({ type: "notification" }, (s) => executeNotification(s, ctx))
    // Additional core nodes - Utility
    .with({ type: "parse" }, (s) => executeParse(s, ctx))
    .with({ type: "validate" }, (s) => executeValidate(s, ctx))
    .with({ type: "format" }, (s) => executeFormat(s, ctx))
    .with({ type: "hash" }, (s) => executeHash(s, ctx))
    // Advanced core nodes - Array Operations
    .with({ type: "group" }, (s) => executeGroup(s, ctx))
    .with({ type: "flatten" }, (s) => executeFlatten(s, ctx))
    .with({ type: "chunk" }, (s) => executeChunk(s, ctx))
    .with({ type: "zip" }, (s) => executeZip(s, ctx))
    // Advanced core nodes - Security
    .with({ type: "encrypt" }, (s) => executeEncrypt(s, ctx))
    .with({ type: "decrypt" }, (s) => executeDecrypt(s, ctx))
    .with({ type: "sign" }, (s) => executeSign(s, ctx))
    .with({ type: "jwt" }, (s) => executeJwt(s, ctx))
    // Advanced core nodes - AI Extensions
    .with({ type: "agent" }, (s) => executeAgent(s, ctx))
    .with({ type: "rag" }, (s) => executeRag(s, ctx))
    .with({ type: "vision" }, (s) => executeVision(s, ctx))
    .with({ type: "audio" }, (s) => executeAudio(s, ctx))
    // Integration steps
    .with({ type: "spreadsheet" }, (s) => executeSpreadsheet(s, ctx))
    .with({ type: "googleSheets" }, (s) => executeGoogleSheets(s, ctx))
    .with({ type: "modelRegistry" }, (s) => executeModelRegistry(s, ctx))
    .with({ type: "webhookVerify" }, (s) => executeWebhookVerify(s, ctx))
    .with({ type: "pdf" }, (s) => executePdf(s, ctx))
    .with({ type: "rateLimit" }, (s) => executeRateLimit(s, ctx))
    // Flow control
    .with({ type: "try_catch" }, (s) => executeTryCatch(s, ctx, def))
    .with({ type: "race" }, (s) => executeRace(s, ctx, def))
    // Documentation (skip during execution)
    .with({ type: "comment" }, () => ({ skipped: true, type: "comment" }))
    // State management
    .with({ type: "state_get" }, (s) => executeStateGet(s, ctx))
    .with({ type: "state_set" }, (s) => executeStateSet(s, ctx))
    .with({ type: "state_wait" }, (s) => executeStateWait(s, ctx))
    // Workflow primitives
    .with({ type: "stop" }, (s) => ({ stopped: true, ...s.stop }))
    .with({ type: "noop" }, () => ({ skipped: true, type: "noop" }))
    .with({ type: "debounce" }, (s) => executeDebounce(s, ctx))
    .with({ type: "diff" }, (s) => executeDiff(s, ctx))
    .with({ type: "change_detector" }, (s) => executeChangeDetector(s, ctx))
    .with({ type: "time_window" }, (s) => executeTimeWindow(s, ctx))
    .with({ type: "ai_transform" }, (s) => executeAiTransform(s, ctx))
    .with({ type: "ai_guardrails" }, (s) => executeAiGuardrails(s, ctx))
    .with({ type: "window" }, async (windowStep: WindowStep) => {
      const raw = ctx.variables.events ?? [];
      const events = Array.isArray(raw) ? raw : [raw];

      const mgr = new WindowStateManager(windowStep.window);

      for (const event of events) {
        mgr.add(event);
      }

      const frames = mgr.flush();

      return {
        windowType: windowStep.window.windowType,
        frames,
        events: frames.flatMap((f) => f.events),
        duration: windowStep.window.duration,
        groupBy: windowStep.window.groupBy,
      };
    })
    // Rivet AI agent graphs
    .with({ type: "rivet" }, (s) => executeRivet(s, ctx))
    // Distributed transactions
    .with({ type: "saga" }, (s) => executeSaga(s, ctx))
    // Cross-service event collection
    .with({ type: "collect" }, (s) => executeCollect(s, ctx))
    .exhaustive();

  // Store result
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
    .with({ type: "loop" }, () => {
      // After loop completes, follow "done" handle
      return "done";
    })
    .otherwise(() => undefined);

  const nextSteps = findNextSteps(def, step.id, sourceHandle);

  return { nextSteps, result };
}

async function executeParallel(
  step: ParallelStep,
  ctx: ExecutionContext,
  def: WorkflowDefinition,
): Promise<{ branches: number; results: unknown[] }> {
  const { parallel } = step;

  // Find branch steps - steps connected from parallel node via "branch_0", "branch_1", etc
  // or if branches array contains step IDs, use those directly
  const getBranchSteps = (branchIndex: number): Step[] => {
    // First try to find steps connected via branch handle
    const handleSteps = findNextSteps(def, step.id, `branch_${branchIndex}`);
    if (handleSteps.length > 0) {
      return handleSteps;
    }

    // Fall back to branches array if it contains step IDs
    if (parallel.branches[branchIndex]) {
      const branchStepIds = parallel.branches[branchIndex];
      if (Array.isArray(branchStepIds)) {
        return branchStepIds
          .map((id) => def.steps.find((s) => s.id === id))
          .filter((s): s is Step => s !== undefined);
      }
    }

    return [];
  };

  // Helper to execute a single branch with an isolated context clone
  const executeBranch = async (
    branchIndex: number,
  ): Promise<{ branch: number; results: unknown[] }> => {
    const branchSteps = getBranchSteps(branchIndex);
    const branchResults: unknown[] = [];

    // Deep-clone mutable context fields so parallel branches don't interfere
    const branchCtx: ExecutionContext = {
      ...ctx,
      variables: structuredClone(ctx.variables),
      stepResults: structuredClone(ctx.stepResults),
    };

    // Execute branch steps in sequence (BFS within branch)
    const branchQueue = [...branchSteps];
    const branchVisited = new Set<string>();

    // Find the "join" or "done" steps that exit the parallel
    const joinSteps = findNextSteps(def, step.id, "done");

    while (branchQueue.length > 0) {
      const branchStep = branchQueue.shift()!;

      if (branchVisited.has(branchStep.id) || branchStep.id === step.id) {
        continue;
      }

      // Skip join steps during branch execution
      if (joinSteps.some((s) => s.id === branchStep.id)) {
        continue;
      }

      branchVisited.add(branchStep.id);

      const { nextSteps, result } = await executeStepInternal(
        def,
        branchStep,
        branchCtx,
      );
      branchResults.push(result);

      // Continue to next steps within branch (but not join steps)
      for (const nextStep of nextSteps) {
        if (!joinSteps.some((s) => s.id === nextStep.id)) {
          branchQueue.push(nextStep);
        }
      }
    }

    return { branch: branchIndex, results: branchResults };
  };

  // Execute branches based on waitFor strategy
  const MAX_PARALLEL_BRANCHES = 50;

  const branchCount =
    parallel.branches.length ||
    // Count branch handles if branches array is empty
    def.edges.filter(
      (e) => e.source === step.id && e.sourceHandle?.startsWith("branch_"),
    ).length;

  const effectiveBranchCount = Math.min(branchCount, MAX_PARALLEL_BRANCHES);

  const branchPromises = Array.from({ length: effectiveBranchCount }, (_, i) =>
    executeBranch(i),
  );

  const waitFor = parallel.waitFor;
  let results: unknown[];

  if (waitFor === "any") {
    // Return as soon as one branch completes
    const first = await Promise.race(branchPromises);
    results = [first];
  } else if (typeof waitFor === "number") {
    // Wait for exactly N branches to complete, then resolve immediately
    results = await new Promise<unknown[]>((resolve, reject) => {
      const settled: unknown[] = [];
      let done = false;

      for (const promise of branchPromises) {
        promise
          .then((value) => {
            if (done) return;
            settled.push(value);
            if (settled.length >= waitFor) {
              done = true;
              resolve(settled);
            }
          })
          .catch((err) => {
            if (done) return;
            done = true;
            reject(err);
          });
      }

      // Edge case: waitFor is 0 or exceeds branch count
      if (waitFor <= 0) {
        done = true;
        resolve([]);
      }
    });
  } else {
    // Wait for all branches (default)
    results = await Promise.all(branchPromises);
  }

  return { branches: branchCount, results };
}

async function executeGate(
  step: GateStep,
  ctx: ExecutionContext,
): Promise<{ passed: boolean; gateType: string }> {
  const { gate } = step;

  // Create approval request via the gate builtin plugin
  const result = await executeBuiltinAction(
    "builtin:gate",
    "execute",
    {
      gateType: gate.type,
      title: gate.title,
      approvers: gate.approvers,
      signalName: gate.signalName,
      timeout: gate.timeout,
      timeoutAction: gate.timeoutAction,
    },
    {
      workflowId: ctx.workflowId,
      runId: ctx.runId,
      stepId: step.id,
      organizationId: ctx.organizationId,
      config: {},
      secrets: {},
    },
  );

  if (!result.success) {
    throw new Error(`Gate execution failed: ${result.error}`);
  }

  const output = result.output as {
    requestId: string;
    status: string;
    gateType: string;
  };

  // Check the request status (handles timeout auto-decisions)
  const checkResult = await executeBuiltinAction("builtin:gate", "check", {
    requestId: output.requestId,
  });

  if (!checkResult.success) {
    throw new Error(`Gate check failed: ${checkResult.error}`);
  }

  const checkOutput = checkResult.output as {
    status: string;
    passed: boolean;
  };

  return { passed: checkOutput.passed, gateType: gate.type };
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
      throw new PluginError("Plugin not loaded", { pluginId: plugin.pluginId });
    }

    callResult = await loadedPlugin.call(
      plugin.function,
      resolvedInputs,
      pluginContext,
    );
  }

  // Track usage immediately after execution (fire-and-forget, non-blocking)
  getPluginRegistry().incrementUsage(
    plugin.pluginId,
    ctx.organizationId ?? "",
    ctx.workflowId,
    ctx.runId,
    step.id,
    plugin.function,
    callResult.durationMs,
    callResult.success,
  );

  if (!callResult.success) {
    throw new PluginError("Plugin execution failed", {
      pluginId: plugin.pluginId,
      operation: plugin.function,
      error: callResult.error,
    });
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
 * Execute a Rivet AI agent graph step.
 * Loads the graph from the database (by graphId) or uses inline JSON,
 * then delegates to the builtin rivet plugin's execute action.
 */
const executeRivet = async (
  step: RivetStep,
  ctx: ExecutionContext,
): Promise<unknown> => {
  const { rivet } = step;

  let graphJson: unknown;

  if (rivet.graphId) {
    // Load graph from rivet_graph table
    const db = getDb();
    const rows = await db
      .select()
      .from(rivetGraphTable)
      .where(eq(rivetGraphTable.id, rivet.graphId))
      .limit(1);

    if (rows.length === 0) {
      throw new NotFoundError("Rivet graph not found", {
        graphId: rivet.graphId,
      });
    }

    graphJson = rows[0].graphJson;
  } else if (rivet.graphInline) {
    graphJson = rivet.graphInline;
  } else {
    throw new ConfigError("Rivet step requires either graphId or graphInline", {
      stepId: step.id,
    });
  }

  const resolvedInputs = rivet.inputs ? resolveInputs(rivet.inputs, ctx) : {};

  const pluginInputs: Record<string, unknown> = {
    graph:
      typeof graphJson === "string" ? graphJson : JSON.stringify(graphJson),
    inputs: resolvedInputs,
    ...(rivet.providerConfig && { providerConfig: rivet.providerConfig }),
  };

  const pluginContext = {
    workflowId: ctx.workflowId,
    runId: ctx.runId,
    stepId: step.id,
    config: {},
    secrets: {},
  };

  const callResult = await executeBuiltinAction(
    "builtin:rivet",
    "execute",
    pluginInputs,
    pluginContext,
  );

  if (!callResult.success) {
    throw new PluginError("Rivet graph execution failed", {
      pluginId: "builtin:rivet",
      operation: "execute",
      error: callResult.error,
    });
  }

  return {
    graphId: rivet.graphId,
    output: callResult.output,
    durationMs: callResult.durationMs,
  };
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
    throw new MCPError("MCP server not connected", { serverId: mcp.serverId });
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
    throw new MCPError("MCP tool execution failed", {
      serverId: mcp.serverId,
      tool: mcp.tool,
      error: callResult.error,
    });
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
      throw new MCPError("LLM MCP server not available", {
        serverId: llm.serverId,
      });
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

  if (!callResult?.success) {
    throw new ExecutionError("LLM execution failed", {
      serverId: llm.serverId,
      model: llm.model,
      error: callResult?.error || "No compatible tool found",
    });
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
 * Execute a Code step via either an isolated Bun Worker or an MCP sandbox server.
 *
 * When `sandbox` is `"worker"`, user code runs locally in a Bun Worker with
 * configurable timeout and memory limits. When `"mcp"` (the default), code is
 * sent to an external MCP code-sandbox server (e.g. node-code-sandbox-mcp).
 */
const executeCode = async (
  step: CodeStep,
  ctx: ExecutionContext,
): Promise<unknown> => {
  const { code } = step;
  const sandbox = code.sandbox ?? "mcp";

  // Resolve input mappings (shared by both paths)
  const inputData: Record<string, unknown> = {};
  if (code.inputs) {
    for (const [varName, expression] of Object.entries(code.inputs)) {
      inputData[varName] = resolveValue(expression, ctx);
    }
  }

  // --- Worker sandbox path ---
  if (sandbox === "worker") {
    const timeoutMs = code.timeout ?? 30_000;
    const memoryMb = code.memoryMb ?? 128;

    const { output, durationMs } = await runSandboxedCode({
      source: code.source,
      inputs: inputData,
      trigger: { data: ctx.triggerData },
      steps: ctx.stepResults,
      limits: { memoryMb, timeoutMs },
    });

    // Map outputs to context variables
    if (code.outputs) {
      for (const [outputKey, variableName] of Object.entries(code.outputs)) {
        ctx.variables[String(variableName)] = output[outputKey];
      }
    }

    return {
      sandbox: "worker",
      executedAt: new Date().toISOString(),
      durationMs,
      inputs: inputData,
      output,
    };
  }

  // --- WASM sandbox path ---
  if (sandbox === "wasm") {
    const timeoutMs = code.timeout ?? 30_000;
    const memoryMb = code.memoryMb ?? 128;

    const { output, durationMs } = await runExtismSandbox({
      source: code.source,
      inputs: inputData,
      limits: { memoryMb, timeoutMs },
    });

    // Map outputs to context variables
    if (code.outputs) {
      for (const [outputKey, variableName] of Object.entries(code.outputs)) {
        ctx.variables[String(variableName)] = output[outputKey];
      }
    }

    return {
      sandbox: "wasm",
      executedAt: new Date().toISOString(),
      durationMs,
      inputs: inputData,
      output,
    };
  }

  // --- MCP sandbox path (default) ---
  if (!code.serverId) {
    throw new ConfigError(
      'Code step with sandbox "mcp" requires a serverId',
      {},
    );
  }

  const mcpClient = getMCPClient();

  // Try to connect if not already connected
  if (!mcpClient.isConnected(code.serverId)) {
    const connected = await connectMCPServer(code.serverId);
    if (!connected) {
      throw new MCPError("Code sandbox MCP server not available", {
        serverId: code.serverId,
      });
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

  if (!callResult?.success) {
    throw new ExecutionError("Code execution failed", {
      serverId: code.serverId,
      error: callResult?.error || "No compatible tool found",
    });
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
      throw new MCPError("Database MCP server not available", {
        serverId: database.serverId,
      });
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

  if (!callResult?.success) {
    throw new ExecutionError("Database operation failed", {
      serverId: database.serverId,
      error: callResult?.error || "No compatible tool found",
    });
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

/**
 * Execute a Subworkflow step - triggers another workflow
 */
async function executeSubworkflow(
  step: SubworkflowStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { subworkflow } = step;
  const { workflowId, waitForCompletion = true, timeout } = subworkflow;

  // Resolve template variables in inputs
  const resolvedInputs = resolveInputs(
    subworkflow.inputs as Record<string, unknown>,
    ctx,
  );

  // Look up the target workflow by ID
  const db = getDb();
  const [targetWorkflow] = await db
    .select()
    .from(workflowTable)
    .where(eq(workflowTable.id, workflowId))
    .limit(1);

  if (!targetWorkflow) {
    throw new NotFoundError("Subworkflow not found", { workflowId });
  }

  if (!targetWorkflow.isActive) {
    throw new ConfigError("Subworkflow is disabled", { workflowId });
  }

  // Generate a unique run ID for the child workflow
  const childRunId = `run-${crypto.randomUUID()}`;

  // Create a workflow run record for tracking
  const dbRunId = await createWorkflowRun({
    workflowId,
    engineWorkflowId: "dsl-workflow",
    engineRunId: childRunId,
    input: resolvedInputs,
  });

  // Initialize Hatchet client and trigger the child workflow
  const hatchet = Hatchet.init();
  await hatchet.event.push("workflow:execute", {
    workflowId,
    runId: childRunId,
    organizationId: ctx.organizationId,
    triggerData: resolvedInputs,
    definition: targetWorkflow.definition,
    parentRunId: ctx.runId,
  });

  // If fire-and-forget mode, return immediately
  if (!waitForCompletion) {
    return {
      workflowId,
      runId: childRunId,
      dbRunId,
      triggered: true,
      waitForCompletion: false,
      status: "triggered",
    };
  }

  // Wait for child workflow to complete by polling the run status
  const startTime = Date.now();
  const timeoutMs = timeout || 5 * 60 * 1000; // Default 5 minutes
  const pollIntervalMs = 1000; // Poll every second

  while (Date.now() - startTime < timeoutMs) {
    const [runStatus] = await db
      .select()
      .from(workflowRunTable)
      .where(eq(workflowRunTable.id, dbRunId))
      .limit(1);

    if (!runStatus) {
      throw new NotFoundError("Workflow run record not found", {
        runId: dbRunId,
      });
    }

    if (runStatus.status === "completed") {
      // Map outputs to context variables if specified
      if (subworkflow.outputs && runStatus.output) {
        const output = runStatus.output as Record<string, unknown>;
        for (const [outputKey, variableName] of Object.entries(
          subworkflow.outputs,
        )) {
          ctx.variables[variableName] = output[outputKey];
        }
      }

      return {
        workflowId,
        runId: childRunId,
        dbRunId,
        status: "completed",
        output: runStatus.output,
      };
    }

    if (runStatus.status === "failed") {
      throw new ExecutionError("Subworkflow failed", {
        workflowId,
        error: runStatus.error || "Unknown error",
      });
    }

    if (runStatus.status === "cancelled") {
      throw new CancelledError("Subworkflow was cancelled", { workflowId });
    }

    // Wait before next poll
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  // Timeout reached
  throw new TimeoutError("Subworkflow timed out", { workflowId, timeoutMs });
}

/**
 * Execute a Wait step - pauses workflow execution
 */
async function executeWait(
  step: WaitStep,
  _ctx: ExecutionContext,
): Promise<unknown> {
  const { wait } = step;

  if (wait.resumeOn === "timeout" && wait.timeout) {
    const multipliers: Record<string, number> = {
      seconds: 1000,
      minutes: 60 * 1000,
      hours: 60 * 60 * 1000,
      days: 24 * 60 * 60 * 1000,
    };
    const ms =
      wait.timeout * (multipliers[wait.timeoutUnit || "minutes"] || 60000);
    const cappedMs = Math.min(ms, 60 * 60 * 1000); // Cap at 1 hour
    await new Promise((resolve) => setTimeout(resolve, cappedMs));
    return { status: "completed", waitedMs: cappedMs };
  }

  // For webhook/event, return waiting status (actual suspension handled by runtime)
  return {
    status: "waiting",
    resumeOn: wait.resumeOn,
    eventName: wait.eventName,
  };
}

/**
 * Execute an Event step - emits an event to the event bus
 */
async function executeEvent(
  step: EventStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { event } = step;

  if (!isInitialized()) {
    logger.warn("Event publisher not initialized, skipping emit", {
      eventName: event.eventName,
    });
    return { emitted: false };
  }

  if (!ctx.organizationId) {
    throw new ValidationError("organizationId is required to emit events");
  }

  const resolvedPayload = event.payload
    ? resolveInputs(event.payload, ctx)
    : {};

  const published = await publish({
    type: event.eventName,
    source: "vortex.workflow",
    data: resolvedPayload,
    organizationId: ctx.organizationId,
    correlationId: ctx.runId,
  });

  return {
    eventId: published?.id,
    eventName: event.eventName,
    payload: resolvedPayload,
    emittedAt: published?.timestamp,
  };
}

/**
 * Execute an Aggregate step - combines data from multiple sources
 */
async function executeAggregate(
  step: AggregateStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { aggregate } = step;

  // Resolve source from context
  const source = resolveExpression(aggregate.source, ctx);
  const items = Array.isArray(source) ? source : [source];

  let result: unknown;
  switch (aggregate.mode) {
    case "collect":
      result = items;
      break;
    case "merge":
      result = Object.assign(
        {},
        ...items.filter((item) => typeof item === "object" && item !== null),
      );
      break;
    case "concat":
      result = items.flat();
      break;
    case "sum":
      result = items.reduce((acc, item) => {
        const num = typeof item === "number" ? item : Number(item);
        return acc + (Number.isNaN(num) ? 0 : num);
      }, 0);
      break;
    case "first":
      result = items[0];
      break;
    case "last":
      result = items[items.length - 1];
      break;
    default:
      result = items;
  }

  // Store in output variable
  if (aggregate.outputVariable) {
    ctx.variables[aggregate.outputVariable] = result;
  }

  return { result, mode: aggregate.mode, itemCount: items.length };
}

/**
 * Execute a Cache step - get/set values in the cache
 */
async function executeCache(
  step: CacheStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { cache } = step;

  // Use the builtin cache plugin
  const result = await executeBuiltinAction(
    "builtin:cache",
    "execute",
    {
      operation: cache.operation,
      key: resolveExpression(cache.key, ctx),
      value: cache.value,
      ttl: cache.ttl,
    },
    {
      workflowId: ctx.workflowId,
      runId: ctx.runId,
      stepId: step.id,
      config: {},
      secrets: {},
    },
  );

  // Store in output variable if specified
  if (cache.outputVariable && result.success && result.output) {
    const output = result.output as Record<string, unknown>;
    ctx.variables[cache.outputVariable] = output.value;
  }

  return result.output;
}

/**
 * Execute a Merge step - combine data from multiple sources.
 */
async function executeMerge(
  step: MergeStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { merge } = step;
  const sources = merge.sources.map((s) => resolveValue(s, ctx));

  // Map merge mode to plugin action
  const actionMap: Record<string, string> = {
    object: "objects",
    array: "arrays",
    deep: "deep",
  };
  const action = actionMap[merge.mode] || "objects";

  const result = await executeBuiltinAction(
    "builtin:merge",
    action,
    {
      sources,
      conflictStrategy: merge.conflictStrategy,
    },
    {
      workflowId: ctx.workflowId,
      runId: ctx.runId,
      stepId: step.id,
      config: {},
      secrets: {},
    },
  );

  if (result.success && merge.outputVariable && result.output) {
    ctx.variables[merge.outputVariable] = (
      result.output as Record<string, unknown>
    ).result;
  }

  return result.output;
}

/**
 * Execute a Split step - split array into individual items or batches.
 */
async function executeSplit(
  step: SplitStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { split } = step;
  const source = resolveValue(split.source, ctx);

  const result = await executeBuiltinAction(
    "builtin:split",
    "array",
    {
      source,
      batchSize: split.batchSize,
      maxItems: split.maxItems,
    },
    {
      workflowId: ctx.workflowId,
      runId: ctx.runId,
      stepId: step.id,
      config: {},
      secrets: {},
    },
  );

  if (result.success && result.output) {
    const output = result.output as Record<string, unknown>;
    // Store split items in variables for downstream access
    ctx.variables[split.itemVariable || "item"] = output.result;
  }

  return result.output;
}

/**
 * Execute a Filter step - filter array based on expression.
 */
async function executeFilter(
  step: FilterStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { filter } = step;
  const source = resolveValue(filter.source, ctx);

  const result = await executeBuiltinAction(
    "builtin:filter",
    "array",
    {
      source,
      expression: filter.expression,
      itemVariable: filter.itemVariable,
    },
    {
      workflowId: ctx.workflowId,
      runId: ctx.runId,
      stepId: step.id,
      config: {},
      secrets: {},
    },
  );

  if (result.success && filter.outputVariable && result.output) {
    ctx.variables[filter.outputVariable] = (
      result.output as Record<string, unknown>
    ).result;
  }

  return result.output;
}

/**
 * Execute a Set step - set workflow variables.
 */
async function executeSet(
  step: SetStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { set } = step;

  // Resolve variable values
  const resolvedVariables: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(set.variables)) {
    resolvedVariables[key] = resolveValue(value, ctx);
  }

  const result = await executeBuiltinAction(
    "builtin:set",
    "variables",
    { variables: resolvedVariables },
    {
      workflowId: ctx.workflowId,
      runId: ctx.runId,
      stepId: step.id,
      config: {},
      secrets: {},
    },
  );

  // Apply variables to context
  if (result.success && result.output) {
    const output = result.output as Record<string, unknown>;
    const vars = output.variables as Record<string, unknown>;
    for (const [key, value] of Object.entries(vars)) {
      ctx.variables[key] = value;
    }
  }

  return result.output;
}

/**
 * Execute an Error step - throw a custom workflow error.
 */
async function executeError(
  step: ErrorStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { error } = step;

  const result = await executeBuiltinAction(
    "builtin:error",
    "throw",
    {
      errorType: resolveValue(error.errorType, ctx),
      message: resolveValue(error.message, ctx),
      data: error.data ? resolveInputs(error.data, ctx) : undefined,
      fatal: error.fatal,
    },
    {
      workflowId: ctx.workflowId,
      runId: ctx.runId,
      stepId: step.id,
      config: {},
      secrets: {},
    },
  );

  // Error plugin returns success: false to signal error
  if (!result.success) {
    const output = result.output as Record<string, unknown> | undefined;
    if (output?.fatal) {
      throw new ExecutionError("Fatal workflow error", { error: result.error });
    }
    throw new ExecutionError(result.error || "Workflow error");
  }

  return result.output;
}

/**
 * Execute a Retry step - configure retry behavior for a step.
 */
async function executeRetry(
  step: RetryStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { retry } = step;

  const result = await executeBuiltinAction(
    "builtin:retry",
    "execute",
    {
      maxAttempts: retry.maxAttempts,
      initialDelayMs: retry.initialDelayMs,
      backoff: retry.backoff,
      maxDelayMs: retry.maxDelayMs,
    },
    {
      workflowId: ctx.workflowId,
      runId: ctx.runId,
      stepId: step.id,
      config: {},
      secrets: {},
    },
  );

  return result.output;
}

/**
 * Execute a Timeout step - wrap operation with timeout handling.
 */
async function executeTimeout(
  step: TimeoutStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { timeout } = step;

  const result = await executeBuiltinAction(
    "builtin:timeout",
    "wrap",
    {
      durationMs: timeout.durationMs,
      onTimeout: timeout.onTimeout,
      fallbackValue: timeout.fallbackValue,
    },
    {
      workflowId: ctx.workflowId,
      runId: ctx.runId,
      stepId: step.id,
      config: {},
      secrets: {},
    },
  );

  return result.output;
}

/**
 * Execute an Email step - send an email.
 */
async function executeEmail(
  step: EmailStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { email } = step;

  const result = await executeBuiltinAction(
    "builtin:email",
    "send",
    {
      to: resolveValue(email.to, ctx),
      cc: email.cc ? resolveValue(email.cc, ctx) : undefined,
      bcc: email.bcc ? resolveValue(email.bcc, ctx) : undefined,
      from: email.from ? resolveValue(email.from, ctx) : undefined,
      subject: resolveValue(email.subject, ctx),
      body: resolveValue(email.body, ctx),
      contentType: email.contentType,
      attachments: email.attachments,
    },
    {
      workflowId: ctx.workflowId,
      runId: ctx.runId,
      stepId: step.id,
      config: {},
      secrets: {},
    },
  );

  if (!result.success) {
    throw new ExecutionError("Email send failed", { error: result.error });
  }

  return result.output;
}

/**
 * Execute a WebhookResponse step - return data to webhook caller.
 */
async function executeWebhookResponse(
  step: WebhookResponseStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { webhookResponse } = step;

  const result = await executeBuiltinAction(
    "builtin:webhookResponse",
    "respond",
    {
      statusCode: webhookResponse.statusCode,
      headers: webhookResponse.headers,
      body: resolveValue(webhookResponse.body, ctx),
      contentType: webhookResponse.contentType,
    },
    {
      workflowId: ctx.workflowId,
      runId: ctx.runId,
      stepId: step.id,
      config: {},
      secrets: {},
    },
  );

  return result.output;
}

/**
 * Execute a File step - file operations.
 */
async function executeFile(
  step: FileStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { file } = step;
  const path = String(resolveValue(file.path, ctx));

  const result = await executeBuiltinAction(
    "builtin:file",
    file.operation,
    {
      path,
      content: file.content ? resolveValue(file.content, ctx) : undefined,
      pattern: file.operation === "list" ? undefined : undefined,
    },
    {
      workflowId: ctx.workflowId,
      runId: ctx.runId,
      stepId: step.id,
      config: {},
      secrets: {},
    },
  );

  if (!result.success) {
    throw new ExecutionError("File operation failed", { error: result.error });
  }

  if (result.success && file.outputVariable && result.output) {
    const output = result.output as Record<string, unknown>;
    // For read, store content; for list, store files; for exists, store exists boolean
    if (file.operation === "read") {
      ctx.variables[file.outputVariable] = output.content;
    } else if (file.operation === "list") {
      ctx.variables[file.outputVariable] = output.files;
    } else if (file.operation === "exists") {
      ctx.variables[file.outputVariable] = output.exists;
    } else {
      ctx.variables[file.outputVariable] = output;
    }
  }

  return result.output;
}

/**
 * Execute a Queue step - message queue operations.
 */
async function executeQueue(
  step: QueueStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { queue } = step;

  const inputs: Record<string, unknown> = {
    queueName: resolveValue(queue.queueName, ctx),
  };

  if (queue.operation === "push") {
    inputs.message = resolveValue(queue.message, ctx);
    inputs.priority = queue.priority;
    inputs.delayMs = queue.delayMs;
  }

  const result = await executeBuiltinAction(
    "builtin:queue",
    queue.operation,
    inputs,
    {
      workflowId: ctx.workflowId,
      runId: ctx.runId,
      stepId: step.id,
      config: {},
      secrets: {},
    },
  );

  if (!result.success) {
    throw new ExecutionError("Queue operation failed", { error: result.error });
  }

  if (result.success && queue.outputVariable && result.output) {
    const output = result.output as Record<string, unknown>;
    ctx.variables[queue.outputVariable] = output.message;
  }

  return result.output;
}

/**
 * Execute an Embedding step - generate vector embeddings.
 */
async function executeEmbedding(
  step: EmbeddingStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { embedding } = step;

  const result = await executeBuiltinAction(
    "builtin:embedding",
    "generate",
    {
      input: resolveValue(embedding.input, ctx),
      model: embedding.model,
      dimensions: embedding.dimensions,
    },
    {
      workflowId: ctx.workflowId,
      runId: ctx.runId,
      stepId: step.id,
      config: {},
      secrets: {},
    },
  );

  if (!result.success) {
    throw new ExecutionError("Embedding generation failed", {
      error: result.error,
    });
  }

  if (result.success && embedding.outputVariable && result.output) {
    const output = result.output as Record<string, unknown>;
    ctx.variables[embedding.outputVariable] = output.embeddings;
  }

  return result.output;
}

/**
 * Execute a VectorSearch step - search vector database.
 */
async function executeVectorSearch(
  step: VectorSearchStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { vectorSearch } = step;

  // Resolve query vector (can be expression referencing embedding output)
  const queryVector = resolveValue(vectorSearch.queryVector, ctx);

  const result = await executeBuiltinAction(
    "builtin:vectorSearch",
    "search",
    {
      queryVector,
      indexName: vectorSearch.indexName,
      topK: vectorSearch.topK,
      minScore: vectorSearch.minScore,
      filter: vectorSearch.filter
        ? resolveInputs(vectorSearch.filter, ctx)
        : undefined,
      includeVectors: vectorSearch.includeVectors,
      includeMetadata: vectorSearch.includeMetadata,
    },
    {
      workflowId: ctx.workflowId,
      runId: ctx.runId,
      stepId: step.id,
      config: {},
      secrets: {},
    },
  );

  if (!result.success) {
    throw new ExecutionError("Vector search failed", { error: result.error });
  }

  if (result.success && vectorSearch.outputVariable && result.output) {
    const output = result.output as Record<string, unknown>;
    ctx.variables[vectorSearch.outputVariable] = output.results;
  }

  return result.output;
}

/**
 * Execute a Log step - write structured log entry.
 */
async function executeLog(
  step: LogStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { log } = step;

  const result = await executeBuiltinAction(
    "builtin:log",
    "write",
    {
      level: log.level,
      message: String(resolveValue(log.message, ctx)),
      data: log.data ? resolveInputs(log.data, ctx) : undefined,
      tags: log.tags,
    },
    {
      workflowId: ctx.workflowId,
      runId: ctx.runId,
      stepId: step.id,
      config: {},
      secrets: {},
    },
  );

  return result.output;
}

/**
 * Execute an Assert step - validate expression or equality.
 */
async function executeAssert(
  step: AssertStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { assert } = step;

  // Resolve the expression with context values
  const expression = String(resolveValue(assert.expression, ctx));

  const result = await executeBuiltinAction(
    "builtin:assert",
    "expression",
    {
      expression,
      message: assert.message,
      softFail: assert.softFail,
    },
    {
      workflowId: ctx.workflowId,
      runId: ctx.runId,
      stepId: step.id,
      config: {},
      secrets: {},
    },
  );

  if (!result.success && !assert.softFail) {
    throw new ValidationError("Assertion failed", { error: result.error });
  }

  if (result.success && assert.outputVariable && result.output) {
    const output = result.output as Record<string, unknown>;
    ctx.variables[assert.outputVariable] = output.passed;
  }

  return result.output;
}

/**
 * Execute a Sleep step - pause workflow execution.
 */
async function executeSleep(
  step: SleepStep,
  _ctx: ExecutionContext,
): Promise<unknown> {
  const { sleep } = step;

  const result = await executeBuiltinAction(
    "builtin:sleep",
    "wait",
    {
      duration: sleep.duration,
      unit: sleep.unit,
    },
    {
      workflowId: _ctx.workflowId,
      runId: _ctx.runId,
      stepId: step.id,
      config: {},
      secrets: {},
    },
  );

  return result.output;
}

/**
 * Resolve an expression string to its value from the execution context.
 */
function resolveExpression(expression: string, ctx: ExecutionContext): unknown {
  return resolveValue(expression, ctx);
}

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
    const resolved = getValueByPath(ctx, path);

    // Return empty string for undefined to preserve the field in JSON output
    if (resolved === undefined) {
      return "";
    }

    return resolved;
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
  // Handle bracket notation for step names: steps["Step Name"].output or steps['Step Name'].output
  // Convert to a normalized format for processing
  let normalizedPath = path;

  // Check for steps["..."] or steps['...'] pattern and resolve step name to step ID
  // Supports both single and double quotes for JSON compatibility
  const stepNameMatch = path.match(/^steps\[["']([^"']+)["']\](.*)$/);
  if (stepNameMatch) {
    const stepName = stepNameMatch[1];
    const remainder = stepNameMatch[2]; // e.g., ".output"

    // Look up step ID from step name (try exact match first, then case-insensitive)
    let stepId = ctx.stepNameToId[stepName];

    if (!stepId) {
      // Try case-insensitive match
      const lowerStepName = stepName.toLowerCase();
      for (const [name, id] of Object.entries(ctx.stepNameToId)) {
        if (name.toLowerCase() === lowerStepName) {
          stepId = id;
          break;
        }
      }
    }

    if (stepId) {
      normalizedPath = `steps.${stepId}${remainder}`;
    } else {
      // Step name not found in mapping - try using it as-is (maybe it's a step ID)
      normalizedPath = `steps.${stepName}${remainder}`;
    }
  }

  const parts = normalizedPath.split(".");
  const root = parts[0];

  // Build a context object with all accessible paths
  const accessibleContext: Record<string, unknown> = {
    trigger: ctx.triggerData,
    variables: ctx.variables,
    steps: {} as Record<string, unknown>,
    // Also expose stepResults directly for backwards compatibility
    stepResults: ctx.stepResults,
    // Expose environment variables for workflow input mappings
    env: process.env,
  };

  // Map step results to be accessible as steps.{stepId}.output
  // Keep the structure so that steps['id'].output works
  for (const [stepId, result] of Object.entries(ctx.stepResults)) {
    const stepResult = result as Record<string, unknown>;
    // Ensure there's an output property - if stepResult already has output, use it as-is
    // Otherwise wrap the result so .output works
    if (stepResult.output !== undefined) {
      (accessibleContext.steps as Record<string, unknown>)[stepId] = stepResult;
    } else {
      (accessibleContext.steps as Record<string, unknown>)[stepId] = {
        output: stepResult,
      };
    }
  }

  // Also map step results by step name for convenience
  for (const [stepName, stepId] of Object.entries(ctx.stepNameToId)) {
    const result = ctx.stepResults[stepId];
    if (result) {
      const stepResult = result as Record<string, unknown>;
      if (stepResult.output !== undefined) {
        (accessibleContext.steps as Record<string, unknown>)[stepName] =
          stepResult;
      } else {
        (accessibleContext.steps as Record<string, unknown>)[stepName] = {
          output: stepResult,
        };
      }
    }
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

// ============================================================================
// Integration Step Executors
// ============================================================================

/**
 * Execute a Spreadsheet step - read/write Excel and CSV files.
 */
async function executeSpreadsheet(
  step: SpreadsheetStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { spreadsheet } = step;

  const result = await executeBuiltinAction(
    "builtin:spreadsheet",
    spreadsheet.operation,
    {
      operation: spreadsheet.operation,
      path: resolveExpression(spreadsheet.path, ctx),
      format: spreadsheet.format,
      sheet: spreadsheet.sheet,
      startRow: spreadsheet.startRow,
      endRow: spreadsheet.endRow,
      columns: spreadsheet.columns,
      headers: spreadsheet.headers,
      data:
        spreadsheet.data !== undefined
          ? resolveValue(spreadsheet.data, ctx)
          : undefined,
      cell: spreadsheet.cell,
      value:
        spreadsheet.value !== undefined
          ? resolveValue(spreadsheet.value, ctx)
          : undefined,
      formula: spreadsheet.formula,
      filter: spreadsheet.filter,
      sortBy: spreadsheet.sortBy,
      sortDirection: spreadsheet.sortDirection,
      limit: spreadsheet.limit,
      offset: spreadsheet.offset,
    },
    buildPluginContext(step, ctx),
  );

  if (spreadsheet.outputVariable && result.success && result.output) {
    ctx.variables[spreadsheet.outputVariable] = result.output;
  }

  return result.output;
}

/**
 * Execute a Google Sheets step - read/write Google Sheets.
 */
async function executeGoogleSheets(
  step: GoogleSheetsStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { googleSheets } = step;

  // Map "delete" operation to "clear" since the plugin uses "clear"
  const pluginOperation =
    googleSheets.operation === "delete" ? "clear" : googleSheets.operation;

  const result = await executeBuiltinAction(
    "builtin:googleSheets",
    pluginOperation,
    {
      connectionId: googleSheets.connectionId,
      spreadsheetId: resolveExpression(googleSheets.spreadsheetId, ctx),
      sheet: googleSheets.sheet,
      range: googleSheets.range,
      data:
        googleSheets.data !== undefined
          ? resolveValue(googleSheets.data, ctx)
          : undefined,
      valueInputOption: googleSheets.valueInputOption,
      includeHeaders: googleSheets.includeHeaders,
      filter: googleSheets.filter,
      sortBy: googleSheets.sortBy,
    },
    buildPluginContext(step, ctx),
  );

  if (googleSheets.outputVariable && result.success && result.output) {
    ctx.variables[googleSheets.outputVariable] = result.output;
  }

  return result.output;
}

/**
 * Execute a Model Registry step - call AI models via BYOK.
 */
async function executeModelRegistry(
  step: ModelRegistryStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { modelRegistry } = step;

  // Map "generate" to "complete" since the plugin uses "complete"
  const pluginOperation =
    modelRegistry.operation === "generate"
      ? "complete"
      : modelRegistry.operation;

  const result = await executeBuiltinAction(
    "builtin:modelRegistry",
    pluginOperation,
    {
      provider: modelRegistry.provider,
      connectionId: modelRegistry.connectionId,
      apiKey: modelRegistry.apiKey,
      model: modelRegistry.model,
      messages: modelRegistry.messages,
      prompt: modelRegistry.prompt,
      input: modelRegistry.input,
      temperature: modelRegistry.temperature,
      maxTokens: modelRegistry.maxTokens,
      topP: modelRegistry.topP,
      stop: modelRegistry.stop,
      baseUrl: modelRegistry.baseUrl,
    },
    buildPluginContext(step, ctx),
  );

  if (modelRegistry.outputVariable && result.success && result.output) {
    ctx.variables[modelRegistry.outputVariable] = result.output;
  }

  return result.output;
}

/**
 * Execute a Webhook Verify step - verify webhook signatures.
 */
async function executeWebhookVerify(
  step: WebhookVerifyStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { webhookVerify } = step;

  const result = await executeBuiltinAction(
    "builtin:webhookVerify",
    "verify",
    {
      provider: webhookVerify.provider,
      payload: String(resolveExpression(webhookVerify.payload, ctx)),
      signature: String(resolveExpression(webhookVerify.signature, ctx)),
      secret: String(resolveExpression(webhookVerify.secret, ctx)),
      timestamp: webhookVerify.timestamp
        ? String(resolveExpression(webhookVerify.timestamp, ctx))
        : undefined,
      tolerance: webhookVerify.tolerance,
      algorithm: webhookVerify.algorithm,
    },
    buildPluginContext(step, ctx),
  );

  if (webhookVerify.outputVariable && result.success && result.output) {
    ctx.variables[webhookVerify.outputVariable] = result.output;
  }

  return result.output;
}

/**
 * Execute a PDF step - generate, parse, and manipulate PDFs.
 */
async function executePdf(
  step: PdfStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { pdf } = step;

  const resolvedInput =
    pdf.input !== undefined ? resolveValue(pdf.input, ctx) : undefined;

  // Build inputs based on the operation
  const inputs: Record<string, unknown> = {
    operation: pdf.operation,
  };

  // Map input to the appropriate field based on operation
  if (pdf.operation === "parse" || pdf.operation === "info") {
    inputs.path = resolvedInput;
  } else if (pdf.operation === "merge") {
    inputs.paths = Array.isArray(resolvedInput)
      ? resolvedInput
      : [resolvedInput];
    inputs.outputPath = resolvedInput;
  } else if (pdf.operation === "split") {
    inputs.path = resolvedInput;
    inputs.outputDir = resolvedInput;
    inputs.mode = "all";
    if (pdf.pageRanges) {
      inputs.mode = "ranges";
      inputs.ranges = pdf.pageRanges;
    }
  } else if (pdf.operation === "watermark") {
    inputs.path = resolvedInput;
    inputs.outputPath = resolvedInput;
    inputs.text = pdf.watermarkText ?? "";
    if (pdf.watermarkOptions) {
      Object.assign(inputs, pdf.watermarkOptions);
    }
  } else if (pdf.operation === "extractPages") {
    inputs.path = resolvedInput;
    inputs.outputPath = resolvedInput;
    if (pdf.pageRanges) {
      inputs.pages = pdf.pageRanges;
    }
  } else if (pdf.operation === "create") {
    inputs.path = resolvedInput ?? "";
    if (pdf.pages) {
      inputs.pages = pdf.pages;
    }
  }

  const result = await executeBuiltinAction(
    "builtin:pdf",
    pdf.operation,
    inputs,
    buildPluginContext(step, ctx),
  );

  if (pdf.outputVariable && result.success && result.output) {
    ctx.variables[pdf.outputVariable] = result.output;
  }

  return result.output;
}

/**
 * Execute a Rate Limit step - throttle and rate limit workflow steps.
 */
async function executeRateLimit(
  step: RateLimitStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { rateLimit } = step;

  const result = await executeBuiltinAction(
    "builtin:rateLimit",
    rateLimit.operation,
    {
      key: String(resolveExpression(rateLimit.key, ctx)),
      limit: rateLimit.limit,
      windowSeconds: rateLimit.windowSeconds,
      algorithm: rateLimit.algorithm,
      burstCapacity: rateLimit.burstCapacity,
      refillRate: rateLimit.refillRate,
      tokens: rateLimit.tokens,
      wait: rateLimit.wait,
      maxWaitMs: rateLimit.maxWaitMs,
      maxRetries: rateLimit.maxRetries,
    },
    buildPluginContext(step, ctx),
  );

  if (rateLimit.outputVariable && result.success && result.output) {
    ctx.variables[rateLimit.outputVariable] = result.output;
  }

  return result.output;
}

// ============================================================================
// Flow Control Step Executors (inline implementations)
// ============================================================================

/**
 * Execute a Debounce step - coalesce rapid-fire events into one execution.
 *
 * Uses the cache plugin to track event windows. On "first" strategy, only the
 * first event within the window is processed. On "last" strategy, the window
 * is always refreshed (last event wins).
 */
async function executeDebounce(
  step: DebounceStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { debounce } = step;
  const cacheKey = `debounce:${String(resolveExpression(debounce.key, ctx))}`;
  const ttlSeconds = Math.ceil(debounce.windowMs / 1000);

  if (debounce.strategy === "first") {
    // Check if key already exists - if so, this event is within the window and should be skipped
    const checkResult = await executeBuiltinAction(
      "builtin:cache",
      "execute",
      { operation: "get", key: cacheKey },
      buildPluginContext(step, ctx),
    );

    const checkOutput = checkResult.output as { hit: boolean } | undefined;
    if (checkOutput?.hit) {
      const output = { debounced: true, skipped: true };
      if (debounce.outputVariable) {
        ctx.variables[debounce.outputVariable] = output;
      }
      return output;
    }

    // Key does not exist - set it with TTL to mark the window as open
    await executeBuiltinAction(
      "builtin:cache",
      "execute",
      { operation: "set", key: cacheKey, value: true, ttl: ttlSeconds },
      buildPluginContext(step, ctx),
    );

    const output = { debounced: false };
    if (debounce.outputVariable) {
      ctx.variables[debounce.outputVariable] = output;
    }
    return output;
  }

  // strategy === "last": always refresh the window (last event wins)
  await executeBuiltinAction(
    "builtin:cache",
    "execute",
    { operation: "set", key: cacheKey, value: true, ttl: ttlSeconds },
    buildPluginContext(step, ctx),
  );

  const output = { debounced: false, refreshed: true };
  if (debounce.outputVariable) {
    ctx.variables[debounce.outputVariable] = output;
  }
  return output;
}

/**
 * Execute a Diff step - compute deep diff between two values.
 */
async function executeDiff(
  step: DiffStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { diff } = step;

  const left = resolveExpression(diff.left, ctx);
  const right = resolveExpression(diff.right, ctx);

  const added: unknown[] = [];
  const removed: unknown[] = [];
  const changed: Array<{ key: string; left: unknown; right: unknown }> = [];
  const unchanged: unknown[] = [];

  if (Array.isArray(left) && Array.isArray(right)) {
    if (diff.key) {
      // Compare arrays of objects by identity key
      const identityKey = diff.key;
      const leftMap = new Map<unknown, unknown>();
      const rightMap = new Map<unknown, unknown>();

      for (const item of left) {
        const k = (item as Record<string, unknown>)[identityKey];
        leftMap.set(k, item);
      }
      for (const item of right) {
        const k = (item as Record<string, unknown>)[identityKey];
        rightMap.set(k, item);
      }

      for (const [k, lv] of leftMap) {
        if (!rightMap.has(k)) {
          removed.push(lv);
        } else {
          const rv = rightMap.get(k);
          if (JSON.stringify(lv) !== JSON.stringify(rv)) {
            changed.push({ key: String(k), left: lv, right: rv });
          } else {
            unchanged.push(lv);
          }
        }
      }
      for (const [k, rv] of rightMap) {
        if (!leftMap.has(k)) {
          added.push(rv);
        }
      }
    } else {
      // Compare by index
      const maxLen = Math.max(left.length, right.length);
      for (let i = 0; i < maxLen; i++) {
        if (i >= left.length) {
          added.push(right[i]);
        } else if (i >= right.length) {
          removed.push(left[i]);
        } else if (JSON.stringify(left[i]) !== JSON.stringify(right[i])) {
          changed.push({ key: String(i), left: left[i], right: right[i] });
        } else {
          unchanged.push(left[i]);
        }
      }
    }
  } else if (
    left !== null &&
    right !== null &&
    typeof left === "object" &&
    typeof right === "object"
  ) {
    // Compare objects key-by-key
    const leftObj = left as Record<string, unknown>;
    const rightObj = right as Record<string, unknown>;
    const allKeys = new Set([
      ...Object.keys(leftObj),
      ...Object.keys(rightObj),
    ]);

    for (const k of allKeys) {
      const hasLeft = k in leftObj;
      const hasRight = k in rightObj;

      if (!hasLeft) {
        added.push({ key: k, value: rightObj[k] });
      } else if (!hasRight) {
        removed.push({ key: k, value: leftObj[k] });
      } else if (JSON.stringify(leftObj[k]) !== JSON.stringify(rightObj[k])) {
        changed.push({ key: k, left: leftObj[k], right: rightObj[k] });
      } else {
        unchanged.push({ key: k, value: leftObj[k] });
      }
    }
  } else {
    // Primitive comparison
    if (JSON.stringify(left) !== JSON.stringify(right)) {
      changed.push({ key: "value", left, right });
    } else {
      unchanged.push(left);
    }
  }

  const output = { added, removed, changed, unchanged };

  if (diff.outputVariable) {
    ctx.variables[diff.outputVariable] = output;
  }

  return output;
}

/**
 * Execute a Change Detector step - only continue if a value has changed.
 *
 * Uses cache to persist the previous value/hash across runs.
 */
async function executeChangeDetector(
  step: ChangeDetectorStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { changeDetector } = step;
  const currentValue = resolveExpression(changeDetector.value, ctx);
  const cacheKey = `change_detector:${String(resolveExpression(changeDetector.key, ctx))}`;

  // Read previous stored value
  const getResult = await executeBuiltinAction(
    "builtin:cache",
    "execute",
    { operation: "get", key: cacheKey },
    buildPluginContext(step, ctx),
  );

  const getOutput = getResult.output as
    | { hit: boolean; value: unknown }
    | undefined;
  const previousStored = getOutput?.hit ? getOutput.value : undefined;

  let hasChanged: boolean;
  let previousValue: unknown;

  if (changeDetector.strategy === "hash") {
    // SHA-256 hash comparison
    const encoder = new TextEncoder();
    const currentStr = JSON.stringify(currentValue);
    const hashBuffer = await crypto.subtle.digest(
      "SHA-256",
      encoder.encode(currentStr),
    );
    const currentHash = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    previousValue = previousStored;
    hasChanged = previousStored === undefined || previousStored !== currentHash;

    if (hasChanged) {
      await executeBuiltinAction(
        "builtin:cache",
        "execute",
        { operation: "set", key: cacheKey, value: currentHash },
        buildPluginContext(step, ctx),
      );
    }
  } else {
    // deep_equal strategy - JSON compare the actual value
    previousValue = previousStored;
    hasChanged =
      previousStored === undefined ||
      JSON.stringify(previousStored) !== JSON.stringify(currentValue);

    if (hasChanged) {
      await executeBuiltinAction(
        "builtin:cache",
        "execute",
        { operation: "set", key: cacheKey, value: currentValue },
        buildPluginContext(step, ctx),
      );
    }
  }

  const output = hasChanged
    ? { changed: true, previous: previousValue, current: currentValue }
    : { changed: false };

  if (changeDetector.outputVariable) {
    ctx.variables[changeDetector.outputVariable] = output;
  }

  return output;
}

/**
 * Execute a Time Window step - only proceed if current time is within a window.
 */
async function executeTimeWindow(
  step: TimeWindowStep,
  _ctx: ExecutionContext,
): Promise<unknown> {
  const { timeWindow } = step;

  const now = new Date();

  // Get current time components in the specified timezone
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timeWindow.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  });

  const parts = formatter.formatToParts(now);
  const hourPart = parts.find((p) => p.type === "hour");
  const minutePart = parts.find((p) => p.type === "minute");
  const weekdayPart = parts.find((p) => p.type === "weekday");

  const currentHour = Number.parseInt(hourPart?.value ?? "0", 10);
  const currentMinute = Number.parseInt(minutePart?.value ?? "0", 10);
  const currentMinutes = currentHour * 60 + currentMinute;

  // Parse start/end times as "HH:MM"
  const [startHour, startMinute] = timeWindow.startTime.split(":").map(Number);
  const [endHour, endMinute] = timeWindow.endTime.split(":").map(Number);
  const startMinutes = startHour * 60 + startMinute;
  const endMinutes = endHour * 60 + endMinute;

  let inTimeRange: boolean;
  if (startMinutes <= endMinutes) {
    inTimeRange = currentMinutes >= startMinutes && currentMinutes < endMinutes;
  } else {
    // Overnight window (e.g., 22:00 - 06:00)
    inTimeRange = currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }

  // Check day of week if specified
  let inDayRange = true;
  if (timeWindow.daysOfWeek && timeWindow.daysOfWeek.length > 0) {
    const weekdayMap: Record<string, number> = {
      Sun: 0,
      Mon: 1,
      Tue: 2,
      Wed: 3,
      Thu: 4,
      Fri: 5,
      Sat: 6,
    };
    const currentDay = weekdayMap[weekdayPart?.value ?? ""] ?? -1;
    inDayRange = timeWindow.daysOfWeek.includes(currentDay);
  }

  const inWindow = inTimeRange && inDayRange;

  const currentTime = now.toISOString();

  if (inWindow) {
    return { inWindow: true, currentTime };
  }

  if (timeWindow.onOutside === "fail") {
    throw new ExecutionError("Execution outside allowed time window", {
      currentTime,
      startTime: timeWindow.startTime,
      endTime: timeWindow.endTime,
      timezone: timeWindow.timezone,
    });
  }

  if (timeWindow.onOutside === "queue") {
    return { inWindow: false, queued: true, currentTime };
  }

  // onOutside === "skip"
  return { inWindow: false, skipped: true, currentTime };
}

/**
 * Execute an AI Transform step - transform data using an LLM with a prompt.
 */
async function executeAiTransform(
  step: AiTransformStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { aiTransform } = step;

  const inputRaw = resolveExpression(aiTransform.input, ctx);
  const inputStr =
    typeof inputRaw === "object" && inputRaw !== null
      ? JSON.stringify(inputRaw, null, 2)
      : String(inputRaw ?? "");

  let userPrompt = `${aiTransform.prompt}\n\nInput:\n${inputStr}`;

  if (aiTransform.schema) {
    userPrompt += `\n\nRespond with valid JSON matching this schema:\n${aiTransform.schema}`;
  }

  const mcpClient = getMCPClient();

  // Try to find a connected LLM server
  const toolArgs: Record<string, unknown> = {
    model: aiTransform.model,
    messages: [{ role: "user", content: userPrompt }],
  };

  const toolNames = ["chat_completion", "complete", "chat", "generate"];
  let callResult = null;

  // Try all registered servers for a compatible tool
  for (const toolName of toolNames) {
    callResult = await mcpClient.callTool(
      aiTransform.model,
      toolName,
      toolArgs,
    );
    if (callResult?.success) break;
  }

  let output: unknown;

  if (callResult?.success) {
    const textContent = callResult.content
      ?.filter((c: { type: string }) => c.type === "text")
      .map((c: { text?: string }) => c.text)
      .join("");

    try {
      const trimmed = textContent?.trim() ?? "";
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        output = JSON.parse(trimmed);
      } else {
        output = textContent;
      }
    } catch {
      output = textContent;
    }
  } else {
    // Fallback: return input unchanged with a note
    output = {
      transformed: inputRaw,
      note: "LLM unavailable - input returned unchanged",
    };
  }

  if (aiTransform.outputVariable) {
    ctx.variables[aiTransform.outputVariable] = output;
  }

  return output;
}

/**
 * Execute an AI Guardrails step - validate LLM output against safety rules.
 */
async function executeAiGuardrails(
  step: AiGuardrailsStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { aiGuardrails } = step;

  const inputRaw = resolveExpression(aiGuardrails.input, ctx);
  const inputStr = String(inputRaw ?? "");

  const violations: Array<{ type: string; value: string; message: string }> =
    [];

  for (const rule of aiGuardrails.rules) {
    switch (rule.type) {
      case "regex": {
        const re = new RegExp(rule.value);
        if (!re.test(inputStr)) {
          violations.push({
            type: "regex",
            value: rule.value,
            message: `Input does not match required pattern: ${rule.value}`,
          });
        }
        break;
      }
      case "contains": {
        if (!inputStr.includes(rule.value)) {
          violations.push({
            type: "contains",
            value: rule.value,
            message: `Input does not contain required string: "${rule.value}"`,
          });
        }
        break;
      }
      case "not_contains": {
        if (inputStr.includes(rule.value)) {
          violations.push({
            type: "not_contains",
            value: rule.value,
            message: `Input contains disallowed string: "${rule.value}"`,
          });
        }
        break;
      }
      case "max_length": {
        const maxLen = Number.parseInt(rule.value, 10);
        if (inputStr.length > maxLen) {
          violations.push({
            type: "max_length",
            value: rule.value,
            message: `Input length ${inputStr.length} exceeds maximum ${maxLen}`,
          });
        }
        break;
      }
      case "json_schema": {
        try {
          const parsed = JSON.parse(inputStr);
          const schema = JSON.parse(rule.value) as Record<string, unknown>;
          // Basic JSON schema validation (type check only)
          if (schema.type) {
            const actualType = Array.isArray(parsed) ? "array" : typeof parsed;
            if (actualType !== schema.type) {
              violations.push({
                type: "json_schema",
                value: rule.value,
                message: `Input type "${actualType}" does not match schema type "${schema.type}"`,
              });
            }
          }
        } catch {
          violations.push({
            type: "json_schema",
            value: rule.value,
            message: "Input is not valid JSON",
          });
        }
        break;
      }
    }
  }

  let output: unknown;

  if (violations.length > 0) {
    if (aiGuardrails.onFail === "block") {
      throw new ValidationError("AI guardrail violations detected", {
        violations,
        input: inputStr,
      });
    }

    if (aiGuardrails.onFail === "sanitize") {
      let sanitized = inputStr;
      for (const v of violations) {
        if (v.type === "regex" || v.type === "contains") {
          try {
            const re = new RegExp(v.value, "g");
            sanitized = sanitized.replace(re, "");
          } catch {
            sanitized = sanitized.split(v.value).join("");
          }
        } else if (v.type === "not_contains") {
          sanitized = sanitized.split(v.value).join("");
        }
      }
      output = { passed: false, violations, output: sanitized };
    } else {
      // onFail === "warn"
      output = { passed: false, violations, output: inputStr };
    }
  } else {
    output = { passed: true, output: inputStr };
  }

  if (aiGuardrails.outputVariable) {
    ctx.variables[aiGuardrails.outputVariable] = output;
  }

  return output;
}

/**
 * Build plugin context from step and execution context.
 */
function buildPluginContext(
  step: Step,
  ctx: ExecutionContext,
): {
  workflowId: string;
  runId: string;
  stepId: string;
  config: Record<string, unknown>;
  secrets: Record<string, unknown>;
} {
  return {
    workflowId: ctx.workflowId,
    runId: ctx.runId,
    stepId: step.id,
    config: {},
    secrets: {},
  };
}

// ============================================================================
// Additional Core Nodes - Data Transformation
// ============================================================================

/**
 * Execute a Map step - transform each item in an array.
 */
async function executeMap(
  step: MapStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { map } = step;
  const source = resolveValue(map.source, ctx);

  const result = await executeBuiltinAction(
    "builtin:map",
    "transform",
    {
      source,
      expression: map.expression,
      itemVariable: map.itemVariable,
      indexVariable: map.indexVariable,
    },
    buildPluginContext(step, ctx),
  );

  if (result.success && map.outputVariable && result.output) {
    ctx.variables[map.outputVariable] = (
      result.output as Record<string, unknown>
    ).result;
  }

  return result.output;
}

/**
 * Execute a Reduce step - aggregate array items into a single value.
 */
async function executeReduce(
  step: ReduceStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { reduce } = step;
  const source = resolveValue(reduce.source, ctx);

  const result = await executeBuiltinAction(
    "builtin:reduce",
    "aggregate",
    {
      source,
      expression: reduce.expression,
      initialValue: reduce.initialValue,
      accumulatorVariable: reduce.accumulatorVariable,
      itemVariable: reduce.itemVariable,
    },
    buildPluginContext(step, ctx),
  );

  if (result.success && reduce.outputVariable && result.output) {
    ctx.variables[reduce.outputVariable] = (
      result.output as Record<string, unknown>
    ).result;
  }

  return result.output;
}

/**
 * Execute a Sort step - sort array items.
 */
async function executeSort(
  step: SortStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { sort } = step;
  const source = resolveValue(sort.source, ctx);

  const result = await executeBuiltinAction(
    "builtin:sort",
    "array",
    {
      source,
      key: sort.key,
      direction: sort.direction,
    },
    buildPluginContext(step, ctx),
  );

  if (result.success && sort.outputVariable && result.output) {
    ctx.variables[sort.outputVariable] = (
      result.output as Record<string, unknown>
    ).result;
  }

  return result.output;
}

/**
 * Execute a Unique step - remove duplicate items from array.
 */
async function executeUnique(
  step: UniqueStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { unique } = step;
  const source = resolveValue(unique.source, ctx);

  const result = await executeBuiltinAction(
    "builtin:unique",
    "array",
    {
      source,
      key: unique.key,
    },
    buildPluginContext(step, ctx),
  );

  if (result.success && unique.outputVariable && result.output) {
    ctx.variables[unique.outputVariable] = (
      result.output as Record<string, unknown>
    ).result;
  }

  return result.output;
}

/**
 * Execute a Template step - render text template with variables.
 */
async function executeTemplate(
  step: TemplateStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { template } = step;

  const variables = Object.assign({}, ctx.variables, template.variables || {});

  const result = await executeBuiltinAction(
    "builtin:template",
    "render",
    {
      content: template.content,
      variables,
    },
    buildPluginContext(step, ctx),
  );

  if (result.success && template.outputVariable && result.output) {
    ctx.variables[template.outputVariable] = (
      result.output as Record<string, unknown>
    ).result;
  }

  return result.output;
}

// ============================================================================
// Additional Core Nodes - AI/ML
// ============================================================================

/**
 * Execute a Prompt step - execute a prompt template with an AI model.
 */
async function executePrompt(
  step: PromptStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { prompt } = step;

  const variables = Object.assign({}, ctx.variables, prompt.variables || {});

  const result = await executeBuiltinAction(
    "builtin:prompt",
    "execute",
    {
      serverId: prompt.serverId,
      model: prompt.model,
      template: prompt.template,
      variables,
      temperature: prompt.temperature,
      maxTokens: prompt.maxTokens,
    },
    buildPluginContext(step, ctx),
  );

  if (result.success && prompt.outputVariable && result.output) {
    ctx.variables[prompt.outputVariable] = (
      result.output as Record<string, unknown>
    ).response;
  }

  return result.output;
}

/**
 * Execute a Chat step - multi-turn conversation with AI model.
 */
async function executeChat(
  step: ChatStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { chat } = step;

  let messages = chat.messages || [];
  if (chat.historyVariable && ctx.variables[chat.historyVariable]) {
    const history = ctx.variables[chat.historyVariable];
    if (Array.isArray(history)) {
      messages = [...history, ...messages];
    }
  }

  const result = await executeBuiltinAction(
    "builtin:chat",
    "send",
    {
      serverId: chat.serverId,
      model: chat.model,
      messages,
      temperature: chat.temperature,
      maxTokens: chat.maxTokens,
    },
    buildPluginContext(step, ctx),
  );

  if (result.success && chat.outputVariable && result.output) {
    ctx.variables[chat.outputVariable] = (
      result.output as Record<string, unknown>
    ).response;
  }

  return result.output;
}

/**
 * Execute a Summarize step - summarize text using AI.
 */
async function executeSummarize(
  step: SummarizeStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { summarize } = step;
  const input = resolveValue(summarize.input, ctx);

  const result = await executeBuiltinAction(
    "builtin:summarize",
    "text",
    {
      serverId: summarize.serverId,
      model: summarize.model,
      input: String(input),
      maxLength: summarize.maxLength,
      style: summarize.style,
    },
    buildPluginContext(step, ctx),
  );

  if (result.success && summarize.outputVariable && result.output) {
    ctx.variables[summarize.outputVariable] = (
      result.output as Record<string, unknown>
    ).summary;
  }

  return result.output;
}

/**
 * Execute a Classify step - classify text into categories using AI.
 */
async function executeClassify(
  step: ClassifyStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { classify } = step;
  const input = resolveValue(classify.input, ctx);

  const result = await executeBuiltinAction(
    "builtin:classify",
    "text",
    {
      serverId: classify.serverId,
      model: classify.model,
      input: String(input),
      categories: classify.categories,
      multiLabel: classify.multiLabel,
    },
    buildPluginContext(step, ctx),
  );

  if (result.success && classify.outputVariable && result.output) {
    ctx.variables[classify.outputVariable] = (
      result.output as Record<string, unknown>
    ).categories;
  }

  return result.output;
}

// ============================================================================
// Additional Core Nodes - Human-in-the-Loop
// ============================================================================

/**
 * Execute an Approval step - request human approval.
 */
async function executeApproval(
  step: ApprovalStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { approval } = step;

  const result = await executeBuiltinAction(
    "builtin:approval",
    "request",
    {
      title: approval.title,
      message: approval.message,
      approvers: approval.approvers,
      timeout: approval.timeout,
      timeoutAction: approval.timeoutAction,
    },
    buildPluginContext(step, ctx),
  );

  if (result.success && approval.outputVariable && result.output) {
    ctx.variables[approval.outputVariable] = result.output;
  }

  return result.output;
}

/**
 * Execute an Input step - request human input.
 */
async function executeInput(
  step: InputStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { input } = step;

  const result = await executeBuiltinAction(
    "builtin:input",
    "request",
    {
      title: input.title,
      message: input.message,
      fields: input.fields,
      assignees: input.assignees,
      timeout: input.timeout,
    },
    buildPluginContext(step, ctx),
  );

  if (result.success && input.outputVariable && result.output) {
    ctx.variables[input.outputVariable] = result.output;
  }

  return result.output;
}

/**
 * Execute a Notification step - send notification to users.
 */
async function executeNotification(
  step: NotificationStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { notification } = step;

  const result = await executeBuiltinAction(
    "builtin:notification",
    "send",
    {
      channel: notification.channel,
      recipients: notification.recipients,
      title: notification.title,
      message: notification.message,
      priority: notification.priority,
      data: notification.data,
    },
    buildPluginContext(step, ctx),
  );

  return result.output;
}

// ============================================================================
// Additional Core Nodes - Utility
// ============================================================================

/**
 * Execute a Parse step - parse data from various formats.
 */
async function executeParse(
  step: ParseStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { parse } = step;
  const input = resolveValue(parse.input, ctx);

  const result = await executeBuiltinAction(
    "builtin:parse",
    "data",
    {
      input: String(input),
      format: parse.format,
      options: parse.options,
    },
    buildPluginContext(step, ctx),
  );

  if (result.success && parse.outputVariable && result.output) {
    ctx.variables[parse.outputVariable] = (
      result.output as Record<string, unknown>
    ).result;
  }

  return result.output;
}

/**
 * Execute a Validate step - validate data against schema.
 */
async function executeValidate(
  step: ValidateStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { validate } = step;
  const input = resolveValue(validate.input, ctx);

  const result = await executeBuiltinAction(
    "builtin:validate",
    "schema",
    {
      input,
      schema: validate.schema,
      strict: validate.strict,
    },
    buildPluginContext(step, ctx),
  );

  if (result.success && validate.outputVariable && result.output) {
    ctx.variables[validate.outputVariable] = result.output;
  }

  if (!result.success) {
    throw new ValidationError(result.error || "Validation failed");
  }

  const output = result.output as Record<string, unknown>;
  if (!output.valid) {
    throw new ValidationError("Validation failed", { errors: output.errors });
  }

  return result.output;
}

/**
 * Execute a Format step - format data to various output formats.
 */
async function executeFormat(
  step: FormatStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { format } = step;
  const input = resolveValue(format.input, ctx);

  const result = await executeBuiltinAction(
    "builtin:format",
    "data",
    {
      input,
      type: format.type,
      options: format.options,
    },
    buildPluginContext(step, ctx),
  );

  if (result.success && format.outputVariable && result.output) {
    ctx.variables[format.outputVariable] = (
      result.output as Record<string, unknown>
    ).result;
  }

  return result.output;
}

/**
 * Execute a Hash step - compute hash of input data.
 */
async function executeHash(
  step: HashStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { hash } = step;
  const input = resolveValue(hash.input, ctx);

  const result = await executeBuiltinAction(
    "builtin:hash",
    "compute",
    {
      input: String(input),
      algorithm: hash.algorithm,
      encoding: hash.encoding,
    },
    buildPluginContext(step, ctx),
  );

  if (result.success && hash.outputVariable && result.output) {
    ctx.variables[hash.outputVariable] = (
      result.output as Record<string, unknown>
    ).hash;
  }

  return result.output;
}

// Array Operations handlers

/**
 * Execute a Group step - group array items by key expression.
 */
async function executeGroup(
  step: GroupStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { group } = step;
  const source = resolveValue(group.source, ctx);

  const result = await executeBuiltinAction(
    "builtin:group",
    "array",
    {
      source,
      keyExpression: group.keyExpression,
      itemVariable: group.itemVariable,
    },
    buildPluginContext(step, ctx),
  );

  if (result.success && group.outputVariable && result.output) {
    ctx.variables[group.outputVariable] = (
      result.output as Record<string, unknown>
    ).result;
  }

  return result.output;
}

/**
 * Execute a Flatten step - flatten nested arrays.
 */
async function executeFlatten(
  step: FlattenStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { flatten } = step;
  const source = resolveValue(flatten.source, ctx);

  const result = await executeBuiltinAction(
    "builtin:flatten",
    "array",
    {
      source,
      depth: flatten.depth,
    },
    buildPluginContext(step, ctx),
  );

  if (result.success && flatten.outputVariable && result.output) {
    ctx.variables[flatten.outputVariable] = (
      result.output as Record<string, unknown>
    ).result;
  }

  return result.output;
}

/**
 * Execute a Chunk step - split array into chunks of specified size.
 */
async function executeChunk(
  step: ChunkStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { chunk } = step;
  const source = resolveValue(chunk.source, ctx);

  const result = await executeBuiltinAction(
    "builtin:chunk",
    "array",
    {
      source,
      size: chunk.size,
    },
    buildPluginContext(step, ctx),
  );

  if (result.success && chunk.outputVariable && result.output) {
    ctx.variables[chunk.outputVariable] = (
      result.output as Record<string, unknown>
    ).result;
  }

  return result.output;
}

/**
 * Execute a Zip step - combine multiple arrays element-wise.
 */
async function executeZip(
  step: ZipStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { zip } = step;
  const sources = zip.sources.map((s) => resolveValue(s, ctx));

  const result = await executeBuiltinAction(
    "builtin:zip",
    "arrays",
    { sources },
    buildPluginContext(step, ctx),
  );

  if (result.success && zip.outputVariable && result.output) {
    ctx.variables[zip.outputVariable] = (
      result.output as Record<string, unknown>
    ).result;
  }

  return result.output;
}

// Security handlers

/**
 * Execute an Encrypt step - encrypt data with specified algorithm.
 */
async function executeEncrypt(
  step: EncryptStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { encrypt } = step;
  const input = resolveValue(encrypt.input, ctx);

  const result = await executeBuiltinAction(
    "builtin:encrypt",
    "data",
    {
      input: String(input),
      key: encrypt.key,
      algorithm: encrypt.algorithm,
    },
    buildPluginContext(step, ctx),
  );

  if (result.success && encrypt.outputVariable && result.output) {
    ctx.variables[encrypt.outputVariable] = (
      result.output as Record<string, unknown>
    ).result;
  }

  return result.output;
}

/**
 * Execute a Decrypt step - decrypt data with specified algorithm.
 */
async function executeDecrypt(
  step: DecryptStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { decrypt } = step;
  const input = resolveValue(decrypt.input, ctx);

  const result = await executeBuiltinAction(
    "builtin:decrypt",
    "data",
    {
      input: String(input),
      key: decrypt.key,
      algorithm: decrypt.algorithm,
    },
    buildPluginContext(step, ctx),
  );

  if (result.success && decrypt.outputVariable && result.output) {
    ctx.variables[decrypt.outputVariable] = (
      result.output as Record<string, unknown>
    ).result;
  }

  return result.output;
}

/**
 * Execute a Sign step - sign data with specified algorithm.
 */
async function executeSign(
  step: SignStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { sign } = step;
  const input = resolveValue(sign.input, ctx);

  const result = await executeBuiltinAction(
    "builtin:sign",
    "data",
    {
      input: String(input),
      key: sign.key,
      algorithm: sign.algorithm,
      encoding: sign.encoding,
    },
    buildPluginContext(step, ctx),
  );

  if (result.success && sign.outputVariable && result.output) {
    ctx.variables[sign.outputVariable] = (
      result.output as Record<string, unknown>
    ).signature;
  }

  return result.output;
}

/**
 * Execute a JWT step - create or verify JWT tokens.
 */
async function executeJwt(
  step: JwtStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { jwt } = step;
  const input = resolveValue(jwt.input, ctx);

  const result = await executeBuiltinAction(
    "builtin:jwt",
    "token",
    {
      operation: jwt.operation,
      input: String(input),
      secret: jwt.secret,
      algorithm: jwt.algorithm,
      expiresIn: jwt.expiresIn,
    },
    buildPluginContext(step, ctx),
  );

  if (result.success && jwt.outputVariable && result.output) {
    ctx.variables[jwt.outputVariable] = result.output;
  }

  return result.output;
}

// AI Extensions handlers

/**
 * Execute an Agent step - run an AI agent with tools.
 */
async function executeAgent(
  step: AgentStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { agent } = step;

  const pluginCtx = {
    ...buildPluginContext(step, ctx),
    organizationId: ctx.organizationId,
    ...(agent.streamEvents && ctx.runId && ctx.organizationId
      ? {
          emit: async (type: string, data: unknown) => {
            await stateStore.publish(
              ctx.organizationId!,
              `run:${ctx.runId}:events`,
              { type, data, timestamp: new Date().toISOString() },
            );
          },
        }
      : {}),
  };

  const result = await executeBuiltinAction(
    "builtin:agent",
    "execute",
    {
      serverId: agent.serverId,
      model: agent.model,
      goal: agent.goal,
      tools: agent.tools,
      maxIterations: agent.maxIterations,
      conversationId: agent.conversationId,
      memoryTtl: agent.memoryTtl,
      streamEvents: agent.streamEvents,
    },
    pluginCtx,
  );

  if (result.success && agent.outputVariable && result.output) {
    ctx.variables[agent.outputVariable] = (
      result.output as Record<string, unknown>
    ).result;
  }

  return result.output;
}

/**
 * Execute a RAG step - retrieval-augmented generation.
 */
async function executeRag(
  step: RagStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { rag } = step;

  const result = await executeBuiltinAction(
    "builtin:rag",
    "query",
    {
      serverId: rag.serverId,
      model: rag.model,
      query: rag.query,
      collection: rag.collection,
      topK: rag.topK,
      promptTemplate: rag.promptTemplate,
    },
    buildPluginContext(step, ctx),
  );

  if (result.success && rag.outputVariable && result.output) {
    ctx.variables[rag.outputVariable] = (
      result.output as Record<string, unknown>
    ).answer;
  }

  return result.output;
}

/**
 * Execute a Vision step - analyze images with AI.
 */
async function executeVision(
  step: VisionStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { vision } = step;
  const image = resolveValue(vision.image, ctx);

  const result = await executeBuiltinAction(
    "builtin:vision",
    "analyze",
    {
      serverId: vision.serverId,
      model: vision.model,
      image: String(image),
      task: vision.task,
      prompt: vision.prompt,
    },
    buildPluginContext(step, ctx),
  );

  if (result.success && vision.outputVariable && result.output) {
    ctx.variables[vision.outputVariable] = result.output;
  }

  return result.output;
}

/**
 * Execute an Audio step - process audio with AI.
 */
async function executeAudio(
  step: AudioStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { audio } = step;
  const input = resolveValue(audio.input, ctx);

  const result = await executeBuiltinAction(
    "builtin:audio",
    "process",
    {
      serverId: audio.serverId,
      model: audio.model,
      task: audio.task,
      input: String(input),
      language: audio.language,
      voice: audio.voice,
    },
    buildPluginContext(step, ctx),
  );

  if (result.success && audio.outputVariable && result.output) {
    const output = result.output as Record<string, unknown>;
    ctx.variables[audio.outputVariable] =
      audio.task === "transcribe" ? output.text : output.audioUrl;
  }

  return result.output;
}

// ============================================================================
// Flow Control Steps
// ============================================================================

/**
 * Parse a delay string like "1s", "500ms", "2m" into milliseconds
 */
function parseDelay(delay: string): number {
  const match = delay.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i);
  if (!match) {
    return 1000; // Default 1 second
  }

  const value = Number.parseFloat(match[1]);
  const unit = (match[2] || "ms").toLowerCase();

  switch (unit) {
    case "ms":
      return value;
    case "s":
      return value * 1000;
    case "m":
      return value * 60 * 1000;
    case "h":
      return value * 60 * 60 * 1000;
    default:
      return value;
  }
}

/**
 * Sleep for a specified number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute a Try/Catch step - wrap execution with error handling and optional retries
 *
 * Executes the try branch, and if it fails, runs the catch branch with error info
 */
async function executeTryCatch(
  step: TryCatchStep,
  ctx: ExecutionContext,
  def: WorkflowDefinition,
): Promise<{ success: boolean; handled?: boolean; attempts: number }> {
  const { tryCatch } = step;
  const maxRetries = tryCatch.retries ?? 0;
  let lastError: Error | null = null;

  // Helper to execute a branch (array of step IDs)
  const executeBranch = async (stepIds: string[]): Promise<unknown[]> => {
    const branchResults: unknown[] = [];

    for (const stepId of stepIds) {
      const targetStep = def.steps.find((s) => s.id === stepId);
      if (!targetStep) {
        throw new NotFoundError("Step not found in try/catch branch", {
          stepId,
        });
      }

      const { result } = await executeStepInternal(def, targetStep, ctx);
      branchResults.push(result);
    }

    return branchResults;
  };

  // Try branch with retries
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await executeBranch(tryCatch.tryBranch);

      return {
        success: true,
        attempts: attempt + 1,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Log retry attempt
      if (attempt < maxRetries) {
        logger.debug("Attempt failed, retrying", {
          attempt: attempt + 1,
          error: lastError.message,
        });

        if (tryCatch.retryDelay) {
          await sleep(parseDelay(tryCatch.retryDelay));
        }
      }
    }
  }

  // All retries exhausted, run catch branch
  // Store error information in the specified output variable
  ctx.variables[tryCatch.errorOutput] = {
    message: lastError?.message,
    name: lastError?.name,
    stack: lastError?.stack,
    attempts: maxRetries + 1,
  };

  logger.debug("All attempts failed, running catch branch", {
    attempts: maxRetries + 1,
  });

  try {
    await executeBranch(tryCatch.catchBranch);
  } catch (catchError) {
    // If catch branch also fails, propagate the error
    const catchErr =
      catchError instanceof Error ? catchError : new Error(String(catchError));
    logger.error("Catch branch failed", { error: catchErr.message });
    throw catchErr;
  }

  return {
    success: false,
    handled: true,
    attempts: maxRetries + 1,
  };
}

/**
 * Execute a Race step - run multiple branches in parallel, first to complete wins
 *
 * All branches start simultaneously, but only the first to complete determines
 * the result. Note: Other branches will continue running (cannot truly cancel)
 */
async function executeRace(
  step: RaceStep,
  ctx: ExecutionContext,
  def: WorkflowDefinition,
): Promise<{ winnerIndex: number; result: unknown }> {
  const { race } = step;

  // Helper to execute a single branch
  const executeBranch = async (
    branchStepIds: string[],
    branchIndex: number,
  ): Promise<{ index: number; result: unknown }> => {
    // Create a copy of variables for branch isolation
    const branchCtx: ExecutionContext = {
      ...ctx,
      variables: { ...ctx.variables },
      stepResults: { ...ctx.stepResults },
    };

    let lastResult: unknown = null;

    for (const stepId of branchStepIds) {
      const targetStep = def.steps.find((s) => s.id === stepId);
      if (!targetStep) {
        throw new NotFoundError("Step not found in race branch", { stepId });
      }

      const { result } = await executeStepInternal(def, targetStep, branchCtx);
      lastResult = result;
    }

    // Return result from the last step in the branch
    const lastStepId = branchStepIds[branchStepIds.length - 1];
    return {
      index: branchIndex,
      result: branchCtx.stepResults[lastStepId] ?? lastResult,
    };
  };

  // Start all branches in parallel
  const branchPromises = race.branches.map((branchStepIds, index) =>
    executeBranch(branchStepIds, index),
  );

  // Add timeout if specified
  let winner: { index: number; result: unknown };

  if (race.timeout) {
    const timeoutMs = parseDelay(race.timeout);

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Race timeout exceeded")), timeoutMs);
    });

    winner = await Promise.race([...branchPromises, timeoutPromise]);
  } else {
    winner = await Promise.race(branchPromises);
  }

  // Store results in context variables
  ctx.variables[race.output] = winner.result;
  ctx.variables[race.winnerIndex] = winner.index;

  logger.debug("Race branch won", { winnerIndex: winner.index });

  return {
    winnerIndex: winner.index,
    result: winner.result,
  };
}

// State management steps

/**
 * Execute a StateGet step - retrieve a value from the cross-workflow state store
 */
async function executeStateGet(
  step: StateGetStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { stateGet } = step;
  const orgId = ctx.organizationId ?? ctx.workflowId;
  const key = String(resolveValue(stateGet.key, ctx));

  const value = await stateStore.get(orgId, key);

  // Store in output variable and step results
  ctx.variables[stateGet.outputVariable] = value;
  ctx.stepResults[step.id] = { value };

  return { value };
}

/**
 * Execute a StateSet step - store a value in the cross-workflow state store
 */
async function executeStateSet(
  step: StateSetStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { stateSet } = step;
  const orgId = ctx.organizationId ?? ctx.workflowId;
  const key = String(resolveValue(stateSet.key, ctx));
  const value = resolveValue(stateSet.value, ctx);

  await stateStore.set(orgId, key, value, stateSet.ttl);

  return { key, written: true };
}

/**
 * Execute a StateWait step - poll the state store until a condition is met or timeout
 */
async function executeStateWait(
  step: StateWaitStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { stateWait } = step;
  const orgId = ctx.organizationId ?? ctx.workflowId;
  const key = String(resolveValue(stateWait.key, ctx));
  const timeoutMs = parseDelay(stateWait.timeout);
  const pollIntervalMs = 1000;
  const startTime = Date.now();

  // Capture initial value for "changed" condition
  let previousValue: unknown = null;
  if (stateWait.condition === "changed") {
    previousValue = await stateStore.get(orgId, key);
  }

  while (Date.now() - startTime < timeoutMs) {
    const currentValue = await stateStore.get(orgId, key);
    let conditionMet = false;

    switch (stateWait.condition) {
      case "exists":
        conditionMet = currentValue !== null;
        break;
      case "equals":
        conditionMet =
          JSON.stringify(currentValue) ===
          JSON.stringify(resolveValue(stateWait.value, ctx));
        break;
      case "changed":
        conditionMet =
          JSON.stringify(currentValue) !== JSON.stringify(previousValue);
        break;
    }

    if (conditionMet) {
      if (stateWait.outputVariable) {
        ctx.variables[stateWait.outputVariable] = currentValue;
      }
      return { conditionMet: true, value: currentValue };
    }

    await sleep(pollIntervalMs);
  }

  throw new TimeoutError("State wait timed out", {
    key,
    condition: stateWait.condition,
    timeoutMs,
  });
}

/**
 * Execute a Collect step - pause workflow until matching external events arrive.
 *
 * Registers expected events in Valkey and returns a "waiting" status.
 * The event router resumes the workflow when all conditions are met.
 */
async function executeCollect(
  step: CollectStep,
  ctx: ExecutionContext,
): Promise<unknown> {
  const { collect } = step;

  // Parse timeout string into absolute deadline
  const timeoutMs = parseDelay(collect.timeout);
  const deadline = Date.now() + timeoutMs;

  // Extract the correlation value from trigger data or workflow variables
  const correlationValue =
    resolveValue(`{{trigger.data.${collect.correlationKey}}}`, ctx) ??
    resolveValue(`{{${collect.correlationKey}}}`, ctx);

  if (
    correlationValue === undefined ||
    correlationValue === null ||
    correlationValue === ""
  ) {
    throw new ValidationError(
      `Collect step requires a correlation value for key "${collect.correlationKey}"`,
    );
  }

  await registerCollect({
    workflowRunId: ctx.runId,
    stepId: step.id,
    events: collect.events.map((e) => ({
      name: e.name,
      sourcePattern: e.sourcePattern,
      typePattern: e.typePattern,
    })),
    mode: collect.mode,
    minRequired: collect.minRequired,
    correlationKey: collect.correlationKey,
    correlationValue: String(correlationValue),
    receivedEvents: {},
    timeout: deadline,
  });

  // Return waiting status; actual suspension is handled by the runtime
  // (same pattern as the wait step with resumeOn: "event")
  return {
    status: "waiting",
    resumeOn: "collect",
    correlationKey: collect.correlationKey,
    correlationValue: String(correlationValue),
    expectedEvents: collect.events.map((e) => e.name),
    mode: collect.mode,
    timeoutAt: new Date(deadline).toISOString(),
  };
}
