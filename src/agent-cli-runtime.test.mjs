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

const printedHelpMessages = [];
const originalHelpStdoutWrite = process.stdout.write;
process.stdout.write = (value = '') => { printedHelpMessages.push(stripAnsiForTest(String(value))); return true; };
try {
  assert.equal(await handleSlashCommand('/help', { mcpServers: {}, allTools: [] }), 'handled');
} finally {
  process.stdout.write = originalHelpStdoutWrite;
}
assert.equal(printedHelpMessages.some((message) => message.includes('/recovery             Show recovery workflow')), true);
assert.equal(await handleSlashCommand('/bad', { mcpServers: {}, allTools: [] }), 'handled');
assert.equal(await handleSlashCommand('plain message', { mcpServers: {}, allTools: [] }), 'none');
assert.equal(printedHelpMessages.some((message) => message.includes('/ops                  Show operation workflow summary')), true);
assert.equal(printedHelpMessages.some((message) => message.includes('/ops sync')), true);
let opsCall;
assert.equal(await handleSlashCommand('/ops', {
  mcpServers: {},
  allTools: [],
  naradaDir: '/tmp/ops-session-dir',
  session: 'ops-test',
  runSessionOperations: async (payload) => {
    opsCall = payload;
    return 0;
  },
}), 'handled');
assert.deepEqual(opsCall, {
  session: 'ops-test',
  naradaDir: '/tmp/ops-session-dir',
  jsonOutput: false,
});
let jsonOpsCall;
assert.equal(await handleSlashCommand('/ops --json', {
  mcpServers: {},
  allTools: [],
  naradaDir: '/tmp/ops-session-dir',
  session: 'ops-json-test',
  runSessionOperations: async (payload) => {
    jsonOpsCall = payload;
    return 0;
  },
}), 'handled');
assert.deepEqual(jsonOpsCall, {
  session: 'ops-json-test',
  naradaDir: '/tmp/ops-session-dir',
  jsonOutput: true,
});
let opsSyncCall;
assert.equal(await handleSlashCommand('/ops sync --target /tmp/ops-target --direction download --dry-run --delete --json', {
  mcpServers: {},
  allTools: [],
  naradaDir: '/tmp/ops-session-dir',
  session: 'ops-sync-test',
  runSessionSyncRunner: async (payload) => {
    opsSyncCall = payload;
    return 0;
  },
}), 'handled');
assert.deepEqual(opsSyncCall, {
  session: 'ops-sync-test',
  naradaDir: '/tmp/ops-session-dir',
  target: '/tmp/ops-target',
  direction: 'download',
  jsonOutput: true,
  dryRun: true,
  deleteMissing: true,
});
let positionalOpsSyncCall;
assert.equal(await handleSlashCommand('/ops sync /tmp/positional-target --direction bidirectional', {
  mcpServers: {},
  allTools: [],
  naradaDir: '/tmp/ops-session-dir',
  session: 'ops-pos-sync',
  runSessionSyncRunner: async (payload) => {
    positionalOpsSyncCall = payload;
    return 0;
  },
}), 'handled');
assert.deepEqual(positionalOpsSyncCall, {
  session: 'ops-pos-sync',
  naradaDir: '/tmp/ops-session-dir',
  target: '/tmp/positional-target',
  direction: 'bidirectional',
  jsonOutput: false,
  dryRun: false,
  deleteMissing: false,
});
const originalConsoleLog = console.log;
const originalSlashStdoutWrite = process.stdout.write;
const printedStatsMessages = [];
process.stdout.write = (value = '') => { printedStatsMessages.push(stripAnsiForTest(String(value))); return true; };
try {
  assert.equal(await handleSlashCommand('/stats --date 2026-06-01 --top 3', {
    mcpServers: {},
    allTools: [],
    statsRunner: (value) => ({ status: 'ok', message: `stats args: ${value}` }),
  }), 'handled');
} finally {
  console.log = originalConsoleLog;
  process.stdout.write = originalSlashStdoutWrite;
}
assert.equal(printedStatsMessages.some((message) => message.includes('stats args: --date 2026-06-01 --top 3')), true);
const statsToolsRoot = mkdtempSync(join(tmpdir(), 'narada-agent-cli-stats-tools-'));
const originalNaradaToolsRoot = process.env.NARADA_TOOLS_ROOT;
try {
  const statsBinDir = join(statsToolsRoot, 'packages', 'codex-transcript-stats', 'bin');
  mkdirSync(statsBinDir, { recursive: true });
  writeFileSync(join(statsBinDir, 'codex-transcript-stats.js'), `
console.log(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
`, 'utf8');
  process.env.NARADA_TOOLS_ROOT = statsToolsRoot;
  const statsResult = runCodexTranscriptStats('--date 2026-06-01 --top 3');
  assert.equal(statsResult.status, 'ok');
  assert.deepEqual(JSON.parse(statsResult.message), {
    argv: ['--date', '2026-06-01', '--top', '3'],
    cwd: statsToolsRoot,
  });
} finally {
  if (originalNaradaToolsRoot === undefined) {
    delete process.env.NARADA_TOOLS_ROOT;
  } else {
    process.env.NARADA_TOOLS_ROOT = originalNaradaToolsRoot;
  }
  rmSync(statsToolsRoot, { recursive: true, force: true });
}
assert.equal(normalizeCarrierGoal('  ship   the  carrier   goal  '), 'ship the carrier goal');
const goalSettings = { goal: '' };
assert.deepEqual(handleGoalCommand('', goalSettings), {
  action: 'show',
  changed: false,
  goal: { value: '', status: 'unset' },
  message: 'No carrier session goal is set.',
});
assert.deepEqual(handleGoalCommand(' finish provider parity ', goalSettings), {
  action: 'set',
  changed: true,
  goal: { value: 'finish provider parity', status: 'active' },
  message: 'Carrier session goal set: finish provider parity',
});
assert.deepEqual(goalSettings.goal, { value: 'finish provider parity', status: 'active' });
assert.deepEqual(handleGoalCommand('pause', goalSettings), {
  action: 'pause',
  changed: true,
  goal: { value: 'finish provider parity', status: 'paused' },
  message: 'Carrier session goal paused: finish provider parity',
});
assert.deepEqual(handleGoalCommand('', goalSettings), {
  action: 'show',
  changed: false,
  goal: { value: 'finish provider parity', status: 'paused' },
  message: 'Current goal (paused): finish provider parity',
});
assert.deepEqual(handleGoalCommand('resume', goalSettings), {
  action: 'resume',
  changed: true,
  goal: { value: 'finish provider parity', status: 'active' },
  message: 'Carrier session goal resumed: finish provider parity',
});
assert.deepEqual(handleGoalCommand('clear', goalSettings), {
  action: 'clear',
  changed: true,
  goal: { value: '', status: 'unset' },
  message: 'Carrier session goal cleared.',
});
assert.deepEqual(handleGoalCommand('pause', goalSettings), {
  action: 'pause',
  changed: false,
  goal: { value: '', status: 'unset' },
  message: 'No carrier session goal is set.',
});
assert.deepEqual(handleGoalCommand('none', goalSettings), {
  action: 'set',
  changed: true,
  goal: { value: 'none', status: 'active' },
  message: 'Carrier session goal set: none',
});
assert.deepEqual(handleGoalCommand('reset', goalSettings), {
  action: 'set',
  changed: true,
  goal: { value: 'reset', status: 'active' },
  message: 'Carrier session goal set: reset',
});
assert.deepEqual(messagesWithCarrierGoal([
  { role: 'system', content: 'base role' },
  { role: 'user', content: 'next turn' },
], { value: 'finish parity', status: 'active' }), [
  { role: 'system', content: 'base role' },
  { role: 'system', content: 'Active carrier session goal: finish parity\nUse this as the persistent task target and completion criterion while it remains active.' },
  { role: 'user', content: 'next turn' },
]);
assert.deepEqual(messagesWithCarrierGoal([{ role: 'user', content: 'next turn' }], { value: 'finish parity', status: 'paused' }), [
  { role: 'user', content: 'next turn' },
]);
const printedGoalMessages = [];
process.stdout.write = (value = '') => { printedGoalMessages.push(stripAnsiForTest(String(value))); return true; };
try {
  assert.equal(await handleSlashCommand('/goal finish cross-carrier command', {
    mcpServers: {},
    allTools: [],
    carrierSessionSettings: goalSettings,
  }), 'handled');
  assert.equal(await handleSlashCommand('/goal pause', {
    mcpServers: {},
    allTools: [],
    carrierSessionSettings: goalSettings,
  }), 'handled');
  assert.equal(await handleSlashCommand('/goal resume', {
    mcpServers: {},
    allTools: [],
    carrierSessionSettings: goalSettings,
  }), 'handled');
  assert.equal(await handleSlashCommand('/goal', {
    mcpServers: {},
    allTools: [],
    carrierSessionSettings: goalSettings,
  }), 'handled');
} finally {
  process.stdout.write = originalSlashStdoutWrite;
}
assert.deepEqual(goalSettings.goal, { value: 'finish cross-carrier command', status: 'active' });
assert.equal(printedGoalMessages.some((message) => message.includes('Carrier session goal set: finish cross-carrier command')), true);
assert.equal(printedGoalMessages.some((message) => message.includes('Carrier session goal paused: finish cross-carrier command')), true);
assert.equal(printedGoalMessages.some((message) => message.includes('Carrier session goal resumed: finish cross-carrier command')), true);
assert.equal(printedGoalMessages.some((message) => message.includes('Current goal (active): finish cross-carrier command')), true);
process.stdout.write = (value = '') => { printedGoalMessages.push(stripAnsiForTest(String(value))); return true; };
try {
  assert.deepEqual(await handleSlashCommand('/goal execute this goal', {
    mcpServers: {},
    allTools: [],
    carrierSessionSettings: goalSettings,
    executeGoalOnSet: true,
  }), {
    action: 'dispatch_goal',
    content: 'execute this goal',
    goal: { value: 'execute this goal', status: 'active' },
  });
} finally {
  process.stdout.write = originalSlashStdoutWrite;
}
const printedToolsMessages = [];
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
const toolsFixtureServers = {
  'local-filesystem': {
    tools: [{
      name: 'fs_read_file',
      description: 'Read a file',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    }],
  },
};
process.stdout.write = (value = '') => { printedToolsMessages.push(stripAnsiForTest(String(value))); return true; };
try {
  assert.equal(await handleSlashCommand('/tools fs_', { mcpServers: toolsFixtureServers, allTools: tools }), 'handled');
} finally {
  process.stdout.write = originalSlashStdoutWrite;
}
assert.equal(printedToolsMessages.some((message) => message.includes('Discovered MCP tools (1)')), true);
assert.equal(printedToolsMessages.some((message) => message.includes('fs_read_file (local-filesystem)')), true);
assert.equal(printedToolsMessages.some((message) => message.includes('input_schema:')), true);
assert.equal(printedToolsMessages.some((message) => message.includes('"path":{"type":"string"}')), true);
assert.equal(printedToolsMessages.some((message) => message.includes('"required":["path"]')), true);
const toolStatus = serverStatus({
  requestId: 'status-tools',
  state: { activeTurn: null, sessionSettings: { model: 'gpt-state-test', thinking: 'high', stream: false, goal: { status: 'active', value: 'ship state' } } },
  allTools: tools,
  mcpServers: toolsFixtureServers,
});
assert.equal(toolStatus.request_id, 'status-tools');
assert.equal(toolStatus.model, 'gpt-state-test');
assert.equal(toolStatus.thinking, 'high');
assert.equal(toolStatus.stream, false);
assert.equal(toolStatus.goal, 'ship state');
assert.equal(toolStatus.tool_count, 1);
assert.deepEqual(toolStatus.mcp_tools, [{
  server_name: 'local-filesystem',
  tool_name: 'fs_read_file',
  description: 'Read a file',
  input_schema: toolsFixtureServers['local-filesystem'].tools[0].inputSchema,
  registry_source: null,
  registry_metadata_authoritative: false,
}]);
assert.equal(toolStatus.observer_muted, false);
assert.deepEqual(toolStatus.observer_visibilities, ['record_only', 'operator_visible', 'agent_visible', 'conversation_visible']);
Object.defineProperty(toolsFixtureServers, '__mcp_startup_failures', {
  value: [{ server_name: 'polluted', code: 'mcp_stdout_pollution', message: 'startup banner' }],
  enumerable: false,
  configurable: true,
});
const toolStatusWithStartupFailure = serverStatus({
  requestId: 'status-tools-failed-startup',
  state: { activeTurn: null },
  allTools: tools,
  mcpServers: toolsFixtureServers,
});
assert.equal(toolStatusWithStartupFailure.mcp_operational_state, 'startup_degraded');
assert.equal(toolStatusWithStartupFailure.mcp_startup_failure_count, 1);
assert.equal(toolStatusWithStartupFailure.mcp_startup_failures[0].server_name, 'polluted');
const toolStatusWithPreflight = serverStatus({
  requestId: 'status-tools-with-preflight',
  state: { activeTurn: null },
  allTools: tools,
  mcpServers: toolsFixtureServers,
  mcpPreflightArtifact: {
    artifact_path: 'D:/tmp/preflight.json',
    generated_at: '2026-06-14T00:00:00.000Z',
    mcp_operational_state: 'healthy',
    mcp_startup_failure_summary: '0',
    mcp_runtime_fault_summary: '0',
    recommended_action: 'start_session',
    recommended_action_display: 'start session',
    recommended_command: null,
    recovery_kind: 'no_recovery',
    recovery_kind_display: 'no recovery',
    recovery_primary_command: null,
    recovery_followup_command: null,
    handoffs: {
      mcp_preflight_read: 'narada-agent-cli --identity narada.test --session narada.test --mcp-preflight-read',
      mcp_preflight_diagnostics: 'narada-agent-cli --identity narada.test --session narada.test --mcp-preflight-diagnostics --mcp-preflight-diagnostics-filter all',
    },
  },
});
assert.equal(toolStatusWithPreflight.mcp_preflight_artifact_path, 'D:/tmp/preflight.json');
assert.equal(toolStatusWithPreflight.mcp_preflight_operational_state, 'healthy');
assert.equal(toolStatusWithPreflight.mcp_preflight_recommended_action, 'start_session');
assert.equal(toolStatusWithPreflight.mcp_preflight_handoffs.mcp_preflight_diagnostics, 'narada-agent-cli --identity narada.test --session narada.test --mcp-preflight-diagnostics --mcp-preflight-diagnostics-filter all');
const printedStatusMessages = [];
process.stdout.write = (value = '') => { printedStatusMessages.push(stripAnsiForTest(String(value))); return true; };
try {
  assert.equal(await handleSlashCommand('/status', { mcpServers: toolsFixtureServers, allTools: tools }), 'handled');
} finally {
  process.stdout.write = originalSlashStdoutWrite;
}
assert.equal(printedStatusMessages.some((message) => message.includes('polluted:mcp_stdout_pollution')), true);
const printedRecoveryMessages = [];
process.stdout.write = (value = '') => { printedRecoveryMessages.push(stripAnsiForTest(String(value))); return true; };
try {
  assert.equal(await handleSlashCommand('/recovery', {
    mcpServers: toolsFixtureServers,
    allTools: tools,
    mcpPreflightArtifact: {
      artifact_path: 'D:/tmp/preflight.json',
      generated_at: '2026-06-14T00:00:00.000Z',
      mcp_operational_state: 'startup_degraded',
      mcp_startup_failure_summary: '1 (degraded:mcp_stdout_pollution)',
      mcp_runtime_fault_summary: '0',
      recommended_action: 'review_startup_diagnostics',
      recommended_action_display: 'review startup diagnostics',
      recommended_command: 'narada-agent-cli --identity narada.test --session narada.test --mcp-preflight-read',
      recovery_kind: 'startup_diagnostic_review',
      recovery_kind_display: 'startup diagnostic review',
      recovery_primary_command: 'narada-agent-cli --identity narada.test --session narada.test --mcp-preflight-diagnostics --mcp-preflight-diagnostics-filter startup',
      recovery_followup_command: 'narada-agent-cli --identity narada.test --session narada.test --mcp-preflight-read',
      handoffs: {
        mcp_preflight_read: 'narada-agent-cli --identity narada.test --session narada.test --mcp-preflight-read',
        mcp_preflight_diagnostics: 'narada-agent-cli --identity narada.test --session narada.test --mcp-preflight-diagnostics --mcp-preflight-diagnostics-filter all',
      },
    },
  }), 'handled');
} finally {
  process.stdout.write = originalSlashStdoutWrite;
}
assert.equal(printedRecoveryMessages.some((message) => message.includes('Session posture')), true);
assert.equal(printedRecoveryMessages.some((message) => message.includes('review startup diagnostics')), true);
assert.equal(printedRecoveryMessages.some((message) => message.includes('Session recovery')), true);
assert.equal(printedRecoveryMessages.some((message) => message.includes('--session-recovery')), true);
assert.equal(printedRecoveryMessages.some((message) => message.includes('Preflight review')), true);
assert.equal(printedRecoveryMessages.some((message) => message.includes('--mcp-preflight-read')), true);
const displaySettings = { toolOutputs: true };
const printedToolOutputMessages = [];
process.stdout.write = (value = '') => { printedToolOutputMessages.push(stripAnsiForTest(String(value))); return true; };
try {
  assert.equal(await handleSlashCommand('/tool-output', { mcpServers: {}, allTools: [], displaySettings }), 'handled');
  assert.equal(displaySettings.toolOutputs, false);
  assert.equal(await handleSlashCommand('/tool-outputs on', { mcpServers: {}, allTools: [], displaySettings }), 'handled');
  assert.equal(displaySettings.toolOutputs, true);
  assert.deepEqual(handleToolOutputDisplayCommand('off', displaySettings), {
    state: false,
    message: 'Tool call outputs are hidden in the displayed transcript.',
  });
  assert.equal(shouldDisplayToolOutputs(displaySettings), false);
} finally {
  console.log = originalConsoleLog;
  process.stdout.write = originalSlashStdoutWrite;
}
assert.equal(printedToolOutputMessages.some((message) => message.includes('Tool call outputs are hidden')), true);
const observerSettings = { observerMuted: false };
assert.equal(formatObserverPosture(observerSettings).includes('Visible interjections: shown'), true);
assert.deepEqual(handleObserverCommand('mute', observerSettings), {
  status: 'ok',
  muted: true,
  message: 'Visible observer interjections are muted for this session.',
});
assert.equal(observerSettings.observerMuted, true);
const printedObserverMessages = [];
process.stdout.write = (value = '') => { printedObserverMessages.push(stripAnsiForTest(String(value))); return true; };
try {
  assert.equal(await handleSlashCommand('/observers', { mcpServers: {}, allTools: [], displaySettings: observerSettings }), 'handled');
  assert.equal(await handleSlashCommand('/observer unmute', { mcpServers: {}, allTools: [], displaySettings: observerSettings }), 'handled');
} finally {
  process.stdout.write = originalSlashStdoutWrite;
}
assert.equal(observerSettings.observerMuted, false);
assert.equal(printedObserverMessages.some((message) => message.includes('Conversation observers')), true);
assert.equal(printedObserverMessages.some((message) => message.includes('Visible observer interjections are shown')), true);
assert.equal(await handleSlashCommand('/exit', { mcpServers: {}, allTools: [] }), 'exit');
const slashQueue = createInputQueue({ drain: async () => ({ terminal_state: 'completed' }) });
await slashQueue.enqueue(normalizeInputEvent({ content: 'first steering', source: 'operator_steering' }, { transport: 'terminal' }));
await slashQueue.enqueue(normalizeInputEvent({ content: 'system held', source: 'system_directive' }, { transport: 'control_jsonl' }));
await slashQueue.enqueue(normalizeInputEvent({ content: 'second steering', source: 'operator_steering' }, { transport: 'terminal' }));
assert.equal(await handleSlashCommand('/queue', { mcpServers: {}, allTools: [], inputQueue: slashQueue }), 'handled');
assert.equal(slashQueue.pendingCount, 3);
assert.equal(await handleSlashCommand('/queue drop 2', { mcpServers: {}, allTools: [], inputQueue: slashQueue }), 'handled');
assert.equal(slashQueue.pendingCount, 2);
assert.equal(slashQueue.pendingOperatorDirectiveCount, 1);
assert.equal(await handleSlashCommand('/queue clear', { mcpServers: {}, allTools: [], inputQueue: slashQueue }), 'handled');
assert.equal(slashQueue.pendingCount, 1);
assert.equal(slashQueue.pendingSystemDirectiveCount, 1);

