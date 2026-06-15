/**
 * Built-in Plugins
 *
 * Native TypeScript plugins for core workflow primitives.
 * These run in-process (not WASM) for performance.
 */

export { agentPlugin } from "./agent";
export { aggregatePlugin } from "./aggregate";
export { assertPlugin } from "./assert";
export { audioPlugin } from "./audio";
export { cachePlugin } from "./cache";
export { chunkPlugin } from "./chunk";
export { compressionPlugin } from "./compression";
export { conditionPlugin } from "./condition";
export { databasePlugin } from "./database";
export { dateTimePlugin } from "./dateTime";
export { decryptPlugin } from "./decrypt";
export { delayPlugin } from "./delay";
export { emailPlugin } from "./email";
export { emailRenderPlugin } from "./emailRender";
export { embeddingPlugin } from "./embedding";
export { encryptPlugin } from "./encrypt";
export { errorPlugin } from "./error";
export { eventPlugin } from "./event";
export { expressionPlugin } from "./expression";
export { filePlugin } from "./file";
export { filterPlugin } from "./filter";
export { flattenPlugin } from "./flatten";
export { formatPlugin } from "./format";
export { ftpPlugin } from "./ftp";
export { gatePlugin } from "./gate";
export { generatorPlugin } from "./generator";
export { googleSheetsPlugin } from "./googleSheets";
export { graphqlPlugin } from "./graphql";
export { groupPlugin } from "./group";
export { hashPlugin } from "./hash";
export { htmlPlugin } from "./html";
export { httpPlugin } from "./http";
export { imagePlugin } from "./image";
export { jwtPlugin } from "./jwt";
export { logPlugin } from "./log";
export { loopPlugin } from "./loop";
export { mapPlugin } from "./map";
export { mcpPlugin } from "./mcp";
export { modelRegistryPlugin } from "./modelRegistry";
export { parallelPlugin } from "./parallel";
export { parsePlugin } from "./parse";
export { pdfPlugin } from "./pdf";
export { queuePlugin } from "./queue";
export { ragPlugin } from "./rag";
export { rateLimitPlugin } from "./rateLimit";
export { reducePlugin } from "./reduce";
export { regexPlugin } from "./regex";
export { retryPlugin } from "./retry";
export { rivetPlugin } from "./rivet";
export { signPlugin } from "./sign";
export { sleepPlugin } from "./sleep";
export { sortPlugin } from "./sort";
export { spreadsheetPlugin } from "./spreadsheet";
export { sshPlugin } from "./ssh";
export { storagePlugin } from "./storage";
export { subworkflowPlugin } from "./subworkflow";
export { switchPlugin } from "./switch";
export { timeoutPlugin } from "./timeout";
export { transformPlugin } from "./transform";
export { triggerPlugin } from "./trigger";
export * from "./types";
export { uniquePlugin } from "./unique";
export { validatePlugin } from "./validate";
export { vectorSearchPlugin } from "./vectorSearch";
export { visionPlugin } from "./vision";
export { waitPlugin } from "./wait";
export { webhookResponsePlugin } from "./webhookResponse";
export { webhookVerifyPlugin } from "./webhookVerify";
export { xmlPlugin } from "./xml";
export { zipPlugin } from "./zip";

