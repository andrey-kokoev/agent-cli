import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync, mkdirSync, mkdtempSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { formatPreflightWorkflowEvent, formatPreflightWorkflowSummary, formatRuntimeMcpFaultEvent, formatRuntimeMcpFaultSummary, formatSessionWorkflowEvent, formatSessionWorkflowSummary, formatStartupMcpEvent, formatStartupMcpSummary, formatWrapperStatusEvent } from '../bin/agent-runtime-server.mjs';
import { createExplicitJsonControlFrame, createOperatorConversationFrame, createOperatorPrompt, createProjectedOutputWriter, createProjectedSlashCommandAction, renderOperatorEvent, rewriteSubmittedOperatorPromptForTest } from './projected-terminal.mjs';
import { createTerminalRendering } from './terminal-rendering.mjs';
import { formatTerminalMessageBlockLines } from './terminal-style.mjs';
import { commandTokens } from '@narada2/carrier-command-contract';
import {
  CARRIER_CONTROL_METHODS,
  classifyCarrierControlRequest,
  classifyCarrierInputHold,
  classifyCarrierInputQueueAdmission,
  createSessionEvent,
  createToolResultPayload,
  validateSessionEvent,
} from '@narada2/carrier-protocol';
import {
  PROVIDER_SUPPORT_STATES,
  REQUEST_ADAPTERS,
  assertApiKeyConfigured,
  buildAnthropicMessagesRequest,
  buildCodexMcpRequest,
  buildChildProcessEnv,
  buildCodexMcpServerArgs,
  buildCodexSubprocessEnv,
  buildCodexExecArgs,
  codexExecMcpConfigArgs,
  codexExecConfigToml,
  codexRequestMcpServers,
  codexExecMcpToolEventSummary,
  buildOpenAiChatRequest,
  aggregateTools,
  providerToolNameForOriginal,
  originalToolNameForProvider,
  codexExecEventText,
  copyToClipboard,
  consumeOperatorDirectiveInputText,
  createCarrierDirectiveEmitter,
  createRuntimeHeaderRows,
  createMcpPreflightArtifactSnapshot,
  createSessionActivitySnapshot,
  createInputQueue,
  createMcpStatusSnapshot,
  createOperationHeartbeatDirectiveEmitter,
  createTerminalStyle,
  environmentBlockLength,
  directiveReceiptEvidence,
  discoverAndStartMcpServers,
  executeMcpTool,
  classifyCarrierHostCommandInput,
  executeCarrierHostCommand,
  formatDuration,
  formatHeaderRow,
  formatHeaderRows,
  formatKeyValueRows,
  filterPersistedSessionEvents,
  filterSessionInventory,
  summarizeSessionInventoryGroups,
  formatProgressStatus,
  formatTimestamp,
  formatToolResultContent,
  formatObserverPosture,
  handleGoalCommand,
  handleControlLine,
  handleObserverCommand,
  handleSlashCommand,
  messagesWithCarrierGoal,
  mcpToolEffectAdmissionEvidence,
  handleToolOutputDisplayCommand,
  runCodexTranscriptStats,
  inputRecordDisplayLabel,
  isAgentCliUtilityCommandMode,
  normalizeDisplayTerms,
  normalizeInputEvent,
  normalizeInputRecord,
  normalizeCarrierGoal,
  normalizeThinkingLevel,
  parseArgs,
  parseBooleanEnv,
  parseColorEnv,
  parseCodexMcpResponse,
  removeInvalidToolHistory,
  parseAnthropicMessagesResponse,
  parseCodexExecJsonLine,
  parseNaradaToolCall,
  isObserverInputEvent,
  isPotentialNaradaToolCallText,
  printAgentMessage,
  readCarrierHostCommandOutputRef,
  readMcpPreflightArtifact,
  readPersistedSessionEvents,
  readSessionInventory,
  recordMcpPreflightArtifactLinkage,
  renderMarkdownForTerminal,
  rewriteSubmittedPromptForTest,
  runConversationTurn,
  runSessionEventsRead,
  runSessionInventory,
  runSessionSync,
  runServerMode,
  serverStatus,
  sanitizeOperatorDirectiveDraftForDisplay,
  resolveProviderAdapter,
  resolveProviderSupportState,
  sessionEventEntry,
  sessionLogEntry,
  shouldDeferQueuedInput,
  shouldDisplayToolOutputs,
  observerVisibility,
  styleInputRouteLabel,
  shouldSuppressMcpStderr,
  startControlJsonlWatcher,
  toolDirectionLabel,
  wrapTerminalLine,
} from './agent-cli.mjs';

const metadata = JSON.parse(readFileSync(new URL('./intelligence-providers.json', import.meta.url), 'utf8')).providers;
const windowsWrapperTemplate = readFileSync(new URL('../templates/Start-AgentCliSession.ps1', import.meta.url), 'utf8');
const naradaToolCallEnvelope = JSON.parse(readFileSync(new URL('../../narada/packages/carrier-provider-contract/contracts/narada-tool-call-envelope.json', import.meta.url), 'utf8'));
const tempDir = mkdtempSync(join(tmpdir(), 'agent-cli-test-'));