assert.throws(
  () => assertApiKeyConfigured('anthropic-api', ''),
  /Missing API key for anthropic-api\. Set ANTHROPIC_API_KEY\./,
);
assert.throws(
  () => assertApiKeyConfigured('openai-api', ''),
  /Missing API key for openai-api\. Set OPENAI_API_KEY\./,
);
assert.throws(
  () => assertApiKeyConfigured('kimi-api', ''),
  /Missing API key for kimi-api\. Set KIMI_API_KEY\./,
);
assert.doesNotThrow(() => assertApiKeyConfigured('codex-subscription', ''));

const emitted = [];
const fakeMessages = [
  { role: 'system', content: 'You are a test agent.' },
  { role: 'user', content: 'Call the test tool.' },
];
let fakeCallCount = 0;
await runConversationTurn(
  fakeMessages,
  [{
    type: 'function',
    function: {
      name: 'fs_read_file',
      description: 'fixture tool',
      parameters: { type: 'object', properties: {} },
    },
  }],
  {
    fixture: {
      tools: [{ name: 'fs_read_file' }],
      send: async () => ({
        result: {
          content: [{ text: JSON.stringify({ status: 'ok', output_ref: 'mcp_output:o_test' }) }],
        },
      }),
      config: {},
    },
  },
  null,
  {
    turn: { turnId: 'turn_test', interruptRequested: false },
    emit: (event, payload) => emitted.push({ event, ...payload }),
    callChatApiFn: async () => {
      fakeCallCount += 1;
      if (fakeCallCount === 1) {
        return {
          choices: [{
            message: {
              role: 'assistant',
              content: 'Calling tool.',
              tool_calls: [{
                id: 'call_test',
                type: 'function',
                function: { name: 'fs_read_file', arguments: '{}' },
              }],
            },
          }],
        };
      }
      return { choices: [{ message: { role: 'assistant', content: 'Done.' } }] };
    },
  },
);
assert.equal(emitted.some((event) => event.event === 'assistant_message' && event.content === 'Calling tool.'), true);
assert.equal(emitted.some((event) => event.event === 'tool_call' && event.tool === 'fs_read_file'), true);
assert.equal(emitted.some((event) => event.event === 'tool_result' && event.output_ref === 'mcp_output:o_test'), true);
assert.equal(emitted.some((event) => event.event === 'tool_result' && event.tool === 'fs_read_file' && event.decision === 'read_only_admitted'), true);
const readOnlyToolCallEvent = emitted.find((event) => event.event === 'tool_call' && event.tool === 'fs_read_file');
assert.equal('arguments' in readOnlyToolCallEvent, false);
assert.equal(readOnlyToolCallEvent.raw_arguments_recorded, false);
assert.equal(readOnlyToolCallEvent.decision, 'read_only_admitted');