import { agentPlugin } from "./agent";
import { aggregatePlugin } from "./aggregate";
import { assertPlugin } from "./assert";
import { audioPlugin } from "./audio";
import { cachePlugin } from "./cache";
import { chunkPlugin } from "./chunk";
import { compressionPlugin } from "./compression";
import { conditionPlugin } from "./condition";
import { databasePlugin } from "./database";
import { dateTimePlugin } from "./dateTime";
import { decryptPlugin } from "./decrypt";
import { delayPlugin } from "./delay";
import { emailPlugin } from "./email";
import { emailRenderPlugin } from "./emailRender";
import { embeddingPlugin } from "./embedding";
import { encryptPlugin } from "./encrypt";
import { errorPlugin } from "./error";
import { eventPlugin } from "./event";
import { expressionPlugin } from "./expression";
import { filePlugin } from "./file";
import { filterPlugin } from "./filter";
import { flattenPlugin } from "./flatten";
import { formatPlugin } from "./format";
import { ftpPlugin } from "./ftp";
import { gatePlugin } from "./gate";
import { generatorPlugin } from "./generator";
import { googleSheetsPlugin } from "./googleSheets";
import { graphqlPlugin } from "./graphql";
import { groupPlugin } from "./group";
import { hashPlugin } from "./hash";
import { htmlPlugin } from "./html";
import { httpPlugin } from "./http";
import { imagePlugin } from "./image";
import { jwtPlugin } from "./jwt";
import { logPlugin } from "./log";
import { loopPlugin } from "./loop";
import { mapPlugin } from "./map";
import { mcpPlugin } from "./mcp";
import { modelRegistryPlugin } from "./modelRegistry";
import { parallelPlugin } from "./parallel";
import { parsePlugin } from "./parse";
import { pdfPlugin } from "./pdf";
import { queuePlugin } from "./queue";
import { ragPlugin } from "./rag";
import { rateLimitPlugin } from "./rateLimit";
import { reducePlugin } from "./reduce";
import { regexPlugin } from "./regex";
import { retryPlugin } from "./retry";
import { rivetPlugin } from "./rivet";
import { signPlugin } from "./sign";
import { sleepPlugin } from "./sleep";
import { sortPlugin } from "./sort";
import { spreadsheetPlugin } from "./spreadsheet";
import { sshPlugin } from "./ssh";
import { storagePlugin } from "./storage";
import { subworkflowPlugin } from "./subworkflow";
import { switchPlugin } from "./switch";
import { timeoutPlugin } from "./timeout";
import { transformPlugin } from "./transform";
import { triggerPlugin } from "./trigger";
import { uniquePlugin } from "./unique";
import { validatePlugin } from "./validate";
import { vectorSearchPlugin } from "./vectorSearch";
import { visionPlugin } from "./vision";
import { waitPlugin } from "./wait";
import { webhookResponsePlugin } from "./webhookResponse";
import { webhookVerifyPlugin } from "./webhookVerify";
import { xmlPlugin } from "./xml";
import { zipPlugin } from "./zip";

import type { PluginCallResult, PluginContext } from "../types";
import type { BuiltinHandler, BuiltinPlugin } from "./types";

/**
 * Registry of all built-in plugins.
 */
