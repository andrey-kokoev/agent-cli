#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync, statSync, openSync, writeSync, closeSync, fsyncSync, copyFileSync, renameSync, unlinkSync, rmSync } from 'node:fs';
import { resolve, join, basename, dirname } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { pathToFileURL } from 'node:url';
import {
  argumentSummary,
  classifyCarrierActionRequest,
  createAndWriteCarrierActionAdmission,
  inspectPayloadForSecrets,
} from '@narada2/carrier-action-admission';
import { buildFallbackToolMetadata } from '@narada2/carrier-action-admission/tool-metadata';
import {
  createPayloadRef,
  carrierDirectiveEmitterSpec,
  classifyDirectiveEmissionRequest,
  createCarrierDirectiveInput,
  createDirectiveEmissionAuthorization,
  createDirectiveEmissionRule,
  directiveEmissionPayload,
  createSessionEvent as createCarrierSessionEvent,
  createToolCallPayload,
  createToolResultPayload,
  createTurnTerminalPayload,
  classifyCarrierObserverInput,
  classifyCarrierInputAdmission,
  classifyCarrierInputHold,
  classifyCarrierInputQueueAdmission,
  classifyCarrierControlRequest,
  normalizeControlInputRecord,
  normalizeInputEvent as normalizeCarrierInputEvent,
  OBSERVER_VISIBILITIES,
  isObserverInputEvent as isProtocolObserverInputEvent,
  isNarsRuntimeEventKind,
  normalizeNarsRuntimeEventKind,
  observerMetadata as protocolObserverMetadata,
  observerPayload as protocolObserverPayload,
  observerVisibility as protocolObserverVisibility,
} from '@narada2/carrier-protocol';
import { resolveToolMetadata } from '@narada2/carrier-action-admission/tool-metadata';
import {
  DEFAULT_AGENT_CLI_PROVIDER,
  PROVIDER_SUPPORT_STATES,
  loadProviderMetadata,
  providerEnvironment,
} from './provider-resolution.mjs';
import {
  isAgentCliUtilityCommandMode,
  parseArgs,
  parseBooleanEnv,
  parseColorEnv,
} from './cli-options.mjs';
import { resolveNarsAttachEndpoint, runNarsAttachClient } from './nars-attach-client.mjs';
import { runCompatibilityShim as runRuntimeServerCompatibilityShim } from './runtime-server-shim.mjs';
import { createTerminalStyle } from './terminal-style.mjs';
import { createTerminalRendering, stripAnsi } from './terminal-rendering.mjs';
import {
  aggregateToolBindings,
  aggregateTools,
  buildChildProcessEnv,
  createMcpStatusSnapshot,
  discoverAndStartMcpServers,
  findToolBinding,
  formatMcpRuntimeDiagnosticSummary,
  formatMcpStartupFailureSummary,
  getMcpRuntimeDiagnostics,
  getMcpStartupFailures,
  mcpOperationalState,
  mcpToolEffectAdmissionEvidence,
  originalToolNameForProvider,
  providerSafeToolName,
  providerToolNameForOriginal,
  rememberMcpRuntimeDiagnostic,
  sendMcpRequest,
  shouldSuppressMcpStderr,
  toolFailureRecovery,
} from './mcp-runtime.mjs';
import {
  REQUEST_ADAPTERS,
  buildAnthropicMessagesRequest,
  buildCodexExecArgs,
  buildCodexMcpRequest,
  buildCodexMcpServerArgs,
  buildCodexSubprocessEnv,
  buildOpenAiChatRequest,
  cleanAnthropicMessages,
  cleanOpenAiMessages,
  codexExecConfigToml,
  codexExecEventText,
  codexExecMcpConfigArgs,
  codexExecMcpToolEventSummary,
  codexExecPrompt,
  codexRequestMcpServers,
  configureProviderAdapterContext,
  isPotentialNaradaToolCallText,
  parseAnthropicMessagesResponse,
  parseCodexExecJsonLine,
  parseCodexMcpResponse,
  parseNaradaToolCall,
} from './provider-adapters.mjs';
import {
  classifyCarrierHostCommandInput as classifyCarrierHostCommandInputRuntime,
  executeCarrierHostCommand as executeCarrierHostCommandRuntime,
  readCarrierHostCommandOutputRef as readCarrierHostCommandOutputRefRuntime,
} from './host-command-runtime.mjs';
import {
  createInputQueue as createInputQueueRuntime,
  inputWithObserverMetadata,
  isObserverInputEvent,
  normalizeInputEvent as normalizeInputEventRuntime,
  normalizeInputRecord,
  observerMetadata,
  observerPayload,
  observerVisibility,
  readlineHasNonWhitespaceInput,
  readlineHasPartialInput,
  shouldDeferQueuedInput as shouldDeferQueuedInputRuntime,
} from './input-queue.mjs';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PROVIDER_METADATA = loadProviderMetadata();
const INTELLIGENCE_PROVIDER = process.env.NARADA_INTELLIGENCE_PROVIDER ?? DEFAULT_AGENT_CLI_PROVIDER;
const {
  providerDefault: PROVIDER_DEFAULT,
  apiKey: API_KEY,
  baseUrl: BASE_URL,
  model: MODEL,
} = providerEnvironment(INTELLIGENCE_PROVIDER, PROVIDER_METADATA);
const THINKING_LEVEL = process.env.NARADA_AI_THINKING ?? process.env.NARADA_THINKING_LEVEL ?? 'medium';
const CODEX_SUBSCRIPTION_TRANSPORT = process.env.NARADA_CODEX_SUBSCRIPTION_TRANSPORT ?? 'exec-json';
const CODEX_NATIVE_MCP_TOOLS = parseBooleanEnv(process.env.NARADA_CODEX_NATIVE_MCP_TOOLS, true);
const SITE_ROOT = resolve(process.env.NARADA_SITE_ROOT ?? process.cwd());
const SITE_ID = process.env.NARADA_SITE_ID ?? process.env.NARADA_SITE_NAME ?? 'unknown-site';
const options = parseArgs(process.argv.slice(2));
const IDENTITY = options.identity ?? 'narada.architect';
const SESSION = options.session ?? IDENTITY.replace(/\./g, '-');
const NARS_DELEGATED_AUTHORITY_HANDOFF = parseNarsDelegatedAuthorityHandoff(process.env.NARADA_NARS_AUTHORITY_HANDOFF);
const REMOVED_CONVERSATION_ARGS = options.removedConversationArgs ?? [];
const MCP_PREFLIGHT_MODE = options.mcpPreflight === true;
const MCP_PREFLIGHT_JSON_MODE = options.mcpPreflightJson === true;
const MCP_PREFLIGHT_READ_MODE = options.mcpPreflightRead === true;
const MCP_PREFLIGHT_READ_JSON_MODE = options.mcpPreflightReadJson === true;
const MCP_PREFLIGHT_INVENTORY_MODE = options.mcpPreflightInventory === true;
const MCP_PREFLIGHT_INVENTORY_JSON_MODE = options.mcpPreflightInventoryJson === true;
const MCP_PREFLIGHT_ACTIONS_MODE = options.mcpPreflightActions === true;
const MCP_PREFLIGHT_ACTIONS_JSON_MODE = options.mcpPreflightActionsJson === true;
const MCP_PREFLIGHT_RECOVERY_MODE = options.mcpPreflightRecovery === true;
const MCP_PREFLIGHT_RECOVERY_JSON_MODE = options.mcpPreflightRecoveryJson === true;
const MCP_PREFLIGHT_DIAGNOSTICS_MODE = options.mcpPreflightDiagnostics === true;
const MCP_PREFLIGHT_DIAGNOSTICS_JSON_MODE = options.mcpPreflightDiagnosticsJson === true;
const MCP_PREFLIGHT_FILTER_KEY = normalizeMcpPreflightFilterKey(options.mcpPreflightFilter);
const MCP_PREFLIGHT_FILTER_VALUE = normalizeMcpPreflightFilterValue(options.mcpPreflightMatch);
const MCP_PREFLIGHT_DIAGNOSTICS_FILTER = normalizeMcpPreflightDiagnosticsFilter(options.mcpPreflightDiagnosticsFilter);
const SESSION_INVENTORY_MODE = options.sessionInventory === true;
const SESSION_INVENTORY_JSON_MODE = options.sessionInventoryJson === true;
const SESSION_INVENTORY_OPERATIONS_MODE = options.sessionInventoryOperations === true;
const SESSION_INVENTORY_OPERATIONS_JSON_MODE = options.sessionInventoryOperationsJson === true;
const SESSION_INVENTORY_HOST_COMMANDS_MODE = options.sessionInventoryHostCommands === true;
const SESSION_INVENTORY_HOST_COMMANDS_JSON_MODE = options.sessionInventoryHostCommandsJson === true;
const SESSION_INVENTORY_ACTIONS_MODE = options.sessionInventoryActions === true;
const SESSION_INVENTORY_ACTIONS_JSON_MODE = options.sessionInventoryActionsJson === true;
const SESSION_INVENTORY_RECOVERY_MODE = options.sessionInventoryRecovery === true;
const SESSION_INVENTORY_RECOVERY_JSON_MODE = options.sessionInventoryRecoveryJson === true;
const SESSION_INVENTORY_FILTER_KEY = normalizeSessionInventoryFilterKey(options.sessionInventoryFilter);
const SESSION_INVENTORY_FILTER_VALUE = normalizeSessionInventoryFilterValue(options.sessionInventoryMatch);
const SESSION_INVENTORY_EVENTS_MODE = options.sessionInventoryEvents === true;
const SESSION_INVENTORY_EVENTS_JSON_MODE = options.sessionInventoryEventsJson === true;
const SESSION_INVENTORY_EVENTS_FILTER = normalizeSessionEventsFilter(options.sessionInventoryEventsFilter);
const SESSION_INVENTORY_EVENTS_COUNT = Number.isFinite(Number(options.sessionInventoryEventsCount))
  ? Math.max(1, Number(options.sessionInventoryEventsCount))
  : 20;
const SESSION_RECOVERY_MODE = options.sessionRecovery === true;
const SESSION_RECOVERY_JSON_MODE = options.sessionRecoveryJson === true;
const SESSION_READ_MODE = options.sessionRead === true;
const SESSION_READ_JSON_MODE = options.sessionReadJson === true;
const SESSION_OPERATIONS_MODE = options.sessionOperations === true;
const SESSION_OPERATIONS_JSON_MODE = options.sessionOperationsJson === true;
const HOST_COMMAND_OUTPUT_READ_MODE = options.hostCommandOutputRead === true;
const HOST_COMMAND_OUTPUT_READ_JSON_MODE = options.hostCommandOutputReadJson === true;
const HOST_COMMAND_OUTPUT_REF = String(options.hostCommandOutputRef ?? '').trim() || null;
const SESSION_EVENTS_MODE = options.sessionEvents === true;
const SESSION_EVENTS_JSON_MODE = options.sessionEventsJson === true;
const SESSION_EVENTS_FILTER = normalizeSessionEventsFilter(options.sessionEventsFilter);
const SESSION_EVENTS_COUNT = Number.isFinite(Number(options.sessionEventsCount))
  ? Math.max(1, Number(options.sessionEventsCount))
  : 20;
const SESSION_SYNC_MODE = options.sessionSync === true;
const SESSION_SYNC_JSON_MODE = options.sessionSyncJson === true;
const SESSION_SYNC_TARGET = String(options.sessionSyncTarget ?? '').trim() || null;
const SESSION_SYNC_DIRECTION = normalizeSessionSyncDirection(options.sessionSyncDirection);
const SESSION_SYNC_DRY_RUN = options.sessionSyncDryRun === true;
const SESSION_SYNC_DELETE = options.sessionSyncDelete === true;
const SERVER_COMPATIBILITY_MODE = options.server === true && options.carrierServerSubstrate !== true;
const SERVER_MODE = options.carrierServerSubstrate === true;
const ATTACH_MODE = options.attach === true;
const UTILITY_COMMAND_MODE = isAgentCliUtilityCommandMode(options);
const sessionSettings = {
  model: options.model ?? MODEL,
  thinking: normalizeThinkingLevel(options.thinking ?? THINKING_LEVEL),
  stream: options.stream ?? parseBooleanEnv(process.env.NARADA_AGENT_CLI_STREAM, true),
  goal: createCarrierGoalState(process.env.NARADA_AGENT_CLI_GOAL ?? process.env.NARADA_CARRIER_GOAL ?? process.env.NARADA_GOAL ?? ''),
};
const transcriptDisplaySettings = {
  toolOutputs: parseBooleanEnv(process.env.NARADA_AGENT_CLI_TOOL_OUTPUTS, true),
  observerMuted: parseBooleanEnv(process.env.NARADA_AGENT_CLI_OBSERVER_MUTED, false),
};
function serverCommandMessage({ requestId, command, message, terminalState = 'completed', fields = null }) {
  return {
    request_id: requestId,
    transport: 'jsonl_stdio',
    event: 'carrier_command_result',
    lifecycle_event: normalizeNarsRuntimeEventKind('carrier_command_result'),
    command,
    terminal_state: terminalState,
    message,
    ...(fields && typeof fields === 'object' ? { fields } : {}),
  };
}

function matchesEventSubscriptionFilter(event, filters = {}) {
  if (!filters || typeof filters !== 'object') return true;
  const eventKind = event.event ?? event.event_kind ?? null;
  const kinds = Array.isArray(filters.event_kinds) ? filters.event_kinds : Array.isArray(filters.kinds) ? filters.kinds : null;
  if (kinds && !kinds.includes(eventKind)) return false;
  const families = Array.isArray(filters.families) ? filters.families : null;
  if (families?.length) {
    const family = String(eventKind ?? '').startsWith('session_') ? 'session' : 'turn';
    if (!families.includes(family)) return false;
  }
  if (filters.request_id && event.request_id !== filters.request_id) return false;
  if (filters.turn_id && event.turn_id !== filters.turn_id) return false;
  return true;
}

function readSessionEventsForSubscription({ sinceSequence = null, sinceTimestamp = null, filters = {}, maxReplay = 100 } = {}) {
  if (!existsSync(EVENTS_PATH)) return [];
  const replayLimit = Math.max(0, Math.min(Number.parseInt(String(maxReplay ?? 100), 10) || 0, 1000));
  const sinceSeq = sinceSequence == null ? null : Number.parseInt(String(sinceSequence), 10);
  const sinceTime = sinceTimestamp ? Date.parse(String(sinceTimestamp)) : null;
  const events = [];
  for (const line of readFileSync(EVENTS_PATH, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (Number.isFinite(sinceSeq) && Number(event.event_sequence ?? event.sequence ?? 0) <= sinceSeq) continue;
      if (Number.isFinite(sinceTime)) {
        const eventTime = Date.parse(String(event.timestamp ?? event.generated_at ?? ''));
        if (Number.isFinite(eventTime) && eventTime <= sinceTime) continue;
      }
      if (!matchesEventSubscriptionFilter(event, filters)) continue;
      events.push(event);
    } catch {}
  }
  return events.slice(-replayLimit);
}

function serverEventsSubscription({ requestId, params = {} }) {
  const filters = params.filters && typeof params.filters === 'object' ? params.filters : {};
  const includeReplay = params.include_replay !== false;
  const replay = includeReplay ? readSessionEventsForSubscription({
    sinceSequence: params.since_sequence,
    sinceTimestamp: params.since_timestamp,
    filters,
    maxReplay: params.max_replay ?? 100,
  }) : [];
  const lastEvent = replay.at(-1) ?? null;
  return {
    schema: 'narada.nars.events.subscription.v1',
    event: 'session_events_subscription_started',
    request_id: requestId,
    subscription_id: `sub_${requestId ?? Date.now()}`,
    transport: 'jsonl_stdio',
    replay_count: replay.length,
    replay,
    cursor: {
      last_sequence: lastEvent?.event_sequence ?? lastEvent?.sequence ?? null,
      next_sequence: SERVER_EVENT_SEQUENCE + 1,
    },
    filters,
    live_stream: 'stdout_jsonl',
    close_semantics: 'request_scoped_replay_over_stdio; durable live subscriptions require websocket transport',
  };
}

function serverToolCatalog({ requestId, mcpServers, filter = '' }) {
  return serverCommandMessage({
    requestId,
    command: '/tools',
    message: formatMcpToolCatalog(mcpServers, { filter }),
  });
}

function serverQueueCommand({ requestId, value, inputQueue }) {
  if (!inputQueue) {
    return serverCommandMessage({ requestId, command: '/queue', message: 'Queue is unavailable in this mode.', terminalState: 'unavailable' });
  }
  const result = handleQueueCommand(value, inputQueue);
  if (result.mutated) {
    appendSession(SESSION_PATH, carrierSessionEventEntry('carrier_command_executed', {
      command: `/queue${value ? ` ${value}` : ''}`,
      mutation: result.mutation,
    }));
  }
  return serverCommandMessage({
    requestId,
    command: '/queue',
    message: result.message,
    terminalState: result.status ?? 'completed',
  });
}

function serverGoalCommand({ requestId, value, state }) {
  const result = handleGoalCommand(value, state.sessionSettings ?? sessionSettings);
  appendSession(SESSION_PATH, sessionEventEntry(result.changed ? 'session_setting_changed' : 'carrier_command_executed', {
    command: '/goal',
    setting: 'goal',
    value: result.goal.value,
    status: result.goal.status,
    action: result.action,
  }));
  return serverCommandMessage({
    requestId,
    command: '/goal',
    message: result.message,
    fields: {
      goal: result.goal.value,
      status: result.goal.status,
      action: result.action,
    },
  });
}

function serverToolOutputCommand({ requestId, value, state }) {
  const result = handleToolOutputDisplayCommand(value, state.displaySettings ?? transcriptDisplaySettings);
  appendSession(SESSION_PATH, sessionEventEntry('session_setting_changed', {
    setting: 'tool_outputs_display',
    value: result.state ? 'shown' : 'hidden',
    command: '/tool-output',
    arguments: value,
  }));
  return serverCommandMessage({
    requestId,
    command: '/tool-output',
    message: result.message,
    fields: { tool_outputs: result.state ? 'shown' : 'hidden' },
  });
}

function serverModelCommand({ requestId, value, state }) {
  const settings = state.sessionSettings ?? sessionSettings;
  const next = String(value ?? '').trim();
  if (!next) {
    return serverCommandMessage({ requestId, command: '/model', message: `Current model: ${settings.model}` });
  }
  settings.model = next;
  appendSession(SESSION_PATH, sessionEventEntry('session_setting_changed', { setting: 'model', value: next }));
  return serverCommandMessage({ requestId, command: '/model', message: `Model set to ${settings.model}`, fields: { model: settings.model } });
}

function serverThinkingCommand({ requestId, value, state }) {
  const settings = state.sessionSettings ?? sessionSettings;
  const nextValue = String(value ?? '').trim();
  if (!nextValue) {
    return serverCommandMessage({ requestId, command: '/thinking', message: `Current thinking: ${settings.thinking}` });
  }
  const next = normalizeThinkingLevel(nextValue);
  if (next !== nextValue.toLowerCase()) {
    return serverCommandMessage({ requestId, command: '/thinking', terminalState: 'invalid', message: 'Usage: /thinking none|low|medium|high' });
  }
  settings.thinking = next;
  appendSession(SESSION_PATH, sessionEventEntry('session_setting_changed', { setting: 'thinking', value: next }));
  return serverCommandMessage({ requestId, command: '/thinking', message: `Thinking set to ${settings.thinking}`, fields: { thinking: settings.thinking } });
}

function serverStatsCommand({ requestId, value, statsRunner = runCodexTranscriptStats }) {
  const result = statsRunner(value);
  appendSession(SESSION_PATH, sessionEventEntry('session_command', {
    command: '/stats',
    arguments: value,
    status: result.status,
    runtime_scope: 'codex_transcript_store',
  }));
  return serverCommandMessage({ requestId, command: '/stats', terminalState: result.status ?? 'completed', message: result.message });
}

function summarizeSessionInventoryHostCommands(inventory = []) {
  const hostCommandSessions = inventory.filter((item) => Number(item?.host_command_event_count ?? 0) > 0);
  const hostCommandEventCounts = {};
  const hostCommandTerminalStateCounts = {};
  let outputRefCount = 0;
  for (const item of hostCommandSessions) {
    mergeInventoryCounts(hostCommandEventCounts, item?.host_command_event_counts ?? null);
    mergeInventoryCounts(hostCommandTerminalStateCounts, item?.host_command_terminal_state_counts ?? null);
    if (item?.last_host_command_output_ref) outputRefCount += 1;
  }
  return {
    host_command_session_count: hostCommandSessions.length,
    host_command_event_counts: hostCommandEventCounts,
    host_command_event_summary: formatInventoryCounts(hostCommandEventCounts),
    host_command_terminal_state_counts: hostCommandTerminalStateCounts,
    host_command_terminal_state_summary: formatInventoryCounts(hostCommandTerminalStateCounts),
    host_command_output_ref_count: outputRefCount,
    host_command_output_ref_summary: `${outputRefCount} with persisted output`,
    groups: {
      terminal_state: summarizeSessionInventoryGroupBy(hostCommandSessions, 'last_host_command_terminal_state', 'last_host_command_terminal_state'),
      recommended_action: summarizeSessionInventoryGroupBy(hostCommandSessions, 'recommended_action', 'recommended_action_display'),
    },
    workflow_groups: summarizeActionWorkflowGroups(hostCommandSessions),
    sessions: hostCommandSessions
      .slice()
      .sort((left, right) => Number(right?.host_command_event_count ?? 0) - Number(left?.host_command_event_count ?? 0)
        || String(right?.last_host_command_at ?? '').localeCompare(String(left?.last_host_command_at ?? ''))
        || String(left?.session ?? '').localeCompare(String(right?.session ?? ''))),
  };
}

function renderSessionInventoryHostCommands(sessions = []) {
  return sessions.map((item) => formatKeyValueRows({
    Session: item.session,
    Heartbeat: item.heartbeat_display,
    'Host command events': item.host_command_event_summary,
    'Host command states': item.host_command_terminal_state_summary,
    'Last host command': item.last_host_command_summary ?? 'none',
    'Last host command state': item.last_host_command_terminal_state ?? 'none',
    'Last host command at': item.last_host_command_at ?? 'unknown',
    'Host command output': item.last_host_command_output_ref ?? 'none',
    'Host command output review': item?.handoffs?.host_command_output_read ?? 'none',
    'Recommended action': item.recommended_action_display,
    'Recommended command': item.recommended_command ?? 'none',
    'Session read': item?.handoffs?.session_read ?? 'none',
    'Session recovery': item?.handoffs?.session_recovery ?? 'none',
    'Session diagnostics': item?.handoffs?.session_events_diagnostics ?? 'none',
  }));
}

function summarizeSessionInventoryOperations(inventory = []) {
  const operationSessions = inventory.filter((item) => Number(item?.operation_event_count ?? 0) > 0);
  const operationEventCounts = {};
  const directiveKindCounts = {};
  const directiveVisibilityCounts = {};
  const operationIdCounts = {};
  for (const item of operationSessions) {
    mergeInventoryCounts(operationEventCounts, item?.operation_event_counts ?? null);
    mergeInventoryCounts(directiveKindCounts, item?.directive_kind_counts ?? null);
    mergeInventoryCounts(directiveVisibilityCounts, item?.directive_visibility_counts ?? null);
    mergeInventoryCounts(operationIdCounts, item?.operation_id_counts ?? null);
  }
  return {
    operation_session_count: operationSessions.length,
    operation_event_counts: operationEventCounts,
    operation_event_summary: formatInventoryCounts(operationEventCounts),
    directive_kind_counts: directiveKindCounts,
    directive_kind_summary: formatInventoryCounts(directiveKindCounts),
    directive_visibility_counts: directiveVisibilityCounts,
    directive_visibility_summary: formatInventoryCounts(directiveVisibilityCounts),
    operation_id_counts: operationIdCounts,
    operation_id_summary: formatInventoryCounts(operationIdCounts),
    groups: {
      directive_kind: summarizeSessionInventoryGroupBy(operationSessions, 'last_directive_kind', 'last_directive_kind'),
      directive_visibility: summarizeSessionInventoryGroupBy(operationSessions, 'last_directive_visibility', 'last_directive_visibility'),
      recommended_action: summarizeSessionInventoryGroupBy(operationSessions, 'recommended_action', 'recommended_action_display'),
    },
    workflow_groups: summarizeActionWorkflowGroups(operationSessions),
    sessions: operationSessions
      .slice()
      .sort((left, right) => Number(right?.operation_event_count ?? 0) - Number(left?.operation_event_count ?? 0)
        || String(right?.last_operation_at ?? '').localeCompare(String(left?.last_operation_at ?? ''))
        || String(left?.session ?? '').localeCompare(String(right?.session ?? ''))),
  };
}

function renderSessionInventoryOperations(sessions = []) {
  return sessions.map((item) => formatKeyValueRows({
    Session: item.session,
    Heartbeat: item.heartbeat_display,
    'Operation events': item.operation_event_summary,
    'Directive kinds': item.directive_kind_summary,
    'Directive visibility': item.directive_visibility_summary,
    'Operation ids': item.operation_id_summary,
    'Last operation id': item.last_operation_id ?? 'none',
    'Last directive kind': item.last_directive_kind ?? 'none',
    'Last directive visibility': item.last_directive_visibility ?? 'none',
    'Last operation at': item.last_operation_at ?? 'unknown',
    'Recommended action': item.recommended_action_display,
    'Recommended command': item.recommended_command ?? 'none',
    'Session read': item?.handoffs?.session_read ?? 'none',
    'Session recovery': item?.handoffs?.session_recovery ?? 'none',
    'Session issues': item?.handoffs?.session_events_issues ?? 'none',
    'Session diagnostics': item?.handoffs?.session_events_diagnostics ?? 'none',
    'Session path': item.session_path,
  }));
}

function formatPersistedSessionEventLine(entry) {
  const timestamp = entry?.timestamp ?? entry?.occurred_at ?? entry?.payload?.occurred_at ?? entry?.payload?.created_at ?? 'unknown-time';
  const eventKind = entry?.event_kind ?? entry?.event ?? 'unknown-event';
  const terminalState = entry?.payload?.terminal_state ?? entry?.terminal_state ?? null;
  const issueCode = classifyPersistedSessionIssueCode(entry);
  const details = [];
  if (terminalState) details.push(`terminal=${terminalState}`);
  if (issueCode) details.push(`code=${issueCode}`);
  return `- ${timestamp} ${eventKind}${details.length > 0 ? ` [${details.join('; ')}]` : ''}`;
}

function formatPersistedSessionInventoryEventLine(entry) {
  const timestamp = entry?.timestamp ?? 'unknown-time';
  const session = entry?.session ?? 'unknown-session';
  const eventKind = entry?.event_kind ?? 'unknown-event';
  const terminalState = entry?.terminal_state ?? null;
  const issueCode = entry?.issue_code ?? null;
  const details = [];
  if (terminalState) details.push(`terminal=${terminalState}`);
  if (issueCode) details.push(`code=${issueCode}`);
  return `- ${session} ${timestamp} ${eventKind}${details.length > 0 ? ` [${details.join('; ')}]` : ''}`;
}

function buildPersistedSessionHandoffs({ session, identity = IDENTITY, eventCount = 20 } = {}) {
  const normalizedSession = String(session ?? '').trim();
  const normalizedIdentity = String(identity ?? IDENTITY).trim() || IDENTITY;
  if (!normalizedSession) return {};
  const base = `narada-agent-cli --identity ${normalizedIdentity} --session ${normalizedSession}`;
  return {
    session_operations: `${base} --session-operations`,
    session_operations_json: `${base} --session-operations-json`,
    session_read: `${base} --session-read`,
    session_read_json: `${base} --session-read-json`,
    session_recovery: `${base} --session-recovery`,
    session_recovery_json: `${base} --session-recovery-json`,
    session_events: `${base} --session-events --session-events-filter all --session-events-count ${eventCount}`,
    session_events_issues: `${base} --session-events --session-events-filter issues --session-events-count ${eventCount}`,
    session_events_diagnostics: `${base} --session-events --session-events-filter diagnostics --session-events-count ${eventCount}`,
  };
}

function buildPersistedHostCommandOutputHandoffs({ session, identity = IDENTITY, outputRef = null } = {}) {
  const normalizedSession = String(session ?? '').trim();
  const normalizedIdentity = String(identity ?? IDENTITY).trim() || IDENTITY;
  const normalizedOutputRef = String(outputRef ?? '').trim();
  if (!normalizedSession || !normalizedOutputRef) return {};
  const base = `narada-agent-cli --identity ${normalizedIdentity} --session ${normalizedSession}`;
  return {
    host_command_output_read: `${base} --host-command-output-read --host-command-output-ref ${normalizedOutputRef}`,
    host_command_output_read_json: `${base} --host-command-output-read-json --host-command-output-ref ${normalizedOutputRef}`,
  };
}

function serverPreflightRecovery({ requestId, mcpPreflightArtifact = readMcpPreflightArtifact() }) {
  const mcpPreflightSnapshot = createMcpPreflightArtifactSnapshot(mcpPreflightArtifact);
  return {
    request_id: requestId,
    transport: 'jsonl_stdio',
    event: 'preflight_recovery',
    ...mcpPreflightSnapshot,
  };
}

function buildMcpPreflightHandoffs({ session, identity = IDENTITY } = {}) {
  const normalizedSession = String(session ?? '').trim();
  const normalizedIdentity = String(identity ?? IDENTITY).trim() || IDENTITY;
  if (!normalizedSession) return {};
  const base = `narada-agent-cli --identity ${normalizedIdentity} --session ${normalizedSession}`;
  return {
    mcp_preflight_read: `${base} --mcp-preflight-read`,
    mcp_preflight_read_json: `${base} --mcp-preflight-read-json`,
    mcp_preflight_diagnostics: `${base} --mcp-preflight-diagnostics --mcp-preflight-diagnostics-filter all`,
    mcp_preflight_diagnostics_json: `${base} --mcp-preflight-diagnostics-json --mcp-preflight-diagnostics-filter all`,
  };
}

function createMcpPreflightWorkflowSnapshot({
  mcpOperationalState = 'unknown',
  session = SESSION,
  identity = IDENTITY,
} = {}) {
  const handoffs = buildMcpPreflightHandoffs({ session, identity });
  if (mcpOperationalState === 'runtime_faulted') {
    return {
      recommended_action: 'review_runtime_diagnostics',
      recommended_action_display: 'review runtime diagnostics',
      recommended_command: handoffs.mcp_preflight_read ?? null,
      recovery_kind: 'diagnostic_review',
      recovery_kind_display: 'diagnostic review',
      recovery_primary_command: handoffs.mcp_preflight_read ?? null,
      recovery_followup_command: handoffs.mcp_preflight_read_json ?? null,
      handoffs,
    };
  }
  if (mcpOperationalState === 'startup_degraded') {
    return {
      recommended_action: 'review_startup_diagnostics',
      recommended_action_display: 'review startup diagnostics',
      recommended_command: handoffs.mcp_preflight_read ?? null,
      recovery_kind: 'startup_diagnostic_review',
      recovery_kind_display: 'startup diagnostic review',
      recovery_primary_command: handoffs.mcp_preflight_read ?? null,
      recovery_followup_command: handoffs.mcp_preflight_read_json ?? null,
      handoffs,
    };
  }
  return {
    recommended_action: 'start_session',
    recommended_action_display: 'start session',
    recommended_command: null,
    recovery_kind: 'no_recovery',
    recovery_kind_display: 'no recovery',
    recovery_primary_command: null,
    recovery_followup_command: null,
    handoffs,
  };
}

function createMcpPreflightPayload({
  identity = IDENTITY,
  session = SESSION,
  siteRoot = SITE_ROOT,
  artifactPath = null,
  generatedAt = null,
  mcpStatus = {},
  mcpServerCount = 0,
  toolCount = 0,
} = {}) {
  const workflow = createMcpPreflightWorkflowSnapshot({
    mcpOperationalState: mcpStatus.mcp_operational_state ?? 'unknown',
    session,
    identity,
  });
  return {
    identity,
    session,
    site_root: siteRoot,
    mcp_server_count: mcpServerCount,
    tool_count: toolCount,
    artifact_path: artifactPath,
    generated_at: generatedAt,
    ...mcpStatus,
    mcp_startup_failures: Array.isArray(mcpStatus.mcp_startup_failures) ? mcpStatus.mcp_startup_failures : [],
    mcp_runtime_faults: Array.isArray(mcpStatus.mcp_runtime_faults) ? mcpStatus.mcp_runtime_faults : [],
    ...workflow,
  };
}

function normalizeMcpPreflightDiagnosticsFilter(value) {
  const normalized = String(value ?? 'all').trim().toLowerCase();
  if (['all', 'startup', 'runtime'].includes(normalized)) return normalized;
  return 'all';
}

function formatMcpPreflightDiagnosticDisplay(code) {
  const normalized = String(code ?? 'unknown').trim();
  return normalized.length > 0 ? normalized.replace(/_/g, ' ') : 'unknown';
}

function createMcpPreflightDiagnosticEntry({ artifact = {}, diagnostic = {}, diagnosticLane = 'startup' } = {}) {
  const diagnosticCode = String(diagnostic?.code ?? 'unknown').trim() || 'unknown';
  const serverName = String(diagnostic?.server_name ?? 'unknown').trim() || 'unknown';
  const toolName = String(diagnostic?.tool_name ?? '').trim() || null;
  const stdoutPollutionCount = Array.isArray(diagnostic?.stdout_pollution) ? diagnostic.stdout_pollution.length : 0;
  const stderrCount = Array.isArray(diagnostic?.stderr) ? diagnostic.stderr.length : 0;
  const detailSummaryParts = [];
  if (toolName) detailSummaryParts.push(`tool=${toolName}`);
  if (stdoutPollutionCount > 0) detailSummaryParts.push(`stdout=${stdoutPollutionCount}`);
  if (stderrCount > 0) detailSummaryParts.push(`stderr=${stderrCount}`);
  return {
    session: artifact.session,
    identity: artifact.identity,
    generated_at: artifact.generated_at ?? null,
    artifact_path: artifact.artifact_path ?? null,
    mcp_operational_state: artifact.mcp_operational_state ?? 'unknown',
    recommended_action: artifact.recommended_action ?? 'unknown',
    recommended_action_display: artifact.recommended_action_display ?? formatMcpPreflightDiagnosticDisplay(artifact.recommended_action),
    recommended_command: artifact.recommended_command ?? null,
    recovery_kind: artifact.recovery_kind ?? 'unknown',
    recovery_kind_display: artifact.recovery_kind_display ?? formatMcpPreflightDiagnosticDisplay(artifact.recovery_kind),
    recovery_primary_command: artifact.recovery_primary_command ?? null,
    recovery_followup_command: artifact.recovery_followup_command ?? null,
    handoffs: artifact.handoffs ?? {},
    diagnostic_lane: diagnosticLane,
    diagnostic_lane_display: diagnosticLane,
    diagnostic_code: diagnosticCode,
    diagnostic_code_display: formatMcpPreflightDiagnosticDisplay(diagnosticCode),
    server_name: serverName,
    server_name_display: serverName,
    tool_name: toolName,
    message: diagnostic?.message ?? null,
    phase: diagnostic?.phase ?? null,
    stdout_pollution_count: stdoutPollutionCount,
    stderr_count: stderrCount,
    detail_summary: detailSummaryParts.length > 0 ? detailSummaryParts.join('; ') : 'none',
    diagnostic,
  };
}

function summarizeMcpPreflightDiagnostics(inventory = [], { diagnosticFilter = 'all' } = {}) {
  const normalizedDiagnosticFilter = normalizeMcpPreflightDiagnosticsFilter(diagnosticFilter);
  const matchedArtifacts = [];
  const diagnostics = [];
  const diagnosticLaneCounts = {};
  const diagnosticCodeCounts = {};
  const serverNameCounts = {};
  const recommendedActionCounts = {};
  const recommendedCommandCounts = {};
  const recoveryPrimaryCounts = {};
  const recoveryFollowupCounts = {};
  for (const artifact of inventory) {
    const artifactDiagnostics = [];
    if (normalizedDiagnosticFilter === 'all' || normalizedDiagnosticFilter === 'startup') {
      for (const diagnostic of Array.isArray(artifact?.mcp_startup_failures) ? artifact.mcp_startup_failures : []) {
        artifactDiagnostics.push(createMcpPreflightDiagnosticEntry({ artifact, diagnostic, diagnosticLane: 'startup' }));
      }
    }
    if (normalizedDiagnosticFilter === 'all' || normalizedDiagnosticFilter === 'runtime') {
      for (const diagnostic of Array.isArray(artifact?.mcp_runtime_faults) ? artifact.mcp_runtime_faults : []) {
        artifactDiagnostics.push(createMcpPreflightDiagnosticEntry({ artifact, diagnostic, diagnosticLane: 'runtime' }));
      }
    }
    if (artifactDiagnostics.length === 0) continue;
    const artifactCodeCounts = {};
    for (const entry of artifactDiagnostics) {
      diagnostics.push(entry);
      incrementInventoryCounter(diagnosticLaneCounts, entry.diagnostic_lane);
      incrementInventoryCounter(diagnosticCodeCounts, entry.diagnostic_code);
      incrementInventoryCounter(serverNameCounts, entry.server_name);
      incrementInventoryCounter(artifactCodeCounts, entry.diagnostic_code);
    }
    incrementInventoryCounter(recommendedActionCounts, artifact?.recommended_action ?? 'unknown');
    incrementInventoryCounter(recommendedCommandCounts, artifact?.recommended_command ?? 'none');
    incrementInventoryCounter(recoveryPrimaryCounts, artifact?.recovery_primary_command ?? 'none');
    incrementInventoryCounter(recoveryFollowupCounts, artifact?.recovery_followup_command ?? 'none');
    matchedArtifacts.push({
      ...artifact,
      matched_diagnostic_count: artifactDiagnostics.length,
      matched_diagnostic_code_counts: artifactCodeCounts,
      matched_diagnostic_code_summary: formatInventoryCounts(artifactCodeCounts),
      diagnostics: artifactDiagnostics,
    });
  }
  return {
    diagnostic_count: diagnostics.length,
    artifacts_with_diagnostics: matchedArtifacts.length,
    diagnostic_lane_counts: diagnosticLaneCounts,
    diagnostic_lane_summary: formatInventoryCounts(diagnosticLaneCounts),
    diagnostic_code_counts: diagnosticCodeCounts,
    diagnostic_code_summary: formatInventoryCounts(diagnosticCodeCounts),
    server_name_counts: serverNameCounts,
    server_name_summary: formatInventoryCounts(serverNameCounts),
    recommended_action_counts: recommendedActionCounts,
    recommended_action_summary: formatInventoryCounts(recommendedActionCounts),
    recommended_command_counts: recommendedCommandCounts,
    recommended_command_summary: formatInventoryCounts(recommendedCommandCounts),
    recovery_primary_counts: recoveryPrimaryCounts,
    recovery_primary_summary: formatInventoryCounts(recoveryPrimaryCounts),
    recovery_followup_counts: recoveryFollowupCounts,
    recovery_followup_summary: formatInventoryCounts(recoveryFollowupCounts),
    groups: {
      diagnostic_lane: summarizeSessionInventoryGroupBy(diagnostics, 'diagnostic_lane', 'diagnostic_lane_display'),
      diagnostic_code: summarizeSessionInventoryGroupBy(diagnostics, 'diagnostic_code', 'diagnostic_code_display'),
      server_name: summarizeSessionInventoryGroupBy(diagnostics, 'server_name', 'server_name_display'),
    },
    workflow_groups: summarizeActionWorkflowGroups(matchedArtifacts),
    diagnostics,
    artifacts: matchedArtifacts,
  };
}

function renderMcpPreflightDiagnostics(artifacts = []) {
  return artifacts.map((item) => {
    const block = formatKeyValueRows({
      Session: item.session,
      Identity: item.identity,
      Generated: item.generated_at ?? 'unknown',
      'MCP state': item.mcp_operational_state,
      'Matched diagnostics': item.matched_diagnostic_count ?? 0,
      'Diagnostic codes': item.matched_diagnostic_code_summary ?? '0',
      'Recommended action': item.recommended_action_display ?? 'unknown',
      'Recommended command': item.recommended_command ?? 'none',
      'Recovery primary': item.recovery_primary_command ?? 'none',
      'Recovery followup': item.recovery_followup_command ?? 'none',
      'Preflight review': item?.handoffs?.mcp_preflight_read ?? 'none',
      'Preflight diagnostics': item?.handoffs?.mcp_preflight_diagnostics ?? 'none',
      Artifact: item.artifact_path ?? 'none',
    });
    const diagnosticLines = item.diagnostics.map((entry) => `- ${entry.diagnostic_lane} ${entry.server_name}${entry.tool_name ? `/${entry.tool_name}` : ''} ${entry.diagnostic_code}${entry.message ? `: ${entry.message}` : ''}${entry.detail_summary !== 'none' ? ` [${entry.detail_summary}]` : ''}`);
    return `${block}\nDiagnostics:\n${diagnosticLines.join('\n')}`;
  });
}

function summarizePersistedSessionRecommendedAction({
  operationalPosture = 'healthy',
  mcpOperationalState = 'unknown',
  requestPosture = 'clean',
  handoffs = {},
} = {}) {
  const recoveryCommand = handoffs.session_recovery ?? null;
  if (mcpOperationalState === 'runtime_faulted') {
    return {
      recommended_action: 'review_runtime_diagnostics',
      recommended_action_display: 'review runtime diagnostics',
      recommended_command: recoveryCommand,
    };
  }
  if (mcpOperationalState === 'startup_degraded') {
    return {
      recommended_action: 'review_startup_diagnostics',
      recommended_action_display: 'review startup diagnostics',
      recommended_command: recoveryCommand,
    };
  }
  if (requestPosture === 'runtime_failures') {
    return {
      recommended_action: 'review_request_issues',
      recommended_action_display: 'review request issues',
      recommended_command: recoveryCommand,
    };
  }
  if (requestPosture === 'invalid_control_traffic') {
    return {
      recommended_action: 'review_invalid_control_traffic',
      recommended_action_display: 'review invalid control traffic',
      recommended_command: recoveryCommand,
    };
  }
  if (requestPosture === 'closed_session_retries') {
    return {
      recommended_action: 'review_closed_session_retries',
      recommended_action_display: 'review closed session retries',
      recommended_command: recoveryCommand,
    };
  }
  if (operationalPosture === 'lifecycle_failed') {
    return {
      recommended_action: 'review_session_events',
      recommended_action_display: 'review session events',
      recommended_command: recoveryCommand,
    };
  }
  return {
    recommended_action: 'review_session_summary',
    recommended_action_display: 'review session summary',
    recommended_command: handoffs.session_read ?? null,
  };
}

function summarizePersistedSessionRecoveryPlan({
  operationalPosture = 'healthy',
  mcpOperationalState = 'unknown',
  requestPosture = 'clean',
  handoffs = {},
} = {}) {
  if (mcpOperationalState === 'runtime_faulted') {
    return {
      recovery_kind: 'diagnostic_review',
      recovery_kind_display: 'diagnostic review',
      recovery_primary_command: handoffs.session_events_diagnostics ?? null,
      recovery_followup_command: handoffs.session_read ?? null,
    };
  }
  if (mcpOperationalState === 'startup_degraded') {
    return {
      recovery_kind: 'startup_diagnostic_review',
      recovery_kind_display: 'startup diagnostic review',
      recovery_primary_command: handoffs.session_events_diagnostics ?? null,
      recovery_followup_command: handoffs.session_read ?? null,
    };
  }
  if (requestPosture === 'runtime_failures') {
    return {
      recovery_kind: 'issue_review',
      recovery_kind_display: 'issue review',
      recovery_primary_command: handoffs.session_events_issues ?? null,
      recovery_followup_command: handoffs.session_events ?? null,
    };
  }
  if (requestPosture === 'invalid_control_traffic') {
    return {
      recovery_kind: 'invalid_control_review',
      recovery_kind_display: 'invalid control review',
      recovery_primary_command: handoffs.session_events_issues ?? null,
      recovery_followup_command: handoffs.session_read ?? null,
    };
  }
  if (requestPosture === 'closed_session_retries') {
    return {
      recovery_kind: 'closed_session_review',
      recovery_kind_display: 'closed session review',
      recovery_primary_command: handoffs.session_events_issues ?? null,
      recovery_followup_command: handoffs.session_read ?? null,
    };
  }
  if (operationalPosture === 'lifecycle_failed') {
    return {
      recovery_kind: 'lifecycle_review',
      recovery_kind_display: 'lifecycle review',
      recovery_primary_command: handoffs.session_events ?? null,
      recovery_followup_command: handoffs.session_read ?? null,
    };
  }
  return {
    recovery_kind: 'no_recovery',
    recovery_kind_display: 'no recovery',
    recovery_primary_command: handoffs.session_read ?? null,
    recovery_followup_command: null,
  };
}

function summarizeActionWorkflowGroups(actions = []) {
  const groups = Object.create(null);
  for (const item of actions) {
    const key = String(item?.recommended_action ?? 'unknown');
    if (!groups[key]) {
      groups[key] = {
        display: item?.recommended_action_display ?? item?.recommended_action ?? 'unknown',
        recommended_command_counts: {},
        recovery_kind_counts: {},
        recovery_primary_counts: {},
        recovery_followup_counts: {},
        sessions: [],
      };
    }
    const group = groups[key];
    incrementInventoryCounter(group.recommended_command_counts, item?.recommended_command ?? 'none');
    incrementInventoryCounter(group.recovery_kind_counts, item?.recovery_kind ?? 'unknown');
    incrementInventoryCounter(group.recovery_primary_counts, item?.recovery_primary_command ?? 'none');
    incrementInventoryCounter(group.recovery_followup_counts, item?.recovery_followup_command ?? 'none');
    group.sessions.push({
      session: item?.session ?? 'unknown',
      display: item?.recovery_kind_display ?? item?.recovery_kind ?? 'unknown',
      heartbeat_at: item?.heartbeat_at ?? null,
    });
  }
  return Object.fromEntries(Object.entries(groups)
    .sort((left, right) => right[1].sessions.length - left[1].sessions.length || left[0].localeCompare(right[0]))
    .map(([key, group]) => [key, {
      display: group.display,
      recommended_command_counts: group.recommended_command_counts,
      recommended_command_summary: formatInventoryCounts(group.recommended_command_counts),
      recovery_kind_counts: group.recovery_kind_counts,
      recovery_kind_summary: formatInventoryCounts(group.recovery_kind_counts),
      recovery_primary_counts: group.recovery_primary_counts,
      recovery_primary_summary: formatInventoryCounts(group.recovery_primary_counts),
      recovery_followup_counts: group.recovery_followup_counts,
      recovery_followup_summary: formatInventoryCounts(group.recovery_followup_counts),
      sessions: group.sessions
        .sort((left, right) => String(right.heartbeat_at ?? '').localeCompare(String(left.heartbeat_at ?? '')) || left.session.localeCompare(right.session))
        .map(({ session, display }) => ({ session, display })),
    }]));
}

function summarizeSessionInventoryActions(inventory = []) {
  const recommendedActionCounts = {};
  const recommendedCommandCounts = {};
  const recoveryPrimaryCounts = {};
  const recoveryFollowupCounts = {};
  const actions = [];
  for (const item of inventory) {
    const recommendedAction = item?.recommended_action ?? 'review_session_summary';
    incrementInventoryCounter(recommendedActionCounts, recommendedAction);
    incrementInventoryCounter(recommendedCommandCounts, item?.recommended_command ?? 'none');
    incrementInventoryCounter(recoveryPrimaryCounts, item?.recovery_primary_command ?? 'none');
    incrementInventoryCounter(recoveryFollowupCounts, item?.recovery_followup_command ?? 'none');
    actions.push(item);
  }
  return {
    recommended_action_counts: recommendedActionCounts,
    recommended_action_summary: formatInventoryCounts(recommendedActionCounts),
    recommended_command_counts: recommendedCommandCounts,
    recommended_command_summary: formatInventoryCounts(recommendedCommandCounts),
    recovery_primary_counts: recoveryPrimaryCounts,
    recovery_primary_summary: formatInventoryCounts(recoveryPrimaryCounts),
    recovery_followup_counts: recoveryFollowupCounts,
    recovery_followup_summary: formatInventoryCounts(recoveryFollowupCounts),
    workflow_groups: summarizeActionWorkflowGroups(actions),
    action_count: actions.length,
    actions,
  };
}

function summarizeSessionInventoryRecoveryQueue(inventory = []) {
  const recoveryActions = inventory.filter((item) => item?.recommended_action !== 'review_session_summary');
  const recommendedActionCounts = {};
  const recoveryKindCounts = {};
  const recoveryPrimaryCounts = {};
  const recoveryFollowupCounts = {};
  for (const item of recoveryActions) {
    incrementInventoryCounter(recommendedActionCounts, item?.recommended_action ?? 'unknown');
    incrementInventoryCounter(recoveryKindCounts, item?.recovery_kind ?? 'unknown');
    incrementInventoryCounter(recoveryPrimaryCounts, item?.recovery_primary_command ?? 'none');
    incrementInventoryCounter(recoveryFollowupCounts, item?.recovery_followup_command ?? 'none');
  }
  return {
    recovery_count: recoveryActions.length,
    recommended_action_counts: recommendedActionCounts,
    recommended_action_summary: formatInventoryCounts(recommendedActionCounts),
    recovery_kind_counts: recoveryKindCounts,
    recovery_kind_summary: formatInventoryCounts(recoveryKindCounts),
    recovery_primary_counts: recoveryPrimaryCounts,
    recovery_primary_summary: formatInventoryCounts(recoveryPrimaryCounts),
    recovery_followup_counts: recoveryFollowupCounts,
    recovery_followup_summary: formatInventoryCounts(recoveryFollowupCounts),
    groups: summarizeSessionInventoryGroupBy(recoveryActions, 'recommended_action', 'recommended_action_display'),
    workflow_groups: summarizeActionWorkflowGroups(recoveryActions),
    actions: recoveryActions,
  };
}

function renderSessionInventoryActions(actions = []) {
  return actions.map((item) => formatKeyValueRows({
    Session: item.session,
    Heartbeat: item.heartbeat_display,
    'Operational posture': item.operational_posture_display,
    'MCP state': item.mcp_operational_state,
    'Request posture': item.request_posture_display,
    'Recommended action': item.recommended_action_display,
    'Recommended command': item.recommended_command ?? 'none',
    'Recovery kind': item.recovery_kind_display ?? 'none',
    'Recovery primary': item.recovery_primary_command ?? 'none',
    'Recovery followup': item.recovery_followup_command ?? 'none',
    'Session read': item?.handoffs?.session_read ?? 'none',
    'Session recovery': item?.handoffs?.session_recovery ?? 'none',
    'Session issues': item?.handoffs?.session_events_issues ?? 'none',
    'Session diagnostics': item?.handoffs?.session_events_diagnostics ?? 'none',
    'Host command output review': item?.handoffs?.host_command_output_read ?? 'none',
  }));
}

function renderSessionInventoryWorkflowGroups(groups = {}, { heading = 'Workflow groups' } = {}) {
  const sections = [];
  for (const [groupKey, group] of Object.entries(groups)) {
    const sessions = Array.isArray(group?.sessions) ? group.sessions : [];
    const lines = [`${heading}: ${groupKey} (${sessions.length})`];
    if (group?.recommended_command_summary) lines.push(`Recommended commands: ${group.recommended_command_summary}`);
    if (group?.recovery_kind_summary) lines.push(`Recovery kinds: ${group.recovery_kind_summary}`);
    if (group?.recovery_primary_summary) lines.push(`Primary commands: ${group.recovery_primary_summary}`);
    if (group?.recovery_followup_summary) lines.push(`Followup commands: ${group.recovery_followup_summary}`);
    for (const entry of sessions.slice(0, 5)) {
      lines.push(`- ${entry.session} ${entry.display ?? groupKey}`);
    }
    sections.push(lines.join('\n'));
  }
  return sections.join('\n\n');
}

function renderSessionInventoryEventGroups(groups = {}) {
  const sections = [];
  for (const [groupKey, buckets] of Object.entries(groups)) {
    const lines = [`Event groups: ${groupKey}`];
    for (const [bucketKey, entries] of Object.entries(buckets)) {
      lines.push(`- ${bucketKey} (${entries.length})`);
      for (const entry of entries.slice(0, 5)) {
        lines.push(`  ${formatPersistedSessionInventoryEventLine(entry)}`);
      }
    }
    sections.push(lines.join('\n'));
  }
  return sections.join('\n\n');
}

function summarizeSessionInventoryGroups(inventory = []) {
  return {
    operational_posture: summarizeSessionInventoryGroupBy(inventory, 'operational_posture', 'operational_posture_display'),
    request_posture: summarizeSessionInventoryGroupBy(inventory, 'request_posture', 'request_posture_display'),
    mcp_state: summarizeSessionInventoryGroupBy(inventory, 'mcp_operational_state', 'mcp_operational_state'),
    heartbeat_status: summarizeSessionInventoryGroupBy(inventory, 'heartbeat_status', 'heartbeat_display'),
  };
}

function summarizeSessionInventoryGroupBy(inventory = [], keyField, displayField) {
  const groups = Object.create(null);
  for (const item of inventory) {
    const key = String(item?.[keyField] ?? 'unknown');
    if (!groups[key]) groups[key] = [];
    groups[key].push({
      session: item.session,
      display: item?.[displayField] ?? item?.[keyField] ?? 'unknown',
      heartbeat_at: item?.heartbeat_at ?? null,
    });
  }
  return Object.fromEntries(Object.entries(groups)
    .sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]))
    .map(([key, entries]) => [key, entries
      .sort((left, right) => String(right.heartbeat_at ?? '').localeCompare(String(left.heartbeat_at ?? '')) || left.session.localeCompare(right.session))
      .map(({ session, display }) => ({ session, display }))]));
}

function renderSessionInventoryGroups(groups = {}) {
  const sections = [];
  for (const [groupKey, buckets] of Object.entries(groups)) {
    const lines = [`Groups: ${groupKey}`];
    for (const [bucketKey, entries] of Object.entries(buckets)) {
      lines.push(`- ${bucketKey} (${entries.length})`);
      for (const entry of entries.slice(0, 5)) {
        lines.push(`  - ${entry.session}: ${entry.display}`);
      }
    }
    sections.push(lines.join('\n'));
  }
  return sections.join('\n\n');
}

function noteSessionActivity(state, eventKind, occurredAt = new Date().toISOString(), terminalState = null) {
  if (!state) return;
  state.sessionEventCount = (state.sessionEventCount ?? 0) + 1;
  state.lastEventKind = eventKind;
  state.lastEventAt = occurredAt;
  if (terminalState) state.lastTerminalState = terminalState;
}

function incrementSessionCounter(counts, key) {
  if (!counts || !key) return;
  counts[key] = (counts[key] ?? 0) + 1;
}

function classifySessionIssueOutcomeCode(issueCode) {
  const normalizedCode = String(issueCode ?? '');
  if (!normalizedCode) return null;
  if (normalizedCode === 'session_closed') return 'rejected_closed';
  if (normalizedCode === 'request_dispatch_failed') return 'dispatch_failure';
  if (normalizedCode === 'request_failed') return 'request_runtime_failure';
  if (normalizedCode === 'interactive_loop_error') return 'interactive_runtime_failure';
  if (
    normalizedCode === 'invalid_json'
    || normalizedCode === 'message_required'
    || normalizedCode === 'directive_message_required'
    || normalizedCode.startsWith('invalid_')
    || normalizedCode.startsWith('unsupported_')
    || normalizedCode.startsWith('unknown_')
    || normalizedCode.endsWith('_required')
  ) {
    return 'invalid_request';
  }
  return 'request_error';
}

function recordSessionRequestIssue(state, issueCode) {
  if (!state || !issueCode) return;
  if (!state.requestIssueCounts) state.requestIssueCounts = {};
  if (!state.requestOutcomeCounts) state.requestOutcomeCounts = {};
  incrementSessionCounter(state.requestIssueCounts, issueCode);
  const issueOutcome = classifySessionIssueOutcomeCode(issueCode);
  if (issueOutcome) incrementSessionCounter(state.requestOutcomeCounts, issueOutcome);
}

function createRequestPostureSnapshot(state = {}) {
  const requestIssueCounts = state.requestIssueCounts ?? {};
  const requestOutcomeCounts = state.requestOutcomeCounts ?? {};
  const requestPosture = summarizeRequestPosture(requestOutcomeCounts);
  return {
    request_outcome_total: requestPosture.request_outcome_total,
    request_posture: requestPosture.request_posture,
    request_posture_display: requestPosture.request_posture_display,
    request_outcome_counts: requestOutcomeCounts,
    request_outcome_summary: formatInventoryCounts(requestOutcomeCounts),
    request_issue_counts: requestIssueCounts,
    request_issue_summary: formatInventoryCounts(requestIssueCounts),
  };
}

function createLiveWorkflowSnapshot({
  state = {},
  mcpOperationalState = 'unknown',
  session = SESSION,
  identity = IDENTITY,
} = {}) {
  const requestPosture = createRequestPostureSnapshot(state);
  const operationalPosture = summarizeOperationalPosture({
    mcpOperationalState,
    requestPosture: requestPosture.request_posture,
    lastLifecycleState: state.lastTerminalState ?? null,
  });
  const handoffs = buildPersistedSessionHandoffs({ session, identity });
  const recommendedAction = summarizePersistedSessionRecommendedAction({
    operationalPosture: operationalPosture.operational_posture,
    mcpOperationalState,
    requestPosture: requestPosture.request_posture,
    handoffs,
  });
  const recoveryPlan = summarizePersistedSessionRecoveryPlan({
    operationalPosture: operationalPosture.operational_posture,
    mcpOperationalState,
    requestPosture: requestPosture.request_posture,
    handoffs,
  });
  return {
    operational_posture: operationalPosture.operational_posture,
    operational_posture_display: operationalPosture.operational_posture_display,
    ...requestPosture,
    recommended_action: recommendedAction.recommended_action,
    recommended_action_display: recommendedAction.recommended_action_display,
    recommended_command: recommendedAction.recommended_command,
    recovery_kind: recoveryPlan.recovery_kind,
    recovery_kind_display: recoveryPlan.recovery_kind_display,
    recovery_primary_command: recoveryPlan.recovery_primary_command,
    recovery_followup_command: recoveryPlan.recovery_followup_command,
    handoffs,
  };
}

function createOperationalPostureSnapshot({ state = {}, mcpOperationalState = 'unknown' } = {}) {
  return createLiveWorkflowSnapshot({ state, mcpOperationalState });
}

function createSessionActivitySnapshot(state = {}) {
  return {
    agent_id: IDENTITY,
    runtime: 'agent-cli',
    mode: 'server',
    started_at: state.startedAt ?? null,
    session_event_count: state.sessionEventCount ?? 0,
    last_event_kind: state.lastEventKind ?? null,
    last_event_at: state.lastEventAt ?? null,
    last_terminal_state: state.lastTerminalState ?? null,
    ...createRequestPostureSnapshot(state),
  };
}

function parseNarsDelegatedAuthorityHandoff(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  try {
    const parsed = JSON.parse(String(value));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('handoff_not_object');
    if (parsed.schema !== 'narada.nars.delegated_authority_handoff.v1') throw new Error('handoff_schema_mismatch');
    if (parsed.crossing_regime !== 'nars_runtime_server_to_carrier_substrate') throw new Error('handoff_crossing_regime_mismatch');
    return {
      ...parsed,
      parse_status: 'accepted',
    };
  } catch (error) {
    return {
      schema: 'narada.nars.delegated_authority_handoff.v1',
      parse_status: 'invalid',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function createMcpPreflightArtifactSnapshot(preflightArtifact) {
  if (!preflightArtifact) {
    return {
      mcp_preflight_artifact_path: null,
      mcp_preflight_artifact_generated_at: null,
      mcp_preflight_operational_state: null,
      mcp_preflight_startup_failure_summary: null,
      mcp_preflight_runtime_fault_summary: null,
      mcp_preflight_recommended_action: null,
      mcp_preflight_recommended_action_display: null,
      mcp_preflight_recommended_command: null,
      mcp_preflight_recovery_kind: null,
      mcp_preflight_recovery_kind_display: null,
      mcp_preflight_recovery_primary_command: null,
      mcp_preflight_recovery_followup_command: null,
      mcp_preflight_handoffs: null,
    };
  }
  return {
    mcp_preflight_artifact_path: preflightArtifact.artifact_path,
    mcp_preflight_artifact_generated_at: preflightArtifact.generated_at,
    mcp_preflight_operational_state: preflightArtifact.mcp_operational_state,
    mcp_preflight_startup_failure_summary: preflightArtifact.mcp_startup_failure_summary,
    mcp_preflight_runtime_fault_summary: preflightArtifact.mcp_runtime_fault_summary,
    mcp_preflight_recommended_action: preflightArtifact.recommended_action ?? null,
    mcp_preflight_recommended_action_display: preflightArtifact.recommended_action_display ?? null,
    mcp_preflight_recommended_command: preflightArtifact.recommended_command ?? null,
    mcp_preflight_recovery_kind: preflightArtifact.recovery_kind ?? null,
    mcp_preflight_recovery_kind_display: preflightArtifact.recovery_kind_display ?? null,
    mcp_preflight_recovery_primary_command: preflightArtifact.recovery_primary_command ?? null,
    mcp_preflight_recovery_followup_command: preflightArtifact.recovery_followup_command ?? null,
    mcp_preflight_handoffs: preflightArtifact.handoffs ?? null,
  };
}

function createRuntimeHeaderRows({
  mcpServers,
  allTools,
  sessionSettings,
  transcriptDisplaySettings,
} = {}) {
  const mcpStatus = createMcpStatusSnapshot(mcpServers);
  return [
    ['Identity', IDENTITY],
    ['Session', SESSION],
    ['Provider', INTELLIGENCE_PROVIDER],
    ['Model', sessionSettings.model],
    ['Thinking', sessionSettings.thinking],
    ['Stream', sessionSettings.stream ? 'on' : 'off'],
    ['Goal', carrierGoalStatusLabel(sessionSettings.goal)],
    ['MCP servers', Object.keys(mcpServers).length],
    ['MCP state', mcpStatus.mcp_operational_state],
    ...(mcpStatus.mcp_startup_failure_count > 0 ? [['MCP startup failures', mcpStatus.mcp_startup_failure_summary]] : []),
    ...(mcpStatus.mcp_runtime_fault_count > 0 ? [['MCP runtime faults', mcpStatus.mcp_runtime_fault_summary]] : []),
    ...Object.entries(mcpServers)
      .filter(([, srv]) => Array.isArray(srv?.tools))
      .map(([name, srv]) => [`  ${name}`, `${srv.tools.length} tools`]),
    ['Tools', allTools.length],
    ['Tool outputs', transcriptDisplaySettings.toolOutputs ? 'shown' : 'hidden'],
    ['Approvals', 'disabled'],
    ['Help', '/help'],
  ];
}

function mcpServerSummaryEntries(mcpServers) {
  return Object.entries(mcpServers ?? {})
    .filter(([, server]) => Array.isArray(server?.tools))
    .map(([name, server]) => ({
      name,
      tool_count: server.tools.length,
    }));
}

function environmentBlockLength(env) {
  return Object.entries(env).reduce((total, [key, value]) => total + key.length + String(value ?? '').length + 2, 1);
}

function terminateChildProcessTree(child, { forceAfterMs = 1500 } = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    try {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('error', () => {});
      killer.unref?.();
    } catch {}
    return;
  }
  try { child.kill('SIGTERM'); } catch {}
  setTimeout(() => {
    if (!child.killed && child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch {}
    }
  }, forceAfterMs).unref?.();
}

const terminalRendering = createTerminalRendering({
  identity: IDENTITY,
  terminalStyle: createTerminalStyle({
    enabled: options.color ?? parseColorEnv(process.env.NARADA_AGENT_CLI_COLOR, false),
  }),
  isObserverInputEvent,
  observerVisibility,
  stringifySummary,
});
const {
  terminalStyle,
  printHeader,
  clearTerminalDisplay,
  printHeaderRow,
  printHeaderRows,
  formatHeaderRows,
  formatHeaderRow,
  printToolRequestLine,
  printToolResultLine,
  toolDirectionLabel,
  styleInputRouteLabel,
  printInlineEvent,
  printAgentMessage,
  printCliMessage,
  copyToClipboard,
  printHostCommandResult,
  printInputRecord,
  inputRecordDisplayLabel,
  printOperatorMessage,
  rewriteSubmittedPrompt,
  rewriteSubmittedPromptForTest,
  clearPreviousTerminalRows,
  formatSubmittedPrompt,
  printMessageBlock,
  writeTerminalRecord,
  appendSuffixToLastLine,
  formatTimestamp,
  renderMarkdownForTerminal,
  styleInlineCode,
  normalizeDisplayTerms,
  transformOutsideInlineCode,
  terminalWidth,
  wrapTerminalLine,
  formatToolResultContent,
  formatKeyValueRows,
  formatDuration,
  formatProgressStatus,
  sanitizeOperatorDirectiveDraftForDisplay,
} = terminalRendering;

// Session persistence
const NARADA_DIR = basename(SITE_ROOT) === '.narada' ? SITE_ROOT : join(SITE_ROOT, '.narada');
const SESSION_DIR = join(NARADA_DIR, 'crew', 'nars-sessions', SESSION);
if (!UTILITY_COMMAND_MODE && !existsSync(SESSION_DIR)) mkdirSync(SESSION_DIR, { recursive: true });
const SESSION_PATH = join(SESSION_DIR, 'session.jsonl');
const EVENTS_PATH = join(SESSION_DIR, 'events.jsonl');
let SERVER_EVENT_SEQUENCE = 0;

configureProviderAdapterContext({
  provider: INTELLIGENCE_PROVIDER,
  apiKey: API_KEY,
  baseUrl: BASE_URL,
  model: MODEL,
  thinking: THINKING_LEVEL,
  siteRoot: SITE_ROOT,
  nativeMcpTools: CODEX_NATIVE_MCP_TOOLS,
  sessionDir: SESSION_DIR,
  buildChildProcessEnv,
  writeDurableTextFile,
});
const CARRIER_SESSION_DIR = join(NARADA_DIR, 'crew', 'nars-sessions', SESSION);
const ENABLE_SESSION_FSYNC = parseBooleanEnv(
  process.env.NARADA_SESSION_FSYNC ?? process.env.NARADA_AGENT_CLI_SESSION_FSYNC,
  false,
);
const HEARTBEAT_PATH = join(CARRIER_SESSION_DIR, 'heartbeat.json');
const MCP_PREFLIGHT_ARTIFACT_DIR = join(NARADA_DIR, 'runtime', 'agent-cli', 'mcp-preflight');
const HEARTBEAT_ENABLED = parseBooleanEnv(process.env.NARADA_AGENT_CLI_HEARTBEAT_ENABLE, true);
const OPERATION_HEARTBEAT_DIRECTIVE_ENABLED = parseBooleanEnv(process.env.NARADA_AGENT_CLI_OPERATION_HEARTBEAT_DIRECTIVE_ENABLE, SERVER_MODE);
const OPERATION_HEARTBEAT_DIRECTIVE_INTERVAL_MS = Number(process.env.NARADA_AGENT_CLI_OPERATION_HEARTBEAT_DIRECTIVE_INTERVAL_MS ?? 60000);
const OPERATION_HEARTBEAT_DIRECTIVE_INITIAL_DELAY_MS = Number(process.env.NARADA_AGENT_CLI_OPERATION_HEARTBEAT_DIRECTIVE_INITIAL_DELAY_MS ?? OPERATION_HEARTBEAT_DIRECTIVE_INTERVAL_MS);
const HOST_COMMANDS_ENABLED = parseBooleanEnv(process.env.NARADA_AGENT_CLI_HOST_COMMANDS, true);
const HOST_COMMAND_OUTPUT_INLINE_LIMIT = 8000;
const HOST_COMMAND_OUTPUT_CAPTURE_LIMIT = 128000;
let activeHeartbeat = null;
let activeOperationHeartbeatDirectiveEmitter = null;

// ---------------------------------------------------------------------------
// Main
async function main() {
  if (MCP_PREFLIGHT_MODE) {
    process.exitCode = await runMcpPreflight();
    return;
  }
  if (MCP_PREFLIGHT_JSON_MODE) {
    process.exitCode = await runMcpPreflight({ jsonOutput: true });
    return;
  }
  if (MCP_PREFLIGHT_READ_MODE) {
    process.exitCode = await runMcpPreflightRead();
    return;
  }
  if (MCP_PREFLIGHT_READ_JSON_MODE) {
    process.exitCode = await runMcpPreflightRead({ jsonOutput: true });
    return;
  }
  if (MCP_PREFLIGHT_INVENTORY_MODE) {
    process.exitCode = await runMcpPreflightInventory({ filterKey: MCP_PREFLIGHT_FILTER_KEY, filterValue: MCP_PREFLIGHT_FILTER_VALUE });
    return;
  }
  if (MCP_PREFLIGHT_INVENTORY_JSON_MODE) {
    process.exitCode = await runMcpPreflightInventory({ jsonOutput: true, filterKey: MCP_PREFLIGHT_FILTER_KEY, filterValue: MCP_PREFLIGHT_FILTER_VALUE });
    return;
  }
  if (MCP_PREFLIGHT_ACTIONS_MODE) {
    process.exitCode = await runMcpPreflightActions({ filterKey: MCP_PREFLIGHT_FILTER_KEY, filterValue: MCP_PREFLIGHT_FILTER_VALUE });
    return;
  }
  if (MCP_PREFLIGHT_ACTIONS_JSON_MODE) {
    process.exitCode = await runMcpPreflightActions({ jsonOutput: true, filterKey: MCP_PREFLIGHT_FILTER_KEY, filterValue: MCP_PREFLIGHT_FILTER_VALUE });
    return;
  }
  if (MCP_PREFLIGHT_RECOVERY_MODE) {
    process.exitCode = await runMcpPreflightRecovery({ filterKey: MCP_PREFLIGHT_FILTER_KEY, filterValue: MCP_PREFLIGHT_FILTER_VALUE });
    return;
  }
  if (MCP_PREFLIGHT_RECOVERY_JSON_MODE) {
    process.exitCode = await runMcpPreflightRecovery({ jsonOutput: true, filterKey: MCP_PREFLIGHT_FILTER_KEY, filterValue: MCP_PREFLIGHT_FILTER_VALUE });
    return;
  }
  if (MCP_PREFLIGHT_DIAGNOSTICS_MODE) {
    process.exitCode = await runMcpPreflightDiagnostics({ filterKey: MCP_PREFLIGHT_FILTER_KEY, filterValue: MCP_PREFLIGHT_FILTER_VALUE, diagnosticsFilter: MCP_PREFLIGHT_DIAGNOSTICS_FILTER });
    return;
  }
  if (MCP_PREFLIGHT_DIAGNOSTICS_JSON_MODE) {
    process.exitCode = await runMcpPreflightDiagnostics({ jsonOutput: true, filterKey: MCP_PREFLIGHT_FILTER_KEY, filterValue: MCP_PREFLIGHT_FILTER_VALUE, diagnosticsFilter: MCP_PREFLIGHT_DIAGNOSTICS_FILTER });
    return;
  }
  if (SESSION_INVENTORY_MODE) {
    process.exitCode = await runSessionInventory({ filterKey: SESSION_INVENTORY_FILTER_KEY, filterValue: SESSION_INVENTORY_FILTER_VALUE });
    return;
  }
  if (SESSION_INVENTORY_JSON_MODE) {
    process.exitCode = await runSessionInventory({ jsonOutput: true, filterKey: SESSION_INVENTORY_FILTER_KEY, filterValue: SESSION_INVENTORY_FILTER_VALUE });
    return;
  }
  if (SESSION_INVENTORY_OPERATIONS_MODE) {
    process.exitCode = await runSessionInventoryOperations({ filterKey: SESSION_INVENTORY_FILTER_KEY, filterValue: SESSION_INVENTORY_FILTER_VALUE });
    return;
  }
  if (SESSION_INVENTORY_OPERATIONS_JSON_MODE) {
    process.exitCode = await runSessionInventoryOperations({ jsonOutput: true, filterKey: SESSION_INVENTORY_FILTER_KEY, filterValue: SESSION_INVENTORY_FILTER_VALUE });
    return;
  }
  if (SESSION_INVENTORY_HOST_COMMANDS_MODE) {
    process.exitCode = await runSessionInventoryHostCommands({ filterKey: SESSION_INVENTORY_FILTER_KEY, filterValue: SESSION_INVENTORY_FILTER_VALUE });
    return;
  }
  if (SESSION_INVENTORY_HOST_COMMANDS_JSON_MODE) {
    process.exitCode = await runSessionInventoryHostCommands({ jsonOutput: true, filterKey: SESSION_INVENTORY_FILTER_KEY, filterValue: SESSION_INVENTORY_FILTER_VALUE });
    return;
  }
  if (SESSION_INVENTORY_ACTIONS_MODE) {
    process.exitCode = await runSessionInventoryActions({ filterKey: SESSION_INVENTORY_FILTER_KEY, filterValue: SESSION_INVENTORY_FILTER_VALUE });
    return;
  }
  if (SESSION_INVENTORY_ACTIONS_JSON_MODE) {
    process.exitCode = await runSessionInventoryActions({ jsonOutput: true, filterKey: SESSION_INVENTORY_FILTER_KEY, filterValue: SESSION_INVENTORY_FILTER_VALUE });
    return;
  }
  if (SESSION_INVENTORY_RECOVERY_MODE) {
    process.exitCode = await runSessionInventoryRecovery({ filterKey: SESSION_INVENTORY_FILTER_KEY, filterValue: SESSION_INVENTORY_FILTER_VALUE });
    return;
  }
  if (SESSION_INVENTORY_RECOVERY_JSON_MODE) {
    process.exitCode = await runSessionInventoryRecovery({ jsonOutput: true, filterKey: SESSION_INVENTORY_FILTER_KEY, filterValue: SESSION_INVENTORY_FILTER_VALUE });
    return;
  }
  if (SESSION_INVENTORY_EVENTS_MODE) {
    process.exitCode = await runSessionInventoryEvents({ filterKey: SESSION_INVENTORY_FILTER_KEY, filterValue: SESSION_INVENTORY_FILTER_VALUE, eventFilter: SESSION_INVENTORY_EVENTS_FILTER, recentCount: SESSION_INVENTORY_EVENTS_COUNT });
    return;
  }
  if (SESSION_INVENTORY_EVENTS_JSON_MODE) {
    process.exitCode = await runSessionInventoryEvents({ jsonOutput: true, filterKey: SESSION_INVENTORY_FILTER_KEY, filterValue: SESSION_INVENTORY_FILTER_VALUE, eventFilter: SESSION_INVENTORY_EVENTS_FILTER, recentCount: SESSION_INVENTORY_EVENTS_COUNT });
    return;
  }
  if (SESSION_OPERATIONS_MODE) {
    process.exitCode = await runSessionOperationsRead();
    return;
  }
  if (SESSION_OPERATIONS_JSON_MODE) {
    process.exitCode = await runSessionOperationsRead({ jsonOutput: true });
    return;
  }
  if (SESSION_RECOVERY_MODE) {
    process.exitCode = await runSessionRecovery();
    return;
  }
  if (SESSION_RECOVERY_JSON_MODE) {
    process.exitCode = await runSessionRecovery({ jsonOutput: true });
    return;
  }
  if (SESSION_READ_MODE) {
    process.exitCode = await runSessionRead();
    return;
  }
  if (SESSION_READ_JSON_MODE) {
    process.exitCode = await runSessionRead({ jsonOutput: true });
    return;
  }
  if (HOST_COMMAND_OUTPUT_READ_MODE) {
    process.exitCode = await runHostCommandOutputRead();
    return;
  }
  if (HOST_COMMAND_OUTPUT_READ_JSON_MODE) {
    process.exitCode = await runHostCommandOutputRead({ jsonOutput: true });
    return;
  }
  if (SESSION_EVENTS_MODE) {
    process.exitCode = await runSessionEventsRead({ eventFilter: SESSION_EVENTS_FILTER, recentCount: SESSION_EVENTS_COUNT });
    return;
  }
  if (SESSION_EVENTS_JSON_MODE) {
    process.exitCode = await runSessionEventsRead({ jsonOutput: true, eventFilter: SESSION_EVENTS_FILTER, recentCount: SESSION_EVENTS_COUNT });
    return;
  }
  if (SESSION_SYNC_MODE) {
    process.exitCode = await runSessionSync({
      target: SESSION_SYNC_TARGET,
      direction: SESSION_SYNC_DIRECTION,
      dryRun: SESSION_SYNC_DRY_RUN,
      deleteMissing: SESSION_SYNC_DELETE,
    });
    return;
  }
  if (SESSION_SYNC_JSON_MODE) {
    process.exitCode = await runSessionSync({
      target: SESSION_SYNC_TARGET,
      direction: SESSION_SYNC_DIRECTION,
      jsonOutput: true,
      dryRun: SESSION_SYNC_DRY_RUN,
      deleteMissing: SESSION_SYNC_DELETE,
    });
    return;
  }
  if (ATTACH_MODE) {
    process.exitCode = await runNarsAttachClient({
      endpoint: resolveNarsAttachEndpoint(options),
      input: process.stdin,
      output: process.stdout,
      maxReplay: 50,
    });
    return;
  }
  if (REMOVED_CONVERSATION_ARGS.length > 0) {
    console.error(`agent-cli removed conversation input flag(s): ${REMOVED_CONVERSATION_ARGS.join(', ')}. Use agent-runtime-server JSONL control input instead.`);
    process.exitCode = 2;
    return;
  }
  if (SERVER_COMPATIBILITY_MODE) {
    const compatibilityArgv = process.argv.slice(2);
    process.exitCode = await runRuntimeServerCompatibilityShim({
      argv: compatibilityArgv.includes('--raw-jsonl') ? compatibilityArgv : ['--raw-jsonl', ...compatibilityArgv],
    });
    return;
  }
  if (!SERVER_MODE) {
    console.error('agent-cli non-server conversation runtime has been removed; launch through agent-runtime-server, pass --attach for a NARS client projection, or use --server compatibility mode.');
    process.exitCode = 2;
    return;
  }
  if (HEARTBEAT_ENABLED) {
    activeHeartbeat = startCarrierHeartbeat({
      path: HEARTBEAT_PATH,
      session: SESSION,
      identity: IDENTITY,
      runtime: 'agent-cli',
      mode: 'server',
      sessionDir: SESSION_DIR,
      carrierSessionDir: CARRIER_SESSION_DIR,
    });
  }
  await runServerMode();
}

async function runMcpPreflight({ jsonOutput = false } = {}) {
  const mcpServers = await discoverAndStartMcpServers(SITE_ROOT);
  try {
    const allTools = aggregateTools(mcpServers);
    const mcpStatus = createMcpStatusSnapshot(mcpServers);
    const artifactPath = writeMcpPreflightArtifact({
      session: SESSION,
      identity: IDENTITY,
      siteRoot: SITE_ROOT,
      mcpStatus,
      mcpServers,
      allTools,
    });
    const preflightPayload = createMcpPreflightPayload({
      identity: IDENTITY,
      session: SESSION,
      siteRoot: SITE_ROOT,
      artifactPath,
      mcpStatus,
      mcpServerCount: Object.keys(mcpServers).length,
      toolCount: allTools.length,
    });
    if (jsonOutput) {
      console.log(`${JSON.stringify({
        schema: 'narada.agent_cli.mcp_preflight.v1',
        ...preflightPayload,
      }, null, 2)}\n`);
    } else {
      console.log(formatKeyValueRows({
        Identity: IDENTITY,
        Session: SESSION,
        SiteRoot: SITE_ROOT,
        'MCP servers': preflightPayload.mcp_server_count,
        'MCP state': preflightPayload.mcp_operational_state,
        ...(preflightPayload.mcp_startup_failure_count > 0 ? { 'MCP startup failures': preflightPayload.mcp_startup_failure_summary } : {}),
        ...(preflightPayload.mcp_runtime_fault_count > 0 ? { 'MCP runtime faults': preflightPayload.mcp_runtime_fault_summary } : {}),
        'Recommended action': preflightPayload.recommended_action_display,
        'Recommended command': preflightPayload.recommended_command ?? 'none',
        'Preflight review': preflightPayload?.handoffs?.mcp_preflight_read ?? 'none',
        Tools: preflightPayload.tool_count,
        Artifact: artifactPath,
      }));
    }
    return mcpStatus.mcp_operational_state === 'healthy' ? 0 : 2;
  } finally {
    closeMcpServers(mcpServers);
  }
}

async function runMcpPreflightRead({ jsonOutput = false } = {}) {
  const preflightArtifact = readMcpPreflightArtifact();
  if (!preflightArtifact) {
    if (jsonOutput) {
      console.log(`${JSON.stringify({
        schema: 'narada.agent_cli.mcp_preflight_read.v1',
        identity: IDENTITY,
        session: SESSION,
        site_root: SITE_ROOT,
        found: false,
      }, null, 2)}\n`);
    } else {
      console.log(formatKeyValueRows({
        Identity: IDENTITY,
        Session: SESSION,
        SiteRoot: SITE_ROOT,
        Status: 'mcp preflight artifact not found',
      }));
    }
    return 0;
  }
  const preflightPayload = createMcpPreflightPayload({
    identity: preflightArtifact.identity,
    session: preflightArtifact.session,
    siteRoot: preflightArtifact.site_root,
    artifactPath: preflightArtifact.artifact_path,
    generatedAt: preflightArtifact.generated_at,
    mcpStatus: {
      mcp_operational_state: preflightArtifact.mcp_operational_state,
      mcp_startup_failure_count: preflightArtifact.mcp_startup_failure_count,
      mcp_startup_failure_summary: preflightArtifact.mcp_startup_failure_summary,
      mcp_runtime_fault_count: preflightArtifact.mcp_runtime_fault_count,
      mcp_runtime_fault_summary: preflightArtifact.mcp_runtime_fault_summary,
    },
    mcpServerCount: preflightArtifact.mcp_server_count ?? 0,
    toolCount: preflightArtifact.tool_count ?? 0,
  });
  if (jsonOutput) {
    console.log(`${JSON.stringify({
      schema: 'narada.agent_cli.mcp_preflight_read.v1',
      found: true,
      ...preflightPayload,
    }, null, 2)}\n`);
    return 0;
  }
  console.log(formatKeyValueRows({
    Identity: preflightPayload.identity,
    Session: preflightPayload.session,
    SiteRoot: preflightPayload.site_root,
    'MCP servers': preflightPayload.mcp_server_count,
    'MCP state': preflightPayload.mcp_operational_state,
    ...(preflightPayload.mcp_startup_failure_count > 0 ? { 'MCP startup failures': preflightPayload.mcp_startup_failure_summary } : {}),
    ...(preflightPayload.mcp_runtime_fault_count > 0 ? { 'MCP runtime faults': preflightPayload.mcp_runtime_fault_summary } : {}),
    'Recommended action': preflightPayload.recommended_action_display,
    'Recommended command': preflightPayload.recommended_command ?? 'none',
    'Preflight review': preflightPayload?.handoffs?.mcp_preflight_read ?? 'none',
    Tools: preflightPayload.tool_count,
    Artifact: preflightPayload.artifact_path,
  }));
  return 0;
}

function summarizeMcpPreflightInventory(inventory = []) {
  const mcpStateCounts = {};
  const recommendedActionCounts = {};
  const recoveryKindCounts = {};
  const recommendedCommandCounts = {};
  const recoveryPrimaryCounts = {};
  const recoveryFollowupCounts = {};
  for (const item of inventory) {
    incrementInventoryCounter(mcpStateCounts, item?.mcp_operational_state ?? 'unknown');
    incrementInventoryCounter(recommendedActionCounts, item?.recommended_action ?? 'unknown');
    incrementInventoryCounter(recoveryKindCounts, item?.recovery_kind ?? 'unknown');
    incrementInventoryCounter(recommendedCommandCounts, item?.recommended_command ?? 'none');
    incrementInventoryCounter(recoveryPrimaryCounts, item?.recovery_primary_command ?? 'none');
    incrementInventoryCounter(recoveryFollowupCounts, item?.recovery_followup_command ?? 'none');
  }
  return {
    mcp_operational_state_counts: mcpStateCounts,
    mcp_operational_state_summary: formatInventoryCounts(mcpStateCounts),
    recommended_action_counts: recommendedActionCounts,
    recommended_action_summary: formatInventoryCounts(recommendedActionCounts),
    recovery_kind_counts: recoveryKindCounts,
    recovery_kind_summary: formatInventoryCounts(recoveryKindCounts),
    recommended_command_counts: recommendedCommandCounts,
    recommended_command_summary: formatInventoryCounts(recommendedCommandCounts),
    recovery_primary_counts: recoveryPrimaryCounts,
    recovery_primary_summary: formatInventoryCounts(recoveryPrimaryCounts),
    recovery_followup_counts: recoveryFollowupCounts,
    recovery_followup_summary: formatInventoryCounts(recoveryFollowupCounts),
  };
}

function summarizeMcpPreflightInventoryGroups(inventory = []) {
  return {
    mcp_state: summarizeSessionInventoryGroupBy(inventory, 'mcp_operational_state', 'mcp_operational_state'),
    recommended_action: summarizeSessionInventoryGroupBy(inventory, 'recommended_action', 'recommended_action_display'),
    recovery_kind: summarizeSessionInventoryGroupBy(inventory, 'recovery_kind', 'recovery_kind_display'),
  };
}

function summarizeMcpPreflightRecoveryQueue(inventory = []) {
  const recoveryArtifacts = inventory.filter((item) => item?.recommended_action !== 'start_session');
  const recommendedActionCounts = {};
  const recoveryKindCounts = {};
  const recommendedCommandCounts = {};
  const recoveryPrimaryCounts = {};
  const recoveryFollowupCounts = {};
  for (const item of recoveryArtifacts) {
    incrementInventoryCounter(recommendedActionCounts, item?.recommended_action ?? 'unknown');
    incrementInventoryCounter(recoveryKindCounts, item?.recovery_kind ?? 'unknown');
    incrementInventoryCounter(recommendedCommandCounts, item?.recommended_command ?? 'none');
    incrementInventoryCounter(recoveryPrimaryCounts, item?.recovery_primary_command ?? 'none');
    incrementInventoryCounter(recoveryFollowupCounts, item?.recovery_followup_command ?? 'none');
  }
  return {
    recovery_count: recoveryArtifacts.length,
    recommended_action_counts: recommendedActionCounts,
    recommended_action_summary: formatInventoryCounts(recommendedActionCounts),
    recovery_kind_counts: recoveryKindCounts,
    recovery_kind_summary: formatInventoryCounts(recoveryKindCounts),
    recommended_command_counts: recommendedCommandCounts,
    recommended_command_summary: formatInventoryCounts(recommendedCommandCounts),
    recovery_primary_counts: recoveryPrimaryCounts,
    recovery_primary_summary: formatInventoryCounts(recoveryPrimaryCounts),
    recovery_followup_counts: recoveryFollowupCounts,
    recovery_followup_summary: formatInventoryCounts(recoveryFollowupCounts),
    groups: summarizeSessionInventoryGroupBy(recoveryArtifacts, 'recommended_action', 'recommended_action_display'),
    workflow_groups: summarizeActionWorkflowGroups(recoveryArtifacts),
    artifacts: recoveryArtifacts,
  };
}

function normalizeMcpPreflightFilterKey(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['mcp_state', 'recommended_action', 'recovery_kind'].includes(normalized)) return normalized;
  return null;
}

function normalizeMcpPreflightFilterValue(value) {
  const normalized = String(value ?? '').trim();
  return normalized.length > 0 ? normalized : null;
}

function filterMcpPreflightInventory(inventory = [], { filterKey = null, filterValue = null } = {}) {
  const normalizedFilterKey = normalizeMcpPreflightFilterKey(filterKey);
  const normalizedFilterValue = normalizeMcpPreflightFilterValue(filterValue);
  if (!normalizedFilterKey || !normalizedFilterValue) return inventory;
  const fieldByFilterKey = {
    mcp_state: 'mcp_operational_state',
    recommended_action: 'recommended_action',
    recovery_kind: 'recovery_kind',
  };
  const field = fieldByFilterKey[normalizedFilterKey];
  return inventory.filter((item) => String(item?.[field] ?? '') === normalizedFilterValue);
}

function renderMcpPreflightInventory(inventory = []) {
  return inventory.map((item) => formatKeyValueRows({
    Session: item.session,
    Identity: item.identity,
    Generated: item.generated_at ?? 'unknown',
    'MCP servers': item.mcp_server_count,
    'MCP state': item.mcp_operational_state,
    ...(item.mcp_startup_failure_count > 0 ? { 'MCP startup failures': item.mcp_startup_failure_summary } : {}),
    ...(item.mcp_runtime_fault_count > 0 ? { 'MCP runtime faults': item.mcp_runtime_fault_summary } : {}),
    'Recommended action': item.recommended_action_display,
    'Recommended command': item.recommended_command ?? 'none',
    'Recovery kind': item.recovery_kind_display ?? 'none',
    'Recovery primary': item.recovery_primary_command ?? 'none',
    'Recovery followup': item.recovery_followup_command ?? 'none',
    'Preflight review': item?.handoffs?.mcp_preflight_read ?? 'none',
    Artifact: item.artifact_path,
  }));
}

function summarizeMcpPreflightActions(inventory = []) {
  const inventoryRollup = summarizeMcpPreflightInventory(inventory);
  return {
    action_count: inventory.length,
    recommended_action_counts: inventoryRollup.recommended_action_counts,
    recommended_action_summary: inventoryRollup.recommended_action_summary,
    recommended_command_counts: inventoryRollup.recommended_command_counts,
    recommended_command_summary: inventoryRollup.recommended_command_summary,
    recovery_kind_counts: inventoryRollup.recovery_kind_counts,
    recovery_kind_summary: inventoryRollup.recovery_kind_summary,
    recovery_primary_counts: inventoryRollup.recovery_primary_counts,
    recovery_primary_summary: inventoryRollup.recovery_primary_summary,
    recovery_followup_counts: inventoryRollup.recovery_followup_counts,
    recovery_followup_summary: inventoryRollup.recovery_followup_summary,
    workflow_groups: summarizeActionWorkflowGroups(inventory),
    actions: inventory,
  };
}

async function runMcpPreflightInventory({ siteRoot = SITE_ROOT, artifactDir = MCP_PREFLIGHT_ARTIFACT_DIR, jsonOutput = false, filterKey = null, filterValue = null } = {}) {
  const inventory = readMcpPreflightInventory({ artifactDir, siteRoot });
  const normalizedFilterKey = normalizeMcpPreflightFilterKey(filterKey);
  const normalizedFilterValue = normalizeMcpPreflightFilterValue(filterValue);
  const filteredInventory = filterMcpPreflightInventory(inventory, { filterKey: normalizedFilterKey, filterValue: normalizedFilterValue });
  const inventoryRollup = summarizeMcpPreflightInventory(filteredInventory);
  const inventoryGroups = summarizeMcpPreflightInventoryGroups(filteredInventory);
  const workflowGroups = summarizeActionWorkflowGroups(filteredInventory);
  const filterLabel = normalizedFilterKey && normalizedFilterValue ? `${normalizedFilterKey}:${normalizedFilterValue}` : 'all';
  if (jsonOutput) {
    console.log(`${JSON.stringify({
      schema: 'narada.agent_cli.mcp_preflight_inventory.v1',
      site_root: siteRoot,
      preflight_artifact_count: filteredInventory.length,
      total_preflight_artifact_count: inventory.length,
      preflight_filter: filterLabel,
      summary: {
        ...inventoryRollup,
      },
      groups: inventoryGroups,
      workflow_groups: workflowGroups,
      artifacts: filteredInventory,
    }, null, 2)}\n`);
    return 0;
  }
  const summary = {
    SiteRoot: siteRoot,
    ...(filterLabel !== 'all' ? { 'Preflight filter': filterLabel, 'Matched artifacts': filteredInventory.length, 'Total artifacts': inventory.length } : { 'Preflight artifacts': filteredInventory.length }),
    'MCP states': inventoryRollup.mcp_operational_state_summary,
    'Recommended actions': inventoryRollup.recommended_action_summary,
    'Recovery kinds': inventoryRollup.recovery_kind_summary,
    'Recommended commands': inventoryRollup.recommended_command_summary,
    'Recovery primary commands': inventoryRollup.recovery_primary_summary,
    'Recovery followups': inventoryRollup.recovery_followup_summary,
  };
  if (filteredInventory.length === 0) {
    summary.Status = 'no persisted mcp preflight artifacts';
    console.log(formatKeyValueRows(summary));
    return 0;
  }
  const blocks = [formatKeyValueRows(summary), ...renderMcpPreflightInventory(filteredInventory), renderSessionInventoryWorkflowGroups(workflowGroups, { heading: 'Preflight action groups' }), renderSessionInventoryGroups(inventoryGroups)];
  console.log(blocks.join('\n\n'));
  return 0;
}

async function runMcpPreflightActions({ siteRoot = SITE_ROOT, artifactDir = MCP_PREFLIGHT_ARTIFACT_DIR, jsonOutput = false, filterKey = null, filterValue = null } = {}) {
  const inventory = readMcpPreflightInventory({ artifactDir, siteRoot });
  const normalizedFilterKey = normalizeMcpPreflightFilterKey(filterKey);
  const normalizedFilterValue = normalizeMcpPreflightFilterValue(filterValue);
  const filteredInventory = filterMcpPreflightInventory(inventory, { filterKey: normalizedFilterKey, filterValue: normalizedFilterValue });
  const actionQueue = summarizeMcpPreflightActions(filteredInventory);
  const filterLabel = normalizedFilterKey && normalizedFilterValue ? `${normalizedFilterKey}:${normalizedFilterValue}` : 'all';
  if (jsonOutput) {
    console.log(`${JSON.stringify({
      schema: 'narada.agent_cli.mcp_preflight_actions.v1',
      site_root: siteRoot,
      preflight_artifact_count: filteredInventory.length,
      total_preflight_artifact_count: inventory.length,
      preflight_filter: filterLabel,
      summary: {
        recommended_action_counts: actionQueue.recommended_action_counts,
        recommended_action_summary: actionQueue.recommended_action_summary,
        recommended_command_counts: actionQueue.recommended_command_counts,
        recommended_command_summary: actionQueue.recommended_command_summary,
        recovery_kind_counts: actionQueue.recovery_kind_counts,
        recovery_kind_summary: actionQueue.recovery_kind_summary,
        recovery_primary_counts: actionQueue.recovery_primary_counts,
        recovery_primary_summary: actionQueue.recovery_primary_summary,
        recovery_followup_counts: actionQueue.recovery_followup_counts,
        recovery_followup_summary: actionQueue.recovery_followup_summary,
      },
      workflow_groups: actionQueue.workflow_groups,
      actions: actionQueue.actions,
    }, null, 2)}\n`);
    return 0;
  }
  const summary = {
    SiteRoot: siteRoot,
    ...(filterLabel !== 'all' ? { 'Preflight filter': filterLabel, 'Matched artifacts': filteredInventory.length, 'Total artifacts': inventory.length } : { 'Preflight artifacts': filteredInventory.length }),
    'Action queue': actionQueue.action_count,
    'Recommended actions': actionQueue.recommended_action_summary,
    'Recommended commands': actionQueue.recommended_command_summary,
    'Recovery kinds': actionQueue.recovery_kind_summary,
    'Recovery primary commands': actionQueue.recovery_primary_summary,
    'Recovery followups': actionQueue.recovery_followup_summary,
  };
  if (actionQueue.action_count === 0) {
    summary.Status = 'no persisted mcp preflight actions';
    console.log(formatKeyValueRows(summary));
    return 0;
  }
  const blocks = [formatKeyValueRows(summary), ...renderMcpPreflightInventory(actionQueue.actions), renderSessionInventoryWorkflowGroups(actionQueue.workflow_groups, { heading: 'Action groups' })];
  console.log(blocks.join('\n\n'));
  return 0;
}

async function runMcpPreflightRecovery({ siteRoot = SITE_ROOT, artifactDir = MCP_PREFLIGHT_ARTIFACT_DIR, jsonOutput = false, filterKey = null, filterValue = null } = {}) {
  const inventory = readMcpPreflightInventory({ artifactDir, siteRoot });
  const normalizedFilterKey = normalizeMcpPreflightFilterKey(filterKey);
  const normalizedFilterValue = normalizeMcpPreflightFilterValue(filterValue);
  const filteredInventory = filterMcpPreflightInventory(inventory, { filterKey: normalizedFilterKey, filterValue: normalizedFilterValue });
  const recoveryQueue = summarizeMcpPreflightRecoveryQueue(filteredInventory);
  const filterLabel = normalizedFilterKey && normalizedFilterValue ? `${normalizedFilterKey}:${normalizedFilterValue}` : 'all';
  if (jsonOutput) {
    console.log(`${JSON.stringify({
      schema: 'narada.agent_cli.mcp_preflight_recovery.v1',
      site_root: siteRoot,
      preflight_artifact_count: recoveryQueue.recovery_count,
      total_preflight_artifact_count: inventory.length,
      preflight_filter: filterLabel,
      summary: {
        recommended_action_counts: recoveryQueue.recommended_action_counts,
        recommended_action_summary: recoveryQueue.recommended_action_summary,
        recovery_kind_counts: recoveryQueue.recovery_kind_counts,
        recovery_kind_summary: recoveryQueue.recovery_kind_summary,
        recommended_command_counts: recoveryQueue.recommended_command_counts,
        recommended_command_summary: recoveryQueue.recommended_command_summary,
        recovery_primary_counts: recoveryQueue.recovery_primary_counts,
        recovery_primary_summary: recoveryQueue.recovery_primary_summary,
        recovery_followup_counts: recoveryQueue.recovery_followup_counts,
        recovery_followup_summary: recoveryQueue.recovery_followup_summary,
      },
      groups: recoveryQueue.groups,
      workflow_groups: recoveryQueue.workflow_groups,
      artifacts: recoveryQueue.artifacts,
    }, null, 2)}\n`);
    return 0;
  }
  const summary = {
    SiteRoot: siteRoot,
    ...(filterLabel !== 'all' ? { 'Preflight filter': filterLabel, 'Matched artifacts': filteredInventory.length, 'Total artifacts': inventory.length } : { 'Recovery queue': recoveryQueue.recovery_count }),
    ...(filterLabel !== 'all' ? { 'Recovery queue': recoveryQueue.recovery_count } : {}),
    'Recommended actions': recoveryQueue.recommended_action_summary,
    'Recovery kinds': recoveryQueue.recovery_kind_summary,
    'Recommended commands': recoveryQueue.recommended_command_summary,
    'Recovery primary commands': recoveryQueue.recovery_primary_summary,
    'Recovery followups': recoveryQueue.recovery_followup_summary,
  };
  if (recoveryQueue.recovery_count === 0) {
    summary.Status = 'no persisted mcp preflight recoveries';
    console.log(formatKeyValueRows(summary));
    return 0;
  }
  const blocks = [formatKeyValueRows(summary), ...renderMcpPreflightInventory(recoveryQueue.artifacts), renderSessionInventoryWorkflowGroups(recoveryQueue.workflow_groups, { heading: 'Preflight recovery groups' })];
  console.log(blocks.join('\n\n'));
  return 0;
}

async function runMcpPreflightDiagnostics({ siteRoot = SITE_ROOT, artifactDir = MCP_PREFLIGHT_ARTIFACT_DIR, jsonOutput = false, filterKey = null, filterValue = null, diagnosticsFilter = 'all' } = {}) {
  const inventory = readMcpPreflightInventory({ artifactDir, siteRoot });
  const normalizedFilterKey = normalizeMcpPreflightFilterKey(filterKey);
  const normalizedFilterValue = normalizeMcpPreflightFilterValue(filterValue);
  const filteredInventory = filterMcpPreflightInventory(inventory, { filterKey: normalizedFilterKey, filterValue: normalizedFilterValue });
  const diagnosticsRollup = summarizeMcpPreflightDiagnostics(filteredInventory, { diagnosticFilter: diagnosticsFilter });
  const filterLabel = normalizedFilterKey && normalizedFilterValue ? `${normalizedFilterKey}:${normalizedFilterValue}` : 'all';
  const normalizedDiagnosticsFilter = normalizeMcpPreflightDiagnosticsFilter(diagnosticsFilter);
  if (jsonOutput) {
    console.log(`${JSON.stringify({
      schema: 'narada.agent_cli.mcp_preflight_diagnostics.v1',
      site_root: siteRoot,
      preflight_artifact_count: diagnosticsRollup.artifacts_with_diagnostics,
      total_preflight_artifact_count: inventory.length,
      preflight_filter: filterLabel,
      diagnostics_filter: normalizedDiagnosticsFilter,
      summary: {
        diagnostic_count: diagnosticsRollup.diagnostic_count,
        diagnostic_lane_counts: diagnosticsRollup.diagnostic_lane_counts,
        diagnostic_lane_summary: diagnosticsRollup.diagnostic_lane_summary,
        diagnostic_code_counts: diagnosticsRollup.diagnostic_code_counts,
        diagnostic_code_summary: diagnosticsRollup.diagnostic_code_summary,
        server_name_counts: diagnosticsRollup.server_name_counts,
        server_name_summary: diagnosticsRollup.server_name_summary,
        recommended_action_counts: diagnosticsRollup.recommended_action_counts,
        recommended_action_summary: diagnosticsRollup.recommended_action_summary,
        recommended_command_counts: diagnosticsRollup.recommended_command_counts,
        recommended_command_summary: diagnosticsRollup.recommended_command_summary,
        recovery_primary_counts: diagnosticsRollup.recovery_primary_counts,
        recovery_primary_summary: diagnosticsRollup.recovery_primary_summary,
        recovery_followup_counts: diagnosticsRollup.recovery_followup_counts,
        recovery_followup_summary: diagnosticsRollup.recovery_followup_summary,
      },
      groups: diagnosticsRollup.groups,
      workflow_groups: diagnosticsRollup.workflow_groups,
      artifacts: diagnosticsRollup.artifacts,
      diagnostics: diagnosticsRollup.diagnostics,
    }, null, 2)}\n`);
    return 0;
  }
  const summary = {
    SiteRoot: siteRoot,
    ...(filterLabel !== 'all' ? { 'Preflight filter': filterLabel, 'Matched artifacts': diagnosticsRollup.artifacts_with_diagnostics, 'Total artifacts': inventory.length } : { 'Artifacts with diagnostics': diagnosticsRollup.artifacts_with_diagnostics }),
    'Diagnostics filter': normalizedDiagnosticsFilter,
    'Diagnostic count': diagnosticsRollup.diagnostic_count,
    'Diagnostic lanes': diagnosticsRollup.diagnostic_lane_summary,
    'Diagnostic codes': diagnosticsRollup.diagnostic_code_summary,
    Servers: diagnosticsRollup.server_name_summary,
    'Recommended actions': diagnosticsRollup.recommended_action_summary,
    'Recommended commands': diagnosticsRollup.recommended_command_summary,
    'Recovery primary commands': diagnosticsRollup.recovery_primary_summary,
    'Recovery followups': diagnosticsRollup.recovery_followup_summary,
  };
  if (diagnosticsRollup.diagnostic_count === 0) {
    summary.Status = 'no persisted mcp preflight diagnostics';
    console.log(formatKeyValueRows(summary));
    return 0;
  }
  const blocks = [formatKeyValueRows(summary), ...renderMcpPreflightDiagnostics(diagnosticsRollup.artifacts), renderSessionInventoryWorkflowGroups(diagnosticsRollup.workflow_groups, { heading: 'Preflight diagnostic groups' }), renderSessionInventoryGroups(diagnosticsRollup.groups)];
  console.log(blocks.join('\n\n'));
  return 0;
}

async function runSessionInventory({ siteRoot = SITE_ROOT, naradaDir = NARADA_DIR, jsonOutput = false, filterKey = null, filterValue = null } = {}) {
  const inventory = readSessionInventory({ siteRoot, naradaDir });
  const normalizedFilterKey = normalizeSessionInventoryFilterKey(filterKey);
  const normalizedFilterValue = normalizeSessionInventoryFilterValue(filterValue);
  const filteredInventory = filterSessionInventory(inventory, { filterKey: normalizedFilterKey, filterValue: normalizedFilterValue });
  const inventoryRollup = summarizeSessionInventoryRollup(inventory);
  const filteredInventoryRollup = summarizeSessionInventoryRollup(filteredInventory);
  const inventoryGroups = summarizeSessionInventoryGroups(filteredInventory);
  const actionQueue = summarizeSessionInventoryActions(filteredInventory);
  const filterLabel = normalizedFilterKey && normalizedFilterValue ? `${normalizedFilterKey}:${normalizedFilterValue}` : 'all';
  if (jsonOutput) {
    console.log(`${JSON.stringify({
      schema: 'narada.agent_cli.session_inventory.v1',
      site_root: siteRoot,
      carrier_session_count: filteredInventory.length,
      total_carrier_session_count: inventory.length,
      inventory_filter: filterLabel,
      summary: {
        ...filteredInventoryRollup,
        recommended_action_counts: actionQueue.recommended_action_counts,
        recommended_action_summary: actionQueue.recommended_action_summary,
        recommended_command_counts: actionQueue.recommended_command_counts,
        recommended_command_summary: actionQueue.recommended_command_summary,
        recovery_primary_counts: actionQueue.recovery_primary_counts,
        recovery_primary_summary: actionQueue.recovery_primary_summary,
        recovery_followup_counts: actionQueue.recovery_followup_counts,
        recovery_followup_summary: actionQueue.recovery_followup_summary,
      },
      groups: inventoryGroups,
      workflow_groups: actionQueue.workflow_groups,
      sessions: filteredInventory,
    }, null, 2)}\n`);
    return 0;
  }
  const summary = {
    SiteRoot: siteRoot,
    ...(filterLabel !== 'all' ? { 'Inventory filter': filterLabel, 'Matched sessions': filteredInventory.length, 'Total sessions': inventory.length } : { 'Carrier sessions': filteredInventory.length }),
    'Heartbeat states': filteredInventoryRollup.heartbeat_status_summary,
    'Operational posture': filteredInventoryRollup.operational_posture_summary,
    'MCP states': filteredInventoryRollup.mcp_operational_state_summary,
    'Terminal states': filteredInventoryRollup.last_terminal_state_summary,
    'Lifecycle states': filteredInventoryRollup.last_lifecycle_state_summary,
    'Lifecycle outcomes': filteredInventoryRollup.lifecycle_outcome_summary,
    'Request posture': filteredInventoryRollup.request_posture_summary,
    'Request outcomes': filteredInventoryRollup.request_outcome_summary,
    'Request issues': filteredInventoryRollup.request_issue_summary,
    'Operation events': filteredInventoryRollup.operation_event_summary,
    'Operation ids': filteredInventoryRollup.operation_id_summary,
    'Host command states': filteredInventoryRollup.host_command_terminal_state_summary,
    'Recommended actions': actionQueue.recommended_action_summary,
    'Recommended commands': actionQueue.recommended_command_summary,
    'Recovery primary commands': actionQueue.recovery_primary_summary,
    'Recovery followups': actionQueue.recovery_followup_summary,
  };
  if (filteredInventory.length === 0) {
    summary.Status = 'no persisted carrier sessions';
    console.log(formatKeyValueRows(summary));
    return 0;
  }
  const blocks = [formatKeyValueRows(summary)];
  for (const item of filteredInventory) {
    blocks.push(formatKeyValueRows({
      Session: item.session,
      Heartbeat: item.heartbeat_display,
      'Operational posture': item.operational_posture_display,
      'MCP state': item.mcp_operational_state,
      'Request posture': item.request_posture_display,
      'MCP startup failures': item.mcp_startup_failure_summary,
      'MCP runtime faults': item.mcp_runtime_fault_summary,
      'Operation events': item.operation_event_summary,
      'Operation ids': item.operation_id_summary,
      'Host command states': item.host_command_terminal_state_summary,
      'Last host command': item.last_host_command_summary ?? 'none',
      'Last host command state': item.last_host_command_terminal_state ?? 'none',
      'Preflight artifact': item.mcp_preflight_artifact_path ?? 'none',
      'Preflight state': item.mcp_preflight_operational_state ?? 'none',
      'Preflight action': item.mcp_preflight_recommended_action_display ?? 'none',
      'Preflight command': item.mcp_preflight_recommended_command ?? 'none',
      'Preflight diagnostics': item?.mcp_preflight_handoffs?.mcp_preflight_diagnostics ?? 'none',
      'Recommended action': item.recommended_action_display,
      'Recommended command': item.recommended_command ?? 'none',
      'Session read': item?.handoffs?.session_read ?? 'none',
      'Session issues': item?.handoffs?.session_events_issues ?? 'none',
      'Session diagnostics': item?.handoffs?.session_events_diagnostics ?? 'none',
      'Host command output review': item?.handoffs?.host_command_output_read ?? 'none',
      'Session path': item.session_path,
    }));
  }
  blocks.push(renderSessionInventoryWorkflowGroups(actionQueue.workflow_groups, { heading: 'Inventory action groups' }));
  blocks.push(renderSessionInventoryGroups(inventoryGroups));
  console.log(blocks.join('\n\n'));
  return 0;
}

async function runSessionInventoryHostCommands({ siteRoot = SITE_ROOT, naradaDir = NARADA_DIR, jsonOutput = false, filterKey = null, filterValue = null } = {}) {
  const inventory = readSessionInventory({ siteRoot, naradaDir });
  const normalizedFilterKey = normalizeSessionInventoryFilterKey(filterKey);
  const normalizedFilterValue = normalizeSessionInventoryFilterValue(filterValue);
  const filteredInventory = filterSessionInventory(inventory, { filterKey: normalizedFilterKey, filterValue: normalizedFilterValue });
  const hostCommandQueue = summarizeSessionInventoryHostCommands(filteredInventory);
  const filterLabel = normalizedFilterKey && normalizedFilterValue ? `${normalizedFilterKey}:${normalizedFilterValue}` : 'all';
  if (jsonOutput) {
    console.log(`${JSON.stringify({
      schema: 'narada.agent_cli.session_inventory_host_commands.v1',
      site_root: siteRoot,
      inventory_filter: filterLabel,
      carrier_session_count: hostCommandQueue.host_command_session_count,
      total_carrier_session_count: inventory.length,
      host_command_event_counts: hostCommandQueue.host_command_event_counts,
      host_command_event_summary: hostCommandQueue.host_command_event_summary,
      host_command_terminal_state_counts: hostCommandQueue.host_command_terminal_state_counts,
      host_command_terminal_state_summary: hostCommandQueue.host_command_terminal_state_summary,
      host_command_output_ref_count: hostCommandQueue.host_command_output_ref_count,
      host_command_output_ref_summary: hostCommandQueue.host_command_output_ref_summary,
      groups: hostCommandQueue.groups,
      workflow_groups: hostCommandQueue.workflow_groups,
      sessions: hostCommandQueue.sessions,
    }, null, 2)}\n`);
    return 0;
  }
  const summary = {
    SiteRoot: siteRoot,
    ...(filterLabel !== 'all' ? { 'Inventory filter': filterLabel, 'Matched sessions': hostCommandQueue.host_command_session_count, 'Total sessions': inventory.length } : { 'Carrier sessions': hostCommandQueue.host_command_session_count }),
    'Host command events': hostCommandQueue.host_command_event_summary,
    'Host command states': hostCommandQueue.host_command_terminal_state_summary,
    'Persisted outputs': hostCommandQueue.host_command_output_ref_summary,
  };
  if (hostCommandQueue.host_command_session_count === 0) {
    summary.Status = 'no persisted host command activity';
    console.log(formatKeyValueRows(summary));
    return 0;
  }
  const blocks = [formatKeyValueRows(summary), ...renderSessionInventoryHostCommands(hostCommandQueue.sessions)];
  blocks.push(renderSessionInventoryWorkflowGroups(hostCommandQueue.workflow_groups, { heading: 'Host command action groups' }));
  blocks.push(renderSessionInventoryGroups(hostCommandQueue.groups));
  console.log(blocks.join('\n\n'));
  return 0;
}

async function runSessionInventoryOperations({ siteRoot = SITE_ROOT, naradaDir = NARADA_DIR, jsonOutput = false, filterKey = null, filterValue = null } = {}) {
  const inventory = readSessionInventory({ siteRoot, naradaDir });
  const normalizedFilterKey = normalizeSessionInventoryFilterKey(filterKey);
  const normalizedFilterValue = normalizeSessionInventoryFilterValue(filterValue);
  const filteredInventory = filterSessionInventory(inventory, { filterKey: normalizedFilterKey, filterValue: normalizedFilterValue });
  const operationQueue = summarizeSessionInventoryOperations(filteredInventory);
  const filterLabel = normalizedFilterKey && normalizedFilterValue ? `${normalizedFilterKey}:${normalizedFilterValue}` : 'all';
  if (jsonOutput) {
    console.log(`${JSON.stringify({
      schema: 'narada.agent_cli.session_inventory_operations.v1',
      site_root: siteRoot,
      inventory_filter: filterLabel,
      carrier_session_count: operationQueue.operation_session_count,
      total_carrier_session_count: inventory.length,
      operation_event_counts: operationQueue.operation_event_counts,
      operation_event_summary: operationQueue.operation_event_summary,
      directive_kind_counts: operationQueue.directive_kind_counts,
      directive_kind_summary: operationQueue.directive_kind_summary,
      directive_visibility_counts: operationQueue.directive_visibility_counts,
      directive_visibility_summary: operationQueue.directive_visibility_summary,
      operation_id_counts: operationQueue.operation_id_counts,
      operation_id_summary: operationQueue.operation_id_summary,
      groups: operationQueue.groups,
      workflow_groups: operationQueue.workflow_groups,
      sessions: operationQueue.sessions,
    }, null, 2)}\n`);
    return 0;
  }
  const summary = {
    SiteRoot: siteRoot,
    ...(filterLabel !== 'all' ? { 'Inventory filter': filterLabel, 'Matched sessions': operationQueue.operation_session_count, 'Total sessions': inventory.length } : { 'Carrier sessions': operationQueue.operation_session_count }),
    'Operation events': operationQueue.operation_event_summary,
    'Directive kinds': operationQueue.directive_kind_summary,
    'Directive visibility': operationQueue.directive_visibility_summary,
    'Operation ids': operationQueue.operation_id_summary,
  };
  if (operationQueue.operation_session_count === 0) {
    summary.Status = 'no persisted operation activity';
    console.log(formatKeyValueRows(summary));
    return 0;
  }
  const blocks = [formatKeyValueRows(summary), ...renderSessionInventoryOperations(operationQueue.sessions)];
  blocks.push(renderSessionInventoryWorkflowGroups(operationQueue.workflow_groups, { heading: 'Operation action groups' }));
  blocks.push(renderSessionInventoryGroups(operationQueue.groups));
  console.log(blocks.join('\n\n'));
  return 0;
}

async function runSessionOperationsRead({ session = SESSION, siteRoot = SITE_ROOT, naradaDir = NARADA_DIR, jsonOutput = false } = {}) {
  const sessionRecord = readPersistedSession({ session, siteRoot, naradaDir });
  if (!sessionRecord) {
    if (jsonOutput) {
      console.log(`${JSON.stringify({
        schema: 'narada.agent_cli.session_operations.v1',
        site_root: siteRoot,
        session,
        found: false,
      }, null, 2)}\n`);
    } else {
      console.log(formatKeyValueRows({
        SiteRoot: siteRoot,
        Session: session,
        Status: 'persisted session not found',
      }));
    }
    return 0;
  }
  const sessionEventSummary = createSessionEventSummaryPayload(sessionRecord, { naradaDir, eventFilter: 'all', recentCount: 20 });
  const sessionOperationPayload = createSessionOperationPayload(sessionRecord);
  if (jsonOutput) {
    console.log(`${JSON.stringify({
      schema: 'narada.agent_cli.session_operations.v1',
      site_root: siteRoot,
      session,
      found: true,
      operation: sessionOperationPayload,
      event_summary: sessionEventSummary,
      recovery: createSessionRecoveryPayload(sessionRecord),
      preflight: createSessionPreflightPayload(sessionRecord),
      host_command_output: createSessionHostCommandOutputPayload(sessionRecord),
      record: sessionRecord,
    }, null, 2)}\n`);
    return 0;
  }
  console.log(formatKeyValueRows({
    SiteRoot: siteRoot,
    Session: sessionRecord.session,
    Agent: sessionRecord.agent_id ?? 'unknown',
    Runtime: sessionRecord.runtime ?? 'unknown',
    Mode: sessionRecord.mode ?? 'unknown',
    Started: sessionRecord.started_at ?? 'unknown',
    Heartbeat: sessionRecord.heartbeat_display,
    'Operational posture': sessionRecord.operational_posture_display,
    'MCP state': sessionRecord.mcp_operational_state,
    'Request posture': sessionRecord.request_posture_display,
    'Operation events': sessionOperationPayload.operation_event_summary,
    'Directive kinds': sessionOperationPayload.directive_kind_summary,
    'Directive visibility': sessionOperationPayload.directive_visibility_summary,
    'Operation ids': sessionOperationPayload.operation_id_summary,
    'Last operation id': sessionOperationPayload.last_operation_id ?? 'none',
    'Last directive kind': sessionOperationPayload.last_directive_kind ?? 'none',
    'Last directive visibility': sessionOperationPayload.last_directive_visibility ?? 'none',
    'Last operation event': sessionOperationPayload.last_operation_event_kind ?? 'none',
    'Last operation at': sessionOperationPayload.last_operation_at ?? 'unknown',
    'Event count': sessionEventSummary.event_count,
    'Event kinds': sessionEventSummary.event_kind_summary,
    'Issue codes': sessionEventSummary.issue_code_summary,
    'Terminal states': sessionEventSummary.terminal_state_summary,
    'Recovery kind': sessionRecord.recovery_kind_display ?? 'none',
    'Recovery primary': sessionRecord.recovery_primary_command ?? 'none',
    'Recovery followup': sessionRecord.recovery_followup_command ?? 'none',
    'Recommended action': sessionRecord.recommended_action_display,
    'Recommended command': sessionRecord.recommended_command ?? 'none',
    'Session operations': sessionOperationPayload.handoffs.session_operations ?? 'none',
    'Session read': sessionRecord?.handoffs?.session_read ?? 'none',
    'Session recovery': sessionRecord?.handoffs?.session_recovery ?? 'none',
    'Session issues': sessionRecord?.handoffs?.session_events_issues ?? 'none',
    'Session diagnostics': sessionRecord?.handoffs?.session_events_diagnostics ?? 'none',
    'Host command output review': sessionRecord?.handoffs?.host_command_output_read ?? 'none',
    'Session path': sessionRecord.session_path,
  }));
  return 0;
}

async function runSessionInventoryActions({ siteRoot = SITE_ROOT, naradaDir = NARADA_DIR, jsonOutput = false, filterKey = null, filterValue = null } = {}) {
  const inventory = readSessionInventory({ siteRoot, naradaDir });
  const normalizedFilterKey = normalizeSessionInventoryFilterKey(filterKey);
  const normalizedFilterValue = normalizeSessionInventoryFilterValue(filterValue);
  const filteredInventory = filterSessionInventory(inventory, { filterKey: normalizedFilterKey, filterValue: normalizedFilterValue });
  const actionQueue = summarizeSessionInventoryActions(filteredInventory);
  const filterLabel = normalizedFilterKey && normalizedFilterValue ? `${normalizedFilterKey}:${normalizedFilterValue}` : 'all';
  if (jsonOutput) {
    console.log(`${JSON.stringify({
      schema: 'narada.agent_cli.session_inventory_actions.v1',
      site_root: siteRoot,
      carrier_session_count: filteredInventory.length,
      total_carrier_session_count: inventory.length,
      inventory_filter: filterLabel,
      summary: {
        recommended_action_counts: actionQueue.recommended_action_counts,
        recommended_action_summary: actionQueue.recommended_action_summary,
        recommended_command_counts: actionQueue.recommended_command_counts,
        recommended_command_summary: actionQueue.recommended_command_summary,
        recovery_primary_counts: actionQueue.recovery_primary_counts,
        recovery_primary_summary: actionQueue.recovery_primary_summary,
        recovery_followup_counts: actionQueue.recovery_followup_counts,
        recovery_followup_summary: actionQueue.recovery_followup_summary,
      },
      workflow_groups: actionQueue.workflow_groups,
      actions: actionQueue.actions,
    }, null, 2)}\n`);
    return 0;
  }
  const summary = {
    SiteRoot: siteRoot,
    ...(filterLabel !== 'all' ? { 'Inventory filter': filterLabel, 'Matched sessions': filteredInventory.length, 'Total sessions': inventory.length } : { 'Carrier sessions': filteredInventory.length }),
    'Action queue': actionQueue.action_count,
    'Recommended actions': actionQueue.recommended_action_summary,
    'Recommended commands': actionQueue.recommended_command_summary,
    'Recovery primary commands': actionQueue.recovery_primary_summary,
    'Recovery followups': actionQueue.recovery_followup_summary,
  };
  if (actionQueue.action_count === 0) {
    summary.Status = 'no persisted carrier session actions';
    console.log(formatKeyValueRows(summary));
    return 0;
  }
  const blocks = [formatKeyValueRows(summary), ...renderSessionInventoryActions(actionQueue.actions), renderSessionInventoryWorkflowGroups(actionQueue.workflow_groups, { heading: 'Action groups' })];
  console.log(blocks.join('\n\n'));
  return 0;
}

async function runSessionInventoryRecovery({ siteRoot = SITE_ROOT, naradaDir = NARADA_DIR, jsonOutput = false, filterKey = null, filterValue = null } = {}) {
  const inventory = readSessionInventory({ siteRoot, naradaDir });
  const normalizedFilterKey = normalizeSessionInventoryFilterKey(filterKey);
  const normalizedFilterValue = normalizeSessionInventoryFilterValue(filterValue);
  const filteredInventory = filterSessionInventory(inventory, { filterKey: normalizedFilterKey, filterValue: normalizedFilterValue });
  const recoveryQueue = summarizeSessionInventoryRecoveryQueue(filteredInventory);
  const filterLabel = normalizedFilterKey && normalizedFilterValue ? `${normalizedFilterKey}:${normalizedFilterValue}` : 'all';
  if (jsonOutput) {
    console.log(`${JSON.stringify({
      schema: 'narada.agent_cli.session_inventory_recovery.v1',
      site_root: siteRoot,
      carrier_session_count: recoveryQueue.recovery_count,
      total_carrier_session_count: inventory.length,
      inventory_filter: filterLabel,
      summary: {
        recommended_action_counts: recoveryQueue.recommended_action_counts,
        recommended_action_summary: recoveryQueue.recommended_action_summary,
        recovery_kind_counts: recoveryQueue.recovery_kind_counts,
        recovery_kind_summary: recoveryQueue.recovery_kind_summary,
        recovery_primary_counts: recoveryQueue.recovery_primary_counts,
        recovery_primary_summary: recoveryQueue.recovery_primary_summary,
        recovery_followup_counts: recoveryQueue.recovery_followup_counts,
        recovery_followup_summary: recoveryQueue.recovery_followup_summary,
      },
      groups: recoveryQueue.groups,
      workflow_groups: recoveryQueue.workflow_groups,
      actions: recoveryQueue.actions,
    }, null, 2)}\n`);
    return 0;
  }
  const summary = {
    SiteRoot: siteRoot,
    ...(filterLabel !== 'all' ? { 'Inventory filter': filterLabel, 'Matched sessions': filteredInventory.length, 'Total sessions': inventory.length } : { 'Carrier sessions': inventory.length }),
    'Recovery queue': recoveryQueue.recovery_count,
    'Recommended actions': recoveryQueue.recommended_action_summary,
    'Recovery kinds': recoveryQueue.recovery_kind_summary,
    'Recovery primary commands': recoveryQueue.recovery_primary_summary,
    'Recovery followups': recoveryQueue.recovery_followup_summary,
  };
  if (recoveryQueue.recovery_count === 0) {
    summary.Status = 'no persisted carrier session recoveries';
    console.log(formatKeyValueRows(summary));
    return 0;
  }
  const blocks = [formatKeyValueRows(summary), ...renderSessionInventoryActions(recoveryQueue.actions), renderSessionInventoryWorkflowGroups(recoveryQueue.workflow_groups, { heading: 'Recovery groups' })];
  console.log(blocks.join('\n\n'));
  return 0;
}

async function runSessionInventoryEvents({ siteRoot = SITE_ROOT, naradaDir = NARADA_DIR, jsonOutput = false, filterKey = null, filterValue = null, eventFilter = 'all', recentCount = 20 } = {}) {
  const inventory = readSessionInventory({ siteRoot, naradaDir });
  const normalizedFilterKey = normalizeSessionInventoryFilterKey(filterKey);
  const normalizedFilterValue = normalizeSessionInventoryFilterValue(filterValue);
  const filteredInventory = filterSessionInventory(inventory, { filterKey: normalizedFilterKey, filterValue: normalizedFilterValue });
  const inventoryEventSummary = summarizeSessionInventoryEvents(filteredInventory, { naradaDir, eventFilter, recentCount });
  const filterLabel = normalizedFilterKey && normalizedFilterValue ? `${normalizedFilterKey}:${normalizedFilterValue}` : 'all';
  if (jsonOutput) {
    console.log(`${JSON.stringify({
      schema: 'narada.agent_cli.session_inventory_events.v1',
      site_root: siteRoot,
      inventory_filter: filterLabel,
      event_filter: inventoryEventSummary.event_filter,
      carrier_session_count: filteredInventory.length,
      total_carrier_session_count: inventory.length,
      sessions_with_events: inventoryEventSummary.sessions.length,
      event_count: inventoryEventSummary.event_count,
      event_kind_counts: inventoryEventSummary.event_kind_counts,
      event_kind_summary: inventoryEventSummary.event_kind_summary,
      issue_code_counts: inventoryEventSummary.issue_code_counts,
      issue_code_summary: inventoryEventSummary.issue_code_summary,
      terminal_state_counts: inventoryEventSummary.terminal_state_counts,
      terminal_state_summary: inventoryEventSummary.terminal_state_summary,
      recommended_action_counts: inventoryEventSummary.recommended_action_counts,
      recommended_action_summary: inventoryEventSummary.recommended_action_summary,
      recommended_command_counts: inventoryEventSummary.recommended_command_counts,
      recommended_command_summary: inventoryEventSummary.recommended_command_summary,
      recovery_primary_counts: inventoryEventSummary.recovery_primary_counts,
      recovery_primary_summary: inventoryEventSummary.recovery_primary_summary,
      recovery_followup_counts: inventoryEventSummary.recovery_followup_counts,
      recovery_followup_summary: inventoryEventSummary.recovery_followup_summary,
      groups: inventoryEventSummary.groups,
      workflow_groups: inventoryEventSummary.workflow_groups,
      sessions: inventoryEventSummary.sessions,
      recent_events: inventoryEventSummary.recent_events,
    }, null, 2)}\n`);
    return 0;
  }
  const summary = {
    SiteRoot: siteRoot,
    ...(filterLabel !== 'all' ? { 'Inventory filter': filterLabel, 'Matched sessions': filteredInventory.length, 'Total sessions': inventory.length } : { 'Carrier sessions': filteredInventory.length }),
    'Event filter': inventoryEventSummary.event_filter,
    'Sessions with events': inventoryEventSummary.sessions.length,
    'Event count': inventoryEventSummary.event_count,
    'Event kinds': inventoryEventSummary.event_kind_summary,
    'Issue codes': inventoryEventSummary.issue_code_summary,
    'Terminal states': inventoryEventSummary.terminal_state_summary,
    'Recommended actions': inventoryEventSummary.recommended_action_summary,
    'Recommended commands': inventoryEventSummary.recommended_command_summary,
    'Recovery primary commands': inventoryEventSummary.recovery_primary_summary,
    'Recovery followups': inventoryEventSummary.recovery_followup_summary,
  };
  if (inventoryEventSummary.event_count === 0) {
    summary.Status = 'no persisted carrier session events';
    console.log(formatKeyValueRows(summary));
    return 0;
  }
  const blocks = [formatKeyValueRows(summary)];
  for (const item of inventoryEventSummary.sessions) {
    blocks.push(formatKeyValueRows({
      Session: item.session,
      'Event count': item.event_count,
      'Last event': item.last_event_kind,
      'Last event at': item.last_event_at,
      'Recommended action': item.recommended_action_display,
      'Recommended command': item.recommended_command ?? 'none',
      'Session read': item?.handoffs?.session_read ?? 'none',
      'Session recovery': item?.handoffs?.session_recovery ?? 'none',
      'Session issues': item?.handoffs?.session_events_issues ?? 'none',
      'Session diagnostics': item?.handoffs?.session_events_diagnostics ?? 'none',
      'Host command output review': item?.handoffs?.host_command_output_read ?? 'none',
    }));
  }
  if (inventoryEventSummary.recent_events.length > 0) {
    blocks.push(['Recent events:', ...inventoryEventSummary.recent_events.map((entry) => formatPersistedSessionInventoryEventLine(entry))].join('\n'));
  }
  blocks.push(renderSessionInventoryWorkflowGroups(inventoryEventSummary.workflow_groups, { heading: 'Event action groups' }));
  blocks.push(renderSessionInventoryEventGroups(inventoryEventSummary.groups));
  console.log(blocks.join('\n\n'));
  return 0;
}

function createSessionRecoveryPayload(sessionRecord) {
  if (!sessionRecord) return null;
  return {
    recovery_kind: sessionRecord.recovery_kind,
    recovery_kind_display: sessionRecord.recovery_kind_display,
    recovery_primary_command: sessionRecord.recovery_primary_command,
    recovery_followup_command: sessionRecord.recovery_followup_command,
    recommended_action: sessionRecord.recommended_action,
    recommended_action_display: sessionRecord.recommended_action_display,
    recommended_command: sessionRecord.recommended_command,
  };
}

function createSessionOperationPayload(sessionRecord) {
  if (!sessionRecord) return null;
  return {
    operation_event_count: sessionRecord.operation_event_count ?? 0,
    operation_event_counts: sessionRecord.operation_event_counts ?? {},
    operation_event_summary: sessionRecord.operation_event_summary ?? '0',
    directive_kind_counts: sessionRecord.directive_kind_counts ?? {},
    directive_kind_summary: sessionRecord.directive_kind_summary ?? '0',
    directive_visibility_counts: sessionRecord.directive_visibility_counts ?? {},
    directive_visibility_summary: sessionRecord.directive_visibility_summary ?? '0',
    operation_id_counts: sessionRecord.operation_id_counts ?? {},
    operation_id_summary: sessionRecord.operation_id_summary ?? '0',
    last_operation_id: sessionRecord.last_operation_id ?? null,
    last_directive_kind: sessionRecord.last_directive_kind ?? null,
    last_directive_visibility: sessionRecord.last_directive_visibility ?? null,
    last_operation_event_kind: sessionRecord.last_operation_event_kind ?? null,
    last_operation_at: sessionRecord.last_operation_at ?? null,
    handoffs: {
      session_operations: sessionRecord?.handoffs?.session_operations ?? null,
      session_operations_json: sessionRecord?.handoffs?.session_operations_json ?? null,
      session_read: sessionRecord?.handoffs?.session_read ?? null,
      session_recovery: sessionRecord?.handoffs?.session_recovery ?? null,
      session_events_issues: sessionRecord?.handoffs?.session_events_issues ?? null,
      session_events_diagnostics: sessionRecord?.handoffs?.session_events_diagnostics ?? null,
      host_command_output_read: sessionRecord?.handoffs?.host_command_output_read ?? null,
    },
  };
}

function createSessionPreflightPayload(sessionRecord) {
  if (!sessionRecord) return null;
  return {
    artifact_path: sessionRecord.mcp_preflight_artifact_path ?? null,
    operational_state: sessionRecord.mcp_preflight_operational_state ?? null,
    startup_failure_summary: sessionRecord.mcp_preflight_startup_failure_summary ?? null,
    runtime_fault_summary: sessionRecord.mcp_preflight_runtime_fault_summary ?? null,
    recommended_action: sessionRecord.mcp_preflight_recommended_action ?? null,
    recommended_action_display: sessionRecord.mcp_preflight_recommended_action_display ?? null,
    recommended_command: sessionRecord.mcp_preflight_recommended_command ?? null,
    recovery_kind: sessionRecord.mcp_preflight_recovery_kind ?? null,
    recovery_kind_display: sessionRecord.mcp_preflight_recovery_kind_display ?? null,
    recovery_primary_command: sessionRecord.mcp_preflight_recovery_primary_command ?? null,
    recovery_followup_command: sessionRecord.mcp_preflight_recovery_followup_command ?? null,
    handoffs: sessionRecord.mcp_preflight_handoffs ?? null,
  };
}

function createSessionHostCommandOutputPayload(sessionRecord) {
  if (!sessionRecord) return null;
  return {
    output_ref: sessionRecord.last_host_command_output_ref ?? null,
    reader_tool: sessionRecord.last_host_command_output_reader_tool ?? null,
    command_id: sessionRecord.last_host_command_id ?? null,
    command_summary: sessionRecord.last_host_command_summary ?? null,
    terminal_state: sessionRecord.last_host_command_terminal_state ?? null,
    handoffs: {
      host_command_output_read: sessionRecord?.handoffs?.host_command_output_read ?? null,
      host_command_output_read_json: sessionRecord?.handoffs?.host_command_output_read_json ?? null,
    },
  };
}

function createSessionEventSummaryPayload(sessionRecord, { naradaDir, eventFilter = 'all', recentCount = 20 } = {}) {
  if (!sessionRecord) return null;
  const sessionEventSummary = summarizeSessionInventoryEvents([sessionRecord], { naradaDir, eventFilter, recentCount });
  return {
    event_count: sessionEventSummary.event_count,
    event_kind_counts: sessionEventSummary.event_kind_counts,
    event_kind_summary: sessionEventSummary.event_kind_summary,
    issue_code_counts: sessionEventSummary.issue_code_counts,
    issue_code_summary: sessionEventSummary.issue_code_summary,
    terminal_state_counts: sessionEventSummary.terminal_state_counts,
    terminal_state_summary: sessionEventSummary.terminal_state_summary,
    recommended_action_counts: sessionEventSummary.recommended_action_counts,
    recommended_action_summary: sessionEventSummary.recommended_action_summary,
    recommended_command_counts: sessionEventSummary.recommended_command_counts,
    recommended_command_summary: sessionEventSummary.recommended_command_summary,
    recovery_primary_counts: sessionEventSummary.recovery_primary_counts,
    recovery_primary_summary: sessionEventSummary.recovery_primary_summary,
    recovery_followup_counts: sessionEventSummary.recovery_followup_counts,
    recovery_followup_summary: sessionEventSummary.recovery_followup_summary,
    groups: sessionEventSummary.groups,
    workflow_groups: sessionEventSummary.workflow_groups,
  };
}

async function runSessionRecovery({ session = SESSION, siteRoot = SITE_ROOT, naradaDir = NARADA_DIR, jsonOutput = false } = {}) {
  const sessionRecord = readPersistedSession({ session, siteRoot, naradaDir });
  if (!sessionRecord) {
    if (jsonOutput) {
      console.log(`${JSON.stringify({
        schema: 'narada.agent_cli.session_recovery.v1',
        site_root: siteRoot,
        session,
        found: false,
      }, null, 2)}\n`);
    } else {
      console.log(formatKeyValueRows({
        SiteRoot: siteRoot,
        Session: session,
        Status: 'persisted session not found',
      }));
    }
    return 0;
  }
  const sessionEventSummary = createSessionEventSummaryPayload(sessionRecord, { naradaDir, eventFilter: 'all', recentCount: 20 });
  const sessionOperationPayload = createSessionOperationPayload(sessionRecord);
  if (jsonOutput) {
    console.log(`${JSON.stringify({
      schema: 'narada.agent_cli.session_recovery.v1',
      site_root: siteRoot,
      session,
      found: true,
      operation: sessionOperationPayload,
      recovery: createSessionRecoveryPayload(sessionRecord),
      preflight: createSessionPreflightPayload(sessionRecord),
      host_command_output: createSessionHostCommandOutputPayload(sessionRecord),
      event_summary: sessionEventSummary,
      record: sessionRecord,
    }, null, 2)}\n`);
    return 0;
  }
  console.log(formatKeyValueRows({
    SiteRoot: siteRoot,
    Session: sessionRecord.session,
    'Operational posture': sessionRecord.operational_posture_display,
    'MCP state': sessionRecord.mcp_operational_state,
    'Request posture': sessionRecord.request_posture_display,
    'Host command states': sessionRecord.host_command_terminal_state_summary,
    'Last host command': sessionRecord.last_host_command_summary ?? 'none',
    'Last host command state': sessionRecord.last_host_command_terminal_state ?? 'none',
    'Recovery kind': sessionRecord.recovery_kind_display ?? 'none',
    'Recovery primary': sessionRecord.recovery_primary_command ?? 'none',
    'Recovery followup': sessionRecord.recovery_followup_command ?? 'none',
    'Recommended action': sessionRecord.recommended_action_display,
    'Recommended command': sessionRecord.recommended_command ?? 'none',
    'Event count': sessionEventSummary.event_count,
    'Event kinds': sessionEventSummary.event_kind_summary,
    'Issue codes': sessionEventSummary.issue_code_summary,
    'Terminal states': sessionEventSummary.terminal_state_summary,
    'Host command output review': sessionRecord?.handoffs?.host_command_output_read ?? 'none',
    'Preflight state': sessionRecord.mcp_preflight_operational_state ?? 'none',
    'Preflight action': sessionRecord.mcp_preflight_recommended_action_display ?? 'none',
    'Preflight command': sessionRecord.mcp_preflight_recommended_command ?? 'none',
    'Preflight diagnostics': sessionRecord?.mcp_preflight_handoffs?.mcp_preflight_diagnostics ?? 'none',
    'Operation events': sessionOperationPayload.operation_event_summary,
    'Directive kinds': sessionOperationPayload.directive_kind_summary,
    'Directive visibility': sessionOperationPayload.directive_visibility_summary,
    'Operation ids': sessionOperationPayload.operation_id_summary,
    'Last operation id': sessionOperationPayload.last_operation_id ?? 'none',
    'Last directive kind': sessionOperationPayload.last_directive_kind ?? 'none',
    'Last directive visibility': sessionOperationPayload.last_directive_visibility ?? 'none',
    'Last operation event': sessionOperationPayload.last_operation_event_kind ?? 'none',
    'Last operation at': sessionOperationPayload.last_operation_at ?? 'unknown',
    'Session operations': sessionOperationPayload.handoffs.session_operations ?? 'none',
    'Session read': sessionRecord?.handoffs?.session_read ?? 'none',
    'Session recovery': sessionRecord?.handoffs?.session_recovery ?? 'none',
    'Session issues': sessionRecord?.handoffs?.session_events_issues ?? 'none',
    'Session diagnostics': sessionRecord?.handoffs?.session_events_diagnostics ?? 'none',
    'Session path': sessionRecord.session_path,
  }));
  return 0;
}

async function runSessionEventsRead({ session = SESSION, siteRoot = SITE_ROOT, naradaDir = NARADA_DIR, jsonOutput = false, recentCount = 20, eventFilter = 'all' } = {}) {
  const sessionRecord = readPersistedSession({ session, siteRoot, naradaDir });
  const events = readPersistedSessionEvents({ session, naradaDir });
  const normalizedEventFilter = normalizeSessionEventsFilter(eventFilter);
  const filteredEvents = filterPersistedSessionEvents(events, { eventFilter: normalizedEventFilter });
  if (!sessionRecord) {
    if (jsonOutput) {
      console.log(`${JSON.stringify({
        schema: 'narada.agent_cli.session_events_read.v1',
        site_root: siteRoot,
        session,
        found: false,
        event_filter: normalizedEventFilter,
        event_count: 0,
        total_event_count: 0,
        recent_events: [],
      }, null, 2)}\n`);
    } else {
      console.log(formatKeyValueRows({
        SiteRoot: siteRoot,
        Session: session,
        Status: 'persisted session not found',
      }));
    }
    return 0;
  }
  const recentEvents = filteredEvents.slice(-recentCount);
  const sessionEventSummary = createSessionEventSummaryPayload(sessionRecord, { naradaDir, eventFilter: normalizedEventFilter, recentCount });
  const sessionOperationPayload = createSessionOperationPayload(sessionRecord);
  if (jsonOutput) {
    console.log(`${JSON.stringify({
      schema: 'narada.agent_cli.session_events_read.v1',
      site_root: siteRoot,
      session,
      found: true,
      event_filter: normalizedEventFilter,
      event_count: filteredEvents.length,
      total_event_count: events.length,
      operation: sessionOperationPayload,
      event_kind_counts: sessionEventSummary.event_kind_counts,
      event_kind_summary: sessionEventSummary.event_kind_summary,
      issue_code_counts: sessionEventSummary.issue_code_counts,
      issue_code_summary: sessionEventSummary.issue_code_summary,
      terminal_state_counts: sessionEventSummary.terminal_state_counts,
      terminal_state_summary: sessionEventSummary.terminal_state_summary,
      recommended_action_counts: sessionEventSummary.recommended_action_counts,
      recommended_action_summary: sessionEventSummary.recommended_action_summary,
      recommended_command_counts: sessionEventSummary.recommended_command_counts,
      recommended_command_summary: sessionEventSummary.recommended_command_summary,
      recovery_primary_counts: sessionEventSummary.recovery_primary_counts,
      recovery_primary_summary: sessionEventSummary.recovery_primary_summary,
      recovery_followup_counts: sessionEventSummary.recovery_followup_counts,
      recovery_followup_summary: sessionEventSummary.recovery_followup_summary,
      groups: sessionEventSummary.groups,
      workflow_groups: sessionEventSummary.workflow_groups,
      recent_events: recentEvents,
      recovery: createSessionRecoveryPayload(sessionRecord),
      preflight: createSessionPreflightPayload(sessionRecord),
      host_command_output: createSessionHostCommandOutputPayload(sessionRecord),
      record: sessionRecord,
    }, null, 2)}\n`);
    return 0;
  }
  const blocks = [formatKeyValueRows({
    SiteRoot: siteRoot,
    Session: sessionRecord.session,
    'Event filter': normalizedEventFilter,
    'Event count': filteredEvents.length,
    'Total event count': events.length,
    'Event kinds': sessionEventSummary.event_kind_summary,
    'Issue codes': sessionEventSummary.issue_code_summary,
    'Terminal states': sessionEventSummary.terminal_state_summary,
    'Operation events': sessionOperationPayload.operation_event_summary,
    'Directive kinds': sessionOperationPayload.directive_kind_summary,
    'Directive visibility': sessionOperationPayload.directive_visibility_summary,
    'Operation ids': sessionOperationPayload.operation_id_summary,
    'Last operation id': sessionOperationPayload.last_operation_id ?? 'none',
    'Last directive kind': sessionOperationPayload.last_directive_kind ?? 'none',
    'Last directive visibility': sessionOperationPayload.last_directive_visibility ?? 'none',
    'Last operation event': sessionOperationPayload.last_operation_event_kind ?? 'none',
    'Last operation at': sessionOperationPayload.last_operation_at ?? 'unknown',
    'Host command states': sessionRecord.host_command_terminal_state_summary,
    'Last host command': sessionRecord.last_host_command_summary ?? 'none',
    'Last host command state': sessionRecord.last_host_command_terminal_state ?? 'none',
    'Last event': sessionRecord.last_event_kind ?? 'none',
    'Last event at': sessionRecord.last_event_at ?? 'unknown',
    'Operational posture': sessionRecord.operational_posture_display,
    'Request posture': sessionRecord.request_posture_display,
    'Lifecycle outcomes': sessionRecord.lifecycle_state_summary,
    'Request issues': sessionRecord.request_issue_summary,
    'Recovery kind': sessionRecord.recovery_kind_display ?? 'none',
    'Recovery primary': sessionRecord.recovery_primary_command ?? 'none',
    'Recovery followup': sessionRecord.recovery_followup_command ?? 'none',
    'Recommended action': sessionRecord.recommended_action_display,
    'Recommended command': sessionRecord.recommended_command ?? 'none',
    'Preflight state': sessionRecord.mcp_preflight_operational_state ?? 'none',
    'Preflight action': sessionRecord.mcp_preflight_recommended_action_display ?? 'none',
    'Preflight command': sessionRecord.mcp_preflight_recommended_command ?? 'none',
    'Preflight diagnostics': sessionRecord?.mcp_preflight_handoffs?.mcp_preflight_diagnostics ?? 'none',
    'Session operations': sessionOperationPayload.handoffs.session_operations ?? 'none',
    'Session recovery': sessionRecord?.handoffs?.session_recovery ?? 'none',
    'Session read': sessionRecord?.handoffs?.session_read ?? 'none',
    'Session issues': sessionRecord?.handoffs?.session_events_issues ?? 'none',
    'Session diagnostics': sessionRecord?.handoffs?.session_events_diagnostics ?? 'none',
    'Host command output review': sessionRecord?.handoffs?.host_command_output_read ?? 'none',
    'Session path': sessionRecord.session_path,
  })];
  if (recentEvents.length > 0) {
    blocks.push(['Recent events:', ...recentEvents.map((entry) => formatPersistedSessionEventLine(entry))].join('\n'));
  }
  console.log(blocks.join('\n\n'));
  return 0;
}

function buildSessionSyncSummary({
  session = SESSION,
  target = null,
  direction = 'upload',
  siteRoot = SITE_ROOT,
  naradaDir = NARADA_DIR,
  dryRun = false,
  deleteMissing = false,
} = {}) {
  if (!target) {
    return {
      exitCode: 1,
      summary: {
        schema: 'narada.agent_cli.session_sync.v1',
        site_root: siteRoot,
        session,
        success: false,
        status: 'missing_target',
        message: '--session-sync-target is required for session sync.',
      },
    };
  }

  const targetResolution = resolveSessionSyncTarget({ target });
  if (!targetResolution.ok) {
    return {
      exitCode: 1,
      summary: {
        schema: 'narada.agent_cli.session_sync.v1',
        site_root: siteRoot,
        session,
        success: false,
        status: targetResolution.status,
        message: targetResolution.message,
      },
    };
  }

  const source = resolveSessionSyncDirectoryRoots({ siteRoot, session, naradaDir });
  const destination = resolveSessionSyncDirectoryRoots({
    siteRoot: targetResolution.siteRoot,
    session,
    naradaDir,
  });
  cleanupSessionSyncStagingDirectories(source, destination);
  const directionResult = runSessionSyncDirection({
    direction,
    source,
    destination,
    session,
    dryRun,
    deleteMissing,
  });
  cleanupSessionSyncStagingDirectories(source, destination);
  const summary = {
    schema: 'narada.agent_cli.session_sync.v1',
    site_root: siteRoot,
    session,
    target,
    target_scheme: targetResolution.scheme,
    target_alias: targetResolution.alias,
    target_resolved_root: targetResolution.siteRoot,
    dry_run: dryRun,
    direction,
    source_session_root: source.sessionDir,
    source_carrier_session_root: source.carrierDir,
    destination_session_root: destination.sessionDir,
    destination_carrier_session_root: destination.carrierDir,
    delete_missing: deleteMissing,
    ...directionResult,
  };

  return {
    exitCode: directionResult.success ? 0 : 1,
    summary,
    success: directionResult.success,
    directionResult,
    targetResolution,
  };
}

async function runSessionSync({
  session = SESSION,
  target = null,
  direction = 'upload',
  siteRoot = SITE_ROOT,
  naradaDir = NARADA_DIR,
  jsonOutput = false,
  transport = 'cli',
  requestId = null,
  recordWorkflow = true,
  dryRun = false,
  deleteMissing = false,
} = {}) {
  const workflowStartedAt = new Date();
  const { summary, exitCode, directionResult = null } = buildSessionSyncSummary({
    session,
    target,
    direction,
    siteRoot,
    naradaDir,
    dryRun,
    deleteMissing,
  });
  if (recordWorkflow) {
    const workflowCompletedAt = new Date();
    const workflowStartedIso = workflowStartedAt.toISOString();
    const workflowCompletedIso = workflowCompletedAt.toISOString();
    const workflowDurationMs = workflowCompletedAt.getTime() - workflowStartedAt.getTime();
    recordSessionSyncWorkflow({
      event: 'session_sync_requested',
      requestId,
      session,
      target,
      direction,
      dryRun,
      deleteMissing,
      summary,
      directionResult,
      exitCode,
      transport,
      naradaDir,
      operation_status: 'requested',
      requested_at: workflowStartedIso,
      completed_at: workflowCompletedIso,
      duration_ms: workflowDurationMs,
    });
    recordSessionSyncWorkflow({
      event: 'session_sync_completed',
      requestId,
      session,
      target,
      direction,
      dryRun,
      deleteMissing,
      summary,
      directionResult,
      exitCode,
      transport,
      naradaDir,
      operation_status: exitCode === 0 ? 'succeeded' : 'failed',
      requested_at: workflowStartedIso,
      completed_at: workflowCompletedIso,
      duration_ms: workflowDurationMs,
    });
  }
  if (jsonOutput) {
    console.log(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    console.log(formatKeyValueRows({
      SiteRoot: siteRoot,
      Session: session,
      Target: target,
      Mode: dryRun ? 'dry-run' : 'live',
      Direction: direction,
      'Session root sync result': `${directionResult?.copied ?? 0} copied / ${directionResult?.skipped ?? 0} skipped`,
      'Carrier session root sync result': `${directionResult?.carrierCopied ?? 0} copied / ${directionResult?.carrierSkipped ?? 0} skipped`,
      'Deleted files': `${directionResult?.deleted ?? 0} deleted`,
      Status: summary?.success ? 'session sync completed' : 'session sync completed with conflicts',
      Message: summary?.message ?? 'ok',
    }));
  }
  return exitCode;
}

function resolveSessionSyncTarget({ target }) {
  const normalized = String(target ?? '').trim();
  if (!normalized) {
    return { ok: false, status: 'missing_target', message: '--session-sync-target is required for session sync.' };
  }

  const fileTarget = normalizeSessionSyncFileTarget(normalized);
  if (fileTarget.ok || fileTarget.status) return fileTarget;

  const siteTarget = normalizeSessionSyncAliasTarget(normalized, 'site:', 'NARADA_SITE_ROOT');
  if (siteTarget.ok || siteTarget.status) return siteTarget;

  const cloudTarget = normalizeSessionSyncAliasTarget(normalized, 'cloud:', 'NARADA_CLOUD_ROOT');
  if (cloudTarget.ok || cloudTarget.status) return cloudTarget;

  if (isLikelyPathLike(normalized)) {
    return {
      ok: true,
      scheme: 'path',
      siteRoot: resolve(normalized),
      alias: null,
    };
  }

  return {
    ok: false,
    status: 'invalid_session_sync_target',
    message: `Unrecognized --session-sync-target "${normalized}". Use a local path, file:// URL, site:<alias>, or cloud:<alias>.`,
  };
}

function normalizeSessionSyncAliasTarget(value, prefix, envPrefix) {
  const lowerPrefix = prefix.toLowerCase();
  if (!value.toLowerCase().startsWith(lowerPrefix)) return { ok: false };
  const alias = value.slice(prefix.length).trim();
  if (!alias) {
    return {
      ok: false,
      status: 'invalid_session_sync_target',
      message: `Unrecognized ${prefix} alias in --session-sync-target "${value}".`,
    };
  }
  const envKey = `${envPrefix}_${normalizeSessionSyncAlias(alias)}`;
  const aliasRoot = process.env[envKey];
  if (!aliasRoot || !String(aliasRoot).trim()) {
    return {
      ok: false,
      status: 'unresolved_session_sync_alias',
      message: `Cannot resolve --session-sync-target "${value}". Missing ${envKey}.`,
    };
  }
  return {
    ok: true,
    scheme: prefix.slice(0, -1),
    alias,
    siteRoot: resolve(String(aliasRoot)),
  };
}

function normalizeSessionSyncFileTarget(value) {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return { ok: false };
  try {
    const siteRoot = resolve(fileURLToPath(new URL(value)));
    return { ok: true, scheme: 'file', alias: null, siteRoot };
  } catch {
    return {
      ok: false,
      status: 'invalid_session_sync_target',
      message: `Invalid file URI in --session-sync-target "${value}".`,
    };
  }
}

function normalizeSessionSyncAlias(alias) {
  return String(alias)
    .trim()
    .replace(/[^A-Za-z0-9_]/g, '_')
    .toUpperCase();
}

function isLikelyPathLike(value) {
  const trimmed = String(value).trim();
  if (!trimmed) return false;
  if (trimmed === '.' || trimmed === '..') return true;
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return true;
  if (trimmed.startsWith('/') || trimmed.startsWith('\\\\') || trimmed.startsWith('./') || trimmed.startsWith('.\\\\')) return true;
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\\\')) return true;
  if (/^[^:]+$/.test(trimmed)) return true;
  return false;
}

function cleanupSessionSyncStagingDirectories(...roots) {
  for (const root of roots) {
    const sourceStaging = join(root.sessionDir, '.session-sync-staging');
    const carrierStaging = join(root.carrierDir, '.session-sync-staging');
    const stale = [sourceStaging, carrierStaging];
    for (const directory of stale) {
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        // Ignore best-effort staging cleanup.
      }
    }
  }
}

function runSessionSyncDirection({ direction, source, destination, dryRun = false, deleteMissing = false }) {
  if (direction === 'download') {
    return copySessionSyncRoots({
      source: destination,
      destination: source,
      dryRun,
      deleteMissing: false,
      direction,
      compare: false,
      operation: 'download',
    });
  }
  if (direction === 'bidirectional') {
    const forward = copySessionSyncRoots({
      source,
      destination,
      direction,
      compare: true,
      dryRun,
      deleteMissing,
      operation: 'bidirectional',
    });
    const backward = copySessionSyncRoots({
      source: destination,
      destination: source,
      dryRun,
      deleteMissing,
      direction,
      compare: true,
      operation: 'bidirectional',
    });
    return {
      operation: 'bidirectional',
      success: forward.success && backward.success,
      copied: forward.copied + backward.copied,
      skipped: forward.skipped + backward.skipped,
      conflicts: forward.conflicts + backward.conflicts,
      message: forward.conflicts + backward.conflicts > 0 ? 'sync completed with conflict timestamps' : 'ok',
      carrierCopied: forward.carrierCopied + backward.carrierCopied,
      carrierSkipped: forward.carrierSkipped + backward.carrierSkipped,
      carrierConflicts: forward.carrierConflicts + backward.carrierConflicts,
      sessionCopied: forward.sessionCopied + backward.sessionCopied,
      sessionSkipped: forward.sessionSkipped + backward.sessionSkipped,
      sessionConflicts: forward.sessionConflicts + backward.sessionConflicts,
      direction,
    };
  }
  return copySessionSyncRoots({
    source,
    destination,
    direction,
    compare: false,
    deleteMissing: direction === 'upload' ? deleteMissing : false,
    dryRun,
    operation: 'upload',
  });
}

function copySessionSyncRoots({ source, destination, direction, compare, operation, dryRun = false, deleteMissing = false }) {
  const sourceSessionEntries = collectSessionRootEntries(source.sessionDir);
  const destinationSessionEntries = collectSessionRootEntries(destination.sessionDir);
  const sourceCarrierEntries = collectSessionRootEntries(source.carrierDir);
  const destinationCarrierEntries = collectSessionRootEntries(destination.carrierDir);

  const syncSession = copySessionSyncEntries({
    sourceRoot: source.sessionDir,
    destinationRoot: destination.sessionDir,
    sourceEntries: sourceSessionEntries,
    destinationEntries: destinationSessionEntries,
    compare,
    dryRun,
    deleteMissing,
    operation,
  });
  const syncCarrier = copySessionSyncEntries({
    sourceRoot: source.carrierDir,
    destinationRoot: destination.carrierDir,
    sourceEntries: sourceCarrierEntries,
    destinationEntries: destinationCarrierEntries,
    compare,
    dryRun,
    deleteMissing,
    operation,
  });

  return {
    operation,
    success: syncSession.conflicts === 0 && syncCarrier.conflicts === 0,
    copied: syncSession.copied + syncCarrier.copied,
    skipped: syncSession.skipped + syncCarrier.skipped,
    conflicts: syncSession.conflicts + syncCarrier.conflicts,
    deleted: syncSession.deleted + syncCarrier.deleted,
    message: syncSession.conflicts + syncCarrier.conflicts > 0 ? 'sync completed with conflict timestamps' : 'ok',
    carrierCopied: syncCarrier.copied,
    carrierSkipped: syncCarrier.skipped,
    carrierConflicts: syncCarrier.conflicts,
    carrierDeleted: syncCarrier.deleted,
    sessionCopied: syncSession.copied,
    sessionSkipped: syncSession.skipped,
    sessionConflicts: syncSession.conflicts,
    sessionDeleted: syncSession.deleted,
    direction,
  };
}

function copySessionSyncEntries({
  sourceRoot,
  destinationRoot,
  sourceEntries,
  destinationEntries,
  compare,
  dryRun = false,
  deleteMissing = false,
}) {
  if (!existsSync(sourceRoot)) sourceRoot = null;
  if (!sourceRoot) {
    return { copied: 0, skipped: 0, conflicts: 1, deleted: 0 };
  }

  const destinationByPath = new Map(destinationEntries.map((entry) => [entry.relativePath, entry]));
  let copied = 0;
  let skipped = 0;
  let conflicts = 0;
  let deleted = 0;

  for (const sourceEntry of sourceEntries) {
    const destinationEntry = destinationByPath.get(sourceEntry.relativePath);
    if (!destinationEntry) {
      if (!dryRun) {
        writeSessionSyncFile({ sourceEntry, destinationRoot });
      }
      copied += 1;
      continue;
    }
    if (!compare) {
      if (!dryRun) {
        writeSessionSyncFile({ sourceEntry, destinationRoot });
      }
      copied += 1;
      continue;
    }
    if (Number(sourceEntry.mtimeMs) > Number(destinationEntry.mtimeMs)) {
      if (!dryRun) {
        writeSessionSyncFile({ sourceEntry, destinationRoot });
      }
      copied += 1;
      continue;
    }
    if (Number(sourceEntry.mtimeMs) < Number(destinationEntry.mtimeMs)) {
      copied += 0;
      skipped += 1;
      continue;
    }
    if (sourceEntry.size === destinationEntry.size && sourceAndDestinationSessionSyncEntriesMatch({ sourceEntry, destinationEntry, destinationRoot })) {
      skipped += 1;
      continue;
    }
    conflicts += 1;
    if (!dryRun) {
      writeSessionSyncFile({ sourceEntry, destinationRoot });
    }
    copied += 1;
  }
  if (deleteMissing) {
    const sourcePaths = new Set(sourceEntries.map((entry) => entry.relativePath));
    for (const destinationEntry of destinationEntries) {
      if (sourcePaths.has(destinationEntry.relativePath)) continue;
      deleted += 1;
      if (!dryRun) {
        const destinationPath = join(destinationRoot, destinationEntry.relativePath);
        try {
          unlinkSync(destinationPath);
        } catch {
          // Ignore best-effort deletion failures.
        }
      }
    }
  }

  return { copied, skipped, conflicts, deleted };
}

function writeSessionSyncFile({ sourceEntry, destinationRoot }) {
  const destinationPath = join(destinationRoot, sourceEntry.relativePath);
  const destinationDirectory = dirname(destinationPath);
  const stagingDirectory = join(destinationRoot, '.session-sync-staging');
  const stagingPath = join(stagingDirectory, `${randomId()}.tmp`);
  let stagingFd = null;
  let destinationDirectoryFd = null;

  mkdirSync(destinationDirectory, { recursive: true });
  mkdirSync(stagingDirectory, { recursive: true });

  try {
    copyFileSync(sourceEntry.sourcePath, stagingPath);
    stagingFd = openSync(stagingPath, 'r');
    try {
      fsyncSync(stagingFd);
    } catch {
      // fsync can be unsupported for some Windows/FS combinations; continue without strict durability.
    }
    closeSync(stagingFd);
    stagingFd = null;
    try {
      renameSync(stagingPath, destinationPath);
    } catch (error) {
      if (error.code === 'EXDEV') {
        copyFileSync(stagingPath, destinationPath);
      } else {
        throw error;
      }
    }
    destinationDirectoryFd = openSync(destinationDirectory, 'r');
    try {
      fsyncSync(destinationDirectoryFd);
    } catch {
      // Directory fsync is best-effort for cross-platform compatibility.
    }
  } catch (error) {
    try {
      unlinkSync(stagingPath);
    } catch {
      // Ignore cleanup failures after write errors.
    }
    throw error;
  } finally {
    if (stagingFd !== null) {
      closeSync(stagingFd);
      stagingFd = null;
    }
    if (destinationDirectoryFd !== null) {
      closeSync(destinationDirectoryFd);
      destinationDirectoryFd = null;
    }
  }
}

function sourceAndDestinationSessionSyncEntriesMatch({ sourceEntry, destinationEntry, destinationRoot }) {
  const destinationPath = join(destinationRoot, sourceEntry.relativePath);
  if (!existsSync(destinationPath)) return false;
  if (Number(destinationEntry.size ?? 0) !== Number(sourceEntry.size)) return false;
  const sourceHash = sessionSyncSha256(sourceEntry.sourcePath);
  const destinationHash = sessionSyncSha256(destinationPath);
  if (!sourceHash || !destinationHash) return false;
  return sourceHash === destinationHash;
}

function sessionSyncSha256(filePath) {
  try {
    return createHash('sha256').update(readFileSync(filePath)).digest('hex');
  } catch {
    return null;
  }
}

function collectSessionRootEntries(root) {
  const entries = [];
  if (!existsSync(root) || !statSync(root).isDirectory()) return entries;
  const visit = (current, relativePath = '') => {
    for (const dirEntry of readdirSync(current, { withFileTypes: true })) {
      const nextPath = join(current, dirEntry.name);
      const nextRelative = relativePath ? join(relativePath, dirEntry.name) : dirEntry.name;
      if (dirEntry.isDirectory()) {
        visit(nextPath, nextRelative);
      } else if (dirEntry.isFile()) {
        const stat = statSync(nextPath);
        entries.push({
          relativePath: nextRelative,
          sourcePath: nextPath,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        });
      }
    }
  };
  visit(root);
  return entries;
}

function resolveSessionSyncDirectoryRoots({ siteRoot, session, naradaDir = NARADA_DIR } = {}) {
  const normalizedSiteRoot = resolve(siteRoot);
  // Legacy sync/import compatibility only. Active runtime sessions live under
  // .narada/crew/nars-sessions/<session>/session.jsonl.
  const legacyAgentSessionsRoot = existsSync(join(normalizedSiteRoot, 'agent-sessions'))
    ? join(normalizedSiteRoot, 'agent-sessions')
    : (existsSync(join(normalizedSiteRoot, '.ai', 'runtime', 'agent-sessions'))
      ? join(normalizedSiteRoot, '.ai', 'runtime', 'agent-sessions')
      : join(normalizedSiteRoot, 'agent-sessions'));

  const carrierSessionRoot = existsSync(join(normalizedSiteRoot, '.narada', 'crew', 'nars-sessions', session))
    ? join(normalizedSiteRoot, '.narada', 'crew', 'nars-sessions', session)
    : join(normalizedSiteRoot, 'crew', 'nars-sessions', session);

  if (existsSync(join(normalizedSiteRoot, 'nars-sessions', session))) {
    return {
      siteRoot: normalizedSiteRoot,
      sessionDir: legacyAgentSessionsRoot,
      carrierDir: join(normalizedSiteRoot, 'nars-sessions', session),
      naradaDir,
      hasCarrierDir: true,
    };
  }
  if (existsSync(join(normalizedSiteRoot, 'agent-sessions', `${session}.jsonl`))) {
    return {
      siteRoot: normalizedSiteRoot,
      sessionDir: legacyAgentSessionsRoot,
      carrierDir: join(normalizedSiteRoot, '.narada', 'crew', 'nars-sessions', session),
      naradaDir,
      hasCarrierDir: true,
    };
  }
  return {
    siteRoot: normalizedSiteRoot,
    sessionDir: legacyAgentSessionsRoot,
    carrierDir: carrierSessionRoot,
    naradaDir,
    hasCarrierDir: true,
  };
}

async function runSessionRead({ session = SESSION, siteRoot = SITE_ROOT, naradaDir = NARADA_DIR, jsonOutput = false } = {}) {
  const sessionRecord = readPersistedSession({ session, siteRoot, naradaDir });
  if (!sessionRecord) {
    if (jsonOutput) {
      console.log(`${JSON.stringify({
        schema: 'narada.agent_cli.session_read.v1',
        site_root: siteRoot,
        session,
        found: false,
      }, null, 2)}\n`);
    } else {
      console.log(formatKeyValueRows({
        SiteRoot: siteRoot,
        Session: session,
        Status: 'persisted session not found',
      }));
    }
    return 0;
  }
  const sessionEventSummary = createSessionEventSummaryPayload(sessionRecord, { naradaDir, eventFilter: 'all', recentCount: 20 });
  const sessionOperationPayload = createSessionOperationPayload(sessionRecord);
  if (jsonOutput) {
    console.log(`${JSON.stringify({
      schema: 'narada.agent_cli.session_read.v1',
      site_root: siteRoot,
      session,
      found: true,
      operation: sessionOperationPayload,
      recovery: createSessionRecoveryPayload(sessionRecord),
      preflight: createSessionPreflightPayload(sessionRecord),
      host_command_output: createSessionHostCommandOutputPayload(sessionRecord),
      event_summary: sessionEventSummary,
      record: sessionRecord,
    }, null, 2)}\n`);
    return 0;
  }
  console.log(formatKeyValueRows({
    SiteRoot: siteRoot,
    Session: sessionRecord.session,
    Agent: sessionRecord.agent_id ?? 'unknown',
    Runtime: sessionRecord.runtime ?? 'unknown',
    Mode: sessionRecord.mode ?? 'unknown',
    Started: sessionRecord.started_at ?? 'unknown',
    Heartbeat: sessionRecord.heartbeat_display,
    'Operational posture': sessionRecord.operational_posture_display,
    'MCP state': sessionRecord.mcp_operational_state,
    'Request posture': sessionRecord.request_posture_display,
    'Operation events': sessionOperationPayload.operation_event_summary,
    'Directive kinds': sessionOperationPayload.directive_kind_summary,
    'Directive visibility': sessionOperationPayload.directive_visibility_summary,
    'Operation ids': sessionOperationPayload.operation_id_summary,
    'Last operation id': sessionOperationPayload.last_operation_id ?? 'none',
    'Last directive kind': sessionOperationPayload.last_directive_kind ?? 'none',
    'Last directive visibility': sessionOperationPayload.last_directive_visibility ?? 'none',
    'Last operation event': sessionOperationPayload.last_operation_event_kind ?? 'none',
    'Last operation at': sessionOperationPayload.last_operation_at ?? 'unknown',
    'Last event': sessionRecord.last_event_kind ?? 'none',
    'Last event at': sessionRecord.last_event_at ?? 'unknown',
    'Last terminal state': sessionRecord.last_terminal_state ?? 'none',
    'Last lifecycle event': sessionRecord.last_lifecycle_event_kind ?? 'none',
    'Last lifecycle at': sessionRecord.last_lifecycle_at ?? 'unknown',
    'Last lifecycle state': sessionRecord.last_lifecycle_state ?? 'none',
    'Lifecycle outcomes': sessionRecord.lifecycle_state_summary,
    'Request outcomes': sessionRecord.request_outcome_summary,
    'Request issues': sessionRecord.request_issue_summary,
    'Host command states': sessionRecord.host_command_terminal_state_summary,
    'Last host command': sessionRecord.last_host_command_summary ?? 'none',
    'Last host command state': sessionRecord.last_host_command_terminal_state ?? 'none',
    'Last host command output': sessionRecord.last_host_command_output_ref ?? 'none',
    'Host command output review': sessionRecord?.handoffs?.host_command_output_read ?? 'none',
    'Event count': sessionEventSummary.event_count,
    'Event kinds': sessionEventSummary.event_kind_summary,
    'Issue codes': sessionEventSummary.issue_code_summary,
    'Terminal states': sessionEventSummary.terminal_state_summary,
    'MCP startup failures': sessionRecord.mcp_startup_failure_summary,
    'MCP runtime faults': sessionRecord.mcp_runtime_fault_summary,
    'Preflight artifact': sessionRecord.mcp_preflight_artifact_path ?? 'none',
    'Preflight state': sessionRecord.mcp_preflight_operational_state ?? 'none',
    'Preflight action': sessionRecord.mcp_preflight_recommended_action_display ?? 'none',
    'Preflight command': sessionRecord.mcp_preflight_recommended_command ?? 'none',
    'Preflight diagnostics': sessionRecord?.mcp_preflight_handoffs?.mcp_preflight_diagnostics ?? 'none',
    'Session operations': sessionOperationPayload.handoffs.session_operations ?? 'none',
    'Recovery kind': sessionRecord.recovery_kind_display ?? 'none',
    'Recovery primary': sessionRecord.recovery_primary_command ?? 'none',
    'Recovery followup': sessionRecord.recovery_followup_command ?? 'none',
    'Recommended action': sessionRecord.recommended_action_display,
    'Recommended command': sessionRecord.recommended_command ?? 'none',
    'Session recovery': sessionRecord?.handoffs?.session_recovery ?? 'none',
    'Session events': sessionRecord?.handoffs?.session_events ?? 'none',
    'Session issues': sessionRecord?.handoffs?.session_events_issues ?? 'none',
    'Session diagnostics': sessionRecord?.handoffs?.session_events_diagnostics ?? 'none',
    'Host command output review': sessionRecord?.handoffs?.host_command_output_read ?? 'none',
    'Session path': sessionRecord.session_path,
  }));
  return 0;
}

async function runHostCommandOutputRead({ session = SESSION, siteRoot = SITE_ROOT, naradaDir = NARADA_DIR, outputRef = HOST_COMMAND_OUTPUT_REF, jsonOutput = false } = {}) {
  const sessionRecord = readPersistedSession({ session, siteRoot, naradaDir });
  const resolvedOutputRef = String(outputRef ?? '').trim() || sessionRecord?.last_host_command_output_ref || null;
  const outputDir = join(naradaDir, 'crew', 'nars-sessions', session, 'host-command-output');
  if (!resolvedOutputRef) {
    if (jsonOutput) {
      console.log(`${JSON.stringify({
        schema: 'narada.agent_cli.host_command_output_read.v1',
        site_root: siteRoot,
        session,
        found: false,
        output_ref: null,
      }, null, 2)}\n`);
    } else {
      console.log(formatKeyValueRows({
        SiteRoot: siteRoot,
        Session: session,
        Status: 'host command output not found',
      }));
    }
    return 0;
  }
  let outputPayload = null;
  try {
    outputPayload = readCarrierHostCommandOutputRef(resolvedOutputRef, { outputDir });
  } catch {
    outputPayload = null;
  }
  if (!outputPayload) {
    if (jsonOutput) {
      console.log(`${JSON.stringify({
        schema: 'narada.agent_cli.host_command_output_read.v1',
        site_root: siteRoot,
        session,
        found: false,
        output_ref: resolvedOutputRef,
      }, null, 2)}\n`);
    } else {
      console.log(formatKeyValueRows({
        SiteRoot: siteRoot,
        Session: session,
        'Output ref': resolvedOutputRef,
        Status: 'host command output not found',
      }));
    }
    return 0;
  }
  const payload = {
    schema: 'narada.agent_cli.host_command_output_read.v1',
    site_root: siteRoot,
    session,
    found: true,
    output_ref: resolvedOutputRef,
    reader_tool: sessionRecord?.last_host_command_output_reader_tool ?? 'carrier_host_command_output_read',
    command_id: sessionRecord?.last_host_command_id ?? outputPayload.command_id ?? null,
    command_summary: sessionRecord?.last_host_command_summary ?? null,
    terminal_state: sessionRecord?.last_host_command_terminal_state ?? null,
    output_truncated: outputPayload.output_truncated ?? false,
    stdout: outputPayload.stdout ?? '',
    stderr: outputPayload.stderr ?? '',
    handoffs: {
      session_read: sessionRecord?.handoffs?.session_read ?? null,
      session_recovery: sessionRecord?.handoffs?.session_recovery ?? null,
      host_command_output_read_json: sessionRecord?.handoffs?.host_command_output_read_json ?? null,
    },
  };
  if (jsonOutput) {
    console.log(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }
  console.log([
    formatKeyValueRows({
      SiteRoot: siteRoot,
      Session: session,
      'Command id': payload.command_id ?? 'unknown',
      'Command summary': payload.command_summary ?? 'unknown',
      'Terminal state': payload.terminal_state ?? 'unknown',
      'Output ref': payload.output_ref,
      'Reader tool': payload.reader_tool,
      'Output truncated': payload.output_truncated ? 'yes' : 'no',
      'Session recovery': payload.handoffs.session_recovery ?? 'none',
      'Session read': payload.handoffs.session_read ?? 'none',
    }),
    ['Stdout:', payload.stdout || '(empty)'].join('\n'),
    ['Stderr:', payload.stderr || '(empty)'].join('\n'),
  ].join('\n\n'));
  return 0;
}



function readMcpPreflightArtifact({ artifactDir = MCP_PREFLIGHT_ARTIFACT_DIR, session = SESSION, identity = IDENTITY, siteRoot = SITE_ROOT } = {}) {
  const artifactPath = join(artifactDir, `${session}.json`);
  if (!existsSync(artifactPath)) return null;
  try {
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
    if (artifact?.schema !== 'narada.agent_cli.mcp_preflight_artifact.v1') return null;
    if (artifact?.session !== session) return null;
    if (artifact?.identity !== identity) return null;
    if (artifact?.site_root !== siteRoot) return null;
    return summarizePersistedMcpPreflightArtifact({ artifact, artifactPath, siteRoot });
  } catch {
    return null;
  }
}

function recordMcpPreflightArtifactLinkage({ sessionPath = SESSION_PATH, emit, preflightArtifact = readMcpPreflightArtifact() } = {}) {
  if (!preflightArtifact) return null;
  const payload = {
    artifact_path: preflightArtifact.artifact_path,
    generated_at: preflightArtifact.generated_at,
    mcp_operational_state: preflightArtifact.mcp_operational_state,
    mcp_startup_failure_summary: preflightArtifact.mcp_startup_failure_summary,
    mcp_runtime_fault_summary: preflightArtifact.mcp_runtime_fault_summary,
    recommended_action: preflightArtifact.recommended_action ?? null,
    recommended_action_display: preflightArtifact.recommended_action_display ?? null,
    recommended_command: preflightArtifact.recommended_command ?? null,
    recovery_kind: preflightArtifact.recovery_kind ?? null,
    recovery_kind_display: preflightArtifact.recovery_kind_display ?? null,
    recovery_primary_command: preflightArtifact.recovery_primary_command ?? null,
    recovery_followup_command: preflightArtifact.recovery_followup_command ?? null,
    handoffs: preflightArtifact.handoffs ?? null,
  };
  appendSession(sessionPath, sessionEventEntry('mcp_preflight_artifact_linked', payload));
  emit?.('mcp_preflight_artifact_linked', payload);
  return payload;
}

function summarizePersistedMcpPreflightArtifact({ artifact, artifactPath, siteRoot = SITE_ROOT } = {}) {
  if (!artifact || artifact?.schema !== 'narada.agent_cli.mcp_preflight_artifact.v1') return null;
  if (!artifact.session || !artifact.identity) return null;
  return createMcpPreflightPayload({
    identity: artifact.identity,
    session: artifact.session,
    siteRoot: artifact.site_root ?? siteRoot,
    artifactPath,
    generatedAt: artifact.generated_at ?? null,
    mcpStatus: {
      mcp_operational_state: artifact.mcp_operational_state ?? 'unknown',
      mcp_startup_failure_count: artifact.mcp_startup_failure_count ?? 0,
      mcp_startup_failures: Array.isArray(artifact.mcp_startup_failures) ? artifact.mcp_startup_failures : [],
      mcp_startup_failure_summary: artifact.mcp_startup_failure_summary ?? '0',
      mcp_runtime_fault_count: artifact.mcp_runtime_fault_count ?? 0,
      mcp_runtime_faults: Array.isArray(artifact.mcp_runtime_faults) ? artifact.mcp_runtime_faults : [],
      mcp_runtime_fault_summary: artifact.mcp_runtime_fault_summary ?? '0',
    },
    mcpServerCount: artifact.mcp_server_count ?? 0,
    toolCount: artifact.tool_count ?? 0,
  });
}

function readMcpPreflightInventory({ artifactDir = MCP_PREFLIGHT_ARTIFACT_DIR, siteRoot = SITE_ROOT } = {}) {
  return readDirFiles(artifactDir)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => {
      const artifactPath = join(artifactDir, entry);
      const artifact = readJsonFile(artifactPath);
      return summarizePersistedMcpPreflightArtifact({ artifact, artifactPath, siteRoot });
    })
    .filter(Boolean)
    .sort((left, right) => String(right?.generated_at ?? '').localeCompare(String(left?.generated_at ?? '')) || left.session.localeCompare(right.session));
}

function readSessionInventory({ siteRoot = SITE_ROOT, naradaDir = NARADA_DIR } = {}) {
  const sessionsRoot = join(naradaDir, 'crew', 'nars-sessions');
  return readDirFiles(sessionsRoot)
    .map((session) => readPersistedSession({ session, siteRoot, naradaDir }))
    .filter(Boolean)
    .sort((left, right) => String(right?.heartbeat_at ?? '').localeCompare(String(left?.heartbeat_at ?? '')) || left.session.localeCompare(right.session));
}

function readPersistedSession({ session = SESSION, siteRoot = SITE_ROOT, naradaDir = NARADA_DIR } = {}) {
  const sessionDir = join(naradaDir, 'crew', 'nars-sessions', session);
  try {
    if (!statSync(sessionDir).isDirectory()) return null;
  } catch {
    return null;
  }
  return summarizePersistedSession({ session, sessionDir, siteRoot, naradaDir });
}

function readPersistedSessionEvents({ session = SESSION, naradaDir = NARADA_DIR } = {}) {
  const sessionDir = join(naradaDir, 'crew', 'nars-sessions', session);
  try {
    if (!statSync(sessionDir).isDirectory()) return [];
  } catch {
    return [];
  }
  return readJsonlFile(join(sessionDir, 'session.jsonl'));
}

function normalizeSessionEventsFilter(value) {
  const normalized = String(value ?? 'all').trim().toLowerCase();
  if (['all', 'lifecycle', 'issues', 'diagnostics', 'operations'].includes(normalized)) return normalized;
  return 'all';
}

function normalizeSessionSyncDirection(value) {
  const normalized = String(value ?? 'upload').trim().toLowerCase();
  if (['upload', 'download', 'bidirectional'].includes(normalized)) return normalized;
  return 'upload';
}

function filterPersistedSessionEvents(events = [], { eventFilter = 'all' } = {}) {
  const normalizedEventFilter = normalizeSessionEventsFilter(eventFilter);
  if (normalizedEventFilter === 'all') return events;
  return events.filter((entry) => {
    if (normalizedEventFilter === 'lifecycle') return classifyPersistedSessionLifecycleState(entry) !== null;
    if (normalizedEventFilter === 'issues') return classifyPersistedSessionIssueCode(entry) !== null;
    if (normalizedEventFilter === 'diagnostics') return (entry?.event_kind ?? entry?.event ?? null) === 'carrier_diagnostic_recorded';
    if (normalizedEventFilter === 'operations') return classifyPersistedSessionOperationEvent(entry) !== null;
    return true;
  });
}

function summarizeSessionInventoryEvents(inventory = [], { naradaDir = NARADA_DIR, eventFilter = 'all', recentCount = 20 } = {}) {
  const normalizedEventFilter = normalizeSessionEventsFilter(eventFilter);
  const eventKindCounts = {};
  const issueCodeCounts = {};
  const terminalStateCounts = {};
  const sessions = [];
  const recentEvents = [];
  for (const item of inventory) {
    const session = item?.session;
    if (!session) continue;
    const events = filterPersistedSessionEvents(readPersistedSessionEvents({ session, naradaDir }), { eventFilter: normalizedEventFilter });
    if (events.length === 0) continue;
    for (const entry of events) {
      const eventKind = entry?.event_kind ?? entry?.event ?? 'unknown-event';
      const terminalState = entry?.payload?.terminal_state ?? entry?.terminal_state ?? null;
      const issueCode = classifyPersistedSessionIssueCode(entry);
      incrementInventoryCounter(eventKindCounts, eventKind);
      if (terminalState) incrementInventoryCounter(terminalStateCounts, terminalState);
      if (issueCode) incrementInventoryCounter(issueCodeCounts, issueCode);
      recentEvents.push({
        session,
        timestamp: entry?.timestamp ?? entry?.occurred_at ?? entry?.payload?.occurred_at ?? entry?.payload?.created_at ?? 'unknown-time',
        event_kind: eventKind,
        terminal_state: terminalState,
        issue_code: issueCode,
      });
    }
    const lastEvent = events.at(-1) ?? null;
    sessions.push({
      session,
      event_count: events.length,
      last_event_kind: lastEvent?.event_kind ?? lastEvent?.event ?? 'unknown-event',
      last_event_at: lastEvent?.timestamp ?? lastEvent?.occurred_at ?? lastEvent?.payload?.occurred_at ?? lastEvent?.payload?.created_at ?? 'unknown-time',
      recommended_action: item?.recommended_action,
      recommended_action_display: item?.recommended_action_display,
      recommended_command: item?.recommended_command ?? null,
      recovery_kind: item?.recovery_kind ?? null,
      recovery_kind_display: item?.recovery_kind_display ?? null,
      recovery_primary_command: item?.recovery_primary_command ?? null,
      recovery_followup_command: item?.recovery_followup_command ?? null,
      handoffs: item?.handoffs ?? buildPersistedSessionHandoffs({ session, identity: item?.agent_id ?? IDENTITY, eventCount: recentCount }),
    });
  }
  sessions.sort((left, right) => right.event_count - left.event_count || String(right.last_event_at ?? '').localeCompare(String(left.last_event_at ?? '')) || left.session.localeCompare(right.session));
  recentEvents.sort((left, right) => String(right.timestamp ?? '').localeCompare(String(left.timestamp ?? '')) || left.session.localeCompare(right.session) || left.event_kind.localeCompare(right.event_kind));
  const workflowGroups = summarizeActionWorkflowGroups(sessions);
  return {
    event_filter: normalizedEventFilter,
    event_count: recentEvents.length,
    event_kind_counts: eventKindCounts,
    event_kind_summary: formatInventoryCounts(eventKindCounts),
    issue_code_counts: issueCodeCounts,
    issue_code_summary: formatInventoryCounts(issueCodeCounts),
    terminal_state_counts: terminalStateCounts,
    terminal_state_summary: formatInventoryCounts(terminalStateCounts),
    recommended_action_counts: workflowGroups ? Object.fromEntries(Object.entries(workflowGroups).map(([key, group]) => [key, Array.isArray(group?.sessions) ? group.sessions.length : 0])) : {},
    recommended_action_summary: formatInventoryCounts(workflowGroups ? Object.fromEntries(Object.entries(workflowGroups).map(([key, group]) => [key, Array.isArray(group?.sessions) ? group.sessions.length : 0])) : {}),
    recommended_command_counts: sessions.reduce((counts, item) => (incrementInventoryCounter(counts, item?.recommended_command ?? 'none'), counts), {}),
    recommended_command_summary: formatInventoryCounts(sessions.reduce((counts, item) => (incrementInventoryCounter(counts, item?.recommended_command ?? 'none'), counts), {})),
    recovery_primary_counts: sessions.reduce((counts, item) => (incrementInventoryCounter(counts, item?.recovery_primary_command ?? 'none'), counts), {}),
    recovery_primary_summary: formatInventoryCounts(sessions.reduce((counts, item) => (incrementInventoryCounter(counts, item?.recovery_primary_command ?? 'none'), counts), {})),
    recovery_followup_counts: sessions.reduce((counts, item) => (incrementInventoryCounter(counts, item?.recovery_followup_command ?? 'none'), counts), {}),
    recovery_followup_summary: formatInventoryCounts(sessions.reduce((counts, item) => (incrementInventoryCounter(counts, item?.recovery_followup_command ?? 'none'), counts), {})),
    groups: summarizeSessionInventoryEventGroups(recentEvents),
    workflow_groups: workflowGroups,
    sessions,
    recent_events: recentEvents.slice(0, recentCount),
  };
}

function summarizeSessionInventoryEventGroups(events = []) {
  return {
    event_kind: summarizeSessionInventoryEventGroupBy(events, (entry) => entry?.event_kind ?? 'unknown-event'),
    issue_code: summarizeSessionInventoryEventGroupBy(events.filter((entry) => entry?.issue_code), (entry) => entry.issue_code),
    terminal_state: summarizeSessionInventoryEventGroupBy(events.filter((entry) => entry?.terminal_state), (entry) => entry.terminal_state),
  };
}

function summarizeSessionInventoryEventGroupBy(events = [], getKey) {
  const groups = Object.create(null);
  for (const entry of events) {
    const key = String(getKey(entry) ?? 'unknown');
    if (!groups[key]) groups[key] = [];
    groups[key].push(entry);
  }
  return Object.fromEntries(Object.entries(groups)
    .sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]))
    .map(([key, entries]) => [key, entries
      .slice()
      .sort((left, right) => String(right.timestamp ?? '').localeCompare(String(left.timestamp ?? '')) || left.session.localeCompare(right.session) || left.event_kind.localeCompare(right.event_kind))]));
}


function normalizeSessionInventoryFilterKey(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['operational_posture', 'request_posture', 'mcp_state', 'heartbeat_status', 'recommended_action', 'recovery_kind'].includes(normalized)) return normalized;
  return null;
}

function normalizeSessionInventoryFilterValue(value) {
  const normalized = String(value ?? '').trim();
  return normalized.length > 0 ? normalized : null;
}

function filterSessionInventory(inventory = [], { filterKey = null, filterValue = null } = {}) {
  const normalizedFilterKey = normalizeSessionInventoryFilterKey(filterKey);
  const normalizedFilterValue = normalizeSessionInventoryFilterValue(filterValue);
  if (!normalizedFilterKey || !normalizedFilterValue) return inventory;
  const fieldByFilterKey = {
    operational_posture: 'operational_posture',
    request_posture: 'request_posture',
    mcp_state: 'mcp_operational_state',
    heartbeat_status: 'heartbeat_status',
    recommended_action: 'recommended_action',
    recovery_kind: 'recovery_kind',
  };
  const field = fieldByFilterKey[normalizedFilterKey];
  return inventory.filter((item) => String(item?.[field] ?? '') === normalizedFilterValue);
}

function summarizeSessionInventoryRollup(inventory = []) {
  const heartbeatCounts = {};
  const operationalPostureCounts = {};
  const mcpStateCounts = {};
  const terminalStateCounts = {};
  const lifecycleStateCounts = {};
  const lifecycleOutcomeCounts = {};
  const requestPostureCounts = {};
  const requestOutcomeCounts = {};
  const requestIssueCounts = {};
  const hostCommandTerminalStateCounts = {};
  for (const item of inventory) {
    incrementInventoryCounter(heartbeatCounts, item?.heartbeat_status ?? 'unknown');
    incrementInventoryCounter(operationalPostureCounts, item?.operational_posture ?? 'unknown');
    incrementInventoryCounter(mcpStateCounts, item?.mcp_operational_state ?? 'unknown');
    incrementInventoryCounter(terminalStateCounts, item?.last_terminal_state ?? 'unknown');
    incrementInventoryCounter(lifecycleStateCounts, item?.last_lifecycle_state ?? 'unknown');
    incrementInventoryCounter(requestPostureCounts, item?.request_posture ?? 'clean');
    mergeInventoryCounts(lifecycleOutcomeCounts, item?.lifecycle_state_counts ?? null);
    mergeInventoryCounts(requestOutcomeCounts, item?.request_outcome_counts ?? null);
    mergeInventoryCounts(requestIssueCounts, item?.request_issue_counts ?? null);
    mergeInventoryCounts(hostCommandTerminalStateCounts, item?.host_command_terminal_state_counts ?? null);
  }
  return {
    heartbeat_status_counts: heartbeatCounts,
    heartbeat_status_summary: formatInventoryCounts(heartbeatCounts),
    operational_posture_counts: operationalPostureCounts,
    operational_posture_summary: formatInventoryCounts(operationalPostureCounts),
    mcp_operational_state_counts: mcpStateCounts,
    mcp_operational_state_summary: formatInventoryCounts(mcpStateCounts),
    last_terminal_state_counts: terminalStateCounts,
    last_terminal_state_summary: formatInventoryCounts(terminalStateCounts),
    last_lifecycle_state_counts: lifecycleStateCounts,
    last_lifecycle_state_summary: formatInventoryCounts(lifecycleStateCounts),
    lifecycle_outcome_counts: lifecycleOutcomeCounts,
    lifecycle_outcome_summary: formatInventoryCounts(lifecycleOutcomeCounts),
    request_posture_counts: requestPostureCounts,
    request_posture_summary: formatInventoryCounts(requestPostureCounts),
    request_outcome_counts: requestOutcomeCounts,
    request_outcome_summary: formatInventoryCounts(requestOutcomeCounts),
    request_issue_counts: requestIssueCounts,
    request_issue_summary: formatInventoryCounts(requestIssueCounts),
    host_command_terminal_state_counts: hostCommandTerminalStateCounts,
    host_command_terminal_state_summary: formatInventoryCounts(hostCommandTerminalStateCounts),
  };
}

function incrementInventoryCounter(counts, key) {
  counts[key] = (counts[key] ?? 0) + 1;
}

function mergeInventoryCounts(targetCounts, sourceCounts) {
  if (!sourceCounts || typeof sourceCounts !== 'object') return;
  for (const [key, count] of Object.entries(sourceCounts)) {
    targetCounts[key] = (targetCounts[key] ?? 0) + Number(count ?? 0);
  }
}

function formatInventoryCounts(counts) {
  const entries = Object.entries(counts);
  if (entries.length === 0) return '0';
  return entries
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([key, count]) => `${count} (${key})`)
    .join(', ');
}

function summarizePersistedHostCommandLifecycle(entries = []) {
  const hostCommandEventCounts = {};
  const hostCommandTerminalStateCounts = {};
  let lastHostCommand = null;
  for (const entry of entries) {
    const eventKind = entry?.event_kind ?? entry?.event ?? null;
    if (!String(eventKind ?? '').startsWith('carrier_host_command_')) continue;
    incrementInventoryCounter(hostCommandEventCounts, eventKind);
    const payload = entry?.payload ?? {};
    const terminalState = payload.terminal_state ?? null;
    if (terminalState) incrementInventoryCounter(hostCommandTerminalStateCounts, terminalState);
    if (!payload.command_id) continue;
    const occurredAt = entry?.timestamp ?? entry?.occurred_at ?? payload?.occurred_at ?? payload?.created_at ?? null;
    const candidate = {
      command_id: payload.command_id,
      command_summary: payload.command_summary ?? payload.command_text ?? null,
      terminal_state: terminalState,
      output_ref: payload?.output_ref?.payload_ref ?? null,
      output_reader_tool: payload?.output_ref?.reader_tool ?? null,
      event_kind: eventKind,
      occurred_at: occurredAt,
    };
    if (!lastHostCommand || String(candidate.occurred_at ?? '').localeCompare(String(lastHostCommand.occurred_at ?? '')) >= 0) {
      lastHostCommand = candidate;
    }
  }
  return {
    host_command_event_count: Object.values(hostCommandEventCounts).reduce((sum, count) => sum + Number(count ?? 0), 0),
    host_command_event_counts: hostCommandEventCounts,
    host_command_event_summary: formatInventoryCounts(hostCommandEventCounts),
    host_command_terminal_state_counts: hostCommandTerminalStateCounts,
    host_command_terminal_state_summary: formatInventoryCounts(hostCommandTerminalStateCounts),
    last_host_command_id: lastHostCommand?.command_id ?? null,
    last_host_command_summary: lastHostCommand?.command_summary ?? null,
    last_host_command_terminal_state: lastHostCommand?.terminal_state ?? null,
    last_host_command_output_ref: lastHostCommand?.output_ref ?? null,
    last_host_command_output_reader_tool: lastHostCommand?.output_reader_tool ?? null,
    last_host_command_event_kind: lastHostCommand?.event_kind ?? null,
    last_host_command_at: lastHostCommand?.occurred_at ?? null,
  };
}

function summarizePersistedOperationLifecycle(entries = []) {
  const operationEventCounts = {};
  const directiveKindCounts = {};
  const directiveVisibilityCounts = {};
  const operationIdCounts = {};
  const operationMetadataById = Object.create(null);
  const visibilityValuesByLifecycleKey = Object.create(null);
  const fallbackOperationIdCandidates = new Set();
  let lastOperation = null;

  const looksLikeOperationId = (value) => (
    typeof value === 'string' && /^operation_[A-Za-z0-9_]+$/.test(value)
      ? value
      : null
  );

  const findOperationIdInObject = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 4) return null;
    if (Array.isArray(value)) {
      for (const item of value) {
        const nested = findOperationIdInObject(item, depth + 1);
        if (nested) return nested;
      }
      return null;
    }
    const objectKind = value?.kind;
    if (objectKind === 'operation' && typeof value?.id === 'string') {
      const candidate = looksLikeOperationId(value.id);
      if (candidate) return candidate;
    }
    for (const [key, candidateValue] of Object.entries(value)) {
      if (key === 'operation_id' || key === 'operationId') {
        const explicitCandidate = looksLikeOperationId(candidateValue);
        if (explicitCandidate) return explicitCandidate;
      }
      const nested = findOperationIdInObject(candidateValue, depth + 1);
      if (nested) return nested;
    }
    return null;
  };

  const targetOperationId = (target) => {
    if (!target || typeof target !== 'object') return null;
    return target.kind === 'operation' ? target.id : null;
  };

  const targetCarrierSessionId = (target) => {
    if (!target || typeof target !== 'object') return null;
    return target.kind === 'carrier_session' ? target.id : null;
  };

  const extractOperationId = (payload, entry) => {
    const operationId = (
      payload?.operation_id
      ?? payload?.operationId
      ?? payload?.operation?.id
      ?? payload?.directive?.operation_id
      ?? payload?.directive?.operationId
      ?? payload?.directive?.operation?.id
      ?? payload?.authorization?.operation_id
      ?? payload?.authorization?.operationId
      ?? payload?.authorization?.operation?.id
      ?? payload?.rule?.operation_id
      ?? payload?.rule?.operationId
      ?? payload?.rule?.operation?.id
      ?? payload?.input?.operation_id
      ?? payload?.input?.operationId
      ?? payload?.input?.operation?.id
      ?? targetOperationId(payload?.target)
      ?? targetOperationId(payload?.authorization?.target)
      ?? targetOperationId(payload?.rule?.target)
      ?? targetOperationId(payload?.input?.target)
      ?? (entry?.operation?.id)
      ?? entry?.operationId
      ?? entry?.operation_id
      ?? entry?.metadata?.operation_id
      ?? entry?.metadata?.operationId
      ?? entry?.metadata?.operation?.id
      ?? payload?.operation_inventory_id
      ?? payload?.operationInventoryId
      ?? (entry?.event === 'directive_emitted'
        ? payload?.authorization?.operation_id
        : null)
      ?? findOperationIdInObject(entry, 0)
      ?? findOperationIdInObject(payload, 0)
    );
    if (operationId) {
      const candidate = looksLikeOperationId(operationId);
      if (candidate) fallbackOperationIdCandidates.add(candidate);
      return operationId;
    }
    const payloadOperationInventory = looksLikeOperationId(payload?.operation_id);
    if (payloadOperationInventory) {
      fallbackOperationIdCandidates.add(payloadOperationInventory);
      return payloadOperationInventory;
    }
    const metadataOperationInventory = looksLikeOperationId(entry?.metadata?.operation_id);
    if (metadataOperationInventory) {
      fallbackOperationIdCandidates.add(metadataOperationInventory);
      return metadataOperationInventory;
    }
    return null;
  };

  const extractDirectiveLifecycleKey = (payload, entry, operationId) => {
    const targetSessionId = targetCarrierSessionId(payload?.target)
      ?? targetCarrierSessionId(payload?.authorization?.target)
      ?? targetCarrierSessionId(payload?.rule?.target)
      ?? targetCarrierSessionId(payload?.input?.target)
      ?? targetCarrierSessionId(entry?.target);
    if (operationId) return `operation:${operationId}`;
    if (targetSessionId) return `carrier_session:${targetSessionId}`;
    return null;
  };

  const recordVisibilityValue = (key, visibility) => {
    if (!key || !visibility) return;
    const current = visibilityValuesByLifecycleKey[key];
    if (!current) {
      visibilityValuesByLifecycleKey[key] = new Set([visibility]);
      return;
    }
    current.add(visibility);
  };

  const resolveVisibilityFromLifecycleKey = (key) => {
    const values = visibilityValuesByLifecycleKey[key];
    if (!values || values.size !== 1) return null;
    return Array.from(values)[0];
  };

  const extractDirectiveKind = (payload, entry) =>
    payload?.directive_kind
    ?? payload?.kind
    ?? payload?.directive?.kind
    ?? payload?.authorization?.directive_kind
    ?? payload?.authorization?.kind
    ?? payload?.rule?.directive_kind
    ?? payload?.rule?.kind
    ?? payload?.input?.directive_kind
    ?? payload?.input?.kind
    ?? entry?.metadata?.directive?.kind
    ?? null;

  const extractDirectiveVisibility = (payload, entry) =>
    payload?.visibility
    ?? payload?.directive_visibility
    ?? payload?.directive?.visibility
    ?? payload?.authorization?.visibility
    ?? payload?.rule?.visibility
    ?? payload?.input?.visibility
    ?? entry?.metadata?.directive?.visibility
    ?? null;

  for (const entry of entries) {
    const eventKind = entry?.event_kind ?? entry?.event ?? null;
    if (!['directive_emission_authorized', 'directive_emission_rule_recorded', 'directive_emitted'].includes(String(eventKind ?? ''))) {
      continue;
    }
    const payload = entry?.payload ?? {};
    const operationId = extractOperationId(payload, entry);
    const key = extractDirectiveLifecycleKey(payload, entry, operationId);
    const directiveKind = extractDirectiveKind(payload, entry);
    const directiveVisibility = extractDirectiveVisibility(payload, entry);
    if (directiveVisibility) {
      recordVisibilityValue(key, directiveVisibility);
    }
    if (!operationId || (!directiveKind && !directiveVisibility)) {
      continue;
    }
    const cachedMetadata = operationMetadataById[operationId] ?? {};
    operationMetadataById[operationId] = {
      ...cachedMetadata,
      kind: directiveKind ?? cachedMetadata.kind ?? null,
      visibility: directiveVisibility ?? cachedMetadata.visibility ?? null,
    };
  }

  let lastDirectiveKind = null;
  let lastDirectiveVisibility = null;
  const synthesizedOperationIdByKey = new Map();
  let synthesizedOperationIdCounter = 1;
  const operationIds = Object.keys(operationMetadataById);
  const candidateOperationIds = Array.from(fallbackOperationIdCandidates);
  const fallbackOperationId = operationIds.length === 1
    ? operationIds[0]
    : (candidateOperationIds.length === 1 ? candidateOperationIds[0] : null);
  const synthesizeOperationId = (lifecycleKey) => {
    if (!lifecycleKey) return null;
    if (!synthesizedOperationIdByKey.has(lifecycleKey)) {
      synthesizedOperationIdByKey.set(
        lifecycleKey,
        `operation_inventory_${synthesizedOperationIdCounter++}`,
      );
    }
    return synthesizedOperationIdByKey.get(lifecycleKey);
  };

  for (const entry of entries) {
    const eventKind = entry?.event_kind ?? entry?.event ?? null;
    if (!['directive_emission_authorized', 'directive_emission_rule_recorded', 'directive_emitted'].includes(String(eventKind ?? ''))) {
      continue;
    }
    incrementInventoryCounter(operationEventCounts, eventKind);
    const payload = entry?.payload ?? {};
    let operationId = extractOperationId(payload, entry) ?? fallbackOperationId;
    const key = extractDirectiveLifecycleKey(payload, entry, operationId);
    if (!operationId) operationId = synthesizeOperationId(key ?? 'default');
    const fallbackVisibilityFromLifecycle = key ? resolveVisibilityFromLifecycleKey(key) : null;
    const fallbackMetadata = operationId ? operationMetadataById[operationId] ?? {} : {};
    const resolvedDirectiveKind = extractDirectiveKind(payload, entry)
      ?? fallbackMetadata.kind
      ?? lastDirectiveKind
      ?? null;
    const resolvedDirectiveVisibility = extractDirectiveVisibility(payload, entry)
      ?? fallbackMetadata.visibility
      ?? fallbackVisibilityFromLifecycle
      ?? lastDirectiveVisibility
      ?? null;

    if (operationId && (resolvedDirectiveKind || resolvedDirectiveVisibility)) {
      const cachedMetadata = operationMetadataById[operationId] ?? {};
      operationMetadataById[operationId] = {
        ...cachedMetadata,
        kind: resolvedDirectiveKind ?? cachedMetadata.kind ?? null,
        visibility: resolvedDirectiveVisibility ?? cachedMetadata.visibility ?? null,
      };
    }

    if (resolvedDirectiveKind) incrementInventoryCounter(directiveKindCounts, resolvedDirectiveKind);
    if (resolvedDirectiveVisibility) incrementInventoryCounter(directiveVisibilityCounts, resolvedDirectiveVisibility);
    if (resolvedDirectiveKind) lastDirectiveKind = resolvedDirectiveKind;
    if (resolvedDirectiveVisibility) lastDirectiveVisibility = resolvedDirectiveVisibility;
    if (operationId) incrementInventoryCounter(operationIdCounts, operationId);

    const occurredAt = entry?.timestamp ?? entry?.occurred_at ?? payload?.occurred_at ?? payload?.created_at ?? null;
    const candidate = {
      operation_id: operationId,
      directive_kind: resolvedDirectiveKind,
      directive_visibility: resolvedDirectiveVisibility,
      event_kind: eventKind,
      occurred_at: occurredAt,
    };
    if (!lastOperation || String(candidate.occurred_at ?? '').localeCompare(String(lastOperation.occurred_at ?? '')) >= 0) {
      lastOperation = candidate;
    }
  }

  return {
    operation_event_count: Object.values(operationEventCounts).reduce((sum, count) => sum + Number(count ?? 0), 0),
    operation_event_counts: operationEventCounts,
    operation_event_summary: formatInventoryCounts(operationEventCounts),
    directive_kind_counts: directiveKindCounts,
    directive_kind_summary: formatInventoryCounts(directiveKindCounts),
    directive_visibility_counts: directiveVisibilityCounts,
    directive_visibility_summary: formatInventoryCounts(directiveVisibilityCounts),
    operation_id_counts: operationIdCounts,
    operation_id_summary: formatInventoryCounts(operationIdCounts),
    last_operation_id: lastOperation?.operation_id ?? null,
    last_directive_kind: lastOperation?.directive_kind ?? null,
    last_directive_visibility: lastOperation?.directive_visibility ?? null,
    last_operation_event_kind: lastOperation?.event_kind ?? null,
    last_operation_at: lastOperation?.occurred_at ?? null,
  };
}

function classifyPersistedSessionLifecycleState(entry) {
  const eventKind = entry?.event ?? entry?.event_kind ?? null;
  const terminalState = entry?.payload?.terminal_state ?? entry?.terminal_state ?? null;
  if (eventKind === 'session_closed') return terminalState ?? 'closed';
  if (eventKind === 'turn_failed') return terminalState ?? 'failed';
  if (eventKind === 'turn_complete') return terminalState ?? 'completed';
  if (eventKind === 'input_completed' || eventKind === 'input_event_completed') return terminalState ?? 'completed';
  if (eventKind === 'interactive_loop_error') return 'interactive_loop_error';
  return null;
}

function classifyPersistedSessionIssueCode(entry) {
  const eventKind = entry?.event ?? entry?.event_kind ?? null;
  if (eventKind === 'error') return entry?.code ?? entry?.payload?.code ?? 'error';
  if (eventKind === 'interactive_loop_error') return 'interactive_loop_error';
  return null;
}

function classifyPersistedSessionOperationEvent(entry) {
  const eventKind = entry?.event_kind ?? entry?.event ?? null;
  if (['directive_emission_authorized', 'directive_emission_rule_recorded', 'directive_emitted'].includes(String(eventKind ?? ''))) {
    return eventKind;
  }
  return null;
}

function classifyPersistedSessionIssueOutcome(entry) {
  const issueCode = classifyPersistedSessionIssueCode(entry);
  if (!issueCode) return null;
  return classifySessionIssueOutcomeCode(issueCode);
}

function summarizeRequestPosture(requestOutcomeCounts = {}) {
  const counts = {
    invalid_control_traffic: Number(requestOutcomeCounts?.invalid_request ?? 0),
    closed_session_retries: Number(requestOutcomeCounts?.rejected_closed ?? 0),
    runtime_failures:
      Number(requestOutcomeCounts?.dispatch_failure ?? 0)
      + Number(requestOutcomeCounts?.request_runtime_failure ?? 0)
      + Number(requestOutcomeCounts?.interactive_runtime_failure ?? 0)
      + Number(requestOutcomeCounts?.request_error ?? 0),
  };
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  if (total === 0) {
    return {
      request_outcome_total: 0,
      request_posture: 'clean',
      request_posture_display: 'clean',
    };
  }
  const postureOrder = ['runtime_failures', 'invalid_control_traffic', 'closed_session_retries'];
  const [requestPosture] = postureOrder
    .map((key) => [key, counts[key]])
    .sort((left, right) => right[1] - left[1] || postureOrder.indexOf(left[0]) - postureOrder.indexOf(right[0]))[0];
  return {
    request_outcome_total: total,
    request_posture: requestPosture,
    request_posture_display: `${requestPosture} (${total})`,
  };
}

function summarizeOperationalPosture({ mcpOperationalState = 'unknown', requestPosture = 'clean', lastLifecycleState = null } = {}) {
  let operationalPosture = 'healthy';
  if (mcpOperationalState === 'runtime_faulted') operationalPosture = 'mcp_runtime_faulted';
  else if (mcpOperationalState === 'startup_degraded') operationalPosture = 'mcp_startup_degraded';
  else if (requestPosture === 'runtime_failures') operationalPosture = 'request_runtime_failures';
  else if (requestPosture === 'invalid_control_traffic') operationalPosture = 'request_invalid_control_traffic';
  else if (requestPosture === 'closed_session_retries') operationalPosture = 'request_closed_session_retries';
  else if (lastLifecycleState === 'failed' || lastLifecycleState === 'interactive_loop_error') operationalPosture = 'lifecycle_failed';
  if (operationalPosture === 'healthy') {
    return {
      operational_posture: 'healthy',
      operational_posture_display: 'healthy',
    };
  }
  const lifecycleLabel = lastLifecycleState ?? 'none';
  return {
    operational_posture: operationalPosture,
    operational_posture_display: `${operationalPosture} [mcp=${mcpOperationalState}; request=${requestPosture}; lifecycle=${lifecycleLabel}]`,
  };
}

function summarizePersistedSession({ session, sessionDir, siteRoot = SITE_ROOT, naradaDir = NARADA_DIR } = {}) {
  const heartbeat = readJsonFile(join(sessionDir, 'heartbeat.json'));
  const entries = readJsonlFile(join(sessionDir, 'session.jsonl'));
  const parseErrors = entries.parse_errors ?? [];
  const startupFailures = [];
  const runtimeDiagnostics = [];
  let linkedPreflight = null;
  const lifecycleStateCounts = {};
  const requestOutcomeCounts = {};
  const requestIssueCounts = {};
  let lastEventKind = null;
  let lastEventAt = null;
  let lastTerminalState = null;
  let lastLifecycleEventKind = null;
  let lastLifecycleAt = null;
  let lastLifecycleState = null;
  for (const entry of entries) {
    if (entry?.event === 'mcp_preflight_artifact_linked') linkedPreflight = entry;
    lastEventKind = entry?.event_kind ?? entry?.event ?? lastEventKind;
    lastEventAt = entry?.timestamp ?? entry?.occurred_at ?? entry?.payload?.occurred_at ?? entry?.payload?.created_at ?? lastEventAt;
    const lifecycleEventKind = entry?.event ?? entry?.event_kind ?? null;
    const lifecycleOccurredAt = entry?.timestamp ?? entry?.occurred_at ?? entry?.payload?.occurred_at ?? entry?.payload?.created_at ?? null;
    const lifecycleState = classifyPersistedSessionLifecycleState(entry);
    if (lifecycleState) {
      incrementInventoryCounter(lifecycleStateCounts, lifecycleState);
      lastLifecycleEventKind = lifecycleEventKind ?? lastLifecycleEventKind;
      lastLifecycleAt = lifecycleOccurredAt ?? lastLifecycleAt;
      lastLifecycleState = lifecycleState;
    }
    const issueCode = classifyPersistedSessionIssueCode(entry);
    if (issueCode) incrementInventoryCounter(requestIssueCounts, issueCode);
    const issueOutcome = classifyPersistedSessionIssueOutcome(entry);
    if (issueOutcome) incrementInventoryCounter(requestOutcomeCounts, issueOutcome);
    if (entry?.event_kind === 'input_completed' || entry?.event === 'input_event_completed') {
      lastTerminalState = entry?.payload?.terminal_state ?? entry?.terminal_state ?? lastTerminalState;
    }
    if (entry?.event_kind !== 'carrier_diagnostic_recorded') continue;
    const payload = entry.payload ?? {};
    if (payload.diagnostic_code === 'mcp_runtime_fault') {
      runtimeDiagnostics.push(payload);
    } else {
      startupFailures.push({
        server_name: payload.server_name,
        code: payload.diagnostic_code ?? payload.code,
      });
    }
  }
  const preflightArtifact = readMcpPreflightArtifact({
    artifactDir: join(naradaDir, 'runtime', 'agent-cli', 'mcp-preflight'),
    session,
    identity: heartbeat?.agent_id ?? IDENTITY,
    siteRoot,
  });
  const operationLifecycle = summarizePersistedOperationLifecycle(entries);
  const hostCommandLifecycle = summarizePersistedHostCommandLifecycle(entries);
  const requestPosture = summarizeRequestPosture(requestOutcomeCounts);
  const handoffs = {
    ...buildPersistedSessionHandoffs({ session, identity: heartbeat?.agent_id ?? IDENTITY }),
    ...buildPersistedHostCommandOutputHandoffs({
      session,
      identity: heartbeat?.agent_id ?? IDENTITY,
      outputRef: hostCommandLifecycle.last_host_command_output_ref,
    }),
  };
  let mcpOperationalState = 'unknown';
  if (runtimeDiagnostics.length > 0) mcpOperationalState = 'runtime_faulted';
  else if (startupFailures.length > 0) mcpOperationalState = 'startup_degraded';
  else if (linkedPreflight?.mcp_operational_state) mcpOperationalState = linkedPreflight.mcp_operational_state;
  else if (preflightArtifact?.mcp_operational_state) mcpOperationalState = preflightArtifact.mcp_operational_state;
  const operationalPosture = summarizeOperationalPosture({
    mcpOperationalState,
    requestPosture: requestPosture.request_posture,
    lastLifecycleState,
  });
  const recommendedAction = summarizePersistedSessionRecommendedAction({
    operationalPosture: operationalPosture.operational_posture,
    mcpOperationalState,
    requestPosture: requestPosture.request_posture,
    handoffs,
  });
  const recoveryPlan = summarizePersistedSessionRecoveryPlan({
    operationalPosture: operationalPosture.operational_posture,
    mcpOperationalState,
    requestPosture: requestPosture.request_posture,
    handoffs,
  });
  return {
    session,
    session_path: join(sessionDir, 'session.jsonl'),
    agent_id: heartbeat?.agent_id ?? null,
    runtime: heartbeat?.runtime ?? null,
    mode: heartbeat?.mode ?? null,
    started_at: heartbeat?.started_at ?? null,
    heartbeat_at: heartbeat?.heartbeat_at ?? null,
    heartbeat_status: heartbeat?.status ?? 'missing',
    heartbeat_display: heartbeat?.heartbeat_at ? `${heartbeat.status ?? 'unknown'} @ ${heartbeat.heartbeat_at}` : (heartbeat?.status ?? 'missing'),
    session_event_count: entries.length,
    session_jsonl_parse_error_count: parseErrors.length,
    session_jsonl_parse_error_sample: parseErrors.slice(0, 3),
    last_event_kind: lastEventKind,
    last_event_at: lastEventAt,
    last_terminal_state: lastTerminalState,
    operational_posture: operationalPosture.operational_posture,
    operational_posture_display: operationalPosture.operational_posture_display,
    recommended_action: recommendedAction.recommended_action,
    recommended_action_display: recommendedAction.recommended_action_display,
    recommended_command: recommendedAction.recommended_command,
    recovery_kind: recoveryPlan.recovery_kind,
    recovery_kind_display: recoveryPlan.recovery_kind_display,
    recovery_primary_command: recoveryPlan.recovery_primary_command,
    recovery_followup_command: recoveryPlan.recovery_followup_command,
    last_lifecycle_event_kind: lastLifecycleEventKind,
    last_lifecycle_at: lastLifecycleAt,
    last_lifecycle_state: lastLifecycleState,
    lifecycle_state_counts: lifecycleStateCounts,
    lifecycle_state_summary: formatInventoryCounts(lifecycleStateCounts),
    request_outcome_total: requestPosture.request_outcome_total,
    request_posture: requestPosture.request_posture,
    request_posture_display: requestPosture.request_posture_display,
    request_outcome_counts: requestOutcomeCounts,
    request_outcome_summary: formatInventoryCounts(requestOutcomeCounts),
    request_issue_counts: requestIssueCounts,
    request_issue_summary: formatInventoryCounts(requestIssueCounts),
    operation_event_count: operationLifecycle.operation_event_count,
    operation_event_counts: operationLifecycle.operation_event_counts,
    operation_event_summary: operationLifecycle.operation_event_summary,
    directive_kind_counts: operationLifecycle.directive_kind_counts,
    directive_kind_summary: operationLifecycle.directive_kind_summary,
    directive_visibility_counts: operationLifecycle.directive_visibility_counts,
    directive_visibility_summary: operationLifecycle.directive_visibility_summary,
    operation_id_counts: operationLifecycle.operation_id_counts,
    operation_id_summary: operationLifecycle.operation_id_summary,
    last_operation_id: operationLifecycle.last_operation_id,
    last_directive_kind: operationLifecycle.last_directive_kind,
    last_directive_visibility: operationLifecycle.last_directive_visibility,
    last_operation_event_kind: operationLifecycle.last_operation_event_kind,
    last_operation_at: operationLifecycle.last_operation_at,
    host_command_event_count: hostCommandLifecycle.host_command_event_count,
    host_command_event_counts: hostCommandLifecycle.host_command_event_counts,
    host_command_event_summary: hostCommandLifecycle.host_command_event_summary,
    host_command_terminal_state_counts: hostCommandLifecycle.host_command_terminal_state_counts,
    host_command_terminal_state_summary: hostCommandLifecycle.host_command_terminal_state_summary,
    last_host_command_id: hostCommandLifecycle.last_host_command_id,
    last_host_command_summary: hostCommandLifecycle.last_host_command_summary,
    last_host_command_terminal_state: hostCommandLifecycle.last_host_command_terminal_state,
    last_host_command_output_ref: hostCommandLifecycle.last_host_command_output_ref,
    last_host_command_output_reader_tool: hostCommandLifecycle.last_host_command_output_reader_tool,
    last_host_command_event_kind: hostCommandLifecycle.last_host_command_event_kind,
    last_host_command_at: hostCommandLifecycle.last_host_command_at,
    mcp_operational_state: mcpOperationalState,
    mcp_startup_failure_summary: startupFailures.length > 0
      ? formatMcpStartupFailureSummary(startupFailures)
      : (linkedPreflight?.mcp_startup_failure_summary ?? preflightArtifact?.mcp_startup_failure_summary ?? '0'),
    mcp_runtime_fault_summary: runtimeDiagnostics.length > 0
      ? formatMcpRuntimeDiagnosticSummary(runtimeDiagnostics)
      : (linkedPreflight?.mcp_runtime_fault_summary ?? preflightArtifact?.mcp_runtime_fault_summary ?? '0'),
    mcp_preflight_artifact_path: linkedPreflight?.artifact_path ?? preflightArtifact?.artifact_path ?? null,
    mcp_preflight_operational_state: linkedPreflight?.mcp_operational_state ?? preflightArtifact?.mcp_operational_state ?? null,
    mcp_preflight_startup_failure_summary: linkedPreflight?.mcp_startup_failure_summary ?? preflightArtifact?.mcp_startup_failure_summary ?? null,
    mcp_preflight_runtime_fault_summary: linkedPreflight?.mcp_runtime_fault_summary ?? preflightArtifact?.mcp_runtime_fault_summary ?? null,
    mcp_preflight_recommended_action: linkedPreflight?.recommended_action ?? preflightArtifact?.recommended_action ?? null,
    mcp_preflight_recommended_action_display: linkedPreflight?.recommended_action_display ?? preflightArtifact?.recommended_action_display ?? null,
    mcp_preflight_recommended_command: linkedPreflight?.recommended_command ?? preflightArtifact?.recommended_command ?? null,
    mcp_preflight_recovery_kind: linkedPreflight?.recovery_kind ?? preflightArtifact?.recovery_kind ?? null,
    mcp_preflight_recovery_kind_display: linkedPreflight?.recovery_kind_display ?? preflightArtifact?.recovery_kind_display ?? null,
    mcp_preflight_recovery_primary_command: linkedPreflight?.recovery_primary_command ?? preflightArtifact?.recovery_primary_command ?? null,
    mcp_preflight_recovery_followup_command: linkedPreflight?.recovery_followup_command ?? preflightArtifact?.recovery_followup_command ?? null,
    mcp_preflight_handoffs: linkedPreflight?.handoffs ?? preflightArtifact?.handoffs ?? null,
    handoffs,
  };
}

function readJsonFile(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function readJsonlFile(path) {
  if (!existsSync(path)) return [];
  try {
    const parseErrors = [];
    const entries = readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          parseErrors.push({
            line,
            error: 'invalid_json',
          });
          return null;
        }
      })
      .filter(Boolean);
    if (parseErrors.length > 0) {
      Object.defineProperty(entries, 'parse_errors', {
        value: parseErrors,
        enumerable: false,
        writable: false,
      });
    }
    return entries;
  } catch {
    return [];
  }
}

function appendJsonlRecord(path, payload) {
  const line = `${JSON.stringify(payload)}\n`;
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'a');
  let directoryFd = null;
  try {
    writeSync(fd, line, null, 'utf8');
    if (ENABLE_SESSION_FSYNC) {
      try {
        fsyncSync(fd);
      } catch {
        // best-effort durability
      }
      try {
        directoryFd = openSync(dirname(path), 'r');
        fsyncSync(directoryFd);
      } catch {
        // directory fsync is best-effort for cross-platform support.
      }
    }
  } finally {
    if (directoryFd !== null) {
      closeSync(directoryFd);
    }
    closeSync(fd);
  }
}

function writeDurableTextFile(path, text, encoding = 'utf8') {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tempPath, text, encoding);
  if (ENABLE_SESSION_FSYNC) {
    let tempFd = null;
    let dirFd = null;
    try {
      tempFd = openSync(tempPath, 'r');
      fsyncSync(tempFd);
    } catch {
      // best-effort durability
    } finally {
      if (tempFd !== null) {
        closeSync(tempFd);
      }
    }
    try {
      dirFd = openSync(dirname(tempPath), 'r');
      fsyncSync(dirFd);
    } catch {
      // best-effort durability
    } finally {
      if (dirFd !== null) {
        closeSync(dirFd);
      }
    }
  }
  renameSync(tempPath, path);
}

function startControlJsonlWatcher({ controlPath, inputQueue }) {
  mkdirSync(resolve(controlPath, '..'), { recursive: true });
  if (!existsSync(controlPath)) {
    writeDurableTextFile(controlPath, '', 'utf8');
  }
  let offset = statSync(controlPath).size;
  let stopped = false;
  let chain = Promise.resolve();
  let buffer = '';
  const timer = setInterval(() => {
    if (stopped) return;
    let size = 0;
    try {
      size = statSync(controlPath).size;
    } catch {
      return;
    }
    if (size <= offset) return;
    const content = readFileSync(controlPath, 'utf8').slice(offset);
    offset = size;
    buffer += content;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      chain = chain.then(() => handleControlLine(line, { inputQueue })).catch((error) => {
        printCliMessage(`Control directive failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }, 250);
  printCliMessage(`Control path: ${controlPath}`);
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

function shouldDeferQueuedInput(event, { rl, promptState } = {}) {
  return shouldDeferQueuedInputRuntime(event, { rl, promptState });
}

async function handleControlLine(line, { inputQueue }) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    printCliMessage('Ignored invalid control JSON.');
    recordCarrierDiagnostic('warn', 'Ignored invalid control JSON.');
    return;
  }
  let controlRecord;
  try {
    controlRecord = normalizeAgentCliControlRecord(request);
  } catch (error) {
    const message = `Ignored invalid control frame: ${error instanceof Error ? error.message : String(error)}`;
    printCliMessage(message);
    recordCarrierDiagnostic('warn', message);
    return;
  }
  await inputQueue.enqueue(controlRecord.input, { drain: true });
}

function normalizeAgentCliControlRecord(request) {
  if (request?.schema === 'narada.carrier.control.input_event.v1') {
    return normalizeControlInputRecord(request, { transport: 'control_jsonl' });
  }
  if (request?.method === 'carrier.input.deliver') {
    const input = request?.params?.input;
    if (!input) throw new Error('carrier.input.deliver requires params.input');
    return normalizeControlInputRecord(input, { transport: 'control_jsonl' });
  }
  if (request?.method !== 'system_directive.deliver') {
    throw new Error(`unsupported_control_method:${request?.method ?? '<missing>'}`);
  }
  const directive = request?.params?.directive ?? null;
  const message = String(request?.params?.message ?? directive?.content?.text ?? '');
  const directiveKind = directive?.kind ?? directive?.content?.kind ?? request?.params?.directive_kind ?? request?.params?.kind ?? null;
  const directiveVisibility = request?.params?.visibility ?? directive?.visibility ?? directive?.content?.visibility ?? null;
  const allowEmptyRecordOnlyDirective = directiveKind === 'operation_heartbeat' && directiveVisibility === 'record_only';
  if (!message.trim() && !allowEmptyRecordOnlyDirective) throw new Error('empty_system_directive_control_frame');
  return normalizeControlInputRecord({
    content: message,
    source: 'system_directive',
    source_id: request?.params?.source_id ?? 'agent-cli.system_directive',
    authority_ref: request?.params?.authority_ref ?? directive?.directive_id ?? request?.params?.directive_id ?? null,
    directive_id: directive?.directive_id ?? request?.params?.directive_id ?? null,
    transport: 'control_jsonl',
    metadata: {
      directive_provenance: { kind: 'system_directive' },
      directive: {
        ...(directiveKind ? { kind: directiveKind } : {}),
        ...(directiveVisibility ? { visibility: directiveVisibility } : {}),
        ...(request?.params?.cadence ?? directive?.cadence ?? directive?.content?.cadence ? { cadence: request?.params?.cadence ?? directive?.cadence ?? directive?.content?.cadence } : {}),
        ...(request?.params?.operation_id ?? directive?.operation_id ?? directive?.content?.operation_id ? { operation_id: request?.params?.operation_id ?? directive?.operation_id ?? directive?.content?.operation_id } : {}),
        ...(request?.params?.reason ?? directive?.reason ?? directive?.content?.reason ? { reason: request?.params?.reason ?? directive?.reason ?? directive?.content?.reason } : {}),
      },
    },
  }, { transport: 'control_jsonl' });
}

function recordCarrierDiagnostic(level, message, extra = {}) {
  appendSession(SESSION_PATH, carrierSessionEventEntry('carrier_diagnostic_recorded', {
    level,
    message,
    ...extra,
  }));
}

function recordServerWorkflowRequest(event, { requestId = null, method = null, transport = 'jsonl_stdio', ...extra } = {}) {
  appendSession(SESSION_PATH, sessionEventEntry(event, {
    request_id: requestId,
    method,
    transport,
    ...extra,
  }));
}

function recordServerWorkflowLifecycleEvent(
  event,
  {
    requestId = null,
    method = null,
    transport = 'jsonl_stdio',
    operation_status = null,
    requested_at = null,
    completed_at = null,
    duration_ms = null,
    ...extra
  } = {},
) {
  appendSession(SESSION_PATH, sessionEventEntry(event, {
    request_id: requestId,
    method,
    transport,
    operation_status,
    requested_at,
    completed_at,
    duration_ms,
    ...extra,
  }));
}

function operatorWorkflowId({ requestId = null, method = null, namespace = 'operator' } = {}) {
  if (!requestId && !method) return null;
  return `operation_${namespace}_${hashStable(`${namespace}:${method ?? ''}:${requestId ?? ''}`).slice(0, 16)}`;
}

function recordMcpStartupFailures(mcpServers, { emit = null } = {}) {
  const failures = getMcpStartupFailures(mcpServers);
  for (const failure of failures) {
    const payload = {
      level: 'warn',
      message: `MCP startup degraded: ${failure.server_name ?? 'unknown'} ${failure.code ?? 'error'}`,
      diagnostic_code: failure.code ?? null,
      server_name: failure.server_name ?? null,
      diagnostic: failure,
    };
    recordCarrierDiagnostic(payload.level, payload.message, {
      diagnostic_code: payload.diagnostic_code,
      server_name: payload.server_name,
      diagnostic: payload.diagnostic,
    });
    emit?.('carrier_diagnostic_recorded', payload);
  }
}

function recordMcpRuntimeFault({ mcpServers = null, serverName, toolName, error, emit = null }) {
  if (isAbortError(error)) return;
  const message = error instanceof Error ? error.message : String(error);
  const payload = {
    level: 'error',
    message: `MCP runtime fault: ${serverName ?? 'unknown'} ${toolName ?? '<missing>'} ${message}`,
    diagnostic_code: 'mcp_runtime_fault',
    server_name: serverName ?? null,
    tool_name: toolName ?? null,
    error_code: error?.code ?? null,
    diagnostic: {
      schema: 'narada.agent_cli.mcp_runtime_diagnostic.v0',
      code: 'mcp_runtime_fault',
      server_name: serverName ?? null,
      tool_name: toolName ?? null,
      error_code: error?.code ?? null,
      message,
    },
  };
  rememberMcpRuntimeDiagnostic(mcpServers, payload.diagnostic);
  recordCarrierDiagnostic(payload.level, payload.message, {
    diagnostic_code: payload.diagnostic_code,
    server_name: payload.server_name,
    tool_name: payload.tool_name,
    error_code: payload.error_code,
    diagnostic: payload.diagnostic,
  });
  emit?.('carrier_diagnostic_recorded', payload);
}

function classifyCarrierHostCommandInput(input, { enabled = HOST_COMMANDS_ENABLED, approvalMode = 'execute' } = {}) {
  return classifyCarrierHostCommandInputRuntime(input, { enabled, approvalMode });
}

async function executeCarrierHostCommand(admission, {
  commandId = `host_command_${randomId()}`,
  cwd = SITE_ROOT,
  env = process.env,
  appendSessionFn = (entry) => appendSession(SESSION_PATH, entry),
  outputDir = join(CARRIER_SESSION_DIR, 'host-command-output'),
  printResult = true,
  spawnFn = spawn,
  now = () => new Date(),
} = {}) {
  return await executeCarrierHostCommandRuntime(admission, {
    commandId,
    cwd,
    env,
    appendSessionFn,
    outputDir,
    printResult,
    spawnFn,
    now,
    carrierSessionEventEntryFn: carrierSessionEventEntry,
    printHostCommandResultFn: printHostCommandResult,
    randomIdFn: randomId,
    writeDurableTextFileFn: writeDurableTextFile,
    outputInlineLimit: HOST_COMMAND_OUTPUT_INLINE_LIMIT,
    outputCaptureLimit: HOST_COMMAND_OUTPUT_CAPTURE_LIMIT,
  });
}

function readCarrierHostCommandOutputRef(payloadRef, { outputDir = join(CARRIER_SESSION_DIR, 'host-command-output') } = {}) {
  return readCarrierHostCommandOutputRefRuntime(payloadRef, { outputDir });
}

async function handleSlashCommand(input, {
  mcpServers,
  allTools,
  inputQueue = null,
  statsRunner = runCodexTranscriptStats,
  displaySettings = transcriptDisplaySettings,
  carrierSessionSettings = sessionSettings,
  carrierState = {},
  mcpPreflightArtifact = readMcpPreflightArtifact(),
  executeGoalOnSet = false,
  runSessionOperations = runSessionOperationsRead,
  runSessionSyncRunner = runSessionSync,
  session = SESSION,
  naradaDir = NARADA_DIR,
}) {
  const trimmed = String(input ?? '').trim();
  if (!trimmed) return 'none';
  if (trimmed.toLowerCase() === 'exit' || trimmed.toLowerCase() === '/exit' || trimmed.toLowerCase() === '/quit') {
    appendSession(SESSION_PATH, sessionEventEntry('session_command', { command: '/exit' }));
    return 'exit';
  }
  if (!trimmed.startsWith('/')) return 'none';

  const [rawCommand, ...rest] = trimmed.split(/\s+/);
  const command = rawCommand.toLowerCase();
  const value = rest.join(' ').trim();
  if (command === '/help') {
    printCliMessage([
      'Commands',
      '',
      '/help                 Show commands',
      '/status               Show session state',
      '/recovery             Show recovery workflow',
      '/goal [text|pause|resume|clear] Show, set, pause, resume, or clear carrier goal',
      '/stats [args]         Show local Codex transcript statistics',
      '/model <name>         Set model for later turns',
      '/thinking <level>     none, low, medium, high',
      '/tool-output [state]  Toggle displayed tool call outputs (on, off, toggle)',
      '/ops                  Show operation workflow summary',
      '/ops sync [--target <path|alias>] [--direction upload|download|bidirectional] [--json] [--dry-run] [--delete]',
      '/tools [filter]       Show discovered MCP tools and input schemas',
      '/observers            Show observer posture',
      '/observer mute        Mute visible observer interjections',
      '/observer unmute      Unmute visible observer interjections',
      '/queue                Show queued carrier input',
      '/queue clear          Clear queued operator steering',
      '/queue drop <index>   Drop one queued operator steering item',
      '! <command>           Execute on the carrier host without provider dispatch',
      '/clear                Clear terminal display',
      '/exit                 Save and quit',
    ].join('\n'));
    return 'handled';
  }
  if (command === '/tools' || command === '/tool') {
    printCliMessage(formatMcpToolCatalog(mcpServers, { filter: value }));
    appendSession(SESSION_PATH, sessionEventEntry('session_command', {
      command: '/tools',
      arguments: value,
      tool_count: allTools.length,
    }));
    return 'handled';
  }
  if (command === '/ops') {
    const { action, payload } = handleOpsCommand(value, { session, naradaDir });
    if (action === 'read') {
      await runSessionOperations(payload);
    } else if (action === 'sync') {
      await runSessionSyncRunner(payload);
    }
    if (!action) {
      printCliMessage('Usage: /ops, /ops --json, /ops sync [--target ...]');
    }
    return 'handled';
  }
  if (command === '/goal') {
    const result = handleGoalCommand(value, carrierSessionSettings);
    printCliMessage(result.message);
    appendSession(SESSION_PATH, sessionEventEntry(result.changed ? 'session_setting_changed' : 'carrier_command_executed', {
      command: '/goal',
      setting: 'goal',
      value: result.goal.value,
      status: result.goal.status,
      action: result.action,
    }));
    if (executeGoalOnSet && result.action === 'set' && result.goal.value) {
      return { action: 'dispatch_goal', content: result.goal.value, goal: result.goal };
    }
    return 'handled';
  }
  if (command === '/tool-output' || command === '/tool-outputs') {
    const result = handleToolOutputDisplayCommand(value, displaySettings);
    printCliMessage(result.message);
    appendSession(SESSION_PATH, sessionEventEntry('session_setting_changed', {
      setting: 'tool_outputs_display',
      value: result.state ? 'shown' : 'hidden',
      command,
      arguments: value,
    }));
    return 'handled';
  }
  if (command === '/observers') {
    printCliMessage(formatObserverPosture(displaySettings));
    appendSession(SESSION_PATH, sessionEventEntry('carrier_command_executed', {
      command: '/observers',
      observer_muted: displaySettings.observerMuted === true,
    }));
    return 'handled';
  }
  if (command === '/observer') {
    const result = handleObserverCommand(value, displaySettings);
    printCliMessage(result.message);
    appendSession(SESSION_PATH, sessionEventEntry('carrier_command_executed', {
      command: `/observer ${value}`.trim(),
      observer_muted: result.muted,
    }));
    return 'handled';
  }
  if (command === '/queue') {
    if (!inputQueue) {
      printCliMessage('Queue is unavailable in this mode.');
      return 'handled';
    }
    const result = handleQueueCommand(value, inputQueue);
    printCliMessage(result.message);
    if (result.mutated) {
      appendSession(SESSION_PATH, carrierSessionEventEntry('carrier_command_executed', {
        command: `/queue${value ? ` ${value}` : ''}`,
        mutation: result.mutation,
      }));
    }
    return 'handled';
  }
  if (command === '/clear') {
    clearTerminalDisplay();
    appendSession(SESSION_PATH, sessionEventEntry('session_command', { command: '/clear' }));
    return 'handled';
  }
  if (command === '/stats') {
    const result = statsRunner(value);
    printCliMessage(result.message);
    appendSession(SESSION_PATH, sessionEventEntry('session_command', {
      command: '/stats',
      arguments: value,
      status: result.status,
      runtime_scope: 'codex_transcript_store',
    }));
    return 'handled';
  }
  if (command === '/status') {
    const startupFailures = getMcpStartupFailures(mcpServers);
    const runtimeDiagnostics = getMcpRuntimeDiagnostics(mcpServers);
    const mcpPreflightSnapshot = createMcpPreflightArtifactSnapshot(mcpPreflightArtifact);
    printCliMessage(formatKeyValueRows({
      Identity: IDENTITY,
      Session: SESSION,
      Provider: INTELLIGENCE_PROVIDER,
      Model: carrierSessionSettings.model ?? sessionSettings.model,
      Thinking: carrierSessionSettings.thinking ?? sessionSettings.thinking,
      Stream: (carrierSessionSettings.stream ?? sessionSettings.stream) ? 'on' : 'off',
      Goal: carrierGoalStatusLabel(carrierSessionSettings.goal),
      'MCP servers': Object.keys(mcpServers).length,
      'MCP state': mcpOperationalState(mcpServers),
      ...(startupFailures.length > 0 ? { 'MCP startup failures': formatMcpStartupFailureSummary(startupFailures) } : {}),
      ...(runtimeDiagnostics.length > 0 ? { 'MCP runtime faults': formatMcpRuntimeDiagnosticSummary(runtimeDiagnostics) } : {}),
      ...(mcpPreflightSnapshot.mcp_preflight_operational_state ? { 'Preflight state': mcpPreflightSnapshot.mcp_preflight_operational_state } : {}),
      ...(mcpPreflightSnapshot.mcp_preflight_recommended_action_display ? { 'Preflight action': mcpPreflightSnapshot.mcp_preflight_recommended_action_display } : {}),
      ...(mcpPreflightSnapshot.mcp_preflight_recommended_command ? { 'Preflight command': mcpPreflightSnapshot.mcp_preflight_recommended_command } : {}),
      ...(mcpPreflightSnapshot.mcp_preflight_handoffs?.mcp_preflight_diagnostics ? { 'Preflight diagnostics': mcpPreflightSnapshot.mcp_preflight_handoffs.mcp_preflight_diagnostics } : {}),
      Tools: allTools.length,
      'Tool outputs': displaySettings.toolOutputs ? 'shown' : 'hidden',
      Observers: displaySettings.observerMuted === true ? 'muted' : 'shown',
    }));
    appendSession(SESSION_PATH, sessionEventEntry('session_command', { command: '/status' }));
    return 'handled';
  }
  if (command === '/recovery') {
    const liveWorkflow = createLiveWorkflowSnapshot({
      state: carrierState,
      mcpOperationalState: mcpOperationalState(mcpServers),
    });
    const mcpPreflightSnapshot = createMcpPreflightArtifactSnapshot(mcpPreflightArtifact);
    printCliMessage(formatKeyValueRows({
      Identity: IDENTITY,
      Session: SESSION,
      'Session posture': liveWorkflow.operational_posture_display,
      'Request posture': liveWorkflow.request_posture_display,
      'Recommended action': liveWorkflow.recommended_action_display,
      'Recommended command': liveWorkflow.recommended_command ?? 'none',
      'Recovery kind': liveWorkflow.recovery_kind_display ?? 'none',
      'Recovery primary': liveWorkflow.recovery_primary_command ?? 'none',
      'Recovery followup': liveWorkflow.recovery_followup_command ?? 'none',
      'Session recovery': liveWorkflow?.handoffs?.session_recovery ?? 'none',
      'Session read': liveWorkflow?.handoffs?.session_read ?? 'none',
      'Session issues': liveWorkflow?.handoffs?.session_events_issues ?? 'none',
      'Session diagnostics': liveWorkflow?.handoffs?.session_events_diagnostics ?? 'none',
      ...(mcpPreflightSnapshot.mcp_preflight_operational_state ? { 'Preflight state': mcpPreflightSnapshot.mcp_preflight_operational_state } : {}),
      ...(mcpPreflightSnapshot.mcp_preflight_recommended_action_display ? { 'Preflight action': mcpPreflightSnapshot.mcp_preflight_recommended_action_display } : {}),
      ...(mcpPreflightSnapshot.mcp_preflight_recommended_command ? { 'Preflight command': mcpPreflightSnapshot.mcp_preflight_recommended_command } : {}),
      ...(mcpPreflightSnapshot.mcp_preflight_recovery_kind_display ? { 'Preflight recovery': mcpPreflightSnapshot.mcp_preflight_recovery_kind_display } : {}),
      ...(mcpPreflightSnapshot.mcp_preflight_recovery_primary_command ? { 'Preflight primary': mcpPreflightSnapshot.mcp_preflight_recovery_primary_command } : {}),
      ...(mcpPreflightSnapshot.mcp_preflight_recovery_followup_command ? { 'Preflight followup': mcpPreflightSnapshot.mcp_preflight_recovery_followup_command } : {}),
      ...(mcpPreflightSnapshot.mcp_preflight_handoffs?.mcp_preflight_read ? { 'Preflight review': mcpPreflightSnapshot.mcp_preflight_handoffs.mcp_preflight_read } : {}),
      ...(mcpPreflightSnapshot.mcp_preflight_handoffs?.mcp_preflight_diagnostics ? { 'Preflight diagnostics': mcpPreflightSnapshot.mcp_preflight_handoffs.mcp_preflight_diagnostics } : {}),
    }));
    appendSession(SESSION_PATH, sessionEventEntry('session_command', { command: '/recovery' }));
    return 'handled';
  }
  if (command === '/model') {
    if (!value) {
      printCliMessage(`Current model: ${sessionSettings.model}`);
      return 'handled';
    }
    sessionSettings.model = value;
    appendSession(SESSION_PATH, sessionEventEntry('session_setting_changed', { setting: 'model', value }));
    printCliMessage(`Model set to ${sessionSettings.model}`);
    return 'handled';
  }
  if (command === '/thinking') {
    if (!value) {
      printCliMessage(`Current thinking: ${sessionSettings.thinking}`);
      return 'handled';
    }
    const next = normalizeThinkingLevel(value);
    if (next !== value.toLowerCase()) {
      printCliMessage('Usage: /thinking none|low|medium|high');
      return 'handled';
    }
    sessionSettings.thinking = next;
    appendSession(SESSION_PATH, sessionEventEntry('session_setting_changed', { setting: 'thinking', value: next }));
    printCliMessage(`Thinking set to ${sessionSettings.thinking}`);
    return 'handled';
  }
  printCliMessage(`Unknown command: ${command}. Type /help.`);
  return 'handled';
}

function handleOpsCommand(value, { session, naradaDir, direction: overrideDirection, target: overrideTarget } = {}) {
  const tokens = shellLikeWords(String(value ?? '').trim());
  if (tokens.length === 0 || (tokens.length === 1 && tokens[0].toLowerCase() === '--json')) {
    return {
      action: 'read',
      payload: {
        session,
        naradaDir,
        jsonOutput: tokens.some((token) => token.toLowerCase() === '--json'),
      },
    };
  }

  if (tokens[0].toLowerCase() === 'sync') {
    const options = {
      session,
      naradaDir,
      target: overrideTarget ?? null,
      direction: overrideDirection ?? 'upload',
      jsonOutput: false,
      dryRun: false,
      deleteMissing: false,
    };
    for (let index = 1; index < tokens.length; index += 1) {
      const token = tokens[index].toLowerCase();
      const next = tokens[index + 1];
      if (token === '--target' && next) {
        options.target = next;
        index += 1;
        continue;
      }
      if (token === '--direction' && next) {
        options.direction = next;
        index += 1;
        continue;
      }
      if (token === '--json') {
        options.jsonOutput = true;
        continue;
      }
      if (token === '--dry-run') {
        options.dryRun = true;
        continue;
      }
      if (token === '--delete') {
        options.deleteMissing = true;
        continue;
      }
      options.target = options.target ?? token;
    }
    return {
      action: 'sync',
      payload: {
        ...options,
        direction: normalizeSessionSyncDirection(options.direction),
        target: String(options.target ?? '').trim() || null,
      },
    };
  }

  return {
    action: null,
    payload: {},
  };
}

function handleToolOutputDisplayCommand(value = '', displaySettings = transcriptDisplaySettings) {
  const requested = String(value ?? '').trim().toLowerCase();
  if (!requested || requested === 'toggle') {
    displaySettings.toolOutputs = !displaySettings.toolOutputs;
  } else if (requested === 'on' || requested === 'show' || requested === 'shown') {
    displaySettings.toolOutputs = true;
  } else if (requested === 'off' || requested === 'hide' || requested === 'hidden') {
    displaySettings.toolOutputs = false;
  } else if (requested !== 'status') {
    return {
      state: displaySettings.toolOutputs,
      message: 'Usage: /tool-output [on|off|toggle|status]',
    };
  }
  return {
    state: displaySettings.toolOutputs,
    message: `Tool call outputs are ${displaySettings.toolOutputs ? 'shown' : 'hidden'} in the displayed transcript.`,
  };
}

function handleGoalCommand(value = '', settings = sessionSettings) {
  const requested = String(value ?? '').trim();
  settings.goal = normalizeCarrierGoalState(settings.goal);
  if (!requested) {
    return {
      action: 'show',
      changed: false,
      goal: settings.goal,
      message: settings.goal.value
        ? `Current goal (${settings.goal.status}): ${settings.goal.value}`
        : 'No carrier session goal is set.',
    };
  }
  const normalized = requested.toLowerCase();
  if (normalized === 'clear') {
    settings.goal = createCarrierGoalState('');
    return {
      action: 'clear',
      changed: true,
      goal: settings.goal,
      message: 'Carrier session goal cleared.',
    };
  }
  if (normalized === 'pause') {
    if (!settings.goal.value) {
      return {
        action: 'pause',
        changed: false,
        goal: settings.goal,
        message: 'No carrier session goal is set.',
      };
    }
    settings.goal.status = 'paused';
    return {
      action: 'pause',
      changed: true,
      goal: settings.goal,
      message: `Carrier session goal paused: ${settings.goal.value}`,
    };
  }
  if (normalized === 'resume') {
    if (!settings.goal.value) {
      return {
        action: 'resume',
        changed: false,
        goal: settings.goal,
        message: 'No carrier session goal is set.',
      };
    }
    settings.goal.status = 'active';
    return {
      action: 'resume',
      changed: true,
      goal: settings.goal,
      message: `Carrier session goal resumed: ${settings.goal.value}`,
    };
  }
  settings.goal = normalizeCarrierGoal(requested);
  settings.goal = createCarrierGoalState(settings.goal, 'active');
  return {
    action: 'set',
    changed: true,
    goal: settings.goal,
    message: `Carrier session goal set: ${settings.goal.value}`,
  };
}

function createCarrierGoalState(value = '', status = 'active') {
  const normalized = normalizeCarrierGoal(value);
  return {
    value: normalized,
    status: normalized ? normalizeCarrierGoalStatus(status) : 'unset',
  };
}

function normalizeCarrierGoalState(goal) {
  if (goal && typeof goal === 'object') {
    return createCarrierGoalState(goal.value ?? '', goal.status ?? 'active');
  }
  return createCarrierGoalState(goal ?? '');
}

function normalizeCarrierGoalStatus(status = 'active') {
  const normalized = String(status ?? '').trim().toLowerCase();
  return normalized === 'paused' ? 'paused' : 'active';
}

function carrierGoalStatusLabel(goal) {
  const normalized = normalizeCarrierGoalState(goal);
  if (!normalized.value) return 'not set';
  return normalized.status === 'paused'
    ? `${normalized.value} (paused)`
    : `${normalized.value} (active)`;
}

function normalizeCarrierGoal(value = '') {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function formatMcpToolCatalog(mcpServers = {}, { filter = '' } = {}) {
  const normalizedFilter = String(filter ?? '').trim().toLowerCase();
  const rows = [];
  for (const [serverName, server] of Object.entries(mcpServers ?? {})) {
    for (const tool of server.tools ?? []) {
      const haystack = [
        serverName,
        tool.name,
        tool.description,
      ].join(' ').toLowerCase();
      if (normalizedFilter && !haystack.includes(normalizedFilter)) continue;
      rows.push({
        serverName,
        tool,
      });
    }
  }
  if (rows.length === 0) {
    return normalizedFilter
      ? `No discovered MCP tools match "${filter}".`
      : 'No MCP tools discovered.';
  }
  return [
    `Discovered MCP tools (${rows.length})`,
    '',
    ...rows.map(({ serverName, tool }) => formatMcpToolCatalogItem(serverName, tool)),
  ].join('\n');
}

function formatMcpToolCatalogItem(serverName, tool) {
  const description = String(tool.description ?? '').trim();
  const schema = formatCompactJsonSchema(tool.inputSchema ?? { type: 'object', properties: {} });
  return [
    `${tool.name} (${serverName})`,
    ...(description ? [`  ${description}`] : []),
    `  input_schema: ${schema}`,
  ].join('\n');
}

function mcpToolCatalogEntries(mcpServers = {}) {
  const entries = [];
  for (const [serverName, server] of Object.entries(mcpServers ?? {})) {
    for (const tool of server.tools ?? []) {
      entries.push({
        server_name: serverName,
        tool_name: tool.name,
        description: tool.description ?? '',
        input_schema: tool.inputSchema ?? { type: 'object', properties: {} },
        registry_source: server.registry_source ?? null,
        registry_metadata_authoritative: server.registry_metadata_authoritative === true,
      });
    }
  }
  return entries;
}

function shouldDisplayToolOutputs(displaySettings = transcriptDisplaySettings) {
  return displaySettings.toolOutputs !== false;
}

function formatObserverPosture(displaySettings = transcriptDisplaySettings) {
  return [
    'Conversation observers',
    '',
    `Visible interjections: ${displaySettings.observerMuted === true ? 'muted' : 'shown'}`,
    `Visibilities: ${OBSERVER_VISIBILITIES.join(', ')}`,
    'Default delivery: admit_after_active_turn',
  ].join('\n');
}

function handleObserverCommand(value = '', displaySettings = transcriptDisplaySettings) {
  const requested = String(value ?? '').trim().toLowerCase();
  if (requested === 'mute') {
    displaySettings.observerMuted = true;
    return { status: 'ok', muted: true, message: 'Visible observer interjections are muted for this session.' };
  }
  if (requested === 'unmute') {
    displaySettings.observerMuted = false;
    return { status: 'ok', muted: false, message: 'Visible observer interjections are shown for this session.' };
  }
  return {
    status: 'usage',
    muted: displaySettings.observerMuted === true,
    message: 'Usage: /observers, /observer mute, /observer unmute',
  };
}

function runCodexTranscriptStats(value = '') {
  const extraArgs = shellLikeWords(value);
  const defaultArgs = extraArgs.length === 0 ? ['--top', '10'] : extraArgs;
  const timeoutMs = Math.max(1000, Math.min(30000, Number(process.env.NARADA_AGENT_CLI_STATS_TIMEOUT_MS ?? 5000) || 5000));
  const configuredRoot = process.env.NARADA_TOOLS_ROOT;
  const defaultRoot = process.platform === 'win32' ? 'D:/code/narada-tools' : '/home/andrey/src/narada-tools';
  const candidateRoot = configuredRoot || defaultRoot;
  const scriptPath = join(candidateRoot, 'packages', 'codex-transcript-stats', 'bin', 'codex-transcript-stats.js');
  const hasLocalWrapper = existsSync(scriptPath);
  const command = hasLocalWrapper ? process.execPath : 'codex-transcript-stats';
  const args = hasLocalWrapper ? [scriptPath, ...defaultArgs] : defaultArgs;
  const cwd = existsSync(candidateRoot) ? candidateRoot : process.cwd();
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    env: process.env,
    timeout: timeoutMs,
  });
  if (result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM') {
    return {
      status: 'timeout',
      message: `Codex transcript stats timed out after ${timeoutMs}ms.`,
    };
  }
  if (result.error) {
    return {
      status: 'unavailable',
      message: [
        'Codex transcript stats unavailable.',
        `Expected package bin wrapper at ${scriptPath} or codex-transcript-stats on PATH.`,
        `Error: ${result.error.message}`,
      ].join('\n'),
    };
  }
  const output = [result.stdout, result.stderr].filter((part) => String(part ?? '').trim()).join('\n').trim();
  if (result.status !== 0) {
    return {
      status: 'failed',
      message: [`Codex transcript stats failed with exit ${result.status}.`, output].filter(Boolean).join('\n'),
    };
  }
  return {
    status: 'ok',
    message: output || 'Codex transcript stats produced no output.',
  };
}

function shellLikeWords(value) {
  const words = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(String(value ?? ''))) !== null) {
    words.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return words;
}

function handleQueueCommand(value, inputQueue) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) {
    const items = inputQueue.items();
    if (items.length === 0) return { message: 'Queue is empty.', mutated: false };
    return {
      message: ['Queue', '', ...items.map(formatQueueItem)].join('\n'),
      mutated: false,
    };
  }
  if (trimmed === 'clear') {
    const dropped = inputQueue.clearOperatorSteering();
    return {
      message: dropped.length === 0 ? 'No queued operator steering to clear.' : `Cleared ${dropped.length} queued operator steering item${dropped.length === 1 ? '' : 's'}.`,
      mutated: dropped.length > 0,
      mutation: { kind: 'queue_clear', dropped_input_event_ids: dropped.map((event) => event.event_id) },
    };
  }
  const dropMatch = trimmed.match(/^drop\s+(\d+)$/i);
  if (dropMatch) {
    const index = Number(dropMatch[1]);
    const dropped = inputQueue.dropOperatorSteering(index);
    return {
      message: dropped ? `Dropped queued operator steering ${index}.` : `No queued operator steering at index ${index}.`,
      mutated: Boolean(dropped),
      mutation: dropped ? { kind: 'queue_drop', dropped_input_event_ids: [dropped.event_id], index } : null,
    };
  }
  return { message: 'Usage: /queue, /queue clear, /queue drop <index>', mutated: false };
}

function formatQueueItem(item) {
  const age = formatDuration(Math.max(0, Date.now() - Date.parse(item.created_at ?? item.received_at ?? new Date().toISOString())));
  const preview = firstLinePreview(item.content, 96);
  return `${item.index}. ${item.source} · ${item.delivery_mode}${item.hold_condition ? ` · hold ${item.hold_condition}` : ''} · age ${age}\n   ${preview}`;
}

function firstLinePreview(text, limit = 96) {
  const first = String(text ?? '').split(/\r?\n/)[0] ?? '';
  return first.length > limit ? `${first.slice(0, Math.max(0, limit - 1))}…` : first;
}

// ---------------------------------------------------------------------------
// Conversation loop
// ---------------------------------------------------------------------------
function normalizeInputEvent(input, defaults = {}) {
  return normalizeInputEventRuntime(input, defaults, { randomIdFn: randomId });
}

function classifyObserverInput(input = {}, displaySettings = transcriptDisplaySettings) {
  return classifyCarrierObserverInput(inputWithObserverMetadata(input), {
    observerMuted: displaySettings?.observerMuted === true,
  });
}

function classifyInputRuntimeAdmission(input = {}, displaySettings = transcriptDisplaySettings, state = {}) {
  return classifyCarrierInputAdmission(inputWithObserverMetadata(input), {
    ...state,
    observerMuted: displaySettings?.observerMuted === true,
  });
}

function classifyInputRuntimeQueueAdmission(input = {}, displaySettings = transcriptDisplaySettings, state = {}) {
  return classifyCarrierInputQueueAdmission(inputWithObserverMetadata(input), {
    ...state,
    observerMuted: displaySettings?.observerMuted === true,
  });
}

function classifyInputRuntimeHold(input = {}, state = {}) {
  return classifyCarrierInputHold(inputWithObserverMetadata(input), state);
}

function recordObserverInputQueued(input) {
  const admission = classifyInputRuntimeAdmission(input);
  for (const event of admission.admission_events) {
    if (event.event_kind === 'observer_observation_recorded' || event.event_kind === 'observer_interjection_proposed') {
      appendSession(SESSION_PATH, carrierSessionEventEntry(event.event_kind, event.payload));
    }
  }
}

function shouldDispatchObserverToAgent(input) {
  return classifyObserverInput(input).dispatch_to_agent;
}

function shouldDisplayObserverToOperator(input) {
  return classifyObserverInput(input).visible_to_operator;
}

function shouldAdmitInputToTurn(input) {
  return classifyInputRuntimeAdmission(input).creates_turn;
}

function createInputQueue({ drain, shouldDefer = () => false, onDeferred = null } = {}) {
  return createInputQueueRuntime({
    drain,
    shouldDefer,
    onDeferred,
    appendSessionFn: (entry) => appendSession(SESSION_PATH, entry),
    sessionEventEntryFn: sessionEventEntry,
    carrierSessionEventEntryFn: carrierSessionEventEntry,
    noteSessionActivityFn: noteSessionActivity,
    recordObserverInputQueuedFn: recordObserverInputQueued,
    classifyInputRuntimeQueueAdmissionFn: classifyInputRuntimeQueueAdmission,
    classifyInputRuntimeAdmissionFn: classifyInputRuntimeAdmission,
    classifyInputRuntimeHoldFn: classifyInputRuntimeHold,
    directiveReceiptEvidenceFn: directiveReceiptEvidence,
    directiveAcceptedEvidenceFn: directiveAcceptedEvidence,
    identity: IDENTITY,
    session: SESSION,
    transcriptDisplaySettings,
    randomIdFn: randomId,
  });
}

async function submitObserverInput({
  input,
  record,
  messages,
  tools,
  mcpServers,
  rl,
  turn = null,
  emit = null,
  callChatApiFn = callChatApi,
  displaySettings = transcriptDisplaySettings,
  carrierSessionSettings = sessionSettings,
}) {
  const admission = classifyInputRuntimeAdmission(input, displaySettings);
  if (admission.visibility === 'record_only') {
    return { terminal_state: 'completed_without_provider' };
  }
  if (admission.suppressed) {
    const suppressed = admission.admission_events.find((event) => event.event_kind === 'observer_interjection_suppressed');
    if (suppressed) appendSession(SESSION_PATH, carrierSessionEventEntry(suppressed.event_kind, suppressed.payload));
    return { terminal_state: 'completed_without_provider' };
  }
  const admitted = admission.admission_events.find((event) => event.event_kind === 'observer_interjection_admitted');
  if (admitted) appendSession(SESSION_PATH, carrierSessionEventEntry(admitted.event_kind, admitted.payload));
  if (!emit && admission.visible_to_operator) {
    printInputRecord(input);
  }
  if (!admission.dispatch_to_provider) {
    return { terminal_state: 'completed_without_provider' };
  }
  const providerContent = `Observer ${input.source_id ?? 'narada.observer'} (${observerMetadata(input).rule_id ?? 'observer'}): ${record.content}`;
  messages.push({ role: 'user', content: providerContent });
  appendSession(SESSION_PATH, sessionLogEntry({
    role: 'user',
    content: providerContent,
    source: 'observer',
    eventId: input?.event_id,
    transport: input?.transport,
  }));
  return await runConversationTurn(messages, tools, mcpServers, rl, { turn, emit, callChatApiFn, inputEventId: input?.event_id ?? null, carrierSessionSettings });
}

async function submitUserInput({
  input,
  messages,
  tools,
  mcpServers,
  rl,
  inputQueue = null,
  turn = null,
  emit = null,
  callChatApiFn = callChatApi,
  displaySettings = transcriptDisplaySettings,
  carrierSessionSettings = sessionSettings,
}) {
  const record = normalizeInputRecord(input);
  if (isObserverInputEvent(input, record)) {
    return submitObserverInput({ input, record, messages, tools, mcpServers, rl, turn, emit, callChatApiFn, displaySettings, carrierSessionSettings });
  }
  const runtimeAdmission = classifyInputRuntimeAdmission(input, displaySettings);
  if (runtimeAdmission.is_directive && runtimeAdmission.complete_without_provider) {
    return { terminal_state: 'completed_without_provider' };
  }
  messages.push({ role: 'user', content: record.content });
  appendSession(SESSION_PATH, sessionLogEntry({
    role: 'user',
    content: record.content,
    source: record.source,
    authorityRef: record.authority_ref,
    eventId: input?.event_id,
    transport: input?.transport,
    directiveId: input?.directive_id,
  }));
  if (!emit && record.source !== 'manual_operator') {
    printInputRecord(record);
  }
  const progress = !emit && !turn ? startTurnProgress({
    readlineInterface: rl,
    onOperatorDirective: async (content) => {
      if (!inputQueue) return null;
      await inputQueue.enqueue(normalizeInputEvent({
        content,
        source: 'operator_steering',
        authority_ref: 'interactive_working_input',
      }, { transport: 'terminal' }), { drain: false });
      return inputQueue.state();
    },
  }) : null;
  try {
    return await runConversationTurn(messages, tools, mcpServers, rl, { turn: turn ?? progress?.turn ?? null, emit, callChatApiFn, inputEventId: input?.event_id ?? null, carrierSessionSettings });
  } finally {
    progress?.stop();
  }
}

async function runConversationTurn(messages, tools, mcpServers, rl, options = {}) {
  const emit = options.emit ?? null;
  const turn = options.turn ?? null;
  const callChatApiFn = options.callChatApiFn ?? callChatApi;
  const carrierSessionSettings = options.carrierSessionSettings ?? sessionSettings;
  let turnStartedRecorded = false;
  let turnTerminalRecorded = false;
  const recordTurnStarted = () => {
    if (turnStartedRecorded || !turn?.turnId) return;
    turnStartedRecorded = true;
    appendCarrierTurnEvent('turn_started', turn.turnId, { input_event_id: options.inputEventId ?? 'unknown_input_event' });
  };
  const recordTurnTerminal = (eventKind, payload = {}) => {
    if (turnTerminalRecorded || !turn?.turnId) return;
    turnTerminalRecorded = true;
    appendCarrierTurnEvent(eventKind, turn.turnId, createTurnTerminalPayload({
      turn_id: turn.turnId,
      input_event_id: options.inputEventId,
      provider_request_status: payload.provider_request_status ?? 'completed',
      terminal_status: payload.terminal_status ?? terminalStatusForEventKind(eventKind),
      provider_execution_enabled: payload.provider_execution_enabled ?? true,
      error_summary: payload.error_summary,
    }));
  };
  while (true) {
    if (turn?.interruptRequested) {
      emit?.('turn_interrupted', { turn_id: turn.turnId, terminal_state: 'interrupted' });
      recordTurnTerminal('turn_interrupted');
      return { terminal_state: 'interrupted' };
    }
    turn?.setPhase?.('thinking');
    let response;
    try {
      recordTurnStarted();
      response = await callChatApiFn(messagesWithCarrierGoal(messages, carrierSessionSettings.goal), tools, { ...carrierSessionSettings, turn, abortSignal: turn?.abortSignal, emit, mcpServers });
    } catch (error) {
      if (turn?.interruptRequested || isAbortError(error)) {
        emit?.('turn_interrupted', { turn_id: turn?.turnId ?? null, terminal_state: 'interrupted' });
        recordTurnTerminal('turn_interrupted');
        return { terminal_state: 'interrupted' };
      }
      const errorSummary = error instanceof Error ? error.message : String(error);
      recordTurnTerminal('turn_failed', { error_summary: errorSummary });
      if (!emit) printHeader(`Provider call failed: ${errorSummary}`, { level: 'warn' });
      return { terminal_state: 'failed', reason: errorSummary };
    }
    if (turn?.interruptRequested) {
      emit?.('turn_interrupted', { turn_id: turn.turnId, terminal_state: 'interrupted' });
      recordTurnTerminal('turn_interrupted');
      return { terminal_state: 'interrupted' };
    }
    const choice = response.choices?.[0];
    if (!choice) {
      if (!emit) printHeader('No response from AI.', { level: 'warn' });
      recordTurnTerminal('turn_failed', { error_summary: 'no_response_from_ai' });
      return { terminal_state: 'failed', reason: 'no_response_from_ai' };
    }

    const message = choice.message;
    messages.push(message);
    appendSession(SESSION_PATH, {
      role: 'assistant',
      content: message.content ?? null,
      tool_calls: message.tool_calls ?? undefined,
      reasoning_content: message.reasoning_content ?? undefined,
      timestamp: new Date().toISOString(),
    });

    if (message.content) {
      if (emit) emit('assistant_message', { turn_id: turn?.turnId ?? null, content: message.content });
      else if (response.streaming_rendered !== true) printAgentMessage(message.content);
    }

    if (message.tool_calls && message.tool_calls.length > 0) {
      const toolResults = [];
      for (const toolCall of message.tool_calls) {
        if (turn?.interruptRequested) {
          emit?.('turn_interrupted', { turn_id: turn.turnId, terminal_state: 'interrupted' });
          recordTurnTerminal('turn_interrupted');
          break;
        }
        const result = await executeMcpTool(toolCall, mcpServers, rl, {
          emit,
          turn,
          turnId: turn?.turnId ?? null,
          serverMode: !!emit,
          agentId: options.agentId,
          carrierSessionId: options.carrierSessionId,
          siteRoot: options.siteRoot,
          delegatedAuthorityHandoff: options.delegatedAuthorityHandoff,
        });
        toolResults.push(result);
      }
      if (turn?.interruptRequested) {
        recordTurnTerminal('turn_interrupted');
        return { terminal_state: 'interrupted' };
      }
      for (const result of toolResults) {
        messages.push(result);
        appendSession(SESSION_PATH, { role: 'tool', content: result.content, tool_call_id: result.tool_call_id, timestamp: new Date().toISOString() });
      }
      // Loop back to send tool results to AI
      turn?.setPhase?.('thinking');
      continue;
    }

    recordTurnTerminal('turn_completed');
    return { terminal_state: 'completed' };
  }
}

function messagesWithCarrierGoal(messages, goal = sessionSettings.goal) {
  const normalized = normalizeCarrierGoalState(goal);
  if (!normalized.value || normalized.status !== 'active') return messages;
  const goalMessage = {
    role: 'system',
    content: `Active carrier session goal: ${normalized.value}\nUse this as the persistent task target and completion criterion while it remains active.`,
  };
  const insertAt = messages.findIndex((message) => message.role !== 'system');
  if (insertAt === -1) return [...messages, goalMessage];
  return [...messages.slice(0, insertAt), goalMessage, ...messages.slice(insertAt)];
}

function terminalStatusForEventKind(eventKind) {
  if (eventKind === 'turn_completed') return 'completed';
  if (eventKind === 'turn_interrupted') return 'interrupted';
  if (eventKind === 'turn_failed') return 'failed';
  return 'failed';
}

// ---------------------------------------------------------------------------
// MCP Tool Execution with Approval Gates
// ---------------------------------------------------------------------------
async function executeMcpTool(toolCall, mcpServers, rl, options = {}) {
  const name = toolCall.function?.name ?? '';
  const args = parseJson(toolCall.function?.arguments ?? '{}');
  const binding = findToolBinding(name, mcpServers);
  const server = binding?.server ?? null;
  const toolMetadata = resolveToolMetadata({ toolName: name, server, tool: binding?.tool ?? null });
  const emit = options.emit ?? null;
  const turn = options.turn ?? null;
  const turnId = options.turnId ?? null;
  const serverMode = options.serverMode === true;
  const startedAt = Date.now();
  const argSummary = argumentSummary(args);
  const argSummaryText = stringifySummary(argSummary);
  appendSession(SESSION_PATH, carrierSessionEventEntry('tool_call_requested', createToolCallPayload({
    tool_name: name || '<missing>',
    arguments_summary: argSummaryText,
    requesting_agent_id: IDENTITY,
  })));
  const admissionClassification = serverMode
    ? classifyCarrierActionRequest(name, args, {
      toolAvailable: !!server,
      toolMetadata,
      delegatedAuthorityHandoff: options.delegatedAuthorityHandoff ?? NARS_DELEGATED_AUTHORITY_HANDOFF,
    })
    : null;
  const category = serverMode
    ? (isServerModeToolExecutionAdmitted(admissionClassification) ? 'auto' : 'prompt')
    : classifyMcpTool(name, args);
  const admissionRequired = serverMode && !isServerModeToolExecutionAdmitted(admissionClassification);
  let delegatedAdmission = null;
  const recordToolResult = (status, contentOrSummary, extra = {}) => {
    appendSession(SESSION_PATH, carrierSessionEventEntry('tool_result_received', createToolResultPayload({
      tool_name: name || '<missing>',
      status,
      duration_ms: Date.now() - startedAt,
      result_summary: summarizeToolResult(contentOrSummary),
      ...mcpToolEffectAdmissionEvidence({ serverMode, admissionClassification, status, category }),
      ...extra,
    })));
  };

  if (emit) {
    if (serverMode) {
      emit('tool_call', {
        turn_id: turnId,
        tool: name,
        decision: admissionClassification.decision,
        classifier_source: admissionClassification.classifier_source ?? toolMetadata?.source ?? null,
        argument_summary: argSummary,
        payload_secret_findings: inspectPayloadForSecrets(args),
        raw_arguments_recorded: false,
        raw_secret_values_recorded: false,
        carrier_mutation_admitted: admissionClassification.carrier_mutation_admitted === true,
      });
    } else {
      emit('tool_call', {
        turn_id: turnId,
        tool: name,
        arguments: args,
        decision: 'read_only_admitted',
        carrier_mutation_admitted: false,
      });
    }
  }
  turn?.setPhase?.(`calling ${name}`);
  if (!serverMode) {
    turn?.clearStatus?.();
    printToolRequestLine(`${name}(${JSON.stringify(args).slice(0, 200)})`, { before: true });
  }

  if (category === 'block') {
    if (!serverMode) {
      turn?.clearStatus?.();
      if (shouldDisplayToolOutputs()) printToolResultLine(`blocked ${name} in ${formatDuration(Date.now() - startedAt)} · blocklist`, { level: 'warn' });
    }
    emit?.('tool_result', { turn_id: turnId, tool: name, status: 'blocked' });
    recordToolResult('denied', `Tool ${name} is blocked by policy.`);
    return {
      role: 'tool',
      tool_call_id: toolCall.id,
      content: JSON.stringify({ error: `Tool ${name} is blocked by policy.` }),
    };
  }
  if (!server) {
    if (serverMode) {
      const admission = createAndWriteCarrierActionAdmission({
        agentId: options.agentId ?? IDENTITY,
        carrierSessionId: options.carrierSessionId ?? SESSION,
        turnId,
        toolCallId: toolCall.id,
        toolName: name,
        args,
        siteRoot: options.siteRoot ?? SITE_ROOT,
        toolAvailable: false,
        toolMetadata,
        delegatedAuthorityHandoff: options.delegatedAuthorityHandoff ?? NARS_DELEGATED_AUTHORITY_HANDOFF,
      });
      const decision = admission.decision;
      emit?.('tool_result', {
        turn_id: turnId,
        tool: name,
        status: 'admission_required',
        request_id: decision.request_id,
        decision: decision.decision,
        reason: decision.reason,
        authority_owner: decision.authority_owner,
        evidence_path: admission.path,
        candidate_ref: decision.candidate_ref,
        carrier_mutation_admitted: decision.carrier_mutation_admitted,
      });
      recordToolResult('denied', 'action_admission_required');
      return {
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify({
          error: 'action_admission_required',
          request_id: decision.request_id,
          tool: name,
          category,
          decision: decision.decision,
          reason: decision.reason,
          authority_owner: decision.authority_owner,
          evidence_path: admission.path,
          candidate_ref: decision.candidate_ref,
          carrier_mutation_admitted: decision.carrier_mutation_admitted,
          message: `Agent Runtime Server could not execute this MCP tool because it is not available in the session.`,
        }),
      };
    }
    emit?.('tool_result', { turn_id: turnId, tool: name, status: 'error', error: `Tool ${name} not found in any MCP server.` });
    recordToolResult(serverMode ? 'denied' : 'failed', `Tool ${name} not found in any MCP server.`);
    if (!serverMode) {
      turn?.clearStatus?.();
      if (shouldDisplayToolOutputs()) printToolResultLine(`failed ${name} in ${formatDuration(Date.now() - startedAt)} · tool not found`, { level: 'error' });
    }
    return {
      role: 'tool',
      tool_call_id: toolCall.id,
      content: JSON.stringify({ error: `Tool ${name} not found in any MCP server.` }),
    };
  }

  if (admissionRequired) {
    const admission = createAndWriteCarrierActionAdmission({
      agentId: options.agentId ?? IDENTITY,
      carrierSessionId: options.carrierSessionId ?? SESSION,
      turnId,
      toolCallId: toolCall.id,
      toolName: name,
        args,
        siteRoot: options.siteRoot ?? SITE_ROOT,
        toolMetadata,
        delegatedAuthorityHandoff: options.delegatedAuthorityHandoff ?? NARS_DELEGATED_AUTHORITY_HANDOFF,
      });
    const decision = admission.decision;
    emit?.('tool_result', {
      turn_id: turnId,
      tool: name,
      status: 'admission_required',
      request_id: decision.request_id,
      decision: decision.decision,
      reason: decision.reason,
      authority_owner: decision.authority_owner,
      evidence_path: admission.path,
      candidate_ref: decision.candidate_ref,
      carrier_mutation_admitted: decision.carrier_mutation_admitted,
    });
    recordToolResult('denied', 'action_admission_required');
    return {
      role: 'tool',
      tool_call_id: toolCall.id,
      content: JSON.stringify({
        error: 'action_admission_required',
        request_id: decision.request_id,
        tool: name,
        category,
        decision: decision.decision,
        reason: decision.reason,
        authority_owner: decision.authority_owner,
        evidence_path: admission.path,
        candidate_ref: decision.candidate_ref,
        carrier_mutation_admitted: decision.carrier_mutation_admitted,
        message: 'Agent Runtime Server did not execute this MCP tool because it is not classified read-only.',
      }),
    };
  }

  if (serverMode && admissionClassification.decision === 'delegated_mutation_admitted') {
    delegatedAdmission = createAndWriteCarrierActionAdmission({
      agentId: options.agentId ?? IDENTITY,
      carrierSessionId: options.carrierSessionId ?? SESSION,
      turnId,
      toolCallId: toolCall.id,
      toolName: name,
      args,
      siteRoot: options.siteRoot ?? SITE_ROOT,
      toolMetadata,
      delegatedAuthorityHandoff: options.delegatedAuthorityHandoff ?? NARS_DELEGATED_AUTHORITY_HANDOFF,
    });
  }

  try {
    const result = await sendMcpRequest(server, {
      jsonrpc: '2.0',
      id: randomId(),
      method: 'tools/call',
      params: { name, arguments: args },
    }, turn?.abortSignal);

    // Handle shell server approval_required fallback
    if (result.content?.[0]?.text) {
      const text = result.content[0].text;
      try {
        const parsed = JSON.parse(text);
        if (parsed.approval_required === true && !serverMode) {
          // Re-send with auto-approve flag (only for shell server)
          if (server.config?.command?.includes('shell')) {
            const autoResult = await sendMcpRequest(server, {
              jsonrpc: '2.0',
              id: randomId(),
              method: 'tools/call',
              params: { name, arguments: { ...args, __auto_approved: true } },
            }, turn?.abortSignal);
            const autoContent = autoResult.content?.[0]?.text ?? JSON.stringify(autoResult);
            turn?.clearStatus?.();
            if (shouldDisplayToolOutputs()) printToolResultLine(`ok ${name} in ${formatDuration(Date.now() - startedAt)} · ${formatToolResultContent(autoContent)}`);
            recordToolResult('ok', autoContent, { result_ref: payloadRefFromOutputRef(extractOutputRef(autoContent)) });
            return { role: 'tool', tool_call_id: toolCall.id, content: autoContent };
          }
        }
      } catch {
        // not JSON, proceed normally
      }
    }

    const content = result.content?.[0]?.text ?? JSON.stringify(result);
    if (!serverMode) {
      turn?.clearStatus?.();
      if (shouldDisplayToolOutputs()) printToolResultLine(`ok ${name} in ${formatDuration(Date.now() - startedAt)} · ${formatToolResultContent(content)}`);
    }
    emit?.('tool_result', {
      turn_id: turnId,
      tool: name,
      status: 'ok',
      decision: serverMode ? admissionClassification.decision : undefined,
      output_ref: extractOutputRef(content),
      request_id: delegatedAdmission?.decision?.request_id,
      authority_owner: delegatedAdmission?.decision?.authority_owner,
      evidence_path: delegatedAdmission?.path,
      carrier_mutation_admitted: admissionClassification?.carrier_mutation_admitted === true,
    });
    recordToolResult('ok', content, {
      result_ref: payloadRefFromOutputRef(extractOutputRef(content)),
      ...(admissionClassification?.carrier_mutation_admitted === true
        ? {
          admission_action: 'admit',
          admission_reason: 'write_tool_effect_admitted',
          authority_ref: delegatedAdmission?.decision?.request?.requested_action?.delegated_authority?.authority_ref,
          evidence_path: delegatedAdmission?.path,
        }
        : {}),
    });

    return {
      role: 'tool',
      tool_call_id: toolCall.id,
      content,
    };
  } catch (err) {
    const recovery = toolFailureRecovery(err?.message);
    recordMcpRuntimeFault({ mcpServers, serverName: server?.name, toolName: name, error: err, emit });
    if (!serverMode) {
      turn?.clearStatus?.();
      if (shouldDisplayToolOutputs()) printToolResultLine(`failed ${name} in ${formatDuration(Date.now() - startedAt)} · ${err.message}${recovery ? `\n${recovery}` : ''}`, { level: 'error' });
    }
    emit?.('tool_result', { turn_id: turnId, tool: name, status: 'error', error: err.message, recovery });
    recordToolResult('failed', err.message, recovery ? { recovery } : {});
    return {
      role: 'tool',
      tool_call_id: toolCall.id,
      content: JSON.stringify({ error: err.message, ...(recovery ? { recovery } : {}) }),
    };
  }
}

function isServerModeToolExecutionAdmitted(admissionClassification) {
  return admissionClassification?.decision === 'read_only_admitted'
    || admissionClassification?.decision === 'delegated_mutation_admitted';
}

function extractOutputRef(content) {
  try {
    const parsed = JSON.parse(content);
    return parsed.output_ref ?? null;
  } catch {
    return null;
  }
}

function payloadRefFromOutputRef(outputRef) {
  if (!outputRef || !String(outputRef).startsWith('mcp_output:')) return null;
  return createPayloadRef({
    payload_ref: String(outputRef),
    reader_tool: 'mcp_output_show',
    summary: 'tool result output stored out of transcript',
  });
}

function summarizeToolResult(contentOrSummary) {
  const text = typeof contentOrSummary === 'string' ? contentOrSummary : JSON.stringify(contentOrSummary);
  const formatted = formatToolResultContent(text);
  return formatted.length > 240 ? `${formatted.slice(0, 239)}…` : formatted;
}

function stringifySummary(summary) {
  if (typeof summary === 'string') return summary;
  try {
    return JSON.stringify(summary);
  } catch {
    return String(summary);
  }
}

function classifyMcpTool(name, args) {
  const metadata = buildFallbackToolMetadata(name);
  if (metadata?.read_only === true) return 'auto';
  return 'prompt';
}

// ---------------------------------------------------------------------------
// Role Prompt Loading
// ---------------------------------------------------------------------------
function loadRolePrompt(identityName, siteRoot) {
  const identitiesPath = join(siteRoot, 'operator-surfaces', 'identities.json');
  if (!existsSync(identitiesPath)) return null;
  try {
    const data = parseJson(readFileSync(identitiesPath, 'utf-8'));
    const identity = data.identities?.find((i) =>
      i.identity_name === identityName || i.identity_id === identityName
    );
    if (identity?.carrier_projections?.windows_terminal?.role_prompt) {
      return identity.carrier_projections.windows_terminal.role_prompt;
    }
    // Fallback to desired-sessions
    const sessionsPath = join(siteRoot, 'operator-surfaces', 'desired-sessions.json');
    if (existsSync(sessionsPath)) {
      const sessions = parseJson(readFileSync(sessionsPath, 'utf-8'));
      const session = sessions.sessions?.find((s) => s.identity_name === identityName);
      if (session?.inhabiting_cli?.description) {
        return `You are ${identityName}. ${session.inhabiting_cli.description}`;
      }
    }
  } catch {
    // ignore
  }
  return `You are ${identityName}, a software engineering agent. Work from the current directory and keep sessions coherent.`;
}

// ---------------------------------------------------------------------------
// Session Persistence
// ---------------------------------------------------------------------------
function loadSession(path) {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf-8').split(/\r?\n/).filter((l) => l.trim());
  const loaded = lines.map((l) => {
    try {
      const { role, content, tool_call_id, tool_calls, reasoning_content } = JSON.parse(l);
      if (role === 'event') return null;
      const msg = { role, content };
      if (tool_call_id) msg.tool_call_id = tool_call_id;
      if (tool_calls) msg.tool_calls = tool_calls;
      if (reasoning_content !== undefined) msg.reasoning_content = reasoning_content;
      return msg;
    } catch {
      return { role: 'user', content: l };
    }
  }).filter(Boolean);
  return removeInvalidToolHistory(loaded);
}

function removeInvalidToolHistory(messages) {
  const cleaned = [];
  const pendingToolCallIds = new Set();
  for (const message of messages) {
    if (!['system', 'user', 'assistant', 'tool'].includes(message?.role)) {
      continue;
    }
    if (message.role === 'assistant') {
      for (const toolCall of message.tool_calls ?? []) {
        if (toolCall?.id) pendingToolCallIds.add(toolCall.id);
      }
      cleaned.push(message);
      continue;
    }
    if (message.role === 'tool') {
      if (!message.tool_call_id || !pendingToolCallIds.has(message.tool_call_id)) {
        continue;
      }
      pendingToolCallIds.delete(message.tool_call_id);
      cleaned.push(message);
      continue;
    }
    cleaned.push(message);
  }
  return cleaned;
}

function appendSession(path, entry) {
  appendJsonlRecord(path, entry);
}

function writeMcpPreflightArtifact({ artifactDir = MCP_PREFLIGHT_ARTIFACT_DIR, session, identity, siteRoot, mcpStatus, mcpServers, allTools }) {
  mkdirSync(artifactDir, { recursive: true });
  const artifactPath = join(artifactDir, `${session}.json`);
  writeDurableTextFile(artifactPath, `${JSON.stringify({
    schema: 'narada.agent_cli.mcp_preflight_artifact.v1',
    session,
    identity,
    site_root: siteRoot,
    generated_at: new Date().toISOString(),
    mcp_server_count: Object.keys(mcpServers).length,
    tool_count: allTools.length,
    ...mcpStatus,
  }, null, 2)}\n`, 'utf8');
  return artifactPath;
}

function startCarrierHeartbeat({ path, session, identity, runtime, mode, sessionDir, carrierSessionDir, intervalMs = 5000 }) {
  const startedAt = new Date().toISOString();
  const write = (status = 'alive') => {
    writeFileSync(path, `${JSON.stringify({
      schema: 'narada.carrier_heartbeat.v1',
      status,
      carrier_session_id: session,
      agent_id: identity,
      runtime,
      mode,
      pid: process.pid,
      session_dir: sessionDir,
      carrier_session_dir: carrierSessionDir,
      started_at: startedAt,
      heartbeat_at: new Date().toISOString(),
    }, null, 2)}\n`, 'utf8');
  };
  write();
  const timer = setInterval(() => write(), intervalMs);
  timer.unref?.();
  const stop = () => {
    clearInterval(timer);
    try {
      write('stopped');
    } catch {
      // Best-effort carrier evidence only.
    }
  };
  process.once('exit', stop);
  process.once('SIGINT', () => {
    stop();
    process.exit(130);
  });
  process.once('SIGTERM', () => {
    stop();
    process.exit(143);
  });
  return { stop };
}

function createCarrierDirectiveEmitter({
  inputQueue,
  directiveKind = 'operation_heartbeat',
  appendSessionFn = (entry) => appendSession(SESSION_PATH, entry),
  carrierSessionEventEntryFn = carrierSessionEventEntry,
  session = SESSION,
  identity = IDENTITY,
  siteId = SITE_ID,
  operationId = process.env.NARADA_OPERATION_ID ?? process.env.NARADA_CARRIER_OPERATION_ID ?? null,
  sourceId,
  cadence,
  visibility,
  target,
  intervalMs = 60000,
  initialDelayMs = intervalMs,
  now = () => new Date().toISOString(),
} = {}) {
  const spec = carrierDirectiveEmitterSpec(directiveKind);
  if (!inputQueue || typeof inputQueue.enqueue !== 'function') throw new Error(`${spec.directive_kind}_directive_emitter_requires_input_queue`);
  let timer = null;
  let initialTimer = null;
  let stopped = false;
  let sequence = 0;
  const targetRef = target ?? (spec.target_kind === 'operation'
    ? { kind: 'operation', id: operationId }
    : { kind: 'carrier_session', id: session });
  const authorization = createDirectiveEmissionAuthorization({
    authorization_id: `auth_${spec.directive_kind}_${session}`,
    directive_kind: spec.directive_kind,
    cadence: cadence ?? spec.default_cadence,
    authorized_by: { kind: 'principal', id: 'principal:service' },
    authorized_emitter: { kind: 'system', id: sourceId ?? spec.default_source_id },
    authority: spec.default_authority,
    target: targetRef,
    status: 'authorized',
    created_at: now(),
  });
  const rule = createDirectiveEmissionRule({
    rule_id: `directive_emission_rule_${spec.directive_kind}_${session}`,
    authorization_id: authorization.authorization_id,
    directive_kind: spec.directive_kind,
    cadence: cadence ?? authorization.cadence ?? spec.default_cadence,
    visibility: visibility ?? spec.default_visibility,
    target: targetRef,
    status: 'active',
    created_at: now(),
  });
  let ruleRecorded = false;

  function ensureRuleRecorded() {
    if (ruleRecorded) return [];
    ruleRecorded = true;
    const events = [
      carrierSessionEventEntryFn('directive_emission_authorized', authorization),
      carrierSessionEventEntryFn('directive_emission_rule_recorded', rule),
    ];
    for (const event of events) appendSessionFn(event);
    return events;
  }

  async function emitOnce({ reason = spec.default_reason, enabled = true, content = spec.content } = {}) {
    if (stopped) return { ok: false, code: `${spec.directive_kind}_directive_emitter_stopped` };
    const decision = classifyDirectiveEmissionRequest({
      directive_kind: spec.directive_kind,
      enabled,
      rule,
      target: targetRef,
    });
    if (decision.action !== 'emit') return { ok: false, code: decision.reason, directive_kind: spec.directive_kind };
    const recordedEvents = ensureRuleRecorded();
    sequence += 1;
    const emittedAt = now();
    const input = createCarrierDirectiveInput({
      directive_kind: spec.directive_kind,
      event_id: `input_${spec.directive_kind}_${session}_${sequence}`,
      directive_id: `dir_${spec.directive_kind}_${session}_${sequence}`,
      authorization_id: authorization.authorization_id,
      rule_id: rule.rule_id,
      operation_id: operationId,
      carrier_session_id: session,
      site_id: siteId,
      created_at: emittedAt,
      source_id: authorization.authorized_emitter?.id ?? spec.default_source_id,
      cadence: rule.cadence,
      visibility: rule.visibility,
      reason,
      content,
      target: targetRef,
    });
    const emitted = carrierSessionEventEntryFn('directive_emitted', directiveEmissionPayload({ authorization, rule, input, emitted_at: emittedAt }));
    appendSessionFn(emitted);
    const queued = await inputQueue.enqueue(input, { drain: true });
    return {
      ok: true,
      directive_kind: spec.directive_kind,
      authorization,
      rule,
      input: queued,
      events: [...recordedEvents, emitted],
    };
  }

  function start() {
    if (timer || initialTimer || stopped) return { stop, emitOnce };
    const boundedInterval = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 60000;
    const boundedInitialDelay = Number.isFinite(initialDelayMs) && initialDelayMs >= 0 ? initialDelayMs : boundedInterval;
    initialTimer = setTimeout(() => {
      initialTimer = null;
      emitOnce().catch((error) => recordCarrierDiagnostic('error', `${spec.directive_kind} directive emission failed: ${error instanceof Error ? error.message : String(error)}`));
      timer = setInterval(() => {
        emitOnce().catch((error) => recordCarrierDiagnostic('error', `${spec.directive_kind} directive emission failed: ${error instanceof Error ? error.message : String(error)}`));
      }, boundedInterval);
      timer.unref?.();
    }, boundedInitialDelay);
    initialTimer.unref?.();
    return { stop, emitOnce };
  }

  function stop() {
    stopped = true;
    if (initialTimer) clearTimeout(initialTimer);
    if (timer) clearInterval(timer);
    initialTimer = null;
    timer = null;
  }

  return { start, stop, emitOnce, authorization, rule };
}

function createOperationHeartbeatDirectiveEmitter(options = {}) {
  return createCarrierDirectiveEmitter({ ...options, directiveKind: 'operation_heartbeat' });
}

function sessionLogEntry({ role, content, source, authorityRef, toolCallId, eventId, transport, directiveId }) {
  const entry = { role, content, timestamp: new Date().toISOString() };
  if (toolCallId) entry.tool_call_id = toolCallId;
  if (source) entry.source = source;
  if (authorityRef) entry.authority_ref = authorityRef;
  if (eventId) entry.event_id = eventId;
  if (transport) entry.transport = transport;
  if (directiveId) entry.directive_id = directiveId;
  return entry;
}

function sessionEventEntry(event, payload = {}) {
  return { role: 'event', event, ...payload, timestamp: new Date().toISOString() };
}

function carrierSessionEventEntry(eventKind, payload = {}) {
  return createCarrierSessionEvent({
    event_kind: eventKind,
    carrier_session_id: SESSION,
    agent_id: IDENTITY,
    site_id: SITE_ID,
    site_root: SITE_ROOT,
    payload,
  });
}

function appendCarrierTurnEvent(eventKind, turnId, payload = {}) {
  if (!turnId) return;
  appendSession(SESSION_PATH, carrierSessionEventEntry(eventKind, {
    turn_id: turnId,
    ...payload,
  }));
}

function directiveReceiptEvidence(event, { agentId, carrierSessionId, receivedAt = new Date().toISOString() }) {
  const evidence = {
    schema: 'narada.directive.carrier_receipt_evidence.v1',
    directive_id: event.directive_id,
    input_event_id: event.event_id,
    received_at: receivedAt,
    agent_id: agentId,
    carrier_session_id: carrierSessionId,
    transport: event.transport,
    authority_ref: event.authority_ref,
    source: event.source,
  };
  return {
    ...evidence,
    receipt_id: `dirrcpt_${hashStable(evidence).slice(0, 32)}`,
  };
}

function directiveAcceptedEvidence(event, { agentId, carrierSessionId, acceptedAt = new Date().toISOString() }) {
  const evidence = {
    schema: 'narada.directive.carrier_acceptance_evidence.v1',
    directive_id: event.directive_id,
    input_event_id: event.event_id,
    accepted_at: acceptedAt,
    agent_id: agentId,
    carrier_session_id: carrierSessionId,
    transport: event.transport,
    authority_ref: event.authority_ref,
    source: event.source,
    acceptance_semantics: 'carrier_started_directive_turn',
  };
  return {
    ...evidence,
    acceptance_id: `diraccept_${hashStable(evidence).slice(0, 32)}`,
  };
}

function startTurnProgress({ onOperatorDirective = null, readlineInterface = null } = {}) {
  const abortController = new AbortController();
  const turn = {
    turnId: randomId(),
    interruptRequested: false,
    abortSignal: abortController.signal,
    phase: 'thinking',
    phaseStartedAt: Date.now(),
    requestInterrupt() {
      if (!this.interruptRequested) {
        appendCarrierTurnEvent('interrupt_requested', this.turnId);
      }
      this.interruptRequested = true;
      if (!abortController.signal.aborted) abortController.abort(new Error('agent_cli_interrupt_requested'));
    },
    setPhase(phase) {
      if (!phase || this.phase === phase) return;
      this.phase = phase;
      this.phaseStartedAt = Date.now();
      forceNextStatus = true;
    },
    clearStatus() {
      process.stdout.write('\r\x1b[K');
      statusVisible = false;
      forceNextStatus = true;
    },
  };
  const started = Date.now();
  let lastSeconds = -1;
  let spinnerIndex = 0;
  let statusVisible = false;
  let forceNextStatus = false;
  let operatorDirectiveBuffer = '';
  let queuedOperatorDirectiveCount = 0;
  const operatorDirectiveDecoder = new StringDecoder('utf8');
  const writeStatus = (force = false) => {
    const seconds = Math.floor((Date.now() - started) / 1000);
    if (!force && !forceNextStatus && seconds === lastSeconds) return;
    lastSeconds = seconds;
    forceNextStatus = false;
    const spinner = ['-', '\\', '|', '/'][spinnerIndex++ % 4];
    const phaseSeconds = Math.floor((Date.now() - turn.phaseStartedAt) / 1000);
    process.stdout.write(`\r\x1b[K${terminalStyle.progress(formatProgressStatus({
      spinner,
      phase: turn.phase,
      totalMs: seconds * 1000,
      phaseMs: phaseSeconds * 1000,
      operatorDirectiveDraft: operatorDirectiveBuffer,
      operatorDirectiveDraftLength: operatorDirectiveBuffer.length,
      queuedOperatorDirectiveCount,
    }))}`);
    statusVisible = true;
  };
  const printProgressMessage = (text) => {
    process.stdout.write(`\r\x1b[K${terminalStyle.tool('agent-cli')}${terminalStyle.muted(':')} ${text}\n`);
    statusVisible = false;
    forceNextStatus = true;
  };
  const onData = (chunk) => {
    const buffer = Buffer.from(chunk);
    if (buffer.includes(0x1b) || buffer.includes(0x03)) {
      turn.requestInterrupt();
      printProgressMessage(terminalStyle.warn('Interrupt requested. Cancelling current provider call...'));
      return;
    }
    if (!onOperatorDirective) return;
    operatorDirectiveBuffer = consumeOperatorDirectiveInputText(operatorDirectiveDecoder.write(buffer), {
      initialBuffer: operatorDirectiveBuffer,
      submitLine: (content) => {
        Promise.resolve(onOperatorDirective(content)).then((queueState) => {
          queuedOperatorDirectiveCount = queueState?.pendingOperatorDirectiveCount ?? queuedOperatorDirectiveCount + 1;
          printProgressMessage(terminalStyle.operatorDirective(`operator directive queued (${queuedOperatorDirectiveCount})`));
        }).catch((error) => {
          printProgressMessage(terminalStyle.warn(`operator directive queue failed: ${error instanceof Error ? error.message : String(error)}`));
        });
      },
    });
    forceNextStatus = true;
  };
  const previousRawMode = process.stdin.isTTY ? process.stdin.isRaw : false;
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on('data', onData);
  writeStatus();
  const timer = setInterval(writeStatus, 250);
  return {
    turn,
    stop: () => {
      clearInterval(timer);
      process.stdin.off('data', onData);
      clearReadlineDraft(readlineInterface);
      if (process.stdin.isTTY) process.stdin.setRawMode(!!previousRawMode);
      if (statusVisible) process.stdout.write('\r\x1b[K');
    },
  };
}

function clearReadlineDraft(rl) {
  if (!rl) return;
  try {
    if (typeof rl.line === 'string') rl.line = '';
    if (typeof rl.cursor === 'number') rl.cursor = 0;
    rl._refreshLine?.();
  } catch {
    // Best-effort cleanup for the next prompt only.
  }
}

function consumeOperatorDirectiveInputText(text, { initialBuffer = '', submitLine = () => {} } = {}) {
  let draft = String(initialBuffer ?? '');
  const chunk = String(text ?? '');
  const containsLineBreak = /[\r\n]/.test(chunk);
  const flushDraft = () => {
    const content = draft.trim();
    draft = '';
    if (content) submitLine(content);
  };
  for (const char of chunk) {
    if (char === '\r' || char === '\n') {
      flushDraft();
      continue;
    }
    if (char === '\x7f' || char === '\b') {
      draft = Array.from(draft).slice(0, -1).join('');
      continue;
    }
    if (char >= ' ') draft += char;
  }
  if (containsLineBreak) flushDraft();
  return draft;
}

function attachTurnAbortController(turn) {
  if (!turn || turn.abortSignal) return turn;
  const abortController = new AbortController();
  turn.abortSignal = abortController.signal;
  turn.requestInterrupt = function requestInterrupt() {
    this.interruptRequested = true;
    if (!abortController.signal.aborted) abortController.abort(new Error('agent_cli_interrupt_requested'));
  };
  return turn;
}

function requestTurnInterrupt(turn) {
  if (!turn) return;
  if (typeof turn.requestInterrupt === 'function') turn.requestInterrupt();
  else turn.interruptRequested = true;
}

function isAbortError(error) {
  const message = String(error?.message ?? error ?? '');
  return error?.name === 'AbortError'
    || error?.code === 'ABORT_ERR'
    || message.includes('agent_cli_interrupt_requested')
    || message.includes('The operation was aborted');
}

// ---------------------------------------------------------------------------
// Agent Runtime Server JSONL Mode
// ---------------------------------------------------------------------------
async function runServerMode({ input = process.stdin, output = process.stdout, callChatApiFn = callChatApi } = {}) {
  const mcpServers = await discoverAndStartMcpServers(SITE_ROOT);
  const allTools = aggregateTools(mcpServers);
  const mcpStatus = createMcpStatusSnapshot(mcpServers);
  const mcpPreflightArtifact = readMcpPreflightArtifact();
  const mcpPreflightSnapshot = createMcpPreflightArtifactSnapshot(mcpPreflightArtifact);
  const rolePrompt = loadRolePrompt(IDENTITY, SITE_ROOT);
  const state = {
    activeTurn: null,
    closed: false,
    displaySettings: { ...transcriptDisplaySettings },
    sessionSettings: { ...sessionSettings },
    pendingRequests: new Set(),
    startedAt: new Date().toISOString(),
    sessionEventCount: 0,
    lastEventKind: null,
    lastEventAt: null,
    lastTerminalState: null,
    requestIssueCounts: {},
    requestOutcomeCounts: {},
  };
  let messages = loadSession(SESSION_PATH);
  if (messages.length === 0 && rolePrompt) {
    messages.push({ role: 'system', content: rolePrompt });
  }
  state.inputQueue = createInputQueue({
    drain: (event) => {
      const requestId = event.request_id ?? event.event_id;
      if (state.closed) {
        noteSessionActivity(state, 'input_rejected_closed');
        emit('error', {
          request_id: requestId,
          code: 'session_closed',
          message: 'Session is closed.',
        });
        return { terminal_state: 'rejected' };
      }
      return runServerInputEvent({
        requestId,
        state,
        messages,
        allTools,
        mcpServers,
        emit,
        callChatApiFn,
        input: event,
        directiveId: event.directive_id ?? null,
      });
    },
  });

  const emit = (event, payload = {}) => {
    if (event === 'error' && payload?.code) recordSessionRequestIssue(state, payload.code);
    const lifecycleEvent = normalizeNarsRuntimeEventKind(event);
    return emitServerEvent(output, {
      event,
      ...(isNarsRuntimeEventKind(lifecycleEvent) ? { lifecycle_event: lifecycleEvent } : {}),
      agent_id: IDENTITY,
      session_id: SESSION,
      timestamp: new Date().toISOString(),
      ...payload,
    });
  };

  noteSessionActivity(state, 'session_started', state.startedAt);

  emit('session_started', {
    transport: 'jsonl_stdio',
    site_root: SITE_ROOT,
    provider: INTELLIGENCE_PROVIDER,
    model: state.sessionSettings.model,
    thinking: state.sessionSettings.thinking,
    stream: state.sessionSettings.stream,
    goal: normalizeCarrierGoalState(state.sessionSettings.goal).value || null,
    goal_display: carrierGoalStatusLabel(state.sessionSettings.goal),
    mcp_server_count: Object.keys(mcpServers).length,
    ...mcpStatus,
    ...mcpPreflightSnapshot,
    ...createSessionActivitySnapshot(state),
    ...createOperationalPostureSnapshot({ state, mcpOperationalState: mcpStatus.mcp_operational_state }),
    tool_count: allTools.length,
    mcp_servers: mcpServerSummaryEntries(mcpServers),
    tool_outputs: transcriptDisplaySettings.toolOutputs ? 'shown' : 'hidden',
    approvals: 'disabled',
    help: '/help',
    health_endpoint: process.env.NARADA_HEALTH_URL ?? null,
    event_endpoint: process.env.NARADA_EVENT_STREAM_URL ?? null,
    websocket_endpoint: process.env.NARADA_EVENT_STREAM_URL ?? null,
    delegated_authority_handoff: NARS_DELEGATED_AUTHORITY_HANDOFF,
    delegated_authority_ref: NARS_DELEGATED_AUTHORITY_HANDOFF?.authority_ref ?? null,
    session_path: SESSION_PATH,
    events_path: EVENTS_PATH,
  });
  recordMcpPreflightArtifactLinkage({ emit, preflightArtifact: mcpPreflightArtifact });
  recordMcpStartupFailures(mcpServers, { emit });

  if (OPERATION_HEARTBEAT_DIRECTIVE_ENABLED) {
    activeOperationHeartbeatDirectiveEmitter = createOperationHeartbeatDirectiveEmitter({
      inputQueue: state.inputQueue,
      intervalMs: OPERATION_HEARTBEAT_DIRECTIVE_INTERVAL_MS,
      initialDelayMs: OPERATION_HEARTBEAT_DIRECTIVE_INITIAL_DELAY_MS,
    }).start();
  }

  input.setEncoding('utf8');
  let buffer = '';
  let orderedServerRequests = Promise.resolve();
  let orderedServerRequestActive = false;
  const dispatchRequestLine = (line) => {
    const runRequest = () => handleServerRequestLine(line, { state, messages, allTools, mcpServers, mcpPreflightArtifact, emit, callChatApiFn });
    let pending;
    if (isConcurrentServerRequestLine(line)) {
      pending = runRequest();
    } else {
      const runOrderedRequest = async () => {
        orderedServerRequestActive = true;
        try {
          return await runRequest();
        } finally {
          orderedServerRequestActive = false;
        }
      };
      pending = orderedServerRequestActive
        ? (orderedServerRequests = orderedServerRequests.then(runOrderedRequest, runOrderedRequest))
        : (orderedServerRequests = runOrderedRequest());
    }
    const tracked = pending
      .catch((error) => {
        emit('error', {
          request_id: null,
          code: 'request_dispatch_failed',
          message: error instanceof Error ? error.message : String(error),
        });
      });
    state.pendingRequests.add(tracked);
    tracked.finally(() => {
      state.pendingRequests.delete(tracked);
    });
    return tracked;
  };
  for await (const chunk of input) {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      dispatchRequestLine(line);
    }
    if (state.closed) break;
  }
  if (!state.closed && buffer.trim()) {
    dispatchRequestLine(buffer);
  }
  await Promise.allSettled([...state.pendingRequests]);
  activeOperationHeartbeatDirectiveEmitter?.stop?.();
  activeOperationHeartbeatDirectiveEmitter = null;
  closeMcpServers(mcpServers);
}

function isConcurrentServerRequestLine(line) {
  try {
    const request = JSON.parse(line);
    if (request?.method === 'conversation.interrupt') return true;
    if (request?.method === 'session.health') return true;
    if (request?.method === 'session.events.subscribe') return true;
    if (request?.method === 'session.operations') return false;
    if (request?.method === 'session.recovery') return false;
    if (request?.method === 'preflight.recovery') return false;
    return classifyCarrierControlRequest(request).concurrent_allowed;
  } catch {
    return false;
  }
}

function serverOperations({ requestId, state, mcpServers, mcpPreflightArtifact = readMcpPreflightArtifact() }) {
  const mcpStatus = createMcpStatusSnapshot(mcpServers);
  const mcpPreflightSnapshot = createMcpPreflightArtifactSnapshot(mcpPreflightArtifact);
  const sessionActivity = createSessionActivitySnapshot(state);
  const sessionRecord = readPersistedSession({ session: SESSION, siteRoot: SITE_ROOT, naradaDir: NARADA_DIR });
  const sessionOperationPayload = createSessionOperationPayload(sessionRecord);
  const sessionEventSummary = createSessionEventSummaryPayload(sessionRecord, { naradaDir: NARADA_DIR, eventFilter: 'all', recentCount: 20 });
  const operationalPosture = createOperationalPostureSnapshot({
    state,
    mcpOperationalState: mcpStatus.mcp_operational_state,
  });
  return {
    request_id: requestId,
    transport: 'jsonl_stdio',
    event: 'session_operations',
    active_turn_state: state.activeTurn ? 'running' : 'idle',
    active_turn_id: state.activeTurn?.turnId ?? null,
    ...mcpStatus,
    ...mcpPreflightSnapshot,
    ...sessionActivity,
    ...operationalPosture,
    operation: sessionOperationPayload,
    event_summary: sessionEventSummary,
    recovery: createSessionRecoveryPayload(sessionRecord),
    preflight: createSessionPreflightPayload(sessionRecord),
    host_command_output: createSessionHostCommandOutputPayload(sessionRecord),
    session_path: SESSION_PATH,
    events_path: EVENTS_PATH,
  };
}

function serverHealth({ requestId, state, allTools = [], mcpServers = {}, mcpPreflightArtifact = readMcpPreflightArtifact() }) {
  const status = serverStatus({ requestId, state, allTools, mcpServers, mcpPreflightArtifact });
  const healthStatus = state?.closed
    ? 'closing'
    : status.operational_posture === 'healthy'
      ? 'healthy'
      : 'degraded';
  return {
    schema: 'narada.nars.health.v1',
    event: 'session_health',
    request_id: requestId,
    status: healthStatus,
    generated_at: new Date().toISOString(),
    agent_id: IDENTITY,
    session_id: SESSION,
    site_root: SITE_ROOT,
    runtime: 'narada-agent-runtime-server',
    runtime_substrate: 'agent-cli',
    runtime_mode: 'server',
    started_at: state?.startedAt ?? null,
    provider: status.provider,
    model: status.model,
    transport: status.transport,
    health_endpoint: process.env.NARADA_HEALTH_URL ?? null,
    delegated_authority_handoff: status.delegated_authority_handoff ?? null,
    delegated_authority_ref: status.delegated_authority_ref ?? null,
    heartbeat: {
      path: status.session_path ? join(dirname(status.session_path), 'heartbeat.json') : null,
      last_written_at: status.last_event_at ?? null,
      age_ms: null,
      freshness: state?.closed ? 'stale' : 'fresh',
    },
    mcp: {
      operational_state: status.mcp_operational_state,
      server_count: status.mcp_server_count,
      startup_failure_count: status.mcp_startup_failure_count,
      startup_failure_summary: status.mcp_startup_failure_summary,
      runtime_fault_count: status.mcp_runtime_fault_count,
      runtime_fault_summary: status.mcp_runtime_fault_summary,
    },
    activity: {
      last_event_kind: status.last_event_kind,
      last_event_at: status.last_event_at,
      active_turn_state: status.active_turn_state,
      active_turn_id: status.active_turn_id,
      last_terminal_state: status.last_terminal_state,
      session_event_count: status.session_event_count,
    },
    posture: {
      request_posture: status.request_posture,
      request_posture_display: status.request_posture_display,
      operational_posture: status.operational_posture,
      operational_posture_display: status.operational_posture_display,
    },
    recommended_action: status.recommended_action,
    recommended_action_display: status.recommended_action_display,
    recommended_command: status.recommended_command,
    recovery_kind: status.recovery_kind,
    recovery_kind_display: status.recovery_kind_display,
    recovery_primary_command: status.recovery_primary_command,
    recovery_followup_command: status.recovery_followup_command,
  };
}

function serverRecovery({ requestId, state, mcpServers, mcpPreflightArtifact = readMcpPreflightArtifact() }) {
  const mcpStatus = createMcpStatusSnapshot(mcpServers);
  const mcpPreflightSnapshot = createMcpPreflightArtifactSnapshot(mcpPreflightArtifact);
  const sessionActivity = createSessionActivitySnapshot(state);
  const operationalPosture = createOperationalPostureSnapshot({
    state,
    mcpOperationalState: mcpStatus.mcp_operational_state,
  });
  return {
    request_id: requestId,
    transport: 'jsonl_stdio',
    event: 'session_recovery',
    active_turn_state: state.activeTurn ? 'running' : 'idle',
    active_turn_id: state.activeTurn?.turnId ?? null,
    ...mcpStatus,
    ...mcpPreflightSnapshot,
    ...sessionActivity,
    ...operationalPosture,
    session_path: SESSION_PATH,
    events_path: EVENTS_PATH,
  };
}

function serverSync({
  requestId,
  direction = 'upload',
  target = null,
  dryRun = false,
  deleteMissing = false,
}) {
  return {
    request_id: requestId,
    transport: 'jsonl_stdio',
    event: 'session_sync',
    ...resolveSessionSyncTarget({ target }),
    mode: dryRun ? 'dry-run' : 'live',
    direction,
    target,
    delete_missing: deleteMissing,
  };
}

function sessionSyncOperationId({ session, target, direction = 'upload', requestId = null, dryRun = false, deleteMissing = false }) {
  const base = {
    kind: 'session_sync',
    session,
    target: target ?? null,
    direction,
    requestId,
    dryRun: !!dryRun,
    deleteMissing: !!deleteMissing,
  };
  return `operation_session_sync_${hashStable(base).slice(0, 16)}`;
}

function recordSessionSyncWorkflow({
  event = 'session_sync_requested',
  requestId = null,
  session = SESSION,
  target = null,
  direction = 'upload',
  dryRun = false,
  deleteMissing = false,
  summary = null,
  directionResult = null,
  exitCode = 0,
  transport = 'jsonl_stdio',
  naradaDir = NARADA_DIR,
  method = 'session.sync',
  operation_status = null,
  requested_at = null,
  completed_at = null,
  duration_ms = null,
}) {
  const operationId = sessionSyncOperationId({ session, target, direction, requestId, dryRun, deleteMissing });
  const normalizedSummary = summary ?? {};
  const syncTarget = normalizedSummary.target ?? target ?? null;
  const sessionPath = join(naradaDir, 'crew', 'nars-sessions', session, 'session.jsonl');
  const result = {
    session,
    target: syncTarget,
    method,
    target_scheme: normalizedSummary.target_scheme ?? null,
    target_alias: normalizedSummary.target_alias ?? null,
    target_resolved_root: normalizedSummary.target_resolved_root ?? null,
    source_session_root: normalizedSummary.source_session_root ?? null,
    destination_session_root: normalizedSummary.destination_session_root ?? null,
    source_carrier_session_root: normalizedSummary.source_carrier_session_root ?? null,
    destination_carrier_session_root: normalizedSummary.destination_carrier_session_root ?? null,
    direction,
    dry_run: !!dryRun,
    delete_missing: !!deleteMissing,
    transport,
    status: normalizedSummary.status ?? null,
    message: normalizedSummary.message ?? null,
    success: exitCode === 0,
    copied: directionResult?.copied ?? normalizedSummary.copied ?? 0,
    skipped: directionResult?.skipped ?? normalizedSummary.skipped ?? 0,
    conflicts: directionResult?.conflicts ?? normalizedSummary.conflicts ?? 0,
    deleted: directionResult?.deleted ?? normalizedSummary.deleted ?? 0,
    carrier_copied: directionResult?.carrierCopied ?? normalizedSummary.carrierCopied ?? 0,
    carrier_skipped: directionResult?.carrierSkipped ?? normalizedSummary.carrierSkipped ?? 0,
    carrier_deleted: directionResult?.carrierDeleted ?? normalizedSummary.carrierDeleted ?? 0,
    requested_at: requested_at,
    completed_at: completed_at,
    duration_ms: duration_ms,
    operation_status,
    operation_id: operationId,
    request_id: requestId,
  };
  appendSession(sessionPath, sessionEventEntry(event, result));
}

async function handleServerRequestLine(line, context) {
  let request;
  try {
    request = JSON.parse(line);
  } catch (error) {
    noteSessionActivity(context.state, 'invalid_json');
    context.emit('error', {
      request_id: null,
      code: 'invalid_json',
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  await handleServerRequest(request, context);
}

async function handleServerRequest(request, { state, messages, allTools, mcpServers, mcpPreflightArtifact, emit, callChatApiFn }) {
  if (request?.method === 'session.operations') {
    const requestId = request?.id ?? null;
    const workflowStartedAt = new Date();
    const workflowStartedIso = workflowStartedAt.toISOString();
    const operationId = operatorWorkflowId({ requestId, method: 'session.operations' });
    noteSessionActivity(state, 'session_operations_requested');
    if (activeOperationHeartbeatDirectiveEmitter?.emitOnce) {
      await activeOperationHeartbeatDirectiveEmitter.emitOnce({ reason: 'session_operations_requested' })
        .catch((error) => recordCarrierDiagnostic('error', `session_operations directive emission failed: ${error instanceof Error ? error.message : String(error)}`));
      noteSessionActivity(state, 'session_operations_requested');
    }
    recordServerWorkflowRequest('session_operations_requested', { requestId, method: 'session.operations' });
    try {
      emit('session_operations', serverOperations({ requestId, state, mcpServers, mcpPreflightArtifact }));
      recordServerWorkflowLifecycleEvent('session_operations_completed', {
        requestId,
        method: 'session.operations',
        operation_status: 'succeeded',
        requested_at: workflowStartedIso,
        completed_at: new Date().toISOString(),
        duration_ms: new Date().getTime() - workflowStartedAt.getTime(),
        operation_id: operationId,
      });
    } catch (error) {
      recordServerWorkflowLifecycleEvent('session_operations_completed', {
        requestId,
        method: 'session.operations',
        operation_status: 'failed',
        requested_at: workflowStartedIso,
        completed_at: new Date().toISOString(),
        duration_ms: new Date().getTime() - workflowStartedAt.getTime(),
        error_code: error instanceof Error ? error.name : 'error',
        error_message: error instanceof Error ? error.message : String(error),
        operation_id: operationId,
      });
      throw error;
    }
    return;
  }
  if (request?.method === 'session.recovery') {
    const requestId = request?.id ?? null;
    const workflowStartedAt = new Date();
    const workflowStartedIso = workflowStartedAt.toISOString();
    const operationId = operatorWorkflowId({ requestId, method: 'session.recovery' });
    noteSessionActivity(state, 'session_recovery_requested');
    recordServerWorkflowRequest('session_recovery_requested', { requestId, method: 'session.recovery' });
    try {
      emit('session_recovery', serverRecovery({ requestId, state, mcpServers, mcpPreflightArtifact }));
      recordServerWorkflowLifecycleEvent('session_recovery_completed', {
        requestId,
        method: 'session.recovery',
        operation_status: 'succeeded',
        requested_at: workflowStartedIso,
        completed_at: new Date().toISOString(),
        duration_ms: new Date().getTime() - workflowStartedAt.getTime(),
        operation_id: operationId,
      });
    } catch (error) {
      recordServerWorkflowLifecycleEvent('session_recovery_completed', {
        requestId,
        method: 'session.recovery',
        operation_status: 'failed',
        requested_at: workflowStartedIso,
        completed_at: new Date().toISOString(),
        duration_ms: new Date().getTime() - workflowStartedAt.getTime(),
        error_code: error instanceof Error ? error.name : 'error',
        error_message: error instanceof Error ? error.message : String(error),
        operation_id: operationId,
      });
      throw error;
    }
    return;
  }
  if (request?.method === 'session.sync') {
    const requestId = request?.id ?? null;
    const params = request?.params ?? {};
    const direction = normalizeSessionSyncDirection(params.direction);
    const target = params.target ?? params.session_sync_target ?? params.sessionSyncTarget ?? null;
    const dryRun = params.dry_run ?? params.dryRun ?? false;
    const deleteMissing = params.delete ?? params.delete_missing ?? params.deleteMissing ?? false;
    const { summary, exitCode, directionResult = null } = buildSessionSyncSummary({
      target,
      direction,
      dryRun,
      deleteMissing,
    });
    if (!summary) {
      recordCarrierDiagnostic('error', 'session sync failed to build summary');
    }
    noteSessionActivity(state, 'session_sync_requested');
    recordServerWorkflowRequest('session_sync_requested', { requestId, method: 'session.sync' });
    const workflowStartedAt = new Date();
    const workflowStartedIso = workflowStartedAt.toISOString();
    recordSessionSyncWorkflow({
      event: 'session_sync_requested',
      requestId,
      session: SESSION,
      target,
      direction,
      dryRun,
      deleteMissing,
      summary,
      directionResult,
      exitCode,
      transport: 'jsonl_stdio',
      operation_status: 'requested',
      requested_at: workflowStartedIso,
      completed_at: null,
      duration_ms: null,
    });
    const workflowCompletedAt = new Date();
    const workflowCompletedIso = workflowCompletedAt.toISOString();
    const workflowDurationMs = workflowCompletedAt.getTime() - workflowStartedAt.getTime();
    recordSessionSyncWorkflow({
      event: 'session_sync_completed',
      requestId,
      session: SESSION,
      target,
      direction,
      dryRun,
      deleteMissing,
      summary,
      directionResult,
      exitCode,
      transport: 'jsonl_stdio',
      naradaDir: NARADA_DIR,
      operation_status: exitCode === 0 ? 'succeeded' : 'failed',
      requested_at: workflowStartedIso,
      completed_at: workflowCompletedIso,
      duration_ms: workflowDurationMs,
    });
    emit('session_sync', {
      request_id: requestId,
      transport: 'jsonl_stdio',
      event: 'session_sync',
      ...(summary ?? {}),
      ...serverSync({
        requestId,
        direction,
        target,
        dryRun,
        deleteMissing,
      }),
      success: exitCode === 0,
      copied: directionResult?.copied ?? summary?.copied ?? 0,
      skipped: directionResult?.skipped ?? summary?.skipped ?? 0,
      conflicts: directionResult?.conflicts ?? summary?.conflicts ?? 0,
      deleted: directionResult?.deleted ?? summary?.deleted ?? 0,
      message: summary?.message ?? 'session sync requested',
    });
    return;
  }
  if (request?.method === 'preflight.recovery') {
    const requestId = request?.id ?? null;
    const workflowStartedAt = new Date();
    const workflowStartedIso = workflowStartedAt.toISOString();
    const operationId = operatorWorkflowId({ requestId, method: 'preflight.recovery' });
    noteSessionActivity(state, 'preflight_recovery_requested');
    recordServerWorkflowRequest('preflight_recovery_requested', { requestId, method: 'preflight.recovery' });
    try {
      emit('preflight_recovery', serverPreflightRecovery({ requestId, mcpPreflightArtifact }));
      recordServerWorkflowLifecycleEvent('preflight_recovery_completed', {
        requestId,
        method: 'preflight.recovery',
        operation_status: 'succeeded',
        requested_at: workflowStartedIso,
        completed_at: new Date().toISOString(),
        duration_ms: new Date().getTime() - workflowStartedAt.getTime(),
        operation_id: operationId,
      });
    } catch (error) {
      recordServerWorkflowLifecycleEvent('preflight_recovery_completed', {
        requestId,
        method: 'preflight.recovery',
        operation_status: 'failed',
        requested_at: workflowStartedIso,
        completed_at: new Date().toISOString(),
        duration_ms: new Date().getTime() - workflowStartedAt.getTime(),
        error_code: error instanceof Error ? error.name : 'error',
        error_message: error instanceof Error ? error.message : String(error),
        operation_id: operationId,
      });
      throw error;
    }
    return;
  }
  const controlRequest = classifyCarrierControlRequest(request);
  const requestId = controlRequest.request_id;
  try {
    if (state.closed && !controlRequest.allowed_when_closed) {
      emit('error', {
        request_id: requestId,
        code: 'session_closed',
        message: 'Session is closed.',
      });
      return;
    }
    if (controlRequest.error) {
      emit('error', {
        request_id: requestId,
        code: controlRequest.error.code,
        message: controlRequest.error.message,
      });
      return;
    }
    if (controlRequest.method_kind === 'agent_cli_command') {
      const command = String(request?.params?.command ?? '').trim().toLowerCase();
      const value = String(request?.params?.value ?? '').trim();
      noteSessionActivity(state, 'carrier_command_requested');
      if (command === '/goal') {
        emit('carrier_command_result', serverGoalCommand({ requestId, value, state }));
        return;
      }
      if (command === '/stats') {
        emit('carrier_command_result', serverStatsCommand({ requestId, value }));
        return;
      }
      if (command === '/model') {
        emit('carrier_command_result', serverModelCommand({ requestId, value, state }));
        return;
      }
      if (command === '/thinking') {
        emit('carrier_command_result', serverThinkingCommand({ requestId, value, state }));
        return;
      }
      if (command === '/tool-output' || command === '/tool-outputs') {
        emit('carrier_command_result', serverToolOutputCommand({ requestId, value, state }));
        return;
      }
      if (command === '/tools' || command === '/tool') {
        emit('carrier_command_result', serverToolCatalog({ requestId, mcpServers, filter: value }));
        return;
      }
      if (command === '/queue') {
        emit('carrier_command_result', serverQueueCommand({ requestId, value, inputQueue: state.inputQueue }));
        return;
      }
      emit('carrier_command_result', serverCommandMessage({
        requestId,
        command: command || 'unknown',
        terminalState: 'unsupported',
        message: `Unsupported command: ${command || '<missing>'}`,
      }));
      return;
    }
    if (controlRequest.method_kind === 'session_status') {
      const operation_id = operatorWorkflowId({ requestId, method: request?.method ?? 'session.status' });
      const startedAt = new Date();
      const requestedAt = startedAt.toISOString();
      recordServerWorkflowLifecycleEvent('session_status_requested', {
        requestId,
        operation_id,
        method: request?.method ?? 'session.status',
        operation_status: 'requested',
        requested_at: requestedAt,
      });
      try {
        noteSessionActivity(state, 'session_status_requested');
        emit('session_status', serverStatus({ requestId, state, allTools, mcpServers }));
        const completedAt = new Date();
        recordServerWorkflowLifecycleEvent('session_status_completed', {
          requestId,
          operation_id,
          method: request?.method ?? 'session.status',
          operation_status: 'completed',
          requested_at: requestedAt,
          completed_at: completedAt.toISOString(),
          duration_ms: completedAt.getTime() - startedAt.getTime(),
        });
      } catch (error) {
        const completedAt = new Date();
        recordServerWorkflowLifecycleEvent('session_status_completed', {
          requestId,
          operationId,
          method: request?.method ?? 'session.status',
          operation_status: 'failed',
          requested_at: requestedAt,
          completed_at: completedAt.toISOString(),
          duration_ms: completedAt.getTime() - startedAt.getTime(),
          error_message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      return;
    }
    if (controlRequest.method_kind === 'session_health') {
      noteSessionActivity(state, 'session_health_requested');
      emit('session_health', serverHealth({ requestId, state, allTools, mcpServers, mcpPreflightArtifact }));
      return;
    }
    if (controlRequest.method_kind === 'session_events_subscribe') {
      noteSessionActivity(state, 'session_events_subscribe_requested');
      emit('session_events_subscription_started', serverEventsSubscription({ requestId, params: request.params ?? {} }));
      return;
    }
    if (controlRequest.method_kind === 'observers_status') {
      const operationId = operatorWorkflowId({ requestId, method: request?.method ?? 'observers.status' });
      const startedAt = new Date();
      const requestedAt = startedAt.toISOString();
      recordServerWorkflowLifecycleEvent('observer_status_requested', {
        requestId,
        operationId,
        method: request?.method ?? 'observers.status',
        operation_status: 'requested',
        requested_at: requestedAt,
      });
      try {
        emit('observer_status', observerServerStatus({ requestId, state }));
        const completedAt = new Date();
        recordServerWorkflowLifecycleEvent('observer_status_completed', {
          requestId,
          operationId,
          method: request?.method ?? 'observers.status',
          operation_status: 'completed',
          requested_at: requestedAt,
          completed_at: completedAt.toISOString(),
          duration_ms: completedAt.getTime() - startedAt.getTime(),
        });
      } catch (error) {
        const completedAt = new Date();
        recordServerWorkflowLifecycleEvent('observer_status_completed', {
          requestId,
          operationId,
          method: request?.method ?? 'observers.status',
          operation_status: 'failed',
          requested_at: requestedAt,
          completed_at: completedAt.toISOString(),
          duration_ms: completedAt.getTime() - startedAt.getTime(),
          error_message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      return;
    }
    if (controlRequest.method_kind === 'observer_set_muted') {
      const operationId = operatorWorkflowId({ requestId, method: request?.method ?? null });
      const startedAt = new Date();
      const requestedAt = startedAt.toISOString();
      const controlMethod = request?.method ?? null;
      recordServerWorkflowLifecycleEvent('observer_state_change_requested', {
        requestId,
        operationId,
        method: controlMethod,
        observer_action: controlRequest.observer_action ?? null,
        operation_status: 'requested',
        requested_at: requestedAt,
      });
      try {
        const result = handleObserverCommand(controlRequest.observer_action, state.displaySettings);
        emit('observer_status', {
          ...observerServerStatus({ requestId, state }),
          terminal_state: result.status,
          message: result.message,
        });
        const completedAt = new Date();
        recordServerWorkflowLifecycleEvent('observer_state_change_completed', {
          requestId,
          operationId,
          method: controlMethod,
          observer_action: controlRequest.observer_action ?? null,
          operation_status: 'completed',
          requested_at: requestedAt,
          completed_at: completedAt.toISOString(),
          duration_ms: completedAt.getTime() - startedAt.getTime(),
        });
      } catch (error) {
        const completedAt = new Date();
        recordServerWorkflowLifecycleEvent('observer_state_change_completed', {
          requestId,
          operationId,
          method: request?.method ?? null,
          observer_action: controlRequest.observer_action ?? null,
          operation_status: 'failed',
          requested_at: requestedAt,
          completed_at: completedAt.toISOString(),
          duration_ms: completedAt.getTime() - startedAt.getTime(),
          error_message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      return;
    }
    if (controlRequest.method_kind === 'conversation_interrupt') {
      const operationId = operatorWorkflowId({ requestId, method: request?.method ?? 'conversation.interrupt' });
      const startedAt = new Date();
      const requestedAt = startedAt.toISOString();
      recordServerWorkflowLifecycleEvent('conversation_interrupt_requested', {
        requestId,
        operationId,
        method: request?.method ?? 'conversation.interrupt',
        operation_status: 'requested',
        requested_at: requestedAt,
      });
      try {
        if (state.activeTurn) {
          requestTurnInterrupt(state.activeTurn);
          emit('turn_interrupted', {
            request_id: requestId,
            turn_id: state.activeTurn.turnId,
            terminal_state: 'interrupted_requested',
          });
        } else {
          emit('session_status', serverStatus({ requestId, state, allTools, mcpServers }));
        }
        const completedAt = new Date();
        recordServerWorkflowLifecycleEvent('conversation_interrupt_completed', {
          requestId,
          operationId,
          method: request?.method ?? 'conversation.interrupt',
          operation_status: 'completed',
          requested_at: requestedAt,
          completed_at: completedAt.toISOString(),
          duration_ms: completedAt.getTime() - startedAt.getTime(),
        });
      } catch (error) {
        const completedAt = new Date();
        recordServerWorkflowLifecycleEvent('conversation_interrupt_completed', {
          requestId,
          operationId,
          method: request?.method ?? 'conversation.interrupt',
          operation_status: 'failed',
          requested_at: requestedAt,
          completed_at: completedAt.toISOString(),
          duration_ms: completedAt.getTime() - startedAt.getTime(),
          error_message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      return;
    }
    if (controlRequest.method_kind === 'session_close') {
      const operationId = operatorWorkflowId({ requestId, method: request?.method ?? 'session.close' });
      const startedAt = new Date();
      const requestedAt = startedAt.toISOString();
      recordServerWorkflowLifecycleEvent('session_close_requested', {
        requestId,
        operationId,
        method: request?.method ?? 'session.close',
        operation_status: 'requested',
        requested_at: requestedAt,
      });
      try {
        const closedAt = new Date().toISOString();
        state.closed = true;
        if (state.activeTurn) requestTurnInterrupt(state.activeTurn);
        noteSessionActivity(state, 'session_closed', closedAt, 'closed');
        emit('session_closed', {
          ...serverStatus({ requestId, state, allTools, mcpServers, mcpPreflightArtifact }),
          terminal_state: 'closed',
        });
        const completedAt = new Date();
        recordServerWorkflowLifecycleEvent('session_close_completed', {
          requestId,
          operationId,
          method: request?.method ?? 'session.close',
          operation_status: 'completed',
          requested_at: requestedAt,
          completed_at: completedAt.toISOString(),
          duration_ms: completedAt.getTime() - startedAt.getTime(),
        });
      } catch (error) {
        const completedAt = new Date();
        recordServerWorkflowLifecycleEvent('session_close_completed', {
          requestId,
          operationId,
          method: request?.method ?? 'session.close',
          operation_status: 'failed',
          requested_at: requestedAt,
          completed_at: completedAt.toISOString(),
          duration_ms: completedAt.getTime() - startedAt.getTime(),
          error_message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      return;
    }
    if (controlRequest.method_kind === 'carrier_input_deliver') {
      const input = normalizeServerControlInputRequest(request, requestId);
      await state.inputQueue.enqueue(input, { drain: true });
      return;
    }
    if (controlRequest.method_kind === 'system_directive_deliver') {
      const directive = request?.params?.directive ?? null;
      const message = String(request?.params?.message ?? directive?.content?.text ?? '');
      const directiveId = directive?.directive_id ?? request?.params?.directive_id ?? null;
      const directiveKind = directive?.kind ?? directive?.content?.kind ?? request?.params?.directive_kind ?? request?.params?.kind ?? null;
      const directiveVisibility = request?.params?.visibility ?? directive?.visibility ?? directive?.content?.visibility ?? null;
      const allowEmptyRecordOnlyDirective = directiveKind === 'operation_heartbeat' && directiveVisibility === 'record_only';
      if (!message.trim() && !allowEmptyRecordOnlyDirective) {
        emit('error', {
          request_id: requestId,
          directive_id: directiveId,
          code: 'directive_message_required',
          message: 'system_directive.deliver requires params.message or params.directive.content.text',
        });
        return;
      }
      await state.inputQueue.enqueue(normalizeInputEvent({
        content: message,
        source: 'system_directive',
        authority_ref: request?.params?.authority_ref ?? directiveId,
        directive_id: directiveId,
        request_id: requestId,
        metadata: {
          directive_provenance: { kind: 'system_directive' },
          directive: {
            ...(directiveKind ? { kind: directiveKind } : {}),
            ...(directiveVisibility ? { visibility: directiveVisibility } : {}),
            ...(request?.params?.cadence ?? directive?.cadence ?? directive?.content?.cadence ? { cadence: request?.params?.cadence ?? directive?.cadence ?? directive?.content?.cadence } : {}),
            ...(request?.params?.operation_id ?? directive?.operation_id ?? directive?.content?.operation_id ? { operation_id: request?.params?.operation_id ?? directive?.operation_id ?? directive?.content?.operation_id } : {}),
            ...(request?.params?.reason ?? directive?.reason ?? directive?.content?.reason ? { reason: request?.params?.reason ?? directive?.reason ?? directive?.content?.reason } : {}),
          },
        },
      }, { transport: 'jsonl_stdio' }), { drain: true, state });
      return;
    }
    const message = String(request?.params?.message ?? '');
    if (!message.trim()) {
      emit('error', {
        request_id: requestId,
        code: 'message_required',
        message: 'conversation.send requires params.message',
      });
      return;
    }
    await state.inputQueue.enqueue(normalizeInputEvent({
      content: message,
      source: request?.params?.source ?? 'automation_jsonl',
      source_id: request?.params?.source_id ?? null,
      authority_ref: request?.params?.authority_ref ?? null,
      request_id: requestId,
    }, { transport: 'jsonl_stdio' }), { drain: true, state });
  } catch (error) {
    emit('error', {
      request_id: requestId,
      code: 'request_failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function normalizeServerControlInputRequest(request, requestId = null) {
  const controlRequest = request?.schema === 'narada.carrier.control.input_event.v1'
    ? request
    : request?.params?.input;
  if (!controlRequest) throw new Error('carrier.input.deliver requires params.input');
  const controlRecord = normalizeAgentCliControlRecord(controlRequest);
  return {
    ...controlRecord.input,
    request_id: requestId ?? controlRecord.input.request_id ?? null,
  };
}

async function runServerInputEvent({ requestId, state, messages, allTools, mcpServers, emit, callChatApiFn, input, directiveId = null }) {
  const record = normalizeInputRecord(input);
  const runtimeAdmission = classifyInputRuntimeAdmission(input, state.displaySettings);
  if (isObserverInputEvent(input, record) && runtimeAdmission.complete_without_provider) {
    const result = await submitUserInput({
      input,
      messages,
      tools: allTools,
      mcpServers,
      rl: null,
      emit,
      callChatApiFn,
      displaySettings: state.displaySettings,
      carrierSessionSettings: state.sessionSettings,
    });
    emitVisibleObserverInput({ requestId, input, emit, admission: runtimeAdmission });
    noteSessionActivity(state, 'observer_input_complete', new Date().toISOString(), result?.terminal_state ?? 'completed_without_provider');
    emit('observer_input_complete', {
      request_id: requestId,
      input_event_id: input.event_id,
      visibility: runtimeAdmission.visibility,
      terminal_state: result?.terminal_state ?? 'completed_without_provider',
    });
    return result;
  }
  if (runtimeAdmission.is_directive && runtimeAdmission.complete_without_provider) {
    if (directiveId) {
      emit('directive_received', {
        request_id: requestId,
        directive_id: directiveId,
        terminal_state: 'accepted',
        source: 'system_directive',
      });
      emit('directive_receipt_recorded', {
        request_id: requestId,
        ...directiveReceiptEvidence(input, {
          agentId: IDENTITY,
          carrierSessionId: SESSION,
        }),
      });
      emit('directive_carrier_accepted_recorded', {
        request_id: requestId,
        ...directiveAcceptedEvidence(input, {
          agentId: IDENTITY,
          carrierSessionId: SESSION,
        }),
      });
    }
    noteSessionActivity(state, 'directive_complete', new Date().toISOString(), 'completed_without_provider');
    emit('directive_complete', {
      request_id: requestId,
      input_event_id: input.event_id,
      terminal_state: 'completed_without_provider',
      ...(directiveId ? { directive_id: directiveId, source: 'system_directive' } : {}),
    });
    return { terminal_state: 'completed_without_provider' };
  }
  return runServerConversationTurn({
    requestId,
    state,
    messages,
    allTools,
    mcpServers,
    emit,
    callChatApiFn,
    input,
    directiveId,
  });
}

function emitVisibleObserverInput({ requestId, input, emit, admission = classifyInputRuntimeAdmission(input) }) {
  if (!admission.visible_to_operator) return;
  const metadata = observerMetadata(input);
  emit('observer_interjection_visible', {
    request_id: requestId,
    input_event_id: input.event_id,
    observer_id: input.source_id ?? 'narada.observer',
    rule_id: metadata.rule_id ?? 'observer',
    visibility: admission.visibility,
    content: String(input.content ?? ''),
  });
}

async function runServerConversationTurn({ requestId, state, messages, allTools, mcpServers, emit, callChatApiFn, input, directiveId = null }) {
  const turnId = `turn_${randomId()}`;
  const turn = { turnId, requestId, interruptRequested: false };
  attachTurnAbortController(turn);
  state.activeTurn = turn;
  if (directiveId) {
    emit('directive_received', {
      request_id: requestId,
      turn_id: turnId,
      directive_id: directiveId,
      terminal_state: 'accepted',
      source: 'system_directive',
    });
    emit('directive_receipt_recorded', {
      request_id: requestId,
      turn_id: turnId,
      ...directiveReceiptEvidence(input, {
        agentId: IDENTITY,
        carrierSessionId: SESSION,
      }),
    });
    emit('directive_carrier_accepted_recorded', {
      request_id: requestId,
      turn_id: turnId,
      ...directiveAcceptedEvidence(input, {
        agentId: IDENTITY,
        carrierSessionId: SESSION,
      }),
    });
  }
  emit('turn_started', {
    request_id: requestId,
    turn_id: turnId,
    terminal_state: 'accepted',
    ...(directiveId ? { directive_id: directiveId, source: 'system_directive' } : {}),
  });
  try {
    const result = await submitUserInput({
      input,
      messages,
      tools: allTools,
      mcpServers,
      rl: null,
      turn,
      emit,
      callChatApiFn,
      displaySettings: state.displaySettings,
      carrierSessionSettings: state.sessionSettings,
    });
    const terminalState = turn.interruptRequested ? 'interrupted' : (result?.terminal_state ?? 'completed');
    if (terminalState === 'failed') {
      emit('turn_failed', {
        request_id: requestId,
        turn_id: turnId,
        ...(directiveId ? { directive_id: directiveId } : {}),
        terminal_state: 'failed',
        reason: result?.reason ?? 'conversation_turn_failed',
      });
    } else {
      emit('turn_complete', {
        request_id: requestId,
        turn_id: turnId,
        ...(directiveId ? { directive_id: directiveId } : {}),
        terminal_state: terminalState,
      });
    }
  } catch (error) {
    emit('turn_failed', {
      request_id: requestId,
      turn_id: turnId,
      ...(directiveId ? { directive_id: directiveId } : {}),
      terminal_state: 'failed',
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (state.activeTurn === turn) state.activeTurn = null;
  }
}

function serverStatus({ requestId, state, allTools, mcpServers, mcpPreflightArtifact = readMcpPreflightArtifact() }) {
  const carrierSessionSettings = state?.sessionSettings ?? sessionSettings;
  const goal = normalizeCarrierGoalState(carrierSessionSettings.goal);
  const mcpStatus = createMcpStatusSnapshot(mcpServers);
  const mcpPreflightSnapshot = createMcpPreflightArtifactSnapshot(mcpPreflightArtifact);
  const sessionActivity = createSessionActivitySnapshot(state);
  const operationalPosture = createOperationalPostureSnapshot({
    state,
    mcpOperationalState: mcpStatus.mcp_operational_state,
  });
  return {
    request_id: requestId,
    transport: 'jsonl_stdio',
    provider: INTELLIGENCE_PROVIDER,
    model: carrierSessionSettings.model,
    thinking: carrierSessionSettings.thinking,
    stream: carrierSessionSettings.stream,
    goal: goal.value || null,
    goal_status: goal.status,
    goal_display: carrierGoalStatusLabel(goal),
    active_turn_state: state.activeTurn ? 'running' : 'idle',
    active_turn_id: state.activeTurn?.turnId ?? null,
    mcp_server_count: Object.keys(mcpServers).length,
    ...mcpStatus,
    ...mcpPreflightSnapshot,
    ...sessionActivity,
    ...operationalPosture,
    tool_count: allTools.length,
    mcp_servers: mcpServerSummaryEntries(mcpServers),
    mcp_tools: mcpToolCatalogEntries(mcpServers),
    observer_muted: (state?.displaySettings ?? transcriptDisplaySettings).observerMuted === true,
    observer_visibilities: OBSERVER_VISIBILITIES,
    health_endpoint: process.env.NARADA_HEALTH_URL ?? null,
    event_endpoint: process.env.NARADA_EVENT_STREAM_URL ?? null,
    websocket_endpoint: process.env.NARADA_EVENT_STREAM_URL ?? null,
    delegated_authority_handoff: NARS_DELEGATED_AUTHORITY_HANDOFF,
    delegated_authority_ref: NARS_DELEGATED_AUTHORITY_HANDOFF?.authority_ref ?? null,
    session_path: SESSION_PATH,
    events_path: EVENTS_PATH,
  };
}

function observerServerStatus({ requestId, state }) {
  return {
    request_id: requestId,
    observer_muted: (state?.displaySettings ?? transcriptDisplaySettings).observerMuted === true,
    observer_visibilities: OBSERVER_VISIBILITIES,
  };
}

function emitServerEvent(output, event) {
  SERVER_EVENT_SEQUENCE += 1;
  const sequencedEvent = {
    event_sequence: SERVER_EVENT_SEQUENCE,
    sequence: SERVER_EVENT_SEQUENCE,
    ...event,
  };
  const line = `${JSON.stringify(sequencedEvent)}\n`;
  appendJsonlRecord(EVENTS_PATH, sequencedEvent);
  output.write(line);
}

function closeMcpServers(mcpServers) {
  for (const server of Object.values(mcpServers)) {
    if (server.process && !server.process.killed) server.process.kill();
  }
}

// ---------------------------------------------------------------------------
// Chat API
// ---------------------------------------------------------------------------
async function callChatApi(messages, tools, settings = sessionSettings) {
  const adapterResolution = resolveProviderAdapter(INTELLIGENCE_PROVIDER);
  assertApiKeyConfigured(INTELLIGENCE_PROVIDER, API_KEY);
  if (adapterResolution.adapter_id === 'codex-mcp-server') {
    const request = adapterResolution.adapter.buildRequest(messages, tools, settings);
    const response = CODEX_SUBSCRIPTION_TRANSPORT === 'mcp-server'
      ? await sendCodexMcpRequest(request, settings)
      : settings.stream === false
        ? await sendCodexExecJsonBufferedRequest(request, settings)
        : await sendCodexExecJsonRequest(request, settings);
    return adapterResolution.adapter.parseResponse(response);
  }
  const response = await sendProviderRequest(adapterResolution.adapter.buildRequest(messages, tools, settings), settings);
  return adapterResolution.adapter.parseResponse(response);
}

function resolveProviderAdapter(provider, metadata = PROVIDER_METADATA, adapters = REQUEST_ADAPTERS) {
  const providerMetadata = metadata[provider];
  if (!providerMetadata) {
    throw new Error(`Unsupported intelligence provider: ${provider}`);
  }
  const support = resolveProviderSupportState(provider, providerMetadata, adapters);
  if (!support.ready) {
    throw new Error(`Unsupported intelligence provider adapter for ${provider}: ${support.state}. ${support.required_next_step}`);
  }
  const adapter = adapters[providerMetadata.adapter_kind];
  if (!adapter) {
    throw new Error(`Request adapter not implemented for ${provider}: ${providerMetadata.adapter_kind}. support_state=${support.state}. ${support.required_next_step}`);
  }
  return {
    provider_id: provider,
    adapter_id: providerMetadata.adapter_kind,
    support_state: support.state,
    support_status: support.state,
    adapter,
  };
}

function resolveProviderSupportState(provider, providerMetadata, adapters = REQUEST_ADAPTERS) {
  const state = normalizeProviderSupportState(providerMetadata.support_state ?? providerMetadata.support_status);
  const adapterExists = !!adapters[providerMetadata.adapter_kind];
  const required_next_step = requiredNextProviderSupportStep(state, providerMetadata.adapter_kind, adapterExists);
  return {
    provider_id: provider,
    state,
    adapter_kind: providerMetadata.adapter_kind,
    adapter_exists: adapterExists,
    ready: state === PROVIDER_SUPPORT_STATES.VERIFIED_SUPPORTED || state === PROVIDER_SUPPORT_STATES.DEPRECATED,
    required_next_step,
  };
}

function normalizeProviderSupportState(value) {
  if (value === 'supported') return PROVIDER_SUPPORT_STATES.VERIFIED_SUPPORTED;
  if (value === 'unsupported_until_adapter_exists') return PROVIDER_SUPPORT_STATES.ADMITTED_UNSUPPORTED;
  if (value === 'unsupported_until_reviewed') return PROVIDER_SUPPORT_STATES.ADAPTER_IMPLEMENTED;
  return value ?? PROVIDER_SUPPORT_STATES.DECLARED;
}

function requiredNextProviderSupportStep(state, adapterKind, adapterExists) {
  if (state === PROVIDER_SUPPORT_STATES.DECLARED) return 'Admit provider policy and choose a request adapter before launch.';
  if (state === PROVIDER_SUPPORT_STATES.ADMITTED_UNSUPPORTED) return `Implement request adapter ${adapterKind} and move the provider to adapter_implemented.`;
  if (state === PROVIDER_SUPPORT_STATES.ADAPTER_IMPLEMENTED) return 'Verify launcher, docs, credential mapping, and runtime tests before marking verified_supported.';
  if (state === PROVIDER_SUPPORT_STATES.REMOVED) return 'Use an admitted replacement provider or restore the provider through a new contract revision.';
  if (state === PROVIDER_SUPPORT_STATES.DEPRECATED) return 'Provider remains launchable for compatibility; migrate to a non-deprecated provider.';
  if (!adapterExists) return `Implement request adapter ${adapterKind} before launching this provider.`;
  return 'Provider is verified for launch.';
}

function assertApiKeyConfigured(provider, apiKey) {
  if (provider === 'codex-subscription') return;
  if (apiKey) return;
  const credentialEnvNames = PROVIDER_METADATA[provider]?.credential_env_names ?? [];
  const credentialHint = credentialEnvNames.length > 0 ? credentialEnvNames.join(' or ') : 'the provider-specific API key environment variable';
  throw new Error(`Missing API key for ${provider}. Set ${credentialHint}.`);
}

function normalizeThinkingLevel(value) {
  const normalized = String(value ?? 'medium').trim().toLowerCase();
  if (['none', 'low', 'medium', 'high', 'xhigh'].includes(normalized)) return normalized;
  return 'medium';
}

function sendProviderRequest({ url, body, headers }, settings = {}) {
  const serializedBody = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    if (settings.abortSignal?.aborted) {
      reject(new Error('agent_cli_interrupt_requested'));
      return;
    }
    const isHttps = url.protocol === 'https:';
    const req = (isHttps ? httpsRequest : httpRequest)(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          ...headers,
          'Content-Length': Buffer.byteLength(serializedBody),
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode < 200 || res.statusCode >= 300) {
              reject(new Error(`API error ${res.statusCode}: ${JSON.stringify(parsed).slice(0, 1000)}`));
              return;
            }
            if (parsed?.error) {
              reject(new Error(`API error: ${JSON.stringify(parsed.error).slice(0, 1000)}`));
              return;
            }
            resolve(parsed);
          } catch {
            reject(new Error(`Invalid JSON from API: ${data.slice(0, 200)}`));
          }
        });
        res.on('error', (error) => {
          reject(isAbortError(error) ? new Error('agent_cli_interrupt_requested') : error);
        });
      }
    );
    req.on('error', (error) => {
      reject(isAbortError(error) ? new Error('agent_cli_interrupt_requested') : error);
    });
    settings.abortSignal?.addEventListener('abort', () => {
      req.destroy(new Error('agent_cli_interrupt_requested'));
    }, { once: true });
    req.write(serializedBody);
    req.end();
  });
}

function sendCodexExecJsonRequest(request, settings = {}) {
  return new Promise((resolveRequest, rejectRequest) => {
    const command = codexCommand();
    const args = buildCodexExecArgs(request, settings);
    const prompt = codexExecPrompt(request);
    const mcpServers = codexRequestMcpServers(request, settings);
    const child = spawn(command.command, [...command.prefixArgs, ...args], {
      cwd: request.arguments?.cwd ?? settings.siteRoot ?? SITE_ROOT,
      windowsHide: true,
      env: buildCodexSubprocessEnv(mcpServers, settings),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end(prompt);
    let stdoutBuffer = '';
    let stderr = '';
    let threadId = request.arguments?.threadId ?? null;
    let content = '';
    let streamed = false;
    let aborted = false;
    const nativeMcpEventState = { startedAtById: new Map() };
    const emitText = (text) => {
      if (!text) return;
      const appendText = content && text.startsWith(content) ? text.slice(content.length) : text;
      if (!appendText) return;
      content += appendText;
      if (isPotentialNaradaToolCallText(content) || parseNaradaToolCall(content)) return;
      if (settings.emit) {
        streamed = true;
        settings.emit('assistant_message_stream', { turn_id: settings.turn?.turnId ?? null, content: appendText });
      } else {
        process.stdout.write('\r\x1b[K');
        streamed = printAgentMessage(appendText) || streamed;
      }
    };
    const abortChild = () => {
      aborted = true;
      terminateChildProcessTree(child);
    };
    if (settings.abortSignal?.aborted) abortChild();
    settings.abortSignal?.addEventListener('abort', abortChild, { once: true });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = parseCodexExecJsonLine(line);
        if (!event) continue;
        settings.emit?.('provider_event', { provider: 'codex-subscription', event });
        handleCodexExecMcpToolEvent(event, settings, nativeMcpEventState);
        if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
          threadId = event.thread_id;
        }
        const text = codexExecEventText(event);
        emitText(text);
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', rejectRequest);
    child.on('exit', (code) => {
      settings.abortSignal?.removeEventListener?.('abort', abortChild);
      if (aborted || settings.abortSignal?.aborted) {
        rejectRequest(new Error('agent_cli_interrupt_requested'));
        return;
      }
      if (stdoutBuffer.trim()) {
        const event = parseCodexExecJsonLine(stdoutBuffer.trim());
        const text = event ? codexExecEventText(event) : '';
        emitText(text);
      }
      if (code !== 0) {
        rejectRequest(new Error(`codex exec --json failed with exit ${code}${stderr.trim() ? `; ${stderr.trim().slice(0, 1000)}` : ''}`));
        return;
      }
      resolveRequest({
        threadId,
        content,
        streaming_rendered: streamed,
      });
    });
  });
}

function sendCodexExecJsonBufferedRequest(request, settings = {}) {
  return new Promise((resolveRequest, rejectRequest) => {
    const command = codexCommand();
    const args = buildCodexExecArgs(request, settings);
    const prompt = codexExecPrompt(request);
    const mcpServers = codexRequestMcpServers(request, settings);
    const child = spawn(command.command, [...command.prefixArgs, ...args], {
      cwd: request.arguments?.cwd ?? settings.siteRoot ?? SITE_ROOT,
      windowsHide: true,
      env: buildCodexSubprocessEnv(mcpServers, settings),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end(prompt);
    let stdoutBuffer = '';
    let stderr = '';
    let threadId = request.arguments?.threadId ?? null;
    let content = '';
    let aborted = false;
    const nativeMcpEventState = { startedAtById: new Map() };
    const abortChild = () => {
      aborted = true;
      terminateChildProcessTree(child);
    };
    if (settings.abortSignal?.aborted) abortChild();
    settings.abortSignal?.addEventListener('abort', abortChild, { once: true });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdoutBuffer += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', rejectRequest);
    child.on('exit', (code) => {
      settings.abortSignal?.removeEventListener?.('abort', abortChild);
      if (aborted || settings.abortSignal?.aborted) {
        rejectRequest(new Error('agent_cli_interrupt_requested'));
        return;
      }
      for (const line of stdoutBuffer.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const event = parseCodexExecJsonLine(line);
        if (!event) continue;
        handleCodexExecMcpToolEvent(event, settings, nativeMcpEventState);
        if (event.type === 'thread.started' && typeof event.thread_id === 'string') threadId = event.thread_id;
        content += codexExecEventText(event);
      }
      if (code !== 0) {
        rejectRequest(new Error(`codex exec --json failed with exit ${code}${stderr.trim() ? `; ${stderr.trim().slice(0, 1000)}` : ''}`));
        return;
      }
      resolveRequest({ threadId, content, streaming_rendered: false });
    });
  });
}

function handleCodexExecMcpToolEvent(event, settings = {}, state = {}) {
  const summary = codexExecMcpToolEventSummary(event);
  if (!summary) return false;
  const turnId = settings.turn?.turnId ?? null;
  if (event.type === 'item.started') {
    state.startedAtById?.set?.(summary.id, Date.now());
    const argSummary = argumentSummary(summary.arguments);
    appendSession(SESSION_PATH, carrierSessionEventEntry('tool_call_requested', createToolCallPayload({
      tool_name: summary.name,
      arguments_summary: stringifySummary(argSummary),
      requesting_agent_id: IDENTITY,
    })));
    settings.emit?.('tool_call', {
      turn_id: turnId,
      tool: summary.name,
      server: summary.server,
      arguments: summary.arguments,
      decision: 'delegated_to_nested_codex',
      carrier_mutation_admitted: false,
      native_mcp_tool_call: true,
    });
    if (!settings.emit && shouldDisplayToolOutputs()) {
      printToolRequestLine(`${summary.name}(${JSON.stringify(summary.arguments).slice(0, 200)})`, { before: true });
    }
    return true;
  }
  if (event.type === 'item.completed') {
    const startedAt = state.startedAtById?.get?.(summary.id) ?? Date.now();
    state.startedAtById?.delete?.(summary.id);
    const durationMs = Math.max(0, Date.now() - startedAt);
    const legacyStatus = summary.error ? 'failed' : 'completed';
    const status = summary.error ? 'failed' : 'ok';
    const resultSummary = summary.error?.message ?? summary.result ?? '';
    appendSession(SESSION_PATH, carrierSessionEventEntry('tool_result_received', createToolResultPayload({
      tool_name: summary.name,
      status,
      duration_ms: durationMs,
      result_summary: summarizeToolResult(resultSummary),
    })));
    settings.emit?.('tool_result', {
      turn_id: turnId,
      tool: summary.name,
      server: summary.server,
      status: legacyStatus,
      duration_ms: durationMs,
      result: summary.result,
      error: summary.error,
      native_mcp_tool_call: true,
    });
    if (!settings.emit && shouldDisplayToolOutputs()) {
      if (summary.error) {
        printToolResultLine(`failed ${summary.name} in ${formatDuration(durationMs)} · ${summary.error.message ?? 'native MCP tool failed'}`, { level: 'error' });
      } else {
        printToolResultLine(`ok ${summary.name} in ${formatDuration(durationMs)} · ${formatToolResultContent(summary.result ?? '')}`);
      }
    }
    return true;
  }
  return false;
}

function codexCommand() {
  if (process.env.NARADA_CODEX_EXEC_COMMAND) {
    const prefixArgs = process.env.NARADA_CODEX_EXEC_PREFIX_ARGS
      ? JSON.parse(process.env.NARADA_CODEX_EXEC_PREFIX_ARGS)
      : [];
    return { command: process.env.NARADA_CODEX_EXEC_COMMAND, prefixArgs };
  }
  if (process.platform !== 'win32') return { command: 'codex', prefixArgs: [] };
  const found = findOnPath(['codex.ps1', 'codex.cmd', 'codex.exe']);
  if (found?.endsWith('.ps1')) return { command: 'pwsh', prefixArgs: ['-NoProfile', '-File', found] };
  if (found) return { command: found, prefixArgs: [] };
  return { command: 'pwsh', prefixArgs: ['-NoProfile', '-Command', 'codex'] };
}

function findOnPath(names) {
  const dirs = String(process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function sendCodexMcpRequest(request, settings = {}) {
  return new Promise((resolve, reject) => {
    const command = codexCommand();
    const mcpServers = codexRequestMcpServers(request, settings);
    const args = buildCodexMcpServerArgs();
    const child = spawn(command.command, [...command.prefixArgs, ...args], {
      cwd: SITE_ROOT,
      windowsHide: true,
      env: buildCodexSubprocessEnv(mcpServers, settings),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '';
    let stderr = '';
    const pending = new Map();
    let aborted = false;
    const abortChild = () => {
      aborted = true;
      for (const pendingRequest of pending.values()) {
        pendingRequest.reject(new Error('agent_cli_interrupt_requested'));
      }
      pending.clear();
      terminateChildProcessTree(child);
    };
    if (settings.abortSignal?.aborted) abortChild();
    settings.abortSignal?.addEventListener('abort', abortChild, { once: true });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id != null && pending.has(msg.id)) {
            pending.get(msg.id).resolve(msg);
            pending.delete(msg.id);
          }
        } catch {
          // Codex may emit non-JSON diagnostics; keep stderr for hard failures.
        }
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);

    const send = (payload, timeoutMs = 120000) => new Promise((resolveRequest, rejectRequest) => {
      if (aborted || settings.abortSignal?.aborted) {
        rejectRequest(new Error('agent_cli_interrupt_requested'));
        return;
      }
      pending.set(payload.id, { resolve: resolveRequest, reject: rejectRequest });
      child.stdin.write(`${JSON.stringify(payload)}\n`);
      setTimeout(() => {
        if (pending.has(payload.id)) {
          pending.delete(payload.id);
          rejectRequest(new Error(`Codex MCP request timeout after ${timeoutMs}ms`));
        }
      }, timeoutMs).unref?.();
    });

    (async () => {
      const initialize = await send({
        jsonrpc: '2.0',
        id: randomId(),
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'narada-agent-cli', version: '0' },
        },
      }, 10000);
      if (initialize.error) throw new Error(initialize.error.message);

      const toolCall = await send({
        jsonrpc: '2.0',
        id: randomId(),
        method: 'tools/call',
        params: {
          name: request.tool,
          arguments: request.arguments,
        },
      }, 120000);
      if (toolCall.error) throw new Error(toolCall.error.message);

      const text = toolCall.result?.content?.[0]?.text ?? JSON.stringify(toolCall.result ?? {});
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve({ threadId: null, content: text });
      }
    })().catch((error) => {
      reject(new Error(`${error.message}${stderr.trim() ? `; ${stderr.trim().slice(0, 1000)}` : ''}`));
    }).finally(() => {
      settings.abortSignal?.removeEventListener?.('abort', abortChild);
      child.stdin.end();
      terminateChildProcessTree(child);
    });
  });
}

function stringifyContent(value) {
  return typeof value === 'string' ? value : JSON.stringify(value ?? '');
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function hashStable(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const record = value;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

function formatCompactJsonSchema(schema, { limit = 1200 } = {}) {
  const normalized = schema && typeof schema === 'object' && !Array.isArray(schema)
    ? schema
    : { type: 'object', properties: {} };
  const text = stableStringify(normalized);
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 3))}...` : text;
}
// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function randomId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function readDirFiles(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------
const isEntrypoint = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

export {
  runSessionEventsRead,
  runSessionOperationsRead,
  runSessionSync,
  runSessionRecovery,
  runSessionRead,
  runSessionInventory,
  runSessionInventoryActions,
  runSessionInventoryRecovery,
  readPersistedSessionEvents,
  filterPersistedSessionEvents,
  filterSessionInventory,
  summarizeSessionInventoryGroups,
  readPersistedSession,
  readSessionInventory,
  sessionEventEntry,
  sessionLogEntry,
} from './session-persistence.mjs';

export {
  PROVIDER_SUPPORT_STATES,
  REQUEST_ADAPTERS,
  assertApiKeyConfigured,
  buildAnthropicMessagesRequest,
  buildCodexExecArgs,
  buildCodexMcpServerArgs,
  buildCodexSubprocessEnv,
  codexExecMcpConfigArgs,
  codexExecConfigToml,
  codexRequestMcpServers,
  buildCodexMcpRequest,
  buildOpenAiChatRequest,
  buildChildProcessEnv,
  clearTerminalDisplay,
  cleanAnthropicMessages,
  cleanOpenAiMessages,
  codexExecMcpToolEventSummary,
  consumeOperatorDirectiveInputText,
  createRuntimeHeaderRows,
  createMcpPreflightArtifactSnapshot,
  createMcpPreflightDiagnosticEntry,
  createMcpPreflightPayload,
  createMcpPreflightWorkflowSnapshot,
  createSessionActivitySnapshot,
  executeMcpTool,
  aggregateTools,
  aggregateToolBindings,
  providerSafeToolName,
  providerToolNameForOriginal,
  originalToolNameForProvider,
  codexExecEventText,
  discoverAndStartMcpServers,
  environmentBlockLength,
  classifyCarrierHostCommandInput,
  executeCarrierHostCommand,
  readCarrierHostCommandOutputRef,
  readMcpPreflightArtifact,
  handleControlLine,
  handleSlashCommand,
  messagesWithCarrierGoal,
  mcpToolEffectAdmissionEvidence,
  runCodexTranscriptStats,
  createInputQueue,
  normalizeInputEvent,
  normalizeProviderSupportState,
  normalizeThinkingLevel,
  normalizeCarrierGoal,
  normalizeInputRecord,
  shouldDeferQueuedInput,
  startControlJsonlWatcher,
  startTurnProgress,
  parseArgs,
  parseBooleanEnv,
  parseColorEnv,
  removeInvalidToolHistory,
  shouldSuppressMcpStderr,
  parseAnthropicMessagesResponse,
  parseCodexExecJsonLine,
  parseCodexMcpResponse,
  parseNarsDelegatedAuthorityHandoff,
  parseNaradaToolCall,
  isPotentialNaradaToolCallText,
  createTerminalStyle,
  formatDuration,
  formatHeaderRow,
  formatHeaderRows,
  formatKeyValueRows,
  createMcpStatusSnapshot,
  formatProgressStatus,
  sanitizeOperatorDirectiveDraftForDisplay,
  formatTimestamp,
  formatToolResultContent,
  formatObserverPosture,
  handleGoalCommand,
  handleObserverCommand,
  handleToolOutputDisplayCommand,
  isObserverInputEvent,
  observerVisibility,
  shouldDisplayToolOutputs,
  normalizeDisplayTerms,
  createCarrierDirectiveEmitter,
  createOperationHeartbeatDirectiveEmitter,
  printAgentMessage,
  printHostCommandResult,
  printCliMessage,
  copyToClipboard,
  printInputRecord,
  printOperatorMessage,
  printInlineEvent,
  rewriteSubmittedPromptForTest,
  toolDirectionLabel,
  inputRecordDisplayLabel,
  isAgentCliUtilityCommandMode,
  rewriteSubmittedPrompt,
  recordMcpPreflightArtifactLinkage,
  renderMarkdownForTerminal,
  wrapTerminalLine,
  runConversationTurn,
  runMcpPreflightDiagnostics,
  runMcpPreflight,
  runServerMode,
  serverHealth,
  serverStatus,
  resolveProviderAdapter,
  resolveProviderSupportState,
  directiveAcceptedEvidence,
  directiveReceiptEvidence,
  styleInputRouteLabel,
};

if (isEntrypoint) {
  if (options.help) {
    console.log(`Usage: narada-agent-cli --identity <name> [--session <name>] --server [--mcp-preflight] [--mcp-preflight-json] [--mcp-preflight-read] [--mcp-preflight-read-json] [--mcp-preflight-inventory] [--mcp-preflight-inventory-json] [--mcp-preflight-actions] [--mcp-preflight-actions-json] [--mcp-preflight-recovery] [--mcp-preflight-recovery-json] [--mcp-preflight-diagnostics] [--mcp-preflight-diagnostics-json] [--mcp-preflight-filter <mcp_state|recommended_action|recovery_kind>] [--mcp-preflight-match <value>] [--mcp-preflight-diagnostics-filter <all|startup|runtime>] [--session-inventory] [--session-inventory-json] [--session-inventory-operations] [--session-inventory-operations-json] [--session-inventory-actions] [--session-inventory-actions-json] [--session-inventory-recovery] [--session-inventory-recovery-json] [--session-inventory-events] [--session-inventory-events-json] [--session-inventory-filter <operational_posture|request_posture|mcp_state|heartbeat_status|recommended_action|recovery_kind>] [--session-inventory-match <value>] [--session-inventory-events-filter <all|lifecycle|issues|diagnostics|operations>] [--session-inventory-events-count <n>] [--session-operations] [--session-operations-json] [--session-recovery] [--session-recovery-json] [--session-read] [--session-read-json] [--session-events] [--session-events-json] [--session-events-filter <all|lifecycle|issues|diagnostics|operations>] [--session-events-count <n>] [--session-sync] [--session-sync-json] [--session-sync-dry-run] [--session-sync-delete] [--session-sync-target <file://url|path|site:alias|cloud:alias>] [--session-sync-direction <upload|download|bidirectional>] [--stream|--no-stream] [--color|--no-color]`);
    console.log('Conversation runtime is NARS-owned. Use agent-runtime-server for JSONL stdio, --server as a compatibility alias, or --attach for terminal projection. Legacy terminal and one-shot message modes have been removed.');
    console.log(`Environment: NARADA_INTELLIGENCE_PROVIDER, OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL, KIMI_API_KEY, KIMI_API_BASE_URL, KIMI_MODEL, KIMI_CODE_API_KEY, KIMI_CODE_API_BASE_URL, KIMI_CODE_MODEL, ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, ANTHROPIC_MODEL, DEEPSEEK_API_KEY, DEEPSEEK_API_BASE_URL, CODEX_MODEL, NARADA_CODEX_AUTH_HOME, NARADA_AGENT_CLI_STREAM, NARADA_AGENT_CLI_COLOR, NARADA_SITE_ROOT, NARADA_CLOUD_ROOT`);
    process.exit(0);
  }

  await main().catch((err) => {
    activeHeartbeat?.stop();
    activeOperationHeartbeatDirectiveEmitter?.stop?.();
    console.error(`[agent-cli] Fatal error: ${err.message}`);
    process.exit(1);
  });
}