const payloadLimitEvents = [];
const payloadLimitResult = await executeMcpTool(
  {
    id: 'call_payload_limit',
    type: 'function',
    function: { name: 'fs_read_file', arguments: '{}' },
  },
  {
    fixture: {
      tools: [{ name: 'fs_read_file' }],
      send: async () => {
        throw new Error('inline_payload_too_long: field=summary length=584 threshold=200 remediation=use payload_ref');
      },
      config: {},
    },
  },
  null,
  {
    turnId: 'turn_payload_limit',
    emit: (event, payload) => payloadLimitEvents.push({ event, ...payload }),
  },
);
const payloadLimitContent = JSON.parse(payloadLimitResult.content);
assert.match(payloadLimitContent.recovery, /mcp_payload_create/);
assert.match(payloadLimitContent.recovery, /Do not print JSON as prose/);
assert.equal(payloadLimitEvents.some((event) => event.event === 'tool_result' && event.recovery?.includes('mcp_payload_create')), true);

const interruptedAbortController = new AbortController();
const interruptedTurn = {
  turnId: 'turn_interrupt',
  interruptRequested: false,
  abortSignal: interruptedAbortController.signal,
  requestInterrupt() {
    this.interruptRequested = true;
    interruptedAbortController.abort(new Error('agent_cli_interrupt_requested'));
  },
};
setTimeout(() => {
  interruptedTurn.requestInterrupt();
}, 20);
const interruptedResult = await runConversationTurn(
  [{ role: 'user', content: 'wait' }],
  [],
  {},
  null,
  {
    turn: interruptedTurn,
    emit: (event, payload) => emitted.push({ event, ...payload }),
    callChatApiFn: async (_messages, _tools, settings) => new Promise((resolveDelay, rejectDelay) => {
      settings.abortSignal.addEventListener('abort', () => rejectDelay(new Error('agent_cli_interrupt_requested')), { once: true });
      setTimeout(() => resolveDelay({ choices: [{ message: { role: 'assistant', content: 'late' } }] }), 60);
    }),
  },
);
assert.equal(interruptedResult.terminal_state, 'interrupted');
assert.equal(emitted.some((event) => event.event === 'turn_interrupted' && event.turn_id === 'turn_interrupt'), true);
assert.equal(interruptedAbortController.signal.aborted, true);