const builtinPlugins: Map<string, BuiltinPlugin> = new Map([
  [aggregatePlugin.id, aggregatePlugin],
  [agentPlugin.id, agentPlugin],
  [assertPlugin.id, assertPlugin],
  [audioPlugin.id, audioPlugin],
  [cachePlugin.id, cachePlugin],
  [chunkPlugin.id, chunkPlugin],
  [conditionPlugin.id, conditionPlugin],
  [decryptPlugin.id, decryptPlugin],
  [delayPlugin.id, delayPlugin],
  [emailPlugin.id, emailPlugin],
  [emailRenderPlugin.id, emailRenderPlugin],
  [embeddingPlugin.id, embeddingPlugin],
  [encryptPlugin.id, encryptPlugin],
  [errorPlugin.id, errorPlugin],
  [eventPlugin.id, eventPlugin],
  [filePlugin.id, filePlugin],
  [filterPlugin.id, filterPlugin],
  [flattenPlugin.id, flattenPlugin],
  [formatPlugin.id, formatPlugin],
  [gatePlugin.id, gatePlugin],
  [groupPlugin.id, groupPlugin],
  [hashPlugin.id, hashPlugin],
  [httpPlugin.id, httpPlugin],
  [jwtPlugin.id, jwtPlugin],
  [logPlugin.id, logPlugin],
  [loopPlugin.id, loopPlugin],
  [mapPlugin.id, mapPlugin],
  [mcpPlugin.id, mcpPlugin],
  [parallelPlugin.id, parallelPlugin],
  [parsePlugin.id, parsePlugin],
  [queuePlugin.id, queuePlugin],
  [ragPlugin.id, ragPlugin],
  [reducePlugin.id, reducePlugin],
  [retryPlugin.id, retryPlugin],
  [signPlugin.id, signPlugin],
  [sortPlugin.id, sortPlugin],
  [sleepPlugin.id, sleepPlugin],
  [subworkflowPlugin.id, subworkflowPlugin],
  [switchPlugin.id, switchPlugin],
  [timeoutPlugin.id, timeoutPlugin],
  [transformPlugin.id, transformPlugin],
  [triggerPlugin.id, triggerPlugin],
  [uniquePlugin.id, uniquePlugin],
  [validatePlugin.id, validatePlugin],
  [vectorSearchPlugin.id, vectorSearchPlugin],
  [visionPlugin.id, visionPlugin],
  [waitPlugin.id, waitPlugin],
  [webhookResponsePlugin.id, webhookResponsePlugin],
  [zipPlugin.id, zipPlugin],
  [spreadsheetPlugin.id, spreadsheetPlugin],
  [googleSheetsPlugin.id, googleSheetsPlugin],
  [modelRegistryPlugin.id, modelRegistryPlugin],
  [webhookVerifyPlugin.id, webhookVerifyPlugin],
  [pdfPlugin.id, pdfPlugin],
  [rateLimitPlugin.id, rateLimitPlugin],
  [htmlPlugin.id, htmlPlugin],
  [dateTimePlugin.id, dateTimePlugin],
  [sshPlugin.id, sshPlugin],
  [ftpPlugin.id, ftpPlugin],
  [imagePlugin.id, imagePlugin],
  [databasePlugin.id, databasePlugin],
  [storagePlugin.id, storagePlugin],
  [compressionPlugin.id, compressionPlugin],
  [xmlPlugin.id, xmlPlugin],
  [graphqlPlugin.id, graphqlPlugin],
  [expressionPlugin.id, expressionPlugin],
  [generatorPlugin.id, generatorPlugin],
  [regexPlugin.id, regexPlugin],
  [rivetPlugin.id, rivetPlugin],
]);

/**
 * Get a built-in plugin by ID.
 */
export const getBuiltinPlugin = (
  pluginId: string,
): BuiltinPlugin | undefined => {
  return builtinPlugins.get(pluginId);
};

/**
 * List all built-in plugins.
 */
export const listBuiltinPlugins = (): BuiltinPlugin[] => {
  return Array.from(builtinPlugins.values());
};

/**
 * Check if a plugin ID is a built-in plugin.
 */
export const isBuiltinPlugin = (pluginId: string): boolean => {
  return pluginId.startsWith("builtin:") && builtinPlugins.has(pluginId);
};

/**
 * Execute a built-in plugin action.
 */
export const executeBuiltinAction = async (
  pluginId: string,
  actionName: string,
  inputs: Record<string, unknown>,
  context?: PluginContext,
): Promise<PluginCallResult> => {
  const plugin = builtinPlugins.get(pluginId);
  if (!plugin) {
    return {
      success: false,
      error: `Built-in plugin not found: ${pluginId}`,
      durationMs: 0,
    };
  }

  const action = plugin.actions[actionName];
  if (!action) {
    return {
      success: false,
      error: `Action not found: ${actionName} in plugin ${pluginId}`,
      durationMs: 0,
    };
  }

  return action.handler(inputs, context);
};

/**
 * Get a specific action handler from a built-in plugin.
 */
export const getBuiltinHandler = (
  pluginId: string,
  actionName: string,
): BuiltinHandler | undefined => {
  const plugin = builtinPlugins.get(pluginId);
  if (!plugin) return undefined;

  const action = plugin.actions[actionName];
  return action?.handler;
};