assert.equal(copyToClipboard('hello', () => ({ status: 0 }), 'win32'), true);
assert.equal(copyToClipboard('hello', () => ({ status: 1 }), 'win32'), false);
assert.equal(copyToClipboard('hello', () => ({ error: new Error('missing') }), 'linux'), false);
assert.equal(formatKeyValueRows({ A: 1, Longer: 'two' }), 'A       1\nLonger  two');
assert.equal(formatDuration(1250), '1s');
assert.equal(formatDuration(65000), '1m 5s');
assert.equal(formatDuration(3661000), '1h 1m 1s');
assert.equal(formatTimestamp(new Date('2026-05-28T16:37:21Z')), '2026-05-28T16:37:21');
assert.equal(formatProgressStatus({ spinner: '-', phase: 'thinking', totalMs: 6000, phaseMs: 6000 }), '- thinking 6s · Enter queues note · Esc to interrupt');
assert.equal(formatProgressStatus({ spinner: '/', phase: 'calling fs_read_file', totalMs: 7000, phaseMs: 1200 }), '/ calling fs_read_file 1s · total 7s · Enter queues note · Esc to interrupt');
assert.equal(formatProgressStatus({ spinner: '/', phase: 'calling fs_read_file', totalMs: 65000, phaseMs: 61000 }), '/ calling fs_read_file 1m 1s · total 1m 5s · Enter queues note · Esc to interrupt');
assert.equal(formatProgressStatus({ spinner: '|', phase: 'thinking', totalMs: 8000, phaseMs: 8000, operatorDirectiveDraftLength: 12, queuedOperatorDirectiveCount: 2 }), '| thinking 8s · queued operator directives 2 · Enter queues note · Esc to interrupt · typing operator directive (12)');
assert.equal(formatHeaderRow('Identity', 'narada.architect', {}).includes('Identity'), true);
assert.equal(formatHeaderRow('Stream', 'on', {}).includes('on'), true);
assert.equal(stripAnsiForTest(formatHeaderRow('Identity', 'narada.architect', {})).includes('[agent-cli] Identity'), true);
const headerRows = stripAnsiForTest(formatHeaderRows([['MCP servers', 1], ['  narada-proper', '29 tools']]));
assert.equal(headerRows.includes('MCP servers     1'), true);
assert.equal(headerRows.includes('  narada-proper 29 tools'), true);
const runtimeHeaderRows = stripAnsiForTest(formatHeaderRows(createRuntimeHeaderRows({
  mcpServers: Object.assign(Object.create(null), {
    narada: { tools: [{ name: 'fs_read_file' }] },
    __mcp_startup_failures: [{ server_name: 'polluted', code: 'mcp_stdout_pollution' }],
    __mcp_runtime_diagnostics: [{ server_name: 'narada', tool_name: 'fs_read_file' }],
  }),
  allTools: [{ name: 'fs_read_file' }],
  sessionSettings: { model: 'gpt-5', thinking: 'medium', stream: true, goal: null },
  transcriptDisplaySettings: { toolOutputs: true },
})));
assert.equal(runtimeHeaderRows.includes('MCP state            runtime_faulted'), true);
assert.equal(runtimeHeaderRows.includes('MCP startup failures 1 (polluted:mcp_stdout_pollution)'), true);
assert.equal(runtimeHeaderRows.includes('MCP runtime faults   1 (narada:fs_read_file)'), true);
assert.equal(formatStartupMcpSummary({ event: 'session_started', mcp_operational_state: 'healthy' }), null);
assert.deepEqual(formatStartupMcpEvent({ event: 'session_started', mcp_operational_state: 'healthy' }), null);
assert.deepEqual(
  formatWrapperStatusEvent({
    event: 'session_started',
    timestamp: '2026-06-15T14:19:00.000Z',
    agent_id: 'narada.test',
    session_id: 'runtime-wrapper-test',
    active_turn_state: 'idle',
    active_turn_id: null,
    mcp_operational_state: 'healthy',
    mcp_startup_failure_count: 0,
    mcp_startup_failure_summary: '0',
    mcp_runtime_fault_count: 0,
    mcp_runtime_fault_summary: '0',
    mcp_preflight_operational_state: 'healthy',
    mcp_preflight_recommended_action: 'start_session',
    mcp_preflight_recommended_action_display: 'start session',
    mcp_preflight_recommended_command: null,
    mcp_preflight_recovery_kind: 'no_recovery',
    mcp_preflight_recovery_kind_display: 'no recovery',
    mcp_preflight_recovery_primary_command: null,
    mcp_preflight_recovery_followup_command: null,
    mcp_preflight_handoffs: {
      mcp_preflight_read: 'narada-agent-cli --identity narada.test --session runtime-wrapper-test --mcp-preflight-read',
      mcp_preflight_diagnostics: 'narada-agent-cli --identity narada.test --session runtime-wrapper-test --mcp-preflight-diagnostics --mcp-preflight-diagnostics-filter all',
    },
    request_outcome_total: 0,
    request_posture: 'clean',
    request_posture_display: 'clean',
    operational_posture: 'healthy',
    operational_posture_display: 'healthy',
    recommended_action: 'review_session_summary',
    recommended_action_display: 'review session summary',
    recommended_command: 'narada-agent-cli --identity narada.test --session runtime-wrapper-test --session-read',
    recovery_kind: 'no_recovery',
    recovery_kind_display: 'no recovery',
    recovery_primary_command: 'narada-agent-cli --identity narada.test --session runtime-wrapper-test --session-read',
    recovery_followup_command: null,
    handoffs: {
      session_read: 'narada-agent-cli --identity narada.test --session runtime-wrapper-test --session-read',
      session_recovery: 'narada-agent-cli --identity narada.test --session runtime-wrapper-test --session-recovery',
    },
    session_event_count: 1,
    last_event_kind: 'session_started',
    last_event_at: '2026-06-15T14:19:00.000Z',
    last_terminal_state: null,
  }),
  {
    schema: 'narada.agent_runtime_server.wrapper_event.v1',
    event: 'session_status_snapshot',
    timestamp: '2026-06-15T14:19:00.000Z',
    source_event: 'session_started',
    request_id: null,
    terminal_state: null,
    agent_id: 'narada.test',
    session_id: 'runtime-wrapper-test',
    active_turn_state: 'idle',
    active_turn_id: null,
    mcp_operational_state: 'healthy',
    mcp_startup_failure_count: 0,
    mcp_startup_failure_summary: '0',
    mcp_runtime_fault_count: 0,
    mcp_runtime_fault_summary: '0',
    mcp_preflight_operational_state: 'healthy',
    mcp_preflight_recommended_action: 'start_session',
    mcp_preflight_recommended_action_display: 'start session',
    mcp_preflight_recommended_command: null,
    mcp_preflight_recovery_kind: 'no_recovery',
    mcp_preflight_recovery_kind_display: 'no recovery',
    mcp_preflight_recovery_primary_command: null,
    mcp_preflight_recovery_followup_command: null,
    mcp_preflight_handoffs: {
      mcp_preflight_read: 'narada-agent-cli --identity narada.test --session runtime-wrapper-test --mcp-preflight-read',
      mcp_preflight_diagnostics: 'narada-agent-cli --identity narada.test --session runtime-wrapper-test --mcp-preflight-diagnostics --mcp-preflight-diagnostics-filter all',
    },
    request_outcome_total: 0,
    request_posture: 'clean',
    request_posture_display: 'clean',
    operational_posture: 'healthy',
    operational_posture_display: 'healthy',
    recommended_action: 'review_session_summary',
    recommended_action_display: 'review session summary',
    recommended_command: 'narada-agent-cli --identity narada.test --session runtime-wrapper-test --session-read',
    recovery_kind: 'no_recovery',
    recovery_kind_display: 'no recovery',
    recovery_primary_command: 'narada-agent-cli --identity narada.test --session runtime-wrapper-test --session-read',
    recovery_followup_command: null,
    handoffs: {
      session_read: 'narada-agent-cli --identity narada.test --session runtime-wrapper-test --session-read',
      session_recovery: 'narada-agent-cli --identity narada.test --session runtime-wrapper-test --session-recovery',
    },
    session_event_count: 1,
    last_event_kind: 'session_started',
    last_event_at: '2026-06-15T14:19:00.000Z',
    last_terminal_state: null,
  },
);
assert.deepEqual(
  formatWrapperStatusEvent({
    event: 'session_closed',
    timestamp: '2026-06-15T14:19:05.000Z',
    request_id: 'close-runtime-wrapper-test',
    terminal_state: 'closed',
    agent_id: 'narada.test',
    session_id: 'runtime-wrapper-test',
    active_turn_state: 'idle',
    active_turn_id: null,
    mcp_operational_state: 'healthy',
    mcp_startup_failure_count: 0,
    mcp_startup_failure_summary: '0',
    mcp_runtime_fault_count: 0,
    mcp_runtime_fault_summary: '0',
    mcp_preflight_operational_state: 'healthy',
    mcp_preflight_recommended_action: 'start_session',
    mcp_preflight_recommended_action_display: 'start session',
    mcp_preflight_recommended_command: null,
    mcp_preflight_recovery_kind: 'no_recovery',
    mcp_preflight_recovery_kind_display: 'no recovery',
    mcp_preflight_recovery_primary_command: null,
    mcp_preflight_recovery_followup_command: null,
    mcp_preflight_handoffs: {
      mcp_preflight_read: 'narada-agent-cli --identity narada.test --session runtime-wrapper-test --mcp-preflight-read',
      mcp_preflight_diagnostics: 'narada-agent-cli --identity narada.test --session runtime-wrapper-test --mcp-preflight-diagnostics --mcp-preflight-diagnostics-filter all',
    },
    request_outcome_total: 0,
    request_posture: 'clean',
    request_posture_display: 'clean',
    operational_posture: 'healthy',
    operational_posture_display: 'healthy',
    recommended_action: 'review_session_summary',
    recommended_action_display: 'review session summary',
    recommended_command: 'narada-agent-cli --identity narada.test --session runtime-wrapper-test --session-read',
    recovery_kind: 'no_recovery',
    recovery_kind_display: 'no recovery',
    recovery_primary_command: 'narada-agent-cli --identity narada.test --session runtime-wrapper-test --session-read',
    recovery_followup_command: null,
    handoffs: {
      session_read: 'narada-agent-cli --identity narada.test --session runtime-wrapper-test --session-read',
      session_recovery: 'narada-agent-cli --identity narada.test --session runtime-wrapper-test --session-recovery',
    },
    session_event_count: 3,
    last_event_kind: 'session_closed',
    last_event_at: '2026-06-15T14:19:05.000Z',
    last_terminal_state: 'closed',
  }),
  {
    schema: 'narada.agent_runtime_server.wrapper_event.v1',
    event: 'session_status_snapshot',
    timestamp: '2026-06-15T14:19:05.000Z',
    source_event: 'session_closed',
    request_id: 'close-runtime-wrapper-test',
    terminal_state: 'closed',
    agent_id: 'narada.test',
    session_id: 'runtime-wrapper-test',
    active_turn_state: 'idle',
    active_turn_id: null,
    mcp_operational_state: 'healthy',
    mcp_startup_failure_count: 0,
    mcp_startup_failure_summary: '0',
    mcp_runtime_fault_count: 0,
    mcp_runtime_fault_summary: '0',
    mcp_preflight_operational_state: 'healthy',
    mcp_preflight_recommended_action: 'start_session',
    mcp_preflight_recommended_action_display: 'start session',
    mcp_preflight_recommended_command: null,
    mcp_preflight_recovery_kind: 'no_recovery',
    mcp_preflight_recovery_kind_display: 'no recovery',
    mcp_preflight_recovery_primary_command: null,
    mcp_preflight_recovery_followup_command: null,
    mcp_preflight_handoffs: {
      mcp_preflight_read: 'narada-agent-cli --identity narada.test --session runtime-wrapper-test --mcp-preflight-read',
      mcp_preflight_diagnostics: 'narada-agent-cli --identity narada.test --session runtime-wrapper-test --mcp-preflight-diagnostics --mcp-preflight-diagnostics-filter all',
    },
    request_outcome_total: 0,
    request_posture: 'clean',
    request_posture_display: 'clean',
    operational_posture: 'healthy',
    operational_posture_display: 'healthy',
    recommended_action: 'review_session_summary',
    recommended_action_display: 'review session summary',
    recommended_command: 'narada-agent-cli --identity narada.test --session runtime-wrapper-test --session-read',
    recovery_kind: 'no_recovery',
    recovery_kind_display: 'no recovery',
    recovery_primary_command: 'narada-agent-cli --identity narada.test --session runtime-wrapper-test --session-read',
    recovery_followup_command: null,
    handoffs: {
      session_read: 'narada-agent-cli --identity narada.test --session runtime-wrapper-test --session-read',
      session_recovery: 'narada-agent-cli --identity narada.test --session runtime-wrapper-test --session-recovery',
    },
    session_event_count: 3,
    last_event_kind: 'session_closed',
    last_event_at: '2026-06-15T14:19:05.000Z',
    last_terminal_state: 'closed',
  },
);
assert.equal(
  formatStartupMcpSummary({
    event: 'session_started',
    timestamp: '2026-06-15T14:20:00.000Z',
    agent_id: 'narada.test',
    session_id: 'runtime-wrapper-test',
    mcp_operational_state: 'startup_degraded',
    mcp_startup_failure_count: 1,
    mcp_startup_failure_summary: '1 (degraded:mcp_stdout_pollution)',
    mcp_runtime_fault_count: 0,
    mcp_runtime_fault_summary: '0',
  }),
  '[agent-runtime-server] MCP state=startup_degraded | startup=1 (degraded:mcp_stdout_pollution)',
);
assert.deepEqual(
  formatStartupMcpEvent({
    event: 'session_started',
    timestamp: '2026-06-15T14:20:00.000Z',
    agent_id: 'narada.test',
    session_id: 'runtime-wrapper-test',
    mcp_operational_state: 'startup_degraded',
    mcp_startup_failure_count: 1,
    mcp_startup_failure_summary: '1 (degraded:mcp_stdout_pollution)',
    mcp_runtime_fault_count: 0,
    mcp_runtime_fault_summary: '0',
  }),
  {
    schema: 'narada.agent_runtime_server.wrapper_event.v1',
    event: 'mcp_startup_status',
    timestamp: '2026-06-15T14:20:00.000Z',
    agent_id: 'narada.test',
    session_id: 'runtime-wrapper-test',
    mcp_operational_state: 'startup_degraded',
    mcp_startup_failure_count: 1,
    mcp_startup_failure_summary: '1 (degraded:mcp_stdout_pollution)',
    mcp_runtime_fault_count: 0,
    mcp_runtime_fault_summary: '0',
  },
);
assert.equal(
  formatRuntimeMcpFaultSummary({
    event: 'carrier_diagnostic_recorded',
    diagnostic_code: 'mcp_runtime_fault',
    server_name: 'reset',
    tool_name: 'fs_stat',
    error_code: 'ECONNRESET',
  }),
  '[agent-runtime-server] MCP runtime fault reset:fs_stat ECONNRESET',
);
assert.deepEqual(
  formatRuntimeMcpFaultEvent({
    event: 'carrier_diagnostic_recorded',
    timestamp: '2026-06-15T14:21:00.000Z',
    agent_id: 'narada.test',
    session_id: 'runtime-wrapper-test',
    diagnostic_code: 'mcp_runtime_fault',
    server_name: 'reset',
    tool_name: 'fs_stat',
    error_code: 'ECONNRESET',
  }),
  {
    schema: 'narada.agent_runtime_server.wrapper_event.v1',
    event: 'mcp_runtime_fault',
    timestamp: '2026-06-15T14:21:00.000Z',
    agent_id: 'narada.test',
    session_id: 'runtime-wrapper-test',
    diagnostic_code: 'mcp_runtime_fault',
    server_name: 'reset',
    tool_name: 'fs_stat',
    error_code: 'ECONNRESET',
  },
);
assert.equal(
  formatSessionWorkflowSummary({
    event: 'session_status',
    recommended_action: 'review_startup_diagnostics',
    recommended_action_display: 'review startup diagnostics',
    recommended_command: 'narada-agent-cli --identity narada.test --session runtime-wrapper-test --session-recovery',
  }),
  '[agent-runtime-server] Session workflow review startup diagnostics | command=narada-agent-cli --identity narada.test --session runtime-wrapper-test --session-recovery',
);
assert.deepEqual(
  formatSessionWorkflowEvent({
    event: 'session_status',
    timestamp: '2026-06-15T14:22:00.000Z',
    request_id: 'status-runtime-wrapper-2',
    agent_id: 'narada.test',
    session_id: 'runtime-wrapper-test',
    operational_posture: 'mcp_startup_degraded',
    operational_posture_display: 'mcp_startup_degraded [mcp=startup_degraded; request=clean; lifecycle=unknown]',
    recommended_action: 'review_startup_diagnostics',
    recommended_action_display: 'review startup diagnostics',
    recommended_command: 'narada-agent-cli --identity narada.test --session runtime-wrapper-test --session-recovery',
    recovery_kind: 'startup_diagnostic_review',
    recovery_kind_display: 'startup diagnostic review',
    recovery_primary_command: 'narada-agent-cli --identity narada.test --session runtime-wrapper-test --session-events --session-events-filter diagnostics --session-events-count 20',
    recovery_followup_command: 'narada-agent-cli --identity narada.test --session runtime-wrapper-test --session-read',
    handoffs: {
      session_recovery: 'narada-agent-cli --identity narada.test --session runtime-wrapper-test --session-recovery',
    },
  }),
  {
    schema: 'narada.agent_runtime_server.wrapper_event.v1',
    event: 'session_workflow_recommendation',
    timestamp: '2026-06-15T14:22:00.000Z',
    source_event: 'session_status',
    request_id: 'status-runtime-wrapper-2',
    agent_id: 'narada.test',
    session_id: 'runtime-wrapper-test',
    operational_posture: 'mcp_startup_degraded',
    operational_posture_display: 'mcp_startup_degraded [mcp=startup_degraded; request=clean; lifecycle=unknown]',
    recommended_action: 'review_startup_diagnostics',
    recommended_action_display: 'review startup diagnostics',
    recommended_command: 'narada-agent-cli --identity narada.test --session runtime-wrapper-test --session-recovery',
    recovery_kind: 'startup_diagnostic_review',
    recovery_kind_display: 'startup diagnostic review',
    recovery_primary_command: 'narada-agent-cli --identity narada.test --session runtime-wrapper-test --session-events --session-events-filter diagnostics --session-events-count 20',
    recovery_followup_command: 'narada-agent-cli --identity narada.test --session runtime-wrapper-test --session-read',
    handoffs: {
      session_recovery: 'narada-agent-cli --identity narada.test --session runtime-wrapper-test --session-recovery',
    },
  },
);
assert.equal(
  formatPreflightWorkflowSummary({
    event: 'session_status',
    mcp_preflight_recommended_action: 'review_startup_diagnostics',
    mcp_preflight_recommended_action_display: 'review startup diagnostics',
    mcp_preflight_recommended_command: 'narada-agent-cli --identity narada.test --session runtime-wrapper-test --mcp-preflight-read',
  }),
  '[agent-runtime-server] Preflight workflow review startup diagnostics | command=narada-agent-cli --identity narada.test --session runtime-wrapper-test --mcp-preflight-read',
);
assert.deepEqual(
  formatPreflightWorkflowEvent({
    event: 'session_status',
    timestamp: '2026-06-15T14:22:05.000Z',
    request_id: 'status-runtime-wrapper-3',
    agent_id: 'narada.test',
    session_id: 'runtime-wrapper-test',
    mcp_preflight_operational_state: 'startup_degraded',
    mcp_preflight_recommended_action: 'review_startup_diagnostics',
    mcp_preflight_recommended_action_display: 'review startup diagnostics',
    mcp_preflight_recommended_command: 'narada-agent-cli --identity narada.test --session runtime-wrapper-test --mcp-preflight-read',
    mcp_preflight_recovery_kind: 'startup_diagnostic_review',
    mcp_preflight_recovery_kind_display: 'startup diagnostic review',
    mcp_preflight_recovery_primary_command: 'narada-agent-cli --identity narada.test --session runtime-wrapper-test --mcp-preflight-diagnostics --mcp-preflight-diagnostics-filter startup',
    mcp_preflight_recovery_followup_command: 'narada-agent-cli --identity narada.test --session runtime-wrapper-test --mcp-preflight-read',
    mcp_preflight_handoffs: {
      mcp_preflight_read: 'narada-agent-cli --identity narada.test --session runtime-wrapper-test --mcp-preflight-read',
    },
  }),
  {
    schema: 'narada.agent_runtime_server.wrapper_event.v1',
    event: 'preflight_workflow_recommendation',
    timestamp: '2026-06-15T14:22:05.000Z',
    source_event: 'session_status',
    request_id: 'status-runtime-wrapper-3',
    agent_id: 'narada.test',
    session_id: 'runtime-wrapper-test',
    mcp_preflight_operational_state: 'startup_degraded',
    mcp_preflight_recommended_action: 'review_startup_diagnostics',
    mcp_preflight_recommended_action_display: 'review startup diagnostics',
    mcp_preflight_recommended_command: 'narada-agent-cli --identity narada.test --session runtime-wrapper-test --mcp-preflight-read',
    mcp_preflight_recovery_kind: 'startup_diagnostic_review',
    mcp_preflight_recovery_kind_display: 'startup diagnostic review',
    mcp_preflight_recovery_primary_command: 'narada-agent-cli --identity narada.test --session runtime-wrapper-test --mcp-preflight-diagnostics --mcp-preflight-diagnostics-filter startup',
    mcp_preflight_recovery_followup_command: 'narada-agent-cli --identity narada.test --session runtime-wrapper-test --mcp-preflight-read',
    mcp_preflight_handoffs: {
      mcp_preflight_read: 'narada-agent-cli --identity narada.test --session runtime-wrapper-test --mcp-preflight-read',
    },
  },
);
assert.equal(formatRuntimeMcpFaultSummary({ event: 'carrier_diagnostic_recorded', diagnostic_code: 'other' }), null);
assert.equal(formatRuntimeMcpFaultEvent({ event: 'carrier_diagnostic_recorded', diagnostic_code: 'other' }), null);
assert.equal(formatSessionWorkflowSummary({ event: 'session_status', recommended_action: 'review_session_summary', recommended_command: 'narada-agent-cli --identity narada.test --session runtime-wrapper-test --session-read' }), null);
assert.equal(formatPreflightWorkflowSummary({ event: 'session_status', mcp_preflight_recommended_action: 'start_session', mcp_preflight_recommended_command: null }), null);
assert.equal(formatWrapperStatusEvent({ event: 'carrier_diagnostic_recorded' }), null);
assert.deepEqual(createMcpStatusSnapshot(Object.assign(Object.create(null), {
  narada: { tools: [{ name: 'fs_read_file' }] },
  __mcp_startup_failures: [{ server_name: 'polluted', code: 'mcp_stdout_pollution' }],
  __mcp_runtime_diagnostics: [{ server_name: 'narada', tool_name: 'fs_read_file' }],
})), {
  mcp_operational_state: 'runtime_faulted',
  mcp_startup_failure_count: 1,
  mcp_startup_failures: [{ server_name: 'polluted', code: 'mcp_stdout_pollution' }],
  mcp_startup_failure_summary: '1 (polluted:mcp_stdout_pollution)',
  mcp_runtime_fault_count: 1,
  mcp_runtime_faults: [{ server_name: 'narada', tool_name: 'fs_read_file' }],
  mcp_runtime_fault_summary: '1 (narada:fs_read_file)',
});
assert.deepEqual(createMcpPreflightArtifactSnapshot(null), {
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
});
assert.deepEqual(createMcpPreflightArtifactSnapshot({
  artifact_path: '/tmp/preflight.json',
  generated_at: '2026-06-14T00:00:00.000Z',
  mcp_operational_state: 'startup_degraded',
  mcp_startup_failure_summary: '1 (degraded:mcp_stdout_pollution)',
  mcp_runtime_fault_summary: '0',
  recommended_action: 'review_startup_diagnostics',
  recommended_action_display: 'review startup diagnostics',
  recommended_command: 'narada-agent-cli --identity narada.test --session preflight-test --mcp-preflight-read',
  recovery_kind: 'startup_diagnostic_review',
  recovery_kind_display: 'startup diagnostic review',
  recovery_primary_command: 'narada-agent-cli --identity narada.test --session preflight-test --mcp-preflight-read',
  recovery_followup_command: 'narada-agent-cli --identity narada.test --session preflight-test --mcp-preflight-read-json',
  handoffs: { mcp_preflight_diagnostics: 'narada-agent-cli --identity narada.test --session preflight-test --mcp-preflight-diagnostics --mcp-preflight-diagnostics-filter all' },
}), {
  mcp_preflight_artifact_path: '/tmp/preflight.json',
  mcp_preflight_artifact_generated_at: '2026-06-14T00:00:00.000Z',
  mcp_preflight_operational_state: 'startup_degraded',
  mcp_preflight_startup_failure_summary: '1 (degraded:mcp_stdout_pollution)',
  mcp_preflight_runtime_fault_summary: '0',
  mcp_preflight_recommended_action: 'review_startup_diagnostics',
  mcp_preflight_recommended_action_display: 'review startup diagnostics',
  mcp_preflight_recommended_command: 'narada-agent-cli --identity narada.test --session preflight-test --mcp-preflight-read',
  mcp_preflight_recovery_kind: 'startup_diagnostic_review',
  mcp_preflight_recovery_kind_display: 'startup diagnostic review',
  mcp_preflight_recovery_primary_command: 'narada-agent-cli --identity narada.test --session preflight-test --mcp-preflight-read',
  mcp_preflight_recovery_followup_command: 'narada-agent-cli --identity narada.test --session preflight-test --mcp-preflight-read-json',
  mcp_preflight_handoffs: { mcp_preflight_diagnostics: 'narada-agent-cli --identity narada.test --session preflight-test --mcp-preflight-diagnostics --mcp-preflight-diagnostics-filter all' },
});
assert.deepEqual(createSessionActivitySnapshot({
  startedAt: '2026-06-14T00:00:00.000Z',
  sessionEventCount: 3,
  lastEventKind: 'input_completed',
  lastEventAt: '2026-06-14T00:01:00.000Z',
  lastTerminalState: 'completed',
}), {
  agent_id: 'narada.architect',
  runtime: 'agent-cli',
  mode: 'server',
  started_at: '2026-06-14T00:00:00.000Z',
  session_event_count: 3,
  last_event_kind: 'input_completed',
  last_event_at: '2026-06-14T00:01:00.000Z',
  last_terminal_state: 'completed',
  request_outcome_total: 0,
  request_posture: 'clean',
  request_posture_display: 'clean',
  request_outcome_counts: {},
  request_outcome_summary: '0',
  request_issue_counts: {},
  request_issue_summary: '0',
});
assert.deepEqual(wrapTerminalLine('alpha beta gamma', 10), ['alpha beta', 'gamma']);
assert.equal(renderMarkdownForTerminal('- `code`').includes('• '), true);
assert.equal(stripAnsiForTest(renderMarkdownForTerminal('- `code`')).includes('code'), true);
assert.equal(stripAnsiForTest(renderMarkdownForTerminal('Site: `narada-proper`')).includes('narada-proper'), true);
assert.equal(normalizeDisplayTerms('authority_locus: narada_proper and authority_posture: facade_only'), 'authority locus: `narada_proper` and authority posture: `facade_only`');
assert.equal(normalizeDisplayTerms('authority_locus: `narada_proper`'), 'authority locus: `narada_proper`');
assert.equal(renderMarkdownForTerminal('  ```powershell\n    narada\n  ```').includes('```'), false);
assert.equal(renderMarkdownForTerminal('  ```powershell\n    narada\n  ```').includes('narada'), true);
const originalStdoutColumnsForToolWrap = process.stdout.columns;
const originalStdoutWriteForToolWrap = process.stdout.write;
const printedToolRows = [];
process.stdout.columns = 80;
process.stdout.write = (value = '') => { printedToolRows.push(stripAnsiForTest(String(value))); return true; };
try {
  createTerminalRendering({ terminalStyle: createTerminalStyle({ enabled: false }) })
    .printToolRequestLine('narada-staccato-graph-mail.graph_mail_query({"mailbox_id":"staccato.narada@global-maxima.com","limit":10,"select":"id,subject,from,toRecipients,receivedDateTime,sentDateTime,isRead,importance,parentFolderId,conversationId,bodyPreview"})');
} finally {
  process.stdout.columns = originalStdoutColumnsForToolWrap;
  process.stdout.write = originalStdoutWriteForToolWrap;
}
const printedToolRowLines = printedToolRows.join('').replace(/\r\x1b\[K/g, '').replace(/\r/g, '').trimEnd().split('\n');
assert.match(printedToolRowLines[0], /^narada\.architect -> agent-cli: narada-staccato-graph-mail\.graph_mail_query/);
assert.ok(printedToolRowLines.length > 1);
assert.equal(printedToolRowLines.slice(1).every((line) => /^  \S/.test(line)), true);
assert.match(printedToolRowLines.at(-1), / 2026-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
const originalStdoutWrite = process.stdout.write;
const printedAgentMessages = [];
process.stdout.write = (value = '') => { printedAgentMessages.push(String(value)); return true; };
try {
  assert.equal(printAgentMessage('   \x1b[0m   '), false);
  assert.deepEqual(printedAgentMessages, []);
  assert.equal(printAgentMessage('hello'), true);
  assert.equal(printedAgentMessages.length, 1);
  assert.equal(printedAgentMessages[0].startsWith('\r\x1b[K\n'), true);
  const printedAgentMessage = stripAnsiForTest(printedAgentMessages[0]).replace(/\r/g, '');
  assert.equal(printedAgentMessage.includes('narada.architect:\n  hello'), true);
  assert.equal(/\n\s+\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\s*$/.test(printedAgentMessage), false);
  assert.match(printedAgentMessage, /hello \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\n\n$/);
} finally {
  process.stdout.write = originalStdoutWrite;
}
assert.equal(stripAnsiForTest(renderMarkdownForTerminal('| Field | Values | Meaning |\n|-------|--------|---------|\n| executor | engine, agent, or operator | **Who** runs the step |\n| blocking | true or false | Whether the run **waits** for sop_run_advance after completion |')), 'Field     Values                      Meaning                                                       \nexecutor  engine, agent, or operator  **Who** runs the step                                         \nblocking  true or false               Whether the run **waits** for sop_run_advance after completion');
assert.equal(stripAnsiForTest(toolDirectionLabel('result')), 'agent-cli -> narada.architect');
const hostCommandOutputDir = mkdtempSync(join(tmpdir(), 'narada-agent-cli-host-command-'));
const hostCommandEvents = [];
const nodeCommand = 'echo host-ok';
const hostCommandResult = await executeCarrierHostCommand(classifyCarrierHostCommandInput(`! ${nodeCommand}`), {
  commandId: 'host_command_success_test',
  cwd: tempDir,
  outputDir: hostCommandOutputDir,
  appendSessionFn: (entry) => hostCommandEvents.push(entry),
  printResult: false,
});
assert.equal(hostCommandResult.terminal_state, 'completed');
assert.equal(hostCommandResult.exit_code, 0);
assert.equal(hostCommandResult.stdout.trim(), 'host-ok');
assert.equal(hostCommandResult.creates_provider_turn, false);
assert.deepEqual(hostCommandEvents.map((entry) => entry.event_kind), [
  'carrier_host_command_requested',
  'carrier_host_command_admitted',
  'carrier_host_command_started',
  'carrier_host_command_completed',
]);
assert.equal(hostCommandEvents[0].payload.command_text, nodeCommand);
assert.equal(hostCommandEvents.at(-1).payload.terminal_state, 'completed');
assert.equal(hostCommandEvents.at(-1).payload.stdout.trim(), 'host-ok');
const hostCommandRejectedEvents = [];
const rejectedHostCommand = await executeCarrierHostCommand(classifyCarrierHostCommandInput('!   '), {
  commandId: 'host_command_rejected_test',
  cwd: tempDir,
  appendSessionFn: (entry) => hostCommandRejectedEvents.push(entry),
  printResult: false,
});
assert.equal(rejectedHostCommand.terminal_state, 'rejected');
assert.deepEqual(hostCommandRejectedEvents.map((entry) => entry.event_kind), [
  'carrier_host_command_requested',
  'carrier_host_command_rejected',
]);
assert.equal(hostCommandRejectedEvents.at(-1).payload.admission_reason, 'empty_host_command');
const hostCommandFailedEvents = [];
const failedHostCommand = await executeCarrierHostCommand(classifyCarrierHostCommandInput('! fail-for-test'), {
  commandId: 'host_command_failed_test',
  cwd: tempDir,
  outputDir: hostCommandOutputDir,
  appendSessionFn: (entry) => hostCommandFailedEvents.push(entry),
  printResult: false,
  spawnFn: () => {
    const child = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      child.stdout.end();
      child.stderr.end();
      child.emit('close', 7);
    });
    return child;
  },
});
assert.equal(failedHostCommand.terminal_state, 'failed');
assert.equal(failedHostCommand.exit_code, 7);
assert.equal(hostCommandFailedEvents.at(-1).event_kind, 'carrier_host_command_failed');
assert.equal(hostCommandFailedEvents.at(-1).payload.terminal_state, 'failed');
const hostCommandLargeEvents = [];
const largeHostCommand = await executeCarrierHostCommand(classifyCarrierHostCommandInput('! large-output-for-test'), {
  commandId: 'host_command_large_test',
  cwd: tempDir,
  outputDir: hostCommandOutputDir,
  appendSessionFn: (entry) => hostCommandLargeEvents.push(entry),
  printResult: false,
  spawnFn: () => {
    const child = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      child.stdout.end('x'.repeat(9000));
      child.stderr.end();
      child.emit('close', 0);
    });
    return child;
  },
});
assert.equal(largeHostCommand.terminal_state, 'completed');
assert.equal(largeHostCommand.output_ref.payload_ref, 'mcp_payload:carrier_host_command_output:host_command_large_test@v1');
assert.equal(existsSync(largeHostCommand.output_path), true);
assert.equal(hostCommandLargeEvents.at(-1).payload.stdout, undefined);
assert.equal(hostCommandLargeEvents.at(-1).payload.output_ref.payload_ref, largeHostCommand.output_ref.payload_ref);
const largeHostCommandOutput = readCarrierHostCommandOutputRef(largeHostCommand.output_ref, { outputDir: hostCommandOutputDir });
assert.equal(largeHostCommandOutput.schema, 'narada.carrier.host_command_output.v1');
assert.equal(largeHostCommandOutput.stdout.length, 9000);
rmSync(hostCommandOutputDir, { recursive: true, force: true });
assert.equal(shouldSuppressMcpStderr('(node:1) ExperimentalWarning: SQLite is an experimental feature and might change at any time'), true);
assert.equal(shouldSuppressMcpStderr('(Use `node --trace-warnings ...` to show where the warning was created)'), true);
assert.equal(shouldSuppressMcpStderr('real MCP server error'), false);
const fixedTimestamp = new Date('2026-05-28T16:37:21Z');
assert.equal(stripAnsiForTest(rewriteSubmittedPromptForTest('operator -> narada.architect', 'short', 120, fixedTimestamp)).replace(/\r/g, ''), '\noperator -> narada.architect: short 2026-05-28T16:37:21\n');
assert.equal(
  stripAnsiForTest(rewriteSubmittedPromptForTest('operator -> narada.architect', 'review what has been going on in commits since checkpoint', 64, fixedTimestamp)).replace(/\r/g, ''),
  '\noperator -> narada.architect: review what has been going on in\n  commits since checkpoint 2026-05-28T16:37:21\n'
);
rmSync(tempDir, { recursive: true, force: true });