// MCP tool call should respect abort signal
const mcpAbortController = new AbortController();
const mcpAbortTurn = {
  turnId: 'turn_mcp_abort',
  interruptRequested: false,
  abortSignal: mcpAbortController.signal,
  requestInterrupt() {
    this.interruptRequested = true;
    mcpAbortController.abort(new Error('agent_cli_interrupt_requested'));
  },
};
let mcpAbortRejectedOnSignal = false;
setTimeout(() => mcpAbortTurn.requestInterrupt(), 20);
const mcpAbortResult = await executeMcpTool(
  { id: 'call_abort', type: 'function', function: { name: 'fs_read_file', arguments: '{}' } },
  {
    fixture: {
      tools: [{ name: 'fs_read_file' }],
      send: async (_req, _timeoutMs, _timeoutCode, abortSignal) => new Promise((_resolve, rejectDelay) => {
        abortSignal?.addEventListener('abort', () => {
          mcpAbortRejectedOnSignal = true;
          rejectDelay(new Error('agent_cli_interrupt_requested'));
        }, { once: true });
        setTimeout(() => _resolve({ result: { content: [{ text: 'late' }] } }), 200);
      }),
      config: {},
    },
  },
  null,
  {
    turn: mcpAbortTurn,
    turnId: 'turn_mcp_abort',
    emit: (event, payload) => emitted.push({ event, ...payload }),
  },
);
const mcpAbortContent = JSON.parse(mcpAbortResult.content);
assert.equal(mcpAbortRejectedOnSignal, true);
assert.equal(mcpAbortContent.error, 'agent_cli_interrupt_requested');
assert.equal(emitted.some((event) => event.event === 'carrier_diagnostic_recorded' && event.diagnostic_code === 'mcp_runtime_fault'), false);

const admissionEvents = [];
let mutatingToolSendCalled = false;
const admissionSite = mkdtempSync(join(tmpdir(), 'narada-agent-cli-admission-'));
const admissionResult = await executeMcpTool(
  {
    id: 'call_mutating',
    type: 'function',
    function: { name: 'task_lifecycle_claim', arguments: '{"task_number":1228}' },
  },
  {
    fixture: {
      tools: [{ name: 'task_lifecycle_claim' }],
      registry_tools: {
        task_lifecycle_claim: {
          read_only: false,
          family: 'task_lifecycle_mutation',
          authority_owner: 'task_governance_service',
          source: 'surface_registry',
          reason: 'test_registry_mutating_tool',
        },
      },
      send: async () => {
        mutatingToolSendCalled = true;
        throw new Error('mutating tool should not execute without admission');
      },
      config: {},
    },
  },
  null,
  {
    turnId: 'turn_admission',
    serverMode: true,
    agentId: 'narada-andrey.Kevin',
    carrierSessionId: 'narada-andrey-Kevin',
    siteRoot: admissionSite,
    emit: (event, payload) => admissionEvents.push({ event, ...payload }),
  },
);
const admissionContent = JSON.parse(admissionResult.content);
assert.equal(mutatingToolSendCalled, false);
assert.equal(admissionContent.error, 'action_admission_required');
assert.equal(admissionContent.request_id, 'car_act_narada-andrey-Kevin_turn_admission_call_mutating_d7a2d0d7577d5d93');
assert.equal(admissionContent.decision, 'routed');
assert.equal(admissionContent.authority_owner, 'task_governance_service');
assert.equal(admissionContent.carrier_mutation_admitted, false);
assert.equal(typeof admissionContent.candidate_ref, 'string');
assert.equal(admissionEvents.some((event) => event.event === 'tool_result' && event.status === 'admission_required'), true);
const admissionEvent = admissionEvents.find((event) => event.event === 'tool_result' && event.status === 'admission_required');
const admissionToolCallEvent = admissionEvents.find((event) => event.event === 'tool_call' && event.tool === 'task_lifecycle_claim');
assert.deepEqual(admissionToolCallEvent.argument_summary.keys, ['task_number']);
assert.equal(admissionToolCallEvent.raw_arguments_recorded, false);
assert.equal('arguments' in admissionToolCallEvent, false);
assert.equal(admissionEvent.request_id, admissionContent.request_id);
assert.equal(admissionEvent.decision, 'routed');
assert.equal(admissionEvent.evidence_path, admissionContent.evidence_path);
assert.equal(admissionEvent.candidate_ref, admissionContent.candidate_ref);
const admissionEvidenceText = readFileSync(admissionContent.evidence_path, 'utf8');
const admissionEvidence = JSON.parse(admissionEvidenceText);
assert.equal(admissionEvidence.schema, 'narada.carrier_action_admission_decision.v0');
assert.equal(admissionEvidence.request.requested_action.tool, 'task_lifecycle_claim');
assert.deepEqual(admissionEvidence.request.requested_action.argument_summary.keys, ['task_number']);
assert.equal(admissionEvidence.request.requested_action.classifier_source, 'surface_registry');
assert.doesNotMatch(admissionEvidenceText, /1228/);
const admissionCandidateText = readFileSync(admissionContent.candidate_ref, 'utf8');
const admissionCandidate = JSON.parse(admissionCandidateText);
assert.equal(admissionCandidate.schema, 'narada.carrier_action_candidate.task.v1');
assert.equal(admissionCandidate.source_admission_evidence_path, admissionContent.evidence_path);
assert.doesNotMatch(admissionCandidateText, /1228/);
rmSync(admissionSite, { recursive: true, force: true });