const expectedAdapters = {
  'openai-api': 'openai-compatible-chat-completions',
  'kimi-api': 'openai-compatible-chat-completions',
  'kimi-code-api': 'openai-compatible-chat-completions',
  'anthropic-api': 'anthropic-messages',
  'codex-subscription': 'codex-mcp-server',
};
assert.equal(windowsWrapperTemplate.includes("[ValidateSet('openai-api', 'kimi-api', 'kimi-code-api', 'anthropic-api', 'codex-subscription')]"), true);
assert.equal(windowsWrapperTemplate.includes('$CredentialEnvNames = @($providerDefault.credential_env_names'), true);
assert.equal(windowsWrapperTemplate.includes('$CredentialSecretRef = if ($providerDefault.credential_secret_ref)'), true);
assert.equal(windowsWrapperTemplate.includes('function Get-ProviderCredentialFromSecretStore'), true);
assert.equal(windowsWrapperTemplate.includes('Set-Secret -Name "$CredentialSecretRef"'), true);
assert.equal(windowsWrapperTemplate.includes('$credentialHint = if ($CredentialEnvNames.Count -gt 0) { ($CredentialEnvNames -join \' or \') }'), true);
assert.equal(windowsWrapperTemplate.includes('$ProviderConfigCredentialValue = $null'), true);
assert.equal(windowsWrapperTemplate.includes('$ProviderConfigCredentialValue = [string]$config.api_key'), true);
assert.equal(windowsWrapperTemplate.includes('Config file fallback: $ConfigPath'), true);
assert.equal(/NARADA_[A-Z0-9_]*_API_KEY/.test(windowsWrapperTemplate), false);
if (process.platform === 'win32') {
  const wrapperSyntaxCheck = spawnSync('pwsh', [
    '-NoProfile',
    '-Command',
    [
      '$tokens=$null;$errors=$null;',
      "[System.Management.Automation.Language.Parser]::ParseFile('templates/Start-AgentCliSession.ps1',[ref]$tokens,[ref]$errors) | Out-Null;",
      'if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }',
    ].join(''),
  ], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', windowsHide: true });
  assert.equal(wrapperSyntaxCheck.status, 0, wrapperSyntaxCheck.stderr);
}
assert.equal(windowsWrapperTemplate.includes('$BaseUrlEnvNames = @($providerDefault.base_url_env_names'), true);
assert.equal(windowsWrapperTemplate.includes('$ModelEnvNames = @($providerDefault.model_env_names'), true);
assert.equal(windowsWrapperTemplate.includes('Set-PrimaryProviderEnvironmentValue -Name $PrimaryBaseUrlEnvName'), true);
assert.equal(windowsWrapperTemplate.includes('Set-PrimaryProviderEnvironmentValue -Name $PrimaryModelEnvName'), true);
assert.equal(windowsWrapperTemplate.includes('[switch]$SessionInventory'), true);
assert.equal(windowsWrapperTemplate.includes('[switch]$SessionInventoryJson'), true);
assert.equal(windowsWrapperTemplate.includes('[switch]$SessionInventoryOperations'), true);
assert.equal(windowsWrapperTemplate.includes('[switch]$SessionInventoryOperationsJson'), true);
assert.equal(windowsWrapperTemplate.includes('[switch]$SessionInventoryHostCommands'), true);
assert.equal(windowsWrapperTemplate.includes('[switch]$SessionInventoryHostCommandsJson'), true);
assert.equal(windowsWrapperTemplate.includes('[switch]$SessionInventoryEvents'), true);
assert.equal(windowsWrapperTemplate.includes('[switch]$SessionInventoryEventsJson'), true);
assert.equal(windowsWrapperTemplate.includes("[ValidateSet('operational_posture', 'request_posture', 'mcp_state', 'heartbeat_status', 'recommended_action', 'recovery_kind')]"), true);
assert.equal(windowsWrapperTemplate.includes('[string]$SessionInventoryFilter'), true);
assert.equal(windowsWrapperTemplate.includes('[string]$SessionInventoryMatch'), true);
assert.equal(windowsWrapperTemplate.includes('[string]$SessionInventoryEventsFilter = \'all\''), true);
assert.equal(windowsWrapperTemplate.includes('[int]$SessionInventoryEventsCount = 20'), true);
assert.equal(windowsWrapperTemplate.includes('[switch]$SessionRead'), true);
assert.equal(windowsWrapperTemplate.includes('[switch]$SessionRecovery'), true);
assert.equal(windowsWrapperTemplate.includes('[switch]$SessionRecoveryJson'), true);
assert.equal(windowsWrapperTemplate.includes('[switch]$SessionReadJson'), true);
assert.equal(windowsWrapperTemplate.includes('[switch]$SessionOperations'), true);
assert.equal(windowsWrapperTemplate.includes('[switch]$SessionOperationsJson'), true);
assert.equal(windowsWrapperTemplate.includes('[switch]$HostCommandOutputRead'), true);
assert.equal(windowsWrapperTemplate.includes('[switch]$HostCommandOutputReadJson'), true);
assert.equal(windowsWrapperTemplate.includes('[string]$HostCommandOutputRef'), true);
assert.equal(windowsWrapperTemplate.includes('[switch]$SessionEvents'), true);
assert.equal(windowsWrapperTemplate.includes('[switch]$SessionEventsJson'), true);
assert.equal(windowsWrapperTemplate.includes("[ValidateSet('all', 'lifecycle', 'issues', 'diagnostics', 'operations')]"), true);
assert.equal(windowsWrapperTemplate.includes('[string]$SessionEventsFilter = \'all\''), true);
assert.equal(windowsWrapperTemplate.includes('[int]$SessionEventsCount = 20'), true);
assert.equal(windowsWrapperTemplate.includes('[switch]$McpPreflightJson'), true);
assert.equal(windowsWrapperTemplate.includes('[switch]$McpPreflightRead'), true);
assert.equal(windowsWrapperTemplate.includes('[switch]$McpPreflightReadJson'), true);
assert.equal(windowsWrapperTemplate.includes('[switch]$McpPreflightInventory'), true);
assert.equal(windowsWrapperTemplate.includes('[switch]$McpPreflightInventoryJson'), true);
assert.equal(windowsWrapperTemplate.includes('[switch]$McpPreflightActions'), true);
assert.equal(windowsWrapperTemplate.includes('[switch]$McpPreflightActionsJson'), true);
assert.equal(windowsWrapperTemplate.includes('[switch]$McpPreflightRecovery'), true);
assert.equal(windowsWrapperTemplate.includes('[switch]$McpPreflightRecoveryJson'), true);
assert.equal(windowsWrapperTemplate.includes("[ValidateSet('all', 'startup', 'runtime')]"), true);
assert.equal(windowsWrapperTemplate.includes("[string]$McpPreflightDiagnosticsFilter = 'all'"), true);
assert.equal(windowsWrapperTemplate.includes('[switch]$McpPreflightDiagnostics'), true);
assert.equal(windowsWrapperTemplate.includes('[switch]$McpPreflightDiagnosticsJson'), true);
assert.equal(windowsWrapperTemplate.includes("'--session-inventory'"), true);
assert.equal(windowsWrapperTemplate.includes("'--session-inventory-json'"), true);
assert.equal(windowsWrapperTemplate.includes("'--session-inventory-host-commands'"), true);
assert.equal(windowsWrapperTemplate.includes("'--session-inventory-host-commands-json'"), true);
assert.equal(windowsWrapperTemplate.includes("'--session-inventory-actions'"), true);
assert.equal(windowsWrapperTemplate.includes("'--session-inventory-actions-json'"), true);
assert.equal(windowsWrapperTemplate.includes("'--session-inventory-recovery'"), true);
assert.equal(windowsWrapperTemplate.includes("'--session-inventory-recovery-json'"), true);
assert.equal(windowsWrapperTemplate.includes("'--session-inventory-events'"), true);
assert.equal(windowsWrapperTemplate.includes("'--session-inventory-events-json'"), true);
assert.equal(windowsWrapperTemplate.includes("'--session-inventory-filter', $SessionInventoryFilter, '--session-inventory-match', $SessionInventoryMatch"), true);
assert.equal(windowsWrapperTemplate.includes("'--session-inventory-events-filter', $SessionInventoryEventsFilter, '--session-inventory-events-count', $SessionInventoryEventsCount"), true);
assert.equal(windowsWrapperTemplate.includes("'--session-read'"), true);
assert.equal(windowsWrapperTemplate.includes("'--session-recovery'"), true);
assert.equal(windowsWrapperTemplate.includes("'--session-recovery-json'"), true);
assert.equal(windowsWrapperTemplate.includes("'--session-read-json'"), true);
assert.equal(windowsWrapperTemplate.includes("'--host-command-output-read'"), true);
assert.equal(windowsWrapperTemplate.includes("'--host-command-output-read-json'"), true);
assert.equal(windowsWrapperTemplate.includes("'--host-command-output-ref', $HostCommandOutputRef"), true);
assert.equal(windowsWrapperTemplate.includes("'--session-events'"), true);
assert.equal(windowsWrapperTemplate.includes("'--session-events-json'"), true);
assert.equal(windowsWrapperTemplate.includes("'--session-events-filter' $SessionEventsFilter '--session-events-count' $SessionEventsCount"), true);
assert.equal(windowsWrapperTemplate.includes("& node $AgentCliPath '--identity' $IdentityName '--session' $SessionName '--session-events-json' '--session-events-filter' $SessionEventsFilter '--session-events-count' $SessionEventsCount"), true);
assert.equal(windowsWrapperTemplate.includes("if ($McpPreflightJson) {"), true);
assert.equal(windowsWrapperTemplate.includes("$preflightArgs = @($AgentCliPath, '--identity', $IdentityName, '--session', $SessionName, '--mcp-preflight-json')"), true);
assert.equal(windowsWrapperTemplate.includes("& node $AgentCliPath '--identity' $IdentityName '--session' $SessionName '--mcp-preflight-read'"), true);
assert.equal(windowsWrapperTemplate.includes("& node $AgentCliPath @preflightInventoryArgs"), true);
assert.equal(windowsWrapperTemplate.includes("'--mcp-preflight-filter', $McpPreflightFilter, '--mcp-preflight-match', $McpPreflightMatch"), true);
assert.equal(windowsWrapperTemplate.includes("& node $AgentCliPath @preflightInventoryJsonArgs"), true);
assert.equal(windowsWrapperTemplate.includes("& node $AgentCliPath @preflightActionArgs"), true);
assert.equal(windowsWrapperTemplate.includes("& node $AgentCliPath @preflightActionsJsonArgs"), true);
assert.equal(windowsWrapperTemplate.includes("& node $AgentCliPath @preflightRecoveryArgs"), true);
assert.equal(windowsWrapperTemplate.includes("& node $AgentCliPath @preflightRecoveryJsonArgs"), true);
assert.equal(windowsWrapperTemplate.includes("& node $AgentCliPath @preflightDiagnosticsArgs"), true);
assert.equal(windowsWrapperTemplate.includes("& node $AgentCliPath @preflightDiagnosticsJsonArgs"), true);
assert.equal(windowsWrapperTemplate.includes("'--mcp-preflight-diagnostics-filter', $McpPreflightDiagnosticsFilter"), true);
assert.equal(windowsWrapperTemplate.includes('ConvertFrom-Json'), true);
assert.equal(windowsWrapperTemplate.includes('MCP preflight reported degraded startup posture; continuing server attach.'), true);
assert.equal(windowsWrapperTemplate.includes('MCP state:'), true);
assert.equal(windowsWrapperTemplate.includes('Recommended action:'), true);
assert.equal(windowsWrapperTemplate.includes('Preflight review:'), true);
assert.equal(windowsWrapperTemplate.includes("$sessionRecoveryArgs = @($AgentCliPath, '--identity', $IdentityName, '--session', $SessionName, '--session-recovery-json')"), true);
assert.equal(windowsWrapperTemplate.includes('Session recovery returned non-JSON output; skipping post-session recovery guidance.'), true);
assert.equal(windowsWrapperTemplate.includes('Post-session recovery...'), true);
assert.equal(windowsWrapperTemplate.includes('Recovery primary:'), true);
assert.equal(windowsWrapperTemplate.includes('Session recovery:'), true);
for (const [providerId, adapterId] of Object.entries(expectedAdapters)) {
  const support = resolveProviderSupportState(providerId, metadata[providerId], REQUEST_ADAPTERS);
  assert.equal(support.state, PROVIDER_SUPPORT_STATES.VERIFIED_SUPPORTED);
  assert.equal(support.ready, true);
  assert.equal(support.required_next_step, 'Provider is verified for launch.');

  const resolution = resolveProviderAdapter(providerId, metadata, REQUEST_ADAPTERS);
  assert.equal(resolution.provider_id, providerId);
  assert.equal(resolution.adapter_id, adapterId);
  assert.notEqual(providerId, adapterId);
  assert.equal(resolution.support_state, PROVIDER_SUPPORT_STATES.VERIFIED_SUPPORTED);
}

assert.throws(
  () => resolveProviderAdapter('future-api', {
    'future-api': { adapter_kind: 'future-wire-protocol', support_state: 'verified_supported' },
  }, REQUEST_ADAPTERS),
  /Request adapter not implemented for future-api: future-wire-protocol\. support_state=verified_supported\. Implement request adapter future-wire-protocol before launching this provider\./,
);
assert.throws(
  () => resolveProviderAdapter('paused-api', {
    'paused-api': { adapter_kind: 'anthropic-messages', support_state: 'adapter_implemented' },
  }, REQUEST_ADAPTERS),
  /Unsupported intelligence provider adapter for paused-api: adapter_implemented\. Verify launcher, docs, credential mapping, and runtime tests before marking verified_supported\./,
);
assert.throws(
  () => resolveProviderAdapter('staged-api', {
    'staged-api': { adapter_kind: 'anthropic-messages', support_state: 'admitted_unsupported' },
  }, REQUEST_ADAPTERS),
  /Unsupported intelligence provider adapter for staged-api: admitted_unsupported\. Implement request adapter anthropic-messages and move the provider to adapter_implemented\./,
);

const tools = [{
  type: 'function',
  function: {
    name: 'fs_read_file',
    description: 'Read a file',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
}];

const messages = [
  { role: 'system', content: 'You are a test agent.' },
  { role: 'user', content: 'Read package metadata.' },
];

const anthropicRequest = buildAnthropicMessagesRequest(messages, tools, {
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-sonnet-4.6',
  apiKey: 'test-anthropic-key',
  thinking: 'high',
});

assert.equal(anthropicRequest.url.href, 'https://api.anthropic.com/v1/messages');
assert.equal(anthropicRequest.headers['x-api-key'], 'test-anthropic-key');
assert.equal(anthropicRequest.headers.Authorization, undefined);
assert.equal(anthropicRequest.headers['anthropic-version'], '2023-06-01');
assert.equal(anthropicRequest.body.model, 'claude-sonnet-4.6');
assert.equal(anthropicRequest.body.system, 'You are a test agent.');
assert.deepEqual(anthropicRequest.body.messages, [{ role: 'user', content: 'Read package metadata.' }]);
assert.deepEqual(anthropicRequest.body.tools, [{
  name: 'fs_read_file',
  description: 'Read a file',
  input_schema: tools[0].function.parameters,
}]);
assert.deepEqual(anthropicRequest.body.thinking, { type: 'enabled', budget_tokens: 4096 });

const parsedAnthropic = parseAnthropicMessagesResponse({
  id: 'msg_123',
  stop_reason: 'tool_use',
  usage: { input_tokens: 12, output_tokens: 8 },
  content: [
    { type: 'text', text: 'I will read it.' },
    { type: 'tool_use', id: 'toolu_123', name: 'fs_read_file', input: { path: 'package.json' } },
  ],
});

assert.equal(parsedAnthropic.choices[0].message.role, 'assistant');
assert.equal(parsedAnthropic.choices[0].message.content, 'I will read it.');
assert.equal(parsedAnthropic.choices[0].finish_reason, 'tool_calls');
assert.deepEqual(parsedAnthropic.choices[0].message.tool_calls, [{
  id: 'toolu_123',
  type: 'function',
  function: { name: 'fs_read_file', arguments: JSON.stringify({ path: 'package.json' }) },
}]);

const openAiRequest = buildOpenAiChatRequest(messages, tools, {
  baseUrl: 'https://api.openai.com',
  model: 'gpt-5.5',
  apiKey: 'test-openai-key',
  thinking: 'low',
});
assert.equal(openAiRequest.url.href, 'https://api.openai.com/v1/chat/completions');
assert.equal(openAiRequest.headers.Authorization, 'Bearer test-openai-key');
assert.equal(openAiRequest.body.messages[0].role, 'system');
assert.equal(openAiRequest.body.tools[0].function.name, 'fs_read_file');

const dottedToolServers = {
  'narada-proper': {
    tools: [{
      name: 'site_task_lifecycle.plan_init',
      description: 'Plan a task',
      inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
    }],
  },
};
const dottedProviderTools = aggregateTools(dottedToolServers);
assert.equal(dottedProviderTools[0].function.name, 'site_task_lifecycle_plan_init');
assert.match(dottedProviderTools[0].function.name, /^[A-Za-z][A-Za-z0-9_-]*$/);
assert.equal(providerToolNameForOriginal('site_task_lifecycle.plan_init', dottedToolServers), 'site_task_lifecycle_plan_init');
assert.equal(originalToolNameForProvider('site_task_lifecycle_plan_init', dottedToolServers), 'site_task_lifecycle.plan_init');
const codexMcpRequest = buildCodexMcpRequest([
  { role: 'system', content: 'You are a test agent.' },
  { role: 'user', content: 'Say ok.' },
], tools, {
  model: 'gpt-5.5',
  thinking: 'high',
  siteRoot: 'C:/Users/Andrey/Narada',
  nativeMcpTools: true,
  mcpServers: {
    'local-filesystem': {
      config: {
        command: 'node',
        args: ['D:/code/mcp-surfaces/packages/local-filesystem-mcp/dist/src/main.js'],
      },
    },
  },
});
assert.equal(codexMcpRequest.tool, 'codex');
assert.equal(codexMcpRequest.arguments.prompt, 'Say ok.');
assert.equal(codexMcpRequest.arguments.model, 'gpt-5.5');
assert.equal(codexMcpRequest.arguments['reasoning-effort'], 'high');
assert.equal(codexMcpRequest.arguments['developer-instructions'].startsWith('You are a test agent.'), true);
assert.equal(codexMcpRequest.arguments['developer-instructions'].includes('narada_tool_call'), true);
assert.equal(codexMcpRequest.arguments['developer-instructions'].includes('registered with nested Codex as native MCP tools'), true);
assert.equal(codexMcpRequest.arguments['developer-instructions'].includes('fs_read_file'), true);
assert.equal(codexMcpRequest.arguments['developer-instructions'].includes('input_schema:'), true);
assert.equal(codexMcpRequest.arguments['developer-instructions'].includes('"path":{"type":"string"}'), true);
assert.equal(codexMcpRequest.arguments.native_mcp_tools, true);
assert.equal(codexMcpRequest.arguments.mcpServers['local-filesystem'].config.command, 'node');
assert.equal(codexRequestMcpServers(codexMcpRequest, {}).hasOwnProperty('local-filesystem'), true);
assert.deepEqual(buildCodexMcpServerArgs(), ['mcp-server']);
assert.equal(buildCodexMcpServerArgs().includes('-c'), false);
if (process.platform === 'win32') {
  assert.equal(codexMcpRequest.arguments.sandbox, 'danger-full-access');
} else {
  assert.equal(codexMcpRequest.arguments.sandbox, 'workspace-write');
}
const codexConfigSessionDir = join(tempDir, 'codex-config-session');
rmSync(codexConfigSessionDir, { recursive: true, force: true });
const inheritedCodexHome = join(tempDir, 'inherited-runtime-codex-home');
const userProfileHome = join(tempDir, 'codex-user-profile');
const userCodexHome = join(userProfileHome, '.codex');
const explicitCodexAuthHome = join(tempDir, 'explicit-codex-auth-home');
mkdirSync(inheritedCodexHome, { recursive: true });
mkdirSync(userCodexHome, { recursive: true });
mkdirSync(explicitCodexAuthHome, { recursive: true });
writeFileSync(join(inheritedCodexHome, 'auth.json'), '{"access_token":"inherited-runtime-home"}\n');
writeFileSync(join(userCodexHome, 'auth.json'), '{"auth_mode":"chatgpt","tokens":{"access_token":"user-home"}}\n');
writeFileSync(join(explicitCodexAuthHome, 'auth.json'), '{"auth_mode":"chatgpt","tokens":{"access_token":"explicit-home"}}\n');
writeFileSync(join(userCodexHome, 'config.toml'), '[mcp_servers."narada-andrey-agent-context"]\ncommand = "node"\n');
const previousCodexHome = process.env.CODEX_HOME;
const previousCodexAuthHome = process.env.NARADA_CODEX_AUTH_HOME;
const previousUserProfile = process.env.USERPROFILE;
const previousHome = process.env.HOME;
const previousOpenAiKey = process.env.OPENAI_API_KEY;
const previousOpenAiBaseUrl = process.env.OPENAI_BASE_URL;
const previousOpenAiModel = process.env.OPENAI_MODEL;
process.env.CODEX_HOME = inheritedCodexHome;
delete process.env.NARADA_CODEX_AUTH_HOME;
process.env.USERPROFILE = userProfileHome;
delete process.env.HOME;
process.env.OPENAI_API_KEY = 'stale-api-key-must-not-reach-nested-codex';
process.env.OPENAI_BASE_URL = 'https://stale-openai.example';
process.env.OPENAI_MODEL = 'stale-openai-model';
const codexSubprocessEnv = buildCodexSubprocessEnv(codexMcpRequest.arguments.mcpServers, {
  sessionDir: codexConfigSessionDir,
});
process.env.NARADA_CODEX_AUTH_HOME = explicitCodexAuthHome;
const explicitCodexSessionDir = join(tempDir, 'explicit-codex-config-session');
const explicitCodexSubprocessEnv = buildCodexSubprocessEnv(codexMcpRequest.arguments.mcpServers, {
  sessionDir: explicitCodexSessionDir,
});
if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
else process.env.CODEX_HOME = previousCodexHome;
if (previousCodexAuthHome === undefined) delete process.env.NARADA_CODEX_AUTH_HOME;
else process.env.NARADA_CODEX_AUTH_HOME = previousCodexAuthHome;
if (previousUserProfile === undefined) delete process.env.USERPROFILE;
else process.env.USERPROFILE = previousUserProfile;
if (previousHome === undefined) delete process.env.HOME;
else process.env.HOME = previousHome;
if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
else process.env.OPENAI_API_KEY = previousOpenAiKey;
if (previousOpenAiBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
else process.env.OPENAI_BASE_URL = previousOpenAiBaseUrl;
if (previousOpenAiModel === undefined) delete process.env.OPENAI_MODEL;
else process.env.OPENAI_MODEL = previousOpenAiModel;
assert.equal(codexSubprocessEnv.CODEX_HOME, join(codexConfigSessionDir, 'codex-home'));
assert.equal(codexSubprocessEnv.CODEX_CONFIG_DIR, codexSubprocessEnv.CODEX_HOME);
assert.notEqual(codexSubprocessEnv.CODEX_HOME, inheritedCodexHome);
assert.equal(readFileSync(join(codexSubprocessEnv.CODEX_HOME, 'auth.json'), 'utf8'), '{"auth_mode":"chatgpt","tokens":{"access_token":"user-home"}}\n');
assert.equal(readFileSync(join(explicitCodexSubprocessEnv.CODEX_HOME, 'auth.json'), 'utf8'), '{"auth_mode":"chatgpt","tokens":{"access_token":"explicit-home"}}\n');
assert.equal(Object.hasOwn(codexSubprocessEnv, 'OPENAI_API_KEY'), false);
assert.equal(Object.hasOwn(codexSubprocessEnv, 'OPENAI_BASE_URL'), false);
assert.equal(Object.hasOwn(codexSubprocessEnv, 'OPENAI_MODEL'), false);
const generatedCodexConfig = readFileSync(join(codexSubprocessEnv.CODEX_HOME, 'config.toml'), 'utf8');
assert.equal(generatedCodexConfig.includes('[mcp_servers."local-filesystem"]'), true);
assert.equal(generatedCodexConfig.includes('D:/code/mcp-surfaces/packages/local-filesystem-mcp/dist/src/main.js'), true);
assert.equal(generatedCodexConfig.includes('env_vars = ["NARADA_AGENT_ID","NARADA_AGENT_START_EVENT_ID","NARADA_CARRIER_SESSION_ID","NARADA_SITE_ROOT","NARADA_WORKSPACE_ROOT","NARADA_AGENT_CONTEXT_DB"]'), true);
assert.equal(generatedCodexConfig.includes('narada-andrey-agent-context'), false);
assert.equal(generatedCodexConfig.includes('C:/Users/Andrey/Narada'), false);
const codexJsonFallbackRequest = buildCodexMcpRequest([
  { role: 'user', content: 'Say ok.' },
], tools, {
  model: 'gpt-5.5',
  thinking: 'medium',
  siteRoot: 'C:/Users/Andrey/Narada',
  nativeMcpTools: false,
});
assert.equal(codexJsonFallbackRequest.arguments.native_mcp_tools, false);
assert.equal(codexJsonFallbackRequest.arguments.mcpServers, undefined);
assert.equal(codexJsonFallbackRequest.arguments['developer-instructions'].includes('not through native Codex tool discovery'), true);
const codexDefaultDiscoveryRequest = buildCodexMcpRequest([
  { role: 'user', content: 'Say ok.' },
], tools, {
  model: 'gpt-5.5',
  thinking: 'medium',
  siteRoot: 'C:/Users/Andrey/Narada',
});
assert.equal(codexDefaultDiscoveryRequest.arguments.native_mcp_tools, true);
assert.equal(codexDefaultDiscoveryRequest.arguments['developer-instructions'].includes('registered with nested Codex as native MCP tools'), true);

const parsedCodex = parseCodexMcpResponse({ threadId: 'thread_123', content: 'ok' });
assert.equal(parsedCodex.choices[0].message.content, 'ok');
assert.deepEqual(parseNaradaToolCall(JSON.stringify(naradaToolCallEnvelope.example)), {
  name: 'mcp_output_show',
  arguments: { output_ref: 'mcp_output:o_6cd77433e384445e976c7fdf' },
});
assert.equal(isPotentialNaradaToolCallText('{"narada_tool_call":{"name":"mcp_payload_create"'), true);
assert.equal(isPotentialNaradaToolCallText('```json\n{"narada_tool_call":{"name":"mcp_payload_create"'), true);
assert.equal(isPotentialNaradaToolCallText('Startup sequence completed.'), false);
const codexMcpReplyRequest = buildCodexMcpRequest([
  { role: 'user', content: 'Continue.' },
], [], {
  model: 'gpt-5.5-mini',
  thinking: 'low',
  siteRoot: 'C:/Users/Andrey/Narada',
});
assert.equal(codexMcpReplyRequest.tool, 'codex-reply');
assert.equal(codexMcpReplyRequest.arguments.threadId, 'thread_123');
assert.equal(codexMcpReplyRequest.arguments.model, 'gpt-5.5-mini');
assert.equal(codexMcpReplyRequest.arguments['reasoning-effort'], 'low');
const codexToolContinuationRequest = buildCodexMcpRequest([
  { role: 'user', content: 'run startup sequence' },
  { role: 'tool', tool_call_id: 'call_startup', content: '{"status":"success"}' },
], [], {
  model: 'gpt-5.5',
  thinking: 'medium',
  siteRoot: 'C:/Users/Andrey/Narada',
});
assert.equal(codexToolContinuationRequest.arguments.prompt.includes('Narada tool result'), true);
const codexFreshUserAfterToolRequest = buildCodexMcpRequest([
  { role: 'user', content: 'run startup sequence' },
  { role: 'tool', tool_call_id: 'call_startup', content: '{"status":"success"}' },
  { role: 'assistant', content: 'Startup sequence completed.' },
  { role: 'user', content: 'is this implemented? -> `D:\\code\\narada\\docs\\concepts\\directive-as-first-class-object.md`' },
], [], {
  model: 'gpt-5.5',
  thinking: 'medium',
  siteRoot: 'C:/Users/Andrey/Narada',
});
assert.equal(codexFreshUserAfterToolRequest.arguments.prompt.includes('is this implemented?'), true);
assert.equal(codexFreshUserAfterToolRequest.arguments.prompt.includes('Narada tool result'), false);
const parsedToolCodex = parseCodexMcpResponse({
  threadId: 'thread_tool',
  content: '```json\n{"narada_tool_call":{"name":"agent_context_startup_sequence","arguments":{}}}\n```',
});
assert.equal(parsedToolCodex.choices[0].message.tool_calls[0].function.name, 'agent_context_startup_sequence');
const streamedCodex = parseCodexMcpResponse({ threadId: 'thread_456', content: 'streamed', streaming_rendered: true });
assert.equal(streamedCodex.streaming_rendered, true);
const codexExecArgs = buildCodexExecArgs(codexMcpRequest, { model: 'gpt-5.5', thinking: 'high', siteRoot: 'D:/code/narada' });
assert.equal(codexExecArgs[0], 'exec');
assert.equal(codexExecArgs.includes('--json'), true);
assert.equal(codexExecArgs.includes('--dangerously-bypass-approvals-and-sandbox'), true);
assert.equal(codexExecArgs.includes('model_reasoning_effort="high"'), true);
assert.equal(codexExecArgs.includes('-C'), true);
assert.equal(codexExecArgs.at(-1), '-');
assert.equal(codexExecArgs.join(' ').includes('Say ok.'), false);
assert.equal(codexExecArgs.some((arg) => arg.includes('mcp_servers."local-filesystem".command=')), true);
assert.equal(codexExecArgs.some((arg) => arg.includes('local-filesystem-mcp/dist/src/main.js')), true);
const codexExecReplyArgs = buildCodexExecArgs(codexMcpReplyRequest, { model: 'gpt-5.5-mini', thinking: 'low', siteRoot: 'D:/code/narada' });
assert.deepEqual(codexExecReplyArgs.slice(0, 3), ['exec', 'resume', '--json']);
assert.equal(codexExecReplyArgs.includes('thread_123'), true);
assert.equal(codexExecReplyArgs.at(-1), '-');
assert.equal(codexExecReplyArgs.includes('-C'), false);
const codexConfigToml = codexExecConfigToml({
  'narada-proper': {
    config: {
      command: 'node',
      args: ['--import', 'tsx', 'D:\\code\\narada\\packages\\narada-proper-mcp\\src\\main.ts'],
      env_vars: ['EXISTING_ENV'],
    },
  },
});
assert.match(codexConfigToml, /\[mcp_servers\."narada-proper"\]/);
assert.match(codexConfigToml, /default_tools_approval_mode = "approve"/);
assert.match(codexConfigToml, /packages\/narada-proper-mcp\/src\/main\.ts/);
assert.match(codexConfigToml, /env_vars = \["EXISTING_ENV","NARADA_AGENT_ID","NARADA_AGENT_START_EVENT_ID","NARADA_CARRIER_SESSION_ID","NARADA_SITE_ROOT","NARADA_WORKSPACE_ROOT","NARADA_AGENT_CONTEXT_DB"\]/);
const codexMcpConfigArgs = codexExecMcpConfigArgs({
  'narada-proper': {
    config: {
      command: 'node',
      args: ['--import', 'tsx', 'D:\\code\\narada\\packages\\narada-proper-mcp\\src\\main.ts'],
      env_vars: ['EXISTING_ENV'],
    },
  },
});
assert.equal(codexMcpConfigArgs.includes('-c'), true);
assert.equal(codexMcpConfigArgs.some((arg) => arg.includes('mcp_servers."narada-proper".command=')), true);
assert.equal(codexMcpConfigArgs.some((arg) => arg.includes('mcp_servers."narada-proper".env_vars=["EXISTING_ENV","NARADA_AGENT_ID","NARADA_AGENT_START_EVENT_ID","NARADA_CARRIER_SESSION_ID","NARADA_SITE_ROOT","NARADA_WORKSPACE_ROOT","NARADA_AGENT_CONTEXT_DB"]')), true);
assert.equal(codexMcpConfigArgs.some((arg) => arg.includes('default_tools_approval_mode="approve"')), true);
const event = parseCodexExecJsonLine('\u001b[32m{"type":"item.completed","item":{"type":"agent_message","text":"hello"}}\u001b[0m');
assert.equal(codexExecEventText(event), 'hello');
const nativeMcpStartedEvent = parseCodexExecJsonLine(JSON.stringify({
  type: 'item.started',
  item: {
    id: 'item_tool_1',
    type: 'mcp_tool_call',
    server: 'local-filesystem',
    tool: 'fs_read_file',
    arguments: { path: 'README.md' },
    status: 'in_progress',
  },
}));
assert.deepEqual(codexExecMcpToolEventSummary(nativeMcpStartedEvent), {
  id: 'item_tool_1',
  server: 'local-filesystem',
  tool: 'fs_read_file',
  name: 'local-filesystem.fs_read_file',
  arguments: { path: 'README.md' },
  status: 'in_progress',
  result: null,
  error: null,
});
assert.equal(codexExecEventText(nativeMcpStartedEvent), '');
const nativeMcpCompletedEvent = parseCodexExecJsonLine(JSON.stringify({
  type: 'item.completed',
  item: {
    id: 'item_tool_1',
    type: 'mcp_tool_call',
    server: 'local-filesystem',
    tool: 'fs_read_file',
    arguments: { path: 'README.md' },
    result: { content: [{ type: 'text', text: 'ok' }] },
    status: 'completed',
  },
}));
assert.equal(codexExecMcpToolEventSummary(nativeMcpCompletedEvent).status, 'completed');
assert.equal(codexExecEventText(nativeMcpCompletedEvent), '');

assert.deepEqual(commandTokens(), [
  '/help',
  '/status',
  '/goal',
  '/stats',
  '/model',
  '/thinking',
  '/tool-output',
  '/tool-outputs',
  '/tools',
  '/tool',
  '/observers',
  '/observer mute',
  '/observer unmute',
  '/queue',
  '/queue clear',
  '/queue drop <index>',
  '/clear',
  '/exit',
  '/quit',
  'exit',
]);
function stripAnsiForTest(text) {
  return String(text).replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

console.log('agent-cli terminal/provider tests PASSED.');