const missingToolEvents = [];
const missingToolSite = mkdtempSync(join(tmpdir(), 'narada-agent-cli-missing-tool-'));
const missingToolResult = await executeMcpTool(
  {
    id: 'call_missing_mutating',
    type: 'function',
    function: { name: 'task_lifecycle_claim', arguments: '{"task_number":1228}' },
  },
  {},
  null,
  {
    turnId: 'turn_missing_tool',
    serverMode: true,
    agentId: 'narada-andrey.Kevin',
    carrierSessionId: 'narada-andrey-Kevin',
    siteRoot: missingToolSite,
    emit: (event, payload) => missingToolEvents.push({ event, ...payload }),
  },
);
const missingToolContent = JSON.parse(missingToolResult.content);
assert.equal(missingToolContent.error, 'action_admission_required');
assert.equal(missingToolContent.decision, 'refused');
assert.equal(missingToolContent.reason, 'mcp_tool_not_available');
assert.equal(missingToolEvents.some((event) => event.event === 'tool_result' && event.status === 'admission_required'), true);
assert.equal(missingToolEvents.some((event) => event.event === 'tool_result' && event.status === 'error'), false);
const missingToolCallEvent = missingToolEvents.find((event) => event.event === 'tool_call');
assert.equal('arguments' in missingToolCallEvent, false);
assert.equal(missingToolCallEvent.raw_arguments_recorded, false);
assert.equal(missingToolCallEvent.decision, 'refused');
const missingToolEvidence = JSON.parse(readFileSync(missingToolContent.evidence_path, 'utf8'));
assert.equal(missingToolEvidence.reason, 'mcp_tool_not_available');
rmSync(missingToolSite, { recursive: true, force: true });

async function withRequiredMcpFabric(fn) {
  const previous = process.env.NARADA_AGENT_CLI_REQUIRE_MCP_FABRIC;
  process.env.NARADA_AGENT_CLI_REQUIRE_MCP_FABRIC = '1';
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.NARADA_AGENT_CLI_REQUIRE_MCP_FABRIC;
    } else {
      process.env.NARADA_AGENT_CLI_REQUIRE_MCP_FABRIC = previous;
    }
  }
}

const missingFabricSite = mkdtempSync(join(tmpdir(), 'narada-agent-cli-missing-fabric-'));
try {
  await assert.rejects(
    () => withRequiredMcpFabric(() => discoverAndStartMcpServers(missingFabricSite)),
    (error) => {
      assert.equal(error.code, 'mcp_fabric_load_failed');
      assert.equal(error.diagnostic.schema, 'narada.agent_cli.mcp_startup_diagnostic.v0');
      assert.equal(error.diagnostic.code, 'mcp_fabric_load_failed');
      assert.equal(error.diagnostic.cause_code, 'mcp_fabric_missing');
      return true;
    },
  );
} finally {
  rmSync(missingFabricSite, { recursive: true, force: true });
}

const emptyFabricSite = mkdtempSync(join(tmpdir(), 'narada-agent-cli-empty-fabric-'));
mkdirSync(join(emptyFabricSite, '.ai', 'mcp'), { recursive: true });
try {
  await assert.rejects(
    () => withRequiredMcpFabric(() => discoverAndStartMcpServers(emptyFabricSite)),
    (error) => {
      assert.equal(error.code, 'mcp_fabric_load_failed');
      assert.equal(error.diagnostic.schema, 'narada.agent_cli.mcp_startup_diagnostic.v0');
      assert.equal(error.diagnostic.cause_code, 'mcp_fabric_empty');
      return true;
    },
  );
} finally {
  rmSync(emptyFabricSite, { recursive: true, force: true });
}

const pollutedFabricSite = mkdtempSync(join(tmpdir(), 'narada-agent-cli-polluted-fabric-'));
mkdirSync(join(pollutedFabricSite, '.ai', 'mcp'), { recursive: true });
const pollutedServerPath = join(pollutedFabricSite, 'polluted-mcp-server.mjs');
writeFileSync(pollutedServerPath, `
import readline from 'node:readline';
console.log('startup banner');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2024-11-05' } }));
    return;
  }
  if (request.method === 'tools/list') {
    console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools: [] } }));
  }
});
`, 'utf8');
writeFileSync(join(pollutedFabricSite, '.ai', 'mcp', 'polluted-mcp.json'), `${JSON.stringify({
  mcpServers: {
    polluted: {
      transport: 'stdio',
      command: 'node',
      args: [pollutedServerPath],
    },
  },
}, null, 2)}\n`, 'utf8');
try {
  await assert.rejects(
    () => withRequiredMcpFabric(() => discoverAndStartMcpServers(pollutedFabricSite)),
    (error) => {
      assert.equal(error.code, 'mcp_startup_failed');
      assert.equal(error.diagnostic.schema, 'narada.agent_cli.mcp_startup_diagnostic.v0');
      assert.equal(error.diagnostic.failures[0].code, 'mcp_stdout_pollution');
      assert.deepEqual(error.diagnostic.failures[0].stdout_pollution, ['startup banner']);
      return true;
    },
  );
  const optionalPollutedServers = await discoverAndStartMcpServers(pollutedFabricSite);
  assert.equal(Object.keys(optionalPollutedServers).length, 0);
  const optionalPollutedStatus = serverStatus({
    requestId: 'status-optional-polluted',
    state: { activeTurn: null },
    allTools: [],
    mcpServers: optionalPollutedServers,
  });
  assert.equal(optionalPollutedStatus.mcp_startup_failure_count, 1);
  assert.equal(optionalPollutedStatus.mcp_startup_failures[0].code, 'mcp_stdout_pollution');
} finally {
  rmSync(pollutedFabricSite, { recursive: true, force: true });
}

const startupTimeoutSite = mkdtempSync(join(tmpdir(), 'narada-agent-cli-startup-timeout-'));
mkdirSync(join(startupTimeoutSite, '.ai', 'mcp'), { recursive: true });
const startupTimeoutServerPath = join(startupTimeoutSite, 'startup-timeout-mcp-server.mjs');
writeFileSync(startupTimeoutServerPath, `
setInterval(() => {}, 1000);
`, 'utf8');
writeFileSync(join(startupTimeoutSite, '.ai', 'mcp', 'startup-timeout-mcp.json'), `${JSON.stringify({
  mcpServers: {
    timeout: {
      transport: 'stdio',
      command: 'node',
      args: [startupTimeoutServerPath],
      startup_timeout_sec: 0.01,
    },
  },
}, null, 2)}\n`, 'utf8');
try {
  await assert.rejects(
    () => withRequiredMcpFabric(() => discoverAndStartMcpServers(startupTimeoutSite)),
    (error) => {
      assert.equal(error.code, 'mcp_startup_failed');
      assert.equal(error.diagnostic.failures[0].code, 'mcp_startup_timeout');
      assert.equal(error.diagnostic.failures[0].phase, 'initialize');
      assert.equal(error.diagnostic.failures[0].timeout_ms, 10);
      return true;
    },
  );
} finally {
  rmSync(startupTimeoutSite, { recursive: true, force: true });
}

const toolHydrationTimeoutSite = mkdtempSync(join(tmpdir(), 'narada-agent-cli-tool-timeout-'));
mkdirSync(join(toolHydrationTimeoutSite, '.ai', 'mcp'), { recursive: true });
const toolHydrationTimeoutServerPath = join(toolHydrationTimeoutSite, 'tool-timeout-mcp-server.mjs');
writeFileSync(toolHydrationTimeoutServerPath, `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2024-11-05' } }));
  }
});
`, 'utf8');
writeFileSync(join(toolHydrationTimeoutSite, '.ai', 'mcp', 'tool-timeout-mcp.json'), `${JSON.stringify({
  mcpServers: {
    timeout: {
      transport: 'stdio',
      command: 'node',
      args: [toolHydrationTimeoutServerPath],
      startup_timeout_sec: 0.2,
    },
  },
}, null, 2)}\n`, 'utf8');
try {
  await assert.rejects(
    () => withRequiredMcpFabric(() => discoverAndStartMcpServers(toolHydrationTimeoutSite)),
    (error) => {
      assert.equal(error.code, 'mcp_startup_failed');
      assert.equal(error.diagnostic.failures[0].code, 'mcp_tool_hydration_timeout');
      assert.equal(error.diagnostic.failures[0].phase, 'tools/list');
      assert.equal(error.diagnostic.failures[0].timeout_ms, 200);
      return true;
    },
  );
} finally {
  rmSync(toolHydrationTimeoutSite, { recursive: true, force: true });
}

const discoveredSite = mkdtempSync(join(tmpdir(), 'narada-agent-cli-discovered-mcp-'));
mkdirSync(join(discoveredSite, '.ai', 'mcp'), { recursive: true });
mkdirSync(join(discoveredSite, '.narada', 'capabilities'), { recursive: true });
const fixtureServerPath = join(discoveredSite, 'fixture-mcp-server.mjs');
writeFileSync(fixtureServerPath, `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2024-11-05' } }));
    return;
  }
  if (request.method === 'tools/list') {
    console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools: [
      { name: 'task_lifecycle_claim', description: 'claim', inputSchema: { type: 'object', properties: {} } },
      { name: 'fs_read_file', description: 'read', inputSchema: { type: 'object', properties: {} } }
    ] } }));
    return;
  }
  if (request.method === 'tools/call') {
    console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [{ text: '{"status":"executed"}' }] } }));
  }
});
`, 'utf8');
writeFileSync(join(discoveredSite, '.ai', 'mcp', 'fixture-mcp.json'), `${JSON.stringify({
  mcpServers: {
    fixture: {
      transport: 'stdio',
      command: 'node',
      args: [fixtureServerPath],
      surface_id: 'fixture.surface',
    },
  },
}, null, 2)}\n`, 'utf8');
writeFileSync(join(discoveredSite, '.narada', 'capabilities', 'mcp-surfaces.json'), `${JSON.stringify({
  surfaces: [{
    surface_id: 'fixture.surface',
    client_config: { generated_path: '.ai/mcp/fixture-mcp.json' },
    tool_contract: {
      read_only_tools: [],
      mutating_tools: ['task_lifecycle_claim'],
      refused_tools: [],
    },
  }],
}, null, 2)}\n`, 'utf8');
const discoveredServers = await discoverAndStartMcpServers(discoveredSite);
try {
  const discoveredEvents = [];
  const discoveredAdmission = await executeMcpTool(
    {
      id: 'call_discovered_registry',
      type: 'function',
      function: { name: 'task_lifecycle_claim', arguments: '{"task_number":1228}' },
    },
    discoveredServers,
    null,
    {
      turnId: 'turn_discovered_registry',
      serverMode: true,
      agentId: 'narada.test',
      carrierSessionId: 'carrier-discovered',
      siteRoot: discoveredSite,
      emit: (event, payload) => discoveredEvents.push({ event, ...payload }),
    },
  );
  const discoveredContent = JSON.parse(discoveredAdmission.content);
  const discoveredEvidence = JSON.parse(readFileSync(discoveredContent.evidence_path, 'utf8'));
  assert.equal(discoveredEvidence.request.requested_action.classifier_source, 'surface_registry');
  assert.equal(discoveredEvidence.request.requested_action.classifier_metadata.surface_id, 'fixture.surface');
  assert.equal(discoveredEvidence.request.requested_action.classifier_metadata.server_name, 'fixture');
  assert.equal(discoveredEvents.find((event) => event.event === 'tool_call').classifier_source, 'surface_registry');

  discoveredServers.fixture.registry_tools.fs_read_file = {
    name: 'fs_read_file',
    read_only: true,
    family: 'read_only_context',
    authority_owner: 'target_site_read_policy',
    source: 'surface_registry',
    surface_id: 'fixture.surface',
    server_name: 'fixture',
    reason: 'surface_registry_read_only_tool',
  };
  const listedRead = await executeMcpTool(
    {
      id: 'call_discovered_listed_read',
      type: 'function',
      function: { name: 'fs_read_file', arguments: '{"path":"package.json"}' },
    },
    discoveredServers,
    null,
    {
      turnId: 'turn_discovered_listed_read',
      serverMode: true,
      agentId: 'narada.test',
      carrierSessionId: 'carrier-discovered',
      siteRoot: discoveredSite,
      emit: (event, payload) => discoveredEvents.push({ event, ...payload }),
    },
  );
  assert.deepEqual(JSON.parse(listedRead.content), { status: 'executed' });
  assert.equal(discoveredEvents.some((event) => event.event === 'tool_result' && event.tool === 'fs_read_file' && event.status === 'ok' && event.decision === 'read_only_admitted'), true);
  delete discoveredServers.fixture.registry_tools.fs_read_file;

  const unlistedRead = await executeMcpTool(
    {
      id: 'call_discovered_unlisted_read',
      type: 'function',
      function: { name: 'fs_read_file', arguments: '{"path":"package.json"}' },
    },
    discoveredServers,
    null,
    {
      turnId: 'turn_discovered_unlisted',
      serverMode: true,
      agentId: 'narada.test',
      carrierSessionId: 'carrier-discovered',
      siteRoot: discoveredSite,
      emit: () => {},
    },
  );
  const unlistedContent = JSON.parse(unlistedRead.content);
  assert.equal(unlistedContent.error, 'action_admission_required');
  assert.equal(unlistedContent.reason, 'surface_registry_tool_not_declared');
} finally {
  await Promise.all(Object.values(discoveredServers).map((server) => stopChildProcess(server.process)));
  rmSync(discoveredSite, { recursive: true, force: true });
}

const resetAfterTimeoutSite = mkdtempSync(join(tmpdir(), 'narada-agent-cli-mcp-reset-after-timeout-'));
mkdirSync(join(resetAfterTimeoutSite, '.ai', 'mcp'), { recursive: true });
const resetAfterTimeoutServerPath = join(resetAfterTimeoutSite, 'reset-after-timeout-mcp-server.mjs');
writeFileSync(resetAfterTimeoutServerPath, `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2024-11-05' } }));
    return;
  }
  if (request.method === 'tools/list') {
    console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools: [
      { name: 'fs_stat', description: 'stat', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }
    ] } }));
  }
});
setInterval(() => {}, 1000);
`, 'utf8');
writeFileSync(join(resetAfterTimeoutSite, '.ai', 'mcp', 'reset-after-timeout-mcp.json'), `${JSON.stringify({
  mcpServers: {
    reset: {
      transport: 'stdio',
      command: 'node',
      args: [resetAfterTimeoutServerPath],
    },
  },
}, null, 2)}\n`, 'utf8');
const resetServers = await discoverAndStartMcpServers(resetAfterTimeoutSite);
try {
  await assert.rejects(
    () => resetServers.reset.send({
      jsonrpc: '2.0',
      id: 'call_reset_timeout',
      method: 'tools/call',
      params: { name: 'fs_stat', arguments: { path: 'decks/customer-data-analysis/node_modules' } },
    }, 20),
    /MCP request timeout after 20ms/,
  );
  assert.equal(resetServers.reset.process.stdin.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })), true);
  const afterReset = await executeMcpTool(
    {
      id: 'call_after_reset',
      type: 'function',
      function: { name: 'fs_stat', arguments: '{"path":"package.json"}' },
    },
    resetServers,
    null,
    {
      turnId: 'turn_after_reset',
      emit: (event, payload) => admissionEvents.push({ event, ...payload }),
    },
  );
  assert.equal(JSON.parse(afterReset.content).error, 'read ECONNRESET');
  assert.equal(admissionEvents.some((event) => event.event === 'carrier_diagnostic_recorded' && event.server_name === 'reset' && event.tool_name === 'fs_stat' && event.diagnostic_code === 'mcp_runtime_fault' && event.error_code === 'ECONNRESET'), true);
  const resetStatus = serverStatus({
    requestId: 'status-reset-fault',
    state: { activeTurn: null },
    allTools: [],
    mcpServers: resetServers,
  });
  assert.equal(resetStatus.mcp_operational_state, 'runtime_faulted');
  assert.equal(resetStatus.mcp_runtime_fault_count, 1);
  assert.equal(resetStatus.mcp_runtime_faults[0].server_name, 'reset');
} finally {
  await Promise.all(Object.values(resetServers).map((server) => stopChildProcess(server.process)));
  rmSync(resetAfterTimeoutSite, { recursive: true, force: true });
}

function stopChildProcess(proc) {
  if (!proc || proc.exitCode !== null) return Promise.resolve();
  return new Promise((resolveStop) => {
    proc.once('exit', () => resolveStop());
    proc.kill();
    setTimeout(resolveStop, 1000);
  });
}

function stripAnsiForTest(text) {
  return String(text).replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

console.log('agent-cli runtime tests PASSED.');
