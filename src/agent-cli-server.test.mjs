import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync, mkdirSync, mkdtempSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { formatPreflightWorkflowEvent, formatPreflightWorkflowSummary, formatRuntimeMcpFaultEvent, formatRuntimeMcpFaultSummary, formatSessionWorkflowEvent, formatSessionWorkflowSummary, formatStartupMcpEvent, formatStartupMcpSummary, formatWrapperStatusEvent } from './runtime-server-events.mjs';
import { createNarsAttachControlSink, createNarsEventSubscribeFrame, normalizeNarsAttachIncomingEvent, resolveNarsAttachEndpoint } from './nars-attach-client.mjs';
import { createExplicitJsonControlFrame, createOperatorConversationFrame, createOperatorPrompt, createProjectedOutputWriter, createProjectedSlashCommandAction, renderOperatorEvent, rewriteSubmittedOperatorPromptForTest } from './projected-terminal.mjs';
import { createTerminalRendering } from './terminal-rendering.mjs';
import { formatTerminalMessageBlockLines } from './terminal-style.mjs';
import { commandTokens } from '@narada2/carrier-command-contract';
import { recordMcpPreflightArtifactLinkage } from '@narada2/carrier-runtime/runtime-dependencies';
import {
  CARRIER_CONTROL_METHODS,
  NARS_RUNTIME_EVENT_KINDS,
  classifyCarrierControlRequest,
  classifyCarrierInputHold,
  classifyCarrierInputQueueAdmission,
  createSessionEvent,
  createToolResultPayload,
  isNarsRuntimeEventKind,
  normalizeNarsRuntimeEventKind,
  validateSessionEvent,
} from '@narada2/carrier-protocol';
import {
  buildChildProcessEnv,
  aggregateTools,
  providerToolNameForOriginal,
  originalToolNameForProvider,
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
  removeInvalidToolHistory,
  isObserverInputEvent,
  printAgentMessage,
  readCarrierHostCommandOutputRef,
  readMcpPreflightArtifact,
  readPersistedSessionEvents,
  readSessionInventory,
  renderMarkdownForTerminal,
  rewriteSubmittedPromptForTest,
  runSessionEventsRead,
  runSessionInventory,
  runSessionSync,
  sanitizeOperatorDirectiveDraftForDisplay,
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

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));



const preflightHealthySite = mkdtempSync(join(tmpdir(), 'narada-agent-cli-preflight-healthy-'));
mkdirSync(join(preflightHealthySite, '.ai', 'mcp'), { recursive: true });
const preflightHealthyServerPath = join(preflightHealthySite, 'healthy-mcp-server.mjs');
writeFileSync(preflightHealthyServerPath, `
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2024-11-05' } }));
    return;
  }
  if (request.method === 'tools/list') {
    console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'fs_stat', inputSchema: { type: 'object' } }] } }));
  }
});
`, 'utf8');
writeFileSync(join(preflightHealthySite, '.ai', 'mcp', 'healthy-mcp.json'), `${JSON.stringify({
  mcpServers: {
    healthy: {
      transport: 'stdio',
      command: 'node',
      args: [preflightHealthyServerPath],
    },
  },
}, null, 2)}\n`, 'utf8');
const preflightHealthy = spawnSync(process.execPath, [
  fileURLToPath(new URL('./agent-cli.mjs', import.meta.url)),
  '--identity', 'narada.test',
  '--session', 'preflight-healthy-test',
  '--mcp-preflight',
], {
  env: {
    ...process.env,
    NARADA_SITE_ROOT: preflightHealthySite,
    NARADA_INTELLIGENCE_PROVIDER: 'codex-subscription',
  },
  encoding: 'utf8',
});
assert.equal(preflightHealthy.status, 0);
assert.equal(preflightHealthy.stdout.includes('MCP state'), true);
assert.equal(preflightHealthy.stdout.includes('healthy'), true);
assert.equal(preflightHealthy.stdout.includes('MCP servers'), true);
assert.equal(preflightHealthy.stdout.includes('Tools'), true);
assert.equal(preflightHealthy.stdout.includes('Recommended action'), true);
assert.equal(preflightHealthy.stdout.includes('start session'), true);
const preflightHealthyArtifactPath = join(preflightHealthySite, '.narada', 'runtime', 'agent-cli', 'mcp-preflight', 'preflight-healthy-test.json');
assert.equal(preflightHealthy.stdout.includes('Preflight review'), true);
assert.equal(preflightHealthy.stdout.includes('narada-agent-cli --identity narada.test --session preflight-healthy-test --mcp-preflight-read'), true);
assert.equal(preflightHealthy.stdout.includes('Artifact'), true);
assert.equal(preflightHealthy.stdout.includes(preflightHealthyArtifactPath), true);
assert.equal(existsSync(preflightHealthyArtifactPath), true);
const preflightHealthyArtifact = JSON.parse(readFileSync(preflightHealthyArtifactPath, 'utf8'));
assert.equal(preflightHealthyArtifact.schema, 'narada.agent_cli.mcp_preflight_artifact.v1');
assert.equal(preflightHealthyArtifact.mcp_operational_state, 'healthy');
assert.equal(preflightHealthyArtifact.mcp_server_count, 1);
assert.equal(preflightHealthyArtifact.tool_count, 1);
const preflightHealthyJson = spawnSync(process.execPath, [
  fileURLToPath(new URL('./agent-cli.mjs', import.meta.url)),
  '--identity', 'narada.test',
  '--session', 'preflight-healthy-test',
  '--mcp-preflight-json',
], {
  env: {
    ...process.env,
    NARADA_SITE_ROOT: preflightHealthySite,
    NARADA_INTELLIGENCE_PROVIDER: 'codex-subscription',
  },
  encoding: 'utf8',
});
assert.equal(preflightHealthyJson.status, 0);
const preflightHealthyJsonPayload = JSON.parse(preflightHealthyJson.stdout);
assert.equal(preflightHealthyJsonPayload.schema, 'narada.agent_cli.mcp_preflight.v1');
assert.equal(preflightHealthyJsonPayload.mcp_operational_state, 'healthy');
assert.equal(preflightHealthyJsonPayload.mcp_server_count, 1);
assert.equal(preflightHealthyJsonPayload.tool_count, 1);
assert.equal(preflightHealthyJsonPayload.recommended_action, 'start_session');
assert.equal(preflightHealthyJsonPayload.recovery_kind, 'no_recovery');
assert.equal(preflightHealthyJsonPayload.handoffs.mcp_preflight_read, 'narada-agent-cli --identity narada.test --session preflight-healthy-test --mcp-preflight-read');
assert.equal(preflightHealthyJsonPayload.artifact_path, preflightHealthyArtifactPath);
const preflightHealthyArtifactAfterJson = JSON.parse(readFileSync(preflightHealthyArtifactPath, 'utf8'));
assert.deepEqual(readMcpPreflightArtifact({
  artifactDir: join(preflightHealthySite, '.narada', 'runtime', 'agent-cli', 'mcp-preflight'),
  session: 'preflight-healthy-test',
  identity: 'narada.test',
  siteRoot: preflightHealthySite,
}), {
  artifact_path: preflightHealthyArtifactPath,
  generated_at: preflightHealthyArtifactAfterJson.generated_at,
  mcp_operational_state: 'healthy',
  mcp_startup_failure_count: 0,
  mcp_startup_failures: [],
  mcp_startup_failure_summary: '0',
  mcp_runtime_fault_count: 0,
  mcp_runtime_faults: [],
  mcp_runtime_fault_summary: '0',
  mcp_server_count: 1,
  tool_count: 1,
  session: 'preflight-healthy-test',
  identity: 'narada.test',
  site_root: preflightHealthySite,
  recommended_action: 'start_session',
  recommended_action_display: 'start session',
  recommended_command: null,
  recovery_kind: 'no_recovery',
  recovery_kind_display: 'no recovery',
  recovery_primary_command: null,
  recovery_followup_command: null,
  handoffs: {
    mcp_preflight_read: 'narada-agent-cli --identity narada.test --session preflight-healthy-test --mcp-preflight-read',
    mcp_preflight_read_json: 'narada-agent-cli --identity narada.test --session preflight-healthy-test --mcp-preflight-read-json',
    mcp_preflight_diagnostics: 'narada-agent-cli --identity narada.test --session preflight-healthy-test --mcp-preflight-diagnostics --mcp-preflight-diagnostics-filter all',
    mcp_preflight_diagnostics_json: 'narada-agent-cli --identity narada.test --session preflight-healthy-test --mcp-preflight-diagnostics-json --mcp-preflight-diagnostics-filter all',
  },
});
const preflightHealthyReadJson = spawnSync(process.execPath, [
  fileURLToPath(new URL('./agent-cli.mjs', import.meta.url)),
  '--identity', 'narada.test',
  '--session', 'preflight-healthy-test',
  '--mcp-preflight-read-json',
], {
  env: {
    ...process.env,
    NARADA_SITE_ROOT: preflightHealthySite,
    NARADA_INTELLIGENCE_PROVIDER: 'codex-subscription',
  },
  encoding: 'utf8',
});
assert.equal(preflightHealthyReadJson.status, 0);
const preflightHealthyReadJsonPayload = JSON.parse(preflightHealthyReadJson.stdout);
assert.equal(preflightHealthyReadJsonPayload.schema, 'narada.agent_cli.mcp_preflight_read.v1');
assert.equal(preflightHealthyReadJsonPayload.found, true);
assert.equal(preflightHealthyReadJsonPayload.recommended_action, 'start_session');
assert.equal(preflightHealthyReadJsonPayload.handoffs.mcp_preflight_read_json, 'narada-agent-cli --identity narada.test --session preflight-healthy-test --mcp-preflight-read-json');
assert.equal(existsSync(join(preflightHealthySite, '.narada', 'crew', 'nars-sessions', 'preflight-healthy-test')), false);
const linkedEventPath = join(preflightHealthySite, '.narada', 'crew', 'nars-sessions', 'preflight-link-helper-test', 'session.jsonl');
mkdirSync(join(preflightHealthySite, '.narada', 'crew', 'nars-sessions', 'preflight-link-helper-test'), { recursive: true });
const linkedPayload = recordMcpPreflightArtifactLinkage({
  sessionPath: linkedEventPath,
  preflightArtifact: readMcpPreflightArtifact({
    artifactDir: join(preflightHealthySite, '.narada', 'runtime', 'agent-cli', 'mcp-preflight'),
    session: 'preflight-healthy-test',
    identity: 'narada.test',
    siteRoot: preflightHealthySite,
  }),
});
assert.equal(linkedPayload.artifact_path, preflightHealthyArtifactPath);
const linkedEntries = readFileSync(linkedEventPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
assert.equal(linkedEntries.at(-1).event, 'mcp_preflight_artifact_linked');
assert.equal(linkedEntries.at(-1).artifact_path, preflightHealthyArtifactPath);
rmSync(preflightHealthySite, { recursive: true, force: true });

const preflightDegradedSite = mkdtempSync(join(tmpdir(), 'narada-agent-cli-preflight-degraded-'));
mkdirSync(join(preflightDegradedSite, '.ai', 'mcp'), { recursive: true });
const preflightDegradedServerPath = join(preflightDegradedSite, 'degraded-mcp-server.mjs');
writeFileSync(preflightDegradedServerPath, `
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
writeFileSync(join(preflightDegradedSite, '.ai', 'mcp', 'degraded-mcp.json'), `${JSON.stringify({
  mcpServers: {
    degraded: {
      transport: 'stdio',
      command: 'node',
      args: [preflightDegradedServerPath],
    },
  },
}, null, 2)}\n`, 'utf8');
const preflightDegraded = spawnSync(process.execPath, [
  fileURLToPath(new URL('./agent-cli.mjs', import.meta.url)),
  '--identity', 'narada.test',
  '--session', 'preflight-degraded-test',
  '--mcp-preflight',
], {
  env: {
    ...process.env,
    NARADA_SITE_ROOT: preflightDegradedSite,
    NARADA_INTELLIGENCE_PROVIDER: 'codex-subscription',
  },
  encoding: 'utf8',
});
assert.equal(preflightDegraded.status, 2);
assert.equal(preflightDegraded.stdout.includes('MCP servers'), true);
assert.equal(preflightDegraded.stdout.includes('MCP state'), true);
assert.equal(preflightDegraded.stdout.includes('startup_degraded'), true);
assert.equal(preflightDegraded.stdout.includes('MCP startup failures'), true);
assert.equal(preflightDegraded.stdout.includes('1 (degraded:mcp_stdout_pollution)'), true);
assert.equal(preflightDegraded.stdout.includes('review startup diagnostics'), true);
const preflightDegradedArtifactPath = join(preflightDegradedSite, '.narada', 'runtime', 'agent-cli', 'mcp-preflight', 'preflight-degraded-test.json');
assert.equal(preflightDegraded.stdout.includes('Preflight review'), true);
assert.equal(preflightDegraded.stdout.includes('narada-agent-cli --identity narada.test --session preflight-degraded-test --mcp-preflight-read'), true);
assert.equal(preflightDegraded.stdout.includes('Artifact'), true);
assert.equal(preflightDegraded.stdout.includes(preflightDegradedArtifactPath), true);
assert.equal(existsSync(preflightDegradedArtifactPath), true);
const preflightDegradedArtifact = JSON.parse(readFileSync(preflightDegradedArtifactPath, 'utf8'));
assert.equal(preflightDegradedArtifact.schema, 'narada.agent_cli.mcp_preflight_artifact.v1');
assert.equal(preflightDegradedArtifact.mcp_operational_state, 'startup_degraded');
assert.equal(preflightDegradedArtifact.mcp_startup_failure_summary, '1 (degraded:mcp_stdout_pollution)');
assert.equal(preflightDegradedArtifact.mcp_server_count, 0);
assert.equal(preflightDegradedArtifact.tool_count, 0);
const preflightDegradedJson = spawnSync(process.execPath, [
  fileURLToPath(new URL('./agent-cli.mjs', import.meta.url)),
  '--identity', 'narada.test',
  '--session', 'preflight-degraded-test',
  '--mcp-preflight-json',
], {
  env: {
    ...process.env,
    NARADA_SITE_ROOT: preflightDegradedSite,
    NARADA_INTELLIGENCE_PROVIDER: 'codex-subscription',
  },
  encoding: 'utf8',
});
assert.equal(preflightDegradedJson.status, 2);
const preflightDegradedJsonPayload = JSON.parse(preflightDegradedJson.stdout);
assert.equal(preflightDegradedJsonPayload.schema, 'narada.agent_cli.mcp_preflight.v1');
assert.equal(preflightDegradedJsonPayload.mcp_operational_state, 'startup_degraded');
assert.equal(preflightDegradedJsonPayload.mcp_startup_failure_summary, '1 (degraded:mcp_stdout_pollution)');
assert.equal(preflightDegradedJsonPayload.mcp_server_count, 0);
assert.equal(preflightDegradedJsonPayload.tool_count, 0);
assert.equal(preflightDegradedJsonPayload.recommended_action, 'review_startup_diagnostics');
assert.equal(preflightDegradedJsonPayload.recovery_kind, 'startup_diagnostic_review');
assert.equal(preflightDegradedJsonPayload.handoffs.mcp_preflight_read, 'narada-agent-cli --identity narada.test --session preflight-degraded-test --mcp-preflight-read');
assert.equal(preflightDegradedJsonPayload.artifact_path, preflightDegradedArtifactPath);
const preflightDegradedRead = spawnSync(process.execPath, [
  fileURLToPath(new URL('./agent-cli.mjs', import.meta.url)),
  '--identity', 'narada.test',
  '--session', 'preflight-degraded-test',
  '--mcp-preflight-read',
], {
  env: {
    ...process.env,
    NARADA_SITE_ROOT: preflightDegradedSite,
    NARADA_INTELLIGENCE_PROVIDER: 'codex-subscription',
  },
  encoding: 'utf8',
});
assert.equal(preflightDegradedRead.status, 0);
assert.equal(preflightDegradedRead.stdout.includes('review startup diagnostics'), true);
assert.equal(preflightDegradedRead.stdout.includes('narada-agent-cli --identity narada.test --session preflight-degraded-test --mcp-preflight-read'), true);
assert.equal(existsSync(join(preflightDegradedSite, '.narada', 'crew', 'nars-sessions', 'preflight-degraded-test')), false);
rmSync(preflightDegradedSite, { recursive: true, force: true });

const preflightInventoryRoot = mkdtempSync(join(tmpdir(), 'narada-agent-cli-preflight-inventory-'));
const preflightInventoryArtifactDir = join(preflightInventoryRoot, '.narada', 'runtime', 'agent-cli', 'mcp-preflight');
mkdirSync(preflightInventoryArtifactDir, { recursive: true });
writeFileSync(join(preflightInventoryArtifactDir, 'preflight-healthy.json'), `${JSON.stringify({
  schema: 'narada.agent_cli.mcp_preflight_artifact.v1',
  session: 'preflight-healthy',
  identity: 'narada.test',
  site_root: preflightInventoryRoot,
  generated_at: '2026-06-15T10:00:00.000Z',
  mcp_operational_state: 'healthy',
  mcp_startup_failure_count: 0,
  mcp_startup_failure_summary: '0',
  mcp_runtime_fault_count: 0,
  mcp_runtime_fault_summary: '0',
  mcp_server_count: 2,
  tool_count: 5,
}, null, 2)}\n`, 'utf8');
writeFileSync(join(preflightInventoryArtifactDir, 'preflight-degraded.json'), `${JSON.stringify({
  schema: 'narada.agent_cli.mcp_preflight_artifact.v1',
  session: 'preflight-degraded',
  identity: 'narada.test',
  site_root: preflightInventoryRoot,
  generated_at: '2026-06-15T10:05:00.000Z',
  mcp_operational_state: 'startup_degraded',
  mcp_startup_failure_count: 1,
  mcp_startup_failure_summary: '1 (degraded:mcp_stdout_pollution)',
  mcp_runtime_fault_count: 0,
  mcp_runtime_fault_summary: '0',
  mcp_server_count: 0,
  tool_count: 0,
}, null, 2)}\n`, 'utf8');
const preflightInventoryRun = spawnSync(process.execPath, [
  fileURLToPath(new URL('./agent-cli.mjs', import.meta.url)),
  '--identity', 'narada.test',
  '--session', 'preflight-inventory-scan',
  '--mcp-preflight-inventory',
], {
  env: { ...process.env, NARADA_SITE_ROOT: preflightInventoryRoot },
  encoding: 'utf8',
});
assert.equal(preflightInventoryRun.status, 0);
assert.equal(preflightInventoryRun.stdout.includes('Preflight artifacts'), true);
assert.equal(preflightInventoryRun.stdout.includes('MCP states'), true);
assert.equal(preflightInventoryRun.stdout.includes('Recommended actions'), true);
assert.equal(preflightInventoryRun.stdout.includes('Recovery kinds'), true);
assert.equal(preflightInventoryRun.stdout.includes('preflight-degraded'), true);
assert.equal(preflightInventoryRun.stdout.includes('startup_degraded'), true);
assert.equal(preflightInventoryRun.stdout.includes('review startup diagnostics'), true);
assert.equal(preflightInventoryRun.stdout.includes('narada-agent-cli --identity narada.test --session preflight-degraded --mcp-preflight-read'), true);
assert.equal(existsSync(join(preflightInventoryRoot, '.narada', 'crew', 'nars-sessions', 'preflight-inventory-scan')), false);
const preflightInventoryJsonRun = spawnSync(process.execPath, [
  fileURLToPath(new URL('./agent-cli.mjs', import.meta.url)),
  '--identity', 'narada.test',
  '--session', 'preflight-inventory-json',
  '--mcp-preflight-inventory-json',
], {
  env: { ...process.env, NARADA_SITE_ROOT: preflightInventoryRoot },
  encoding: 'utf8',
});
assert.equal(preflightInventoryJsonRun.status, 0);
const preflightInventoryJson = JSON.parse(preflightInventoryJsonRun.stdout);
assert.equal(preflightInventoryJson.schema, 'narada.agent_cli.mcp_preflight_inventory.v1');
assert.equal(preflightInventoryJson.site_root, preflightInventoryRoot);
assert.equal(preflightInventoryJson.preflight_artifact_count, 2);
assert.deepEqual(preflightInventoryJson.summary.mcp_operational_state_counts, { healthy: 1, startup_degraded: 1 });
assert.deepEqual(preflightInventoryJson.summary.recommended_action_counts, { review_startup_diagnostics: 1, start_session: 1 });
assert.deepEqual(preflightInventoryJson.summary.recovery_kind_counts, { no_recovery: 1, startup_diagnostic_review: 1 });
assert.equal(preflightInventoryJson.workflow_groups.review_startup_diagnostics.display, 'review startup diagnostics');
assert.equal(preflightInventoryJson.groups.mcp_state.startup_degraded[0].session, 'preflight-degraded');
assert.equal(preflightInventoryJson.groups.recommended_action.start_session[0].session, 'preflight-healthy');
assert.equal(preflightInventoryJson.artifacts[0].session, 'preflight-degraded');
assert.equal(preflightInventoryJson.artifacts[0].recommended_action, 'review_startup_diagnostics');
assert.equal(preflightInventoryJson.artifacts[1].session, 'preflight-healthy');
const preflightInventoryFilteredJsonRun = spawnSync(process.execPath, [
  fileURLToPath(new URL('./agent-cli.mjs', import.meta.url)),
  '--identity', 'narada.test',
  '--session', 'preflight-inventory-filtered-json',
  '--mcp-preflight-inventory-json',
  '--mcp-preflight-filter', 'mcp_state',
  '--mcp-preflight-match', 'startup_degraded',
], {
  env: { ...process.env, NARADA_SITE_ROOT: preflightInventoryRoot },
  encoding: 'utf8',
});
assert.equal(preflightInventoryFilteredJsonRun.status, 0);
const preflightInventoryFilteredJson = JSON.parse(preflightInventoryFilteredJsonRun.stdout);
assert.equal(preflightInventoryFilteredJson.preflight_filter, 'mcp_state:startup_degraded');
assert.equal(preflightInventoryFilteredJson.preflight_artifact_count, 1);
assert.equal(preflightInventoryFilteredJson.total_preflight_artifact_count, 2);
assert.equal(preflightInventoryFilteredJson.artifacts[0].session, 'preflight-degraded');
const preflightActionsRun = spawnSync(process.execPath, [
  fileURLToPath(new URL('./agent-cli.mjs', import.meta.url)),
  '--identity', 'narada.test',
  '--session', 'preflight-actions-scan',
  '--mcp-preflight-actions',
], {
  env: { ...process.env, NARADA_SITE_ROOT: preflightInventoryRoot },
  encoding: 'utf8',
});
assert.equal(preflightActionsRun.status, 0);
assert.equal(preflightActionsRun.stdout.includes('Action queue'), true);
assert.equal(preflightActionsRun.stdout.includes('review startup diagnostics'), true);
assert.equal(preflightActionsRun.stdout.includes('start session'), true);
assert.equal(preflightActionsRun.stdout.includes('preflight-degraded'), true);
assert.equal(preflightActionsRun.stdout.includes('preflight-healthy'), true);
assert.equal(existsSync(join(preflightInventoryRoot, '.narada', 'crew', 'nars-sessions', 'preflight-actions-scan')), false);
const preflightActionsJsonRun = spawnSync(process.execPath, [
  fileURLToPath(new URL('./agent-cli.mjs', import.meta.url)),
  '--identity', 'narada.test',
  '--session', 'preflight-actions-json',
  '--mcp-preflight-actions-json',
], {
  env: { ...process.env, NARADA_SITE_ROOT: preflightInventoryRoot },
  encoding: 'utf8',
});
assert.equal(preflightActionsJsonRun.status, 0);
const preflightActionsJson = JSON.parse(preflightActionsJsonRun.stdout);
assert.equal(preflightActionsJson.schema, 'narada.agent_cli.mcp_preflight_actions.v1');
assert.equal(preflightActionsJson.site_root, preflightInventoryRoot);
assert.equal(preflightActionsJson.preflight_artifact_count, 2);
assert.equal(preflightActionsJson.total_preflight_artifact_count, 2);
assert.deepEqual(preflightActionsJson.summary.recommended_action_counts, { review_startup_diagnostics: 1, start_session: 1 });
assert.deepEqual(preflightActionsJson.summary.recovery_kind_counts, { no_recovery: 1, startup_diagnostic_review: 1 });
assert.equal(preflightActionsJson.workflow_groups.review_startup_diagnostics.sessions[0].session, 'preflight-degraded');
assert.equal(preflightActionsJson.workflow_groups.start_session.sessions[0].session, 'preflight-healthy');
assert.equal(preflightActionsJson.actions[0].session, 'preflight-degraded');
const preflightActionsFilteredJsonRun = spawnSync(process.execPath, [
  fileURLToPath(new URL('./agent-cli.mjs', import.meta.url)),
  '--identity', 'narada.test',
  '--session', 'preflight-actions-filtered-json',
  '--mcp-preflight-actions-json',
  '--mcp-preflight-filter', 'recommended_action',
  '--mcp-preflight-match', 'start_session',
], {
  env: { ...process.env, NARADA_SITE_ROOT: preflightInventoryRoot },
  encoding: 'utf8',
});
assert.equal(preflightActionsFilteredJsonRun.status, 0);
const preflightActionsFilteredJson = JSON.parse(preflightActionsFilteredJsonRun.stdout);
assert.equal(preflightActionsFilteredJson.preflight_filter, 'recommended_action:start_session');
assert.equal(preflightActionsFilteredJson.preflight_artifact_count, 1);
assert.equal(preflightActionsFilteredJson.total_preflight_artifact_count, 2);
assert.equal(preflightActionsFilteredJson.actions[0].session, 'preflight-healthy');
const preflightRecoveryRun = spawnSync(process.execPath, [
  fileURLToPath(new URL('./agent-cli.mjs', import.meta.url)),
  '--identity', 'narada.test',
  '--session', 'preflight-recovery-scan',
  '--mcp-preflight-recovery',
], {
  env: { ...process.env, NARADA_SITE_ROOT: preflightInventoryRoot },
  encoding: 'utf8',
});
assert.equal(preflightRecoveryRun.status, 0);
assert.equal(preflightRecoveryRun.stdout.includes('Recovery queue'), true);
assert.equal(preflightRecoveryRun.stdout.includes('review startup diagnostics'), true);
assert.equal(preflightRecoveryRun.stdout.includes('preflight-degraded'), true);
assert.equal(preflightRecoveryRun.stdout.includes('preflight-healthy'), false);
assert.equal(existsSync(join(preflightInventoryRoot, '.narada', 'crew', 'nars-sessions', 'preflight-recovery-scan')), false);
const preflightRecoveryJsonRun = spawnSync(process.execPath, [
  fileURLToPath(new URL('./agent-cli.mjs', import.meta.url)),
  '--identity', 'narada.test',
  '--session', 'preflight-recovery-json',
  '--mcp-preflight-recovery-json',
], {
  env: { ...process.env, NARADA_SITE_ROOT: preflightInventoryRoot },
  encoding: 'utf8',
});
assert.equal(preflightRecoveryJsonRun.status, 0);
const preflightRecoveryJson = JSON.parse(preflightRecoveryJsonRun.stdout);
assert.equal(preflightRecoveryJson.schema, 'narada.agent_cli.mcp_preflight_recovery.v1');
assert.equal(preflightRecoveryJson.site_root, preflightInventoryRoot);
assert.equal(preflightRecoveryJson.preflight_artifact_count, 1);
assert.equal(preflightRecoveryJson.total_preflight_artifact_count, 2);
assert.deepEqual(preflightRecoveryJson.summary.recommended_action_counts, { review_startup_diagnostics: 1 });
assert.deepEqual(preflightRecoveryJson.summary.recovery_kind_counts, { startup_diagnostic_review: 1 });
assert.equal(preflightRecoveryJson.workflow_groups.review_startup_diagnostics.sessions[0].session, 'preflight-degraded');
assert.equal(preflightRecoveryJson.artifacts[0].session, 'preflight-degraded');
const preflightRecoveryFilteredJsonRun = spawnSync(process.execPath, [
  fileURLToPath(new URL('./agent-cli.mjs', import.meta.url)),
  '--identity', 'narada.test',
  '--session', 'preflight-recovery-filtered-json',
  '--mcp-preflight-recovery-json',
  '--mcp-preflight-filter', 'recommended_action',
  '--mcp-preflight-match', 'review_startup_diagnostics',
], {
  env: { ...process.env, NARADA_SITE_ROOT: preflightInventoryRoot },
  encoding: 'utf8',
});
assert.equal(preflightRecoveryFilteredJsonRun.status, 0);
const preflightRecoveryFilteredJson = JSON.parse(preflightRecoveryFilteredJsonRun.stdout);
assert.equal(preflightRecoveryFilteredJson.preflight_filter, 'recommended_action:review_startup_diagnostics');
assert.equal(preflightRecoveryFilteredJson.preflight_artifact_count, 1);
assert.equal(preflightRecoveryFilteredJson.artifacts[0].session, 'preflight-degraded');
rmSync(preflightInventoryRoot, { recursive: true, force: true });

const preflightDiagnosticsRoot = mkdtempSync(join(tmpdir(), 'narada-agent-cli-preflight-diagnostics-'));
const preflightDiagnosticsArtifactDir = join(preflightDiagnosticsRoot, '.narada', 'runtime', 'agent-cli', 'mcp-preflight');
mkdirSync(preflightDiagnosticsArtifactDir, { recursive: true });
writeFileSync(join(preflightDiagnosticsArtifactDir, 'preflight-startup.json'), `${JSON.stringify({
  schema: 'narada.agent_cli.mcp_preflight_artifact.v1',
  session: 'preflight-startup',
  identity: 'narada.test',
  site_root: preflightDiagnosticsRoot,
  generated_at: '2026-06-15T11:00:00.000Z',
  mcp_operational_state: 'startup_degraded',
  mcp_startup_failure_count: 1,
  mcp_startup_failures: [{
    schema: 'narada.agent_cli.mcp_startup_diagnostic.v0',
    code: 'mcp_stdout_pollution',
    message: 'MCP server startup emitted banner text',
    phase: 'initialize_or_tools_list',
    server_name: 'startup-server',
    stdout_pollution: ['banner line'],
    stderr: [],
  }],
  mcp_startup_failure_summary: '1 (degraded:mcp_stdout_pollution)',
  mcp_runtime_fault_count: 0,
  mcp_runtime_faults: [],
  mcp_runtime_fault_summary: '0',
  mcp_server_count: 0,
  tool_count: 0,
}, null, 2)}\n`, 'utf8');
writeFileSync(join(preflightDiagnosticsArtifactDir, 'preflight-runtime.json'), `${JSON.stringify({
  schema: 'narada.agent_cli.mcp_preflight_artifact.v1',
  session: 'preflight-runtime',
  identity: 'narada.test',
  site_root: preflightDiagnosticsRoot,
  generated_at: '2026-06-15T11:05:00.000Z',
  mcp_operational_state: 'runtime_faulted',
  mcp_startup_failure_count: 0,
  mcp_startup_failures: [],
  mcp_startup_failure_summary: '0',
  mcp_runtime_fault_count: 1,
  mcp_runtime_faults: [{
    schema: 'narada.agent_cli.mcp_runtime_diagnostic.v0',
    code: 'mcp_runtime_fault',
    message: 'MCP tool call reset connection',
    server_name: 'runtime-server',
    tool_name: 'fs_stat',
  }],
  mcp_runtime_fault_summary: '1 (runtime-server:fs_stat)',
  mcp_server_count: 1,
  tool_count: 3,
}, null, 2)}\n`, 'utf8');
const preflightDiagnosticsRun = spawnSync(process.execPath, [
  fileURLToPath(new URL('./agent-cli.mjs', import.meta.url)),
  '--identity', 'narada.test',
  '--session', 'preflight-diagnostics-scan',
  '--mcp-preflight-diagnostics',
], {
  env: { ...process.env, NARADA_SITE_ROOT: preflightDiagnosticsRoot },
  encoding: 'utf8',
});
assert.equal(preflightDiagnosticsRun.status, 0);
assert.equal(preflightDiagnosticsRun.stdout.includes('Diagnostics filter'), true);
assert.equal(preflightDiagnosticsRun.stdout.includes('Diagnostic codes'), true);
assert.equal(preflightDiagnosticsRun.stdout.includes('startup-server'), true);
assert.equal(preflightDiagnosticsRun.stdout.includes('runtime-server/fs_stat mcp_runtime_fault'), true);
assert.equal(preflightDiagnosticsRun.stdout.includes('narada-agent-cli --identity narada.test --session preflight-runtime --mcp-preflight-diagnostics --mcp-preflight-diagnostics-filter all'), true);
assert.equal(existsSync(join(preflightDiagnosticsRoot, '.narada', 'crew', 'nars-sessions', 'preflight-diagnostics-scan')), false);
const preflightDiagnosticsJsonRun = spawnSync(process.execPath, [
  fileURLToPath(new URL('./agent-cli.mjs', import.meta.url)),
  '--identity', 'narada.test',
  '--session', 'preflight-diagnostics-json',
  '--mcp-preflight-diagnostics-json',
], {
  env: { ...process.env, NARADA_SITE_ROOT: preflightDiagnosticsRoot },
  encoding: 'utf8',
});
assert.equal(preflightDiagnosticsJsonRun.status, 0);
const preflightDiagnosticsJson = JSON.parse(preflightDiagnosticsJsonRun.stdout);
assert.equal(preflightDiagnosticsJson.schema, 'narada.agent_cli.mcp_preflight_diagnostics.v1');
assert.equal(preflightDiagnosticsJson.site_root, preflightDiagnosticsRoot);
assert.equal(preflightDiagnosticsJson.preflight_artifact_count, 2);
assert.equal(preflightDiagnosticsJson.total_preflight_artifact_count, 2);
assert.equal(preflightDiagnosticsJson.diagnostics_filter, 'all');
assert.equal(preflightDiagnosticsJson.summary.diagnostic_count, 2);
assert.deepEqual(preflightDiagnosticsJson.summary.diagnostic_lane_counts, { startup: 1, runtime: 1 });
assert.deepEqual(preflightDiagnosticsJson.summary.diagnostic_code_counts, { mcp_runtime_fault: 1, mcp_stdout_pollution: 1 });
assert.equal(preflightDiagnosticsJson.workflow_groups.review_runtime_diagnostics.sessions[0].session, 'preflight-runtime');
assert.equal(preflightDiagnosticsJson.workflow_groups.review_startup_diagnostics.sessions[0].session, 'preflight-startup');
assert.equal(preflightDiagnosticsJson.artifacts[0].session, 'preflight-runtime');
assert.equal(preflightDiagnosticsJson.diagnostics[0].session, 'preflight-runtime');
const preflightDiagnosticsRuntimeJsonRun = spawnSync(process.execPath, [
  fileURLToPath(new URL('./agent-cli.mjs', import.meta.url)),
  '--identity', 'narada.test',
  '--session', 'preflight-diagnostics-runtime-json',
  '--mcp-preflight-diagnostics-json',
  '--mcp-preflight-diagnostics-filter', 'runtime',
], {
  env: { ...process.env, NARADA_SITE_ROOT: preflightDiagnosticsRoot },
  encoding: 'utf8',
});
assert.equal(preflightDiagnosticsRuntimeJsonRun.status, 0);
const preflightDiagnosticsRuntimeJson = JSON.parse(preflightDiagnosticsRuntimeJsonRun.stdout);
assert.equal(preflightDiagnosticsRuntimeJson.diagnostics_filter, 'runtime');
assert.equal(preflightDiagnosticsRuntimeJson.preflight_artifact_count, 1);
assert.equal(preflightDiagnosticsRuntimeJson.summary.diagnostic_count, 1);
assert.deepEqual(preflightDiagnosticsRuntimeJson.summary.diagnostic_lane_counts, { runtime: 1 });
assert.equal(preflightDiagnosticsRuntimeJson.artifacts[0].session, 'preflight-runtime');
assert.equal(preflightDiagnosticsRuntimeJson.diagnostics[0].diagnostic_code, 'mcp_runtime_fault');
rmSync(preflightDiagnosticsRoot, { recursive: true, force: true });

assert.equal(packageJson.narada.package_role, 'nars_client_projection');
assert.equal(packageJson.narada.runtime_server_owner, '@narada2/agent-runtime-server');
assert.equal(packageJson.bin['narada-agent-cli'], './bin/narada-agent-cli.mjs');
assert.equal(packageJson.bin['agent-runtime-server'], undefined);
assert.equal(packageJson.narada.compatibility_bins, undefined);
assert.equal(packageJson.narada.private_carrier_substrate, undefined);
assert.equal(packageJson.exports['./nars-attach-client'], './src/nars-attach-client.mjs');
assert.equal(packageJson.exports['./runtime-server-shim'], undefined);
assert.equal(packageJson.narada.temporary_runtime_exports, undefined);
const operatorConversationFrame = createOperatorConversationFrame('  hello operator  ');
assert.equal(operatorConversationFrame.method, 'conversation.send');
assert.equal(operatorConversationFrame.params.message, '  hello operator  ');
assert.equal(operatorConversationFrame.params.source, 'programmatic_operator');
assert.equal(operatorConversationFrame.params.source_id, 'agent-runtime-server.operator_terminal');
assert.equal(createOperatorConversationFrame('{"looks":"like json"}').method, 'conversation.send');
assert.equal(createOperatorConversationFrame('   '), null);
const explicitJsonControlFrame = createExplicitJsonControlFrame('/json {"id":"close-1","method":"session.close","params":{}}');
assert.equal(explicitJsonControlFrame.frame.method, 'session.close');
assert.equal(createExplicitJsonControlFrame('{"id":"not-explicit"}'), null);
assert.equal(createExplicitJsonControlFrame('/json').error, 'usage: /json <control-frame-json>');
assert.equal(createExplicitJsonControlFrame('/json []').error, '/json payload must be a JSON object control frame');
assert.equal(createExplicitJsonControlFrame('/json {').error.startsWith('/json invalid JSON:'), true);
assert.equal(createProjectedSlashCommandAction('/help').kind, 'local_help');
assert.equal(createProjectedSlashCommandAction('/status').frame.method, 'session.status');
assert.equal(createProjectedSlashCommandAction('/health').frame.method, 'session.health');
assert.equal(createProjectedSlashCommandAction('/events').frame.method, 'session.events.subscribe');
assert.equal(createProjectedSlashCommandAction('/recovery').frame.method, 'session.recovery');
assert.equal(createProjectedSlashCommandAction('/ops').frame.method, 'session.operations');
const projectedOpsSyncFrame = createProjectedSlashCommandAction('/ops sync --target D:/tmp/session-sync --direction bidirectional --dry-run --delete').frame;
assert.equal(projectedOpsSyncFrame.method, 'session.sync');
assert.deepEqual(projectedOpsSyncFrame.params, {
  target: 'D:/tmp/session-sync',
  direction: 'bidirectional',
  dry_run: true,
  delete: true,
});
assert.equal(resolveNarsAttachEndpoint({ attachEndpoint: 'ws://127.0.0.1:1/events' }, {}), 'ws://127.0.0.1:1/events');
assert.equal(resolveNarsAttachEndpoint({}, { NARADA_EVENT_STREAM_URL: 'ws://127.0.0.1:2/events' }), 'ws://127.0.0.1:2/events');
assert.deepEqual(createNarsEventSubscribeFrame({ id: 'events-test', maxReplay: 7 }), {
  id: 'events-test',
  method: 'session.events.subscribe',
  params: { include_replay: true, max_replay: 7 },
});
assert.deepEqual(normalizeNarsAttachIncomingEvent({
  schema: 'narada.nars.events.envelope.v1',
  event: 'session_event',
  payload: { event: 'assistant_message', content: 'hello' },
}), { event: 'assistant_message', content: 'hello' });
const attachSentFrames = [];
const attachSink = createNarsAttachControlSink({ sendFrame: (frame) => attachSentFrames.push(frame) });
assert.equal(attachSink.write(`${JSON.stringify({ id: 'status-attach', method: 'session.status', params: {} })}\n`), true);
assert.deepEqual(attachSentFrames.at(-1), { id: 'status-attach', method: 'session.status', params: {} });
assert.equal(createProjectedSlashCommandAction('/observers').frame.method, 'observers.status');
assert.equal(createProjectedSlashCommandAction('/observer mute').frame.method, 'observer.mute');
assert.equal(createProjectedSlashCommandAction('/exit').frame.method, 'session.close');
assert.equal(createProjectedSlashCommandAction('exit').frame.method, 'session.close');
assert.equal(createProjectedSlashCommandAction('/goal ship it').frame.method, 'carrier.command.execute');
assert.equal(createProjectedSlashCommandAction('/goal ship it').frame.params.command, '/goal');
assert.equal(createProjectedSlashCommandAction('/goal ship it').frame.params.value, 'ship it');
assert.equal(createProjectedSlashCommandAction('/stats --today').frame.params.command, '/stats');
assert.equal(createProjectedSlashCommandAction('/model gpt-test').frame.params.command, '/model');
assert.equal(createProjectedSlashCommandAction('/model gpt-test').frame.params.value, 'gpt-test');
assert.equal(createProjectedSlashCommandAction('/thinking high').frame.params.command, '/thinking');
assert.equal(createProjectedSlashCommandAction('/tool-output off').frame.params.command, '/tool-output');
assert.equal(createProjectedSlashCommandAction('/tools fs_read').frame.params.command, '/tools');
assert.equal(createProjectedSlashCommandAction('/queue clear').frame.params.command, '/queue');
assert.equal(createProjectedSlashCommandAction('/queue clear').frame.params.value, 'clear');
for (const command of ['/goal', '/stats', '/model', '/thinking', '/tool-output', '/tools', '/queue']) {
  assert.equal(commandTokens().includes(command), true, command);
  assert.equal(createProjectedSlashCommandAction(`${command} test`).frame.method, 'carrier.command.execute', command);
}
assert.equal(createProjectedSlashCommandAction('/does-not-exist').message, 'Unknown command: /does-not-exist. Type /help.');
assert.equal(createProjectedSlashCommandAction('run startup sequence'), null);
assert.equal(createOperatorPrompt(), 'operator > ');
const rewrittenProjectedPrompt = rewriteSubmittedOperatorPromptForTest({ line: 'run startup sequence', agentId: 'sonar.resident', columns: 80, now: '2026-06-21T03:04:00.000Z' });
assert.equal(stripAnsiForTest(rewrittenProjectedPrompt).includes('operator -> sonar.resident: run startup sequence 2026-06-21T03:04:00'), true);
assert.equal(rewrittenProjectedPrompt.startsWith('\x1b[1A\r\x1b[K\n'), true);
const wrappedProjectedPrompt = stripAnsiForTest(rewriteSubmittedOperatorPromptForTest({ line: 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda', agentId: 'sonar.resident', columns: 50, now: '2026-06-21T03:04:00.000Z' }));
assert.equal(wrappedProjectedPrompt.includes('\n  iota kappa lambda 2026-06-21T03:04:00'), true);
const projectedWriterOutput = new PassThrough();
projectedWriterOutput.isTTY = true;
let projectedWriterText = '';
projectedWriterOutput.setEncoding('utf8');
projectedWriterOutput.on('data', (chunk) => { projectedWriterText += chunk; });
let projectedWriterClearCount = 0;
const projectedWriter = createProjectedOutputWriter({ composer: { clear() { projectedWriterClearCount += 1; }, render() {} }, interactive: true, output: projectedWriterOutput });
projectedWriter('first line');
const projectedWriterAfterClear = projectedWriterText;
projectedWriter('preserved line', { preserveCurrentLine: true, prompt: false });
assert.equal(projectedWriterClearCount, 1);
assert.equal(projectedWriterAfterClear, 'first line');
assert.equal(projectedWriterText.slice(projectedWriterAfterClear.length), 'preserved line');
const renderStateForTest = { streamedTurns: new Set(), timestamps: false };
const renderedStartupForTest = renderOperatorEvent({
  event: 'session_started',
  agent_id: 'narada.test',
  session_id: 'carrier_test',
  provider: 'codex-subscription',
  model: 'gpt-5.5',
  thinking: 'medium',
  stream: true,
  goal_display: 'not set',
  mcp_server_count: 1,
  mcp_operational_state: 'healthy',
  mcp_servers: [{ name: 'narada-test-agent-context', tool_count: 8 }],
  tool_count: 8,
  tool_outputs: 'shown',
}, renderStateForTest).join('\n');
assert.match(renderedStartupForTest, /Identity\s+narada\.test/);
assert.match(renderedStartupForTest, /narada-test-agent-context\s+8 tools/);
assert.match(renderedStartupForTest, /Tool outputs\s+shown/);
assert.deepEqual(renderOperatorEvent({ event: 'tool_call', tool: 'agent_context_startup_sequence' }, renderStateForTest), ['agent -> agent-cli: agent_context_startup_sequence']);
assert.deepEqual(renderOperatorEvent({ event: 'tool_result', tool: 'agent_context_startup_sequence', status: 'success' }, renderStateForTest), ['agent-cli -> agent: agent_context_startup_sequence ok']);
assert.deepEqual(renderOperatorEvent({ event: 'tool_result', tool: 'agent_context_startup_sequence', status: 'completed' }, renderStateForTest), ['agent-cli -> agent: agent_context_startup_sequence ok']);
const sharedColorStyleForTest = createTerminalStyle({ enabled: true });
assert.equal(renderOperatorEvent({ event: 'tool_call', tool: 'agent_context_startup_sequence' }, { streamedTurns: new Set(), timestamps: false, style: { ...sharedColorStyleForTest, agent: sharedColorStyleForTest.label, ok: sharedColorStyleForTest.success } })[0].includes('\x1b['), true);
assert.deepEqual(renderOperatorEvent({ event: 'tool_call', agent_id: 'narada.test', tool: 'fs_read_file', argument_summary: 'path=D:/code/file.md' }, { streamedTurns: new Set(), now: '2026-06-21T03:04:00.000Z' }), ['narada.test -> agent-cli: fs_read_file(path=D:/code/file.md) 2026-06-21T03:04:00']);
assert.deepEqual(renderOperatorEvent({ event: 'tool_result', agent_id: 'narada.test', tool: 'fs_read_file', status: 'error', error: 'not found' }, { streamedTurns: new Set(), now: '2026-06-21T03:05:00.000Z' }), ['agent-cli -> narada.test: fs_read_file error · error=not found 2026-06-21T03:05:00']);
assert.deepEqual(renderOperatorEvent({ event: 'tool_result', agent_id: 'narada.test', tool: 'fs_read_file', status: 'failed', error: { code: 'ENOENT', message: 'file not found' } }, { streamedTurns: new Set(), now: '2026-06-21T03:06:00.000Z' }), ['agent-cli -> narada.test: fs_read_file failed · error=ENOENT: file not found 2026-06-21T03:06:00']);
assert.deepEqual(renderOperatorEvent({ event: 'tool_call', agent_id: 'narada.test', tool: 'fs_read_file', argument_summary: 'alpha beta gamma delta epsilon zeta eta theta iota' }, { streamedTurns: new Set(), terminalColumns: 56, timestamps: false }), ['narada.test -> agent-cli: fs_read_file(alpha beta gamma', '  delta epsilon zeta eta theta', '  iota)']);
const projectedCompactToolRows = renderOperatorEvent({ event: 'tool_call', agent_id: 'narada.test', tool: 'graph_mail_query', argument_summary: '{"mailbox_id":"staccato.narada@global-maxima.com","limit":10,"select":"id,subject,from,toRecipients,receivedDateTime,sentDateTime,isRead,importance,parentFolderId,conversationId,bodyPreview"}' }, { streamedTurns: new Set(), terminalColumns: 80, timestamps: false });
assert.match(projectedCompactToolRows[0], /^narada\.test -> agent-cli: graph_mail_query\(/);
assert.ok(projectedCompactToolRows.length > 1);
assert.equal(projectedCompactToolRows.slice(1).every((line) => /^  \S/.test(line)), true);
assert.equal(renderOperatorEvent({ event: 'tool_result', agent_id: 'narada.test', tool: 'fs_read_file', status: 'failed', error: { code: 'ENOENT', message: 'file not found' } }, { streamedTurns: new Set(), now: '2026-06-21T03:06:00.000Z' }).join('\n').includes('[object Object]'), false);
assert.deepEqual(renderOperatorEvent({ event: 'session_recovery', operational_posture_display: 'healthy', recommended_action_display: 'review session summary' }, renderStateForTest), ['agent-cli: recovery healthy; action review session summary']);
assert.deepEqual(renderOperatorEvent({ event: 'session_operations', operation: { operation_event_summary: '2 running' } }, renderStateForTest), ['agent-cli: operations 2 running']);
assert.deepEqual(renderOperatorEvent({ event: 'session_sync', success: true, direction: 'upload', target: 'D:/tmp/session-sync' }, renderStateForTest), ['agent-cli: session sync succeeded; upload D:/tmp/session-sync']);
assert.deepEqual(renderOperatorEvent({ event: 'observer_status', observer_muted: true }, renderStateForTest), ['agent-cli: observers muted']);
assert.deepEqual(renderOperatorEvent({ event: 'carrier_command_result', command: '/model', terminal_state: 'completed', message: 'Model set to gpt-test' }, renderStateForTest), ['agent-cli: Model set to gpt-test']);
const toolOutputRenderStateForTest = { streamedTurns: new Set(), timestamps: false };
assert.deepEqual(renderOperatorEvent({ event: 'tool_call', tool: 'visible_tool' }, toolOutputRenderStateForTest), ['agent -> agent-cli: visible_tool']);
assert.deepEqual(renderOperatorEvent({ event: 'carrier_command_result', command: '/tool-output', terminal_state: 'completed', message: 'Tool call outputs are hidden in the displayed transcript.', fields: { tool_outputs: 'hidden' } }, toolOutputRenderStateForTest), ['agent-cli: Tool call outputs are hidden in the displayed transcript.']);
assert.deepEqual(renderOperatorEvent({ event: 'tool_call', tool: 'hidden_tool' }, toolOutputRenderStateForTest), []);
assert.deepEqual(renderOperatorEvent({ event: 'tool_result', tool: 'hidden_tool', status: 'success' }, toolOutputRenderStateForTest), []);
assert.deepEqual(renderOperatorEvent({ event: 'carrier_command_result', command: '/tool-output', terminal_state: 'completed', message: 'Tool call outputs are shown in the displayed transcript.', fields: { tool_outputs: 'shown' } }, toolOutputRenderStateForTest), ['agent-cli: Tool call outputs are shown in the displayed transcript.']);
assert.deepEqual(renderOperatorEvent({ event: 'tool_call', tool: 'visible_again' }, toolOutputRenderStateForTest), ['agent -> agent-cli: visible_again']);
assert.deepEqual(renderOperatorEvent({ event: 'carrier_command_result', command: '/tools', terminal_state: 'completed', message: 'Tools\n\nnone' }, renderStateForTest), ['agent-cli:', '  Tools', '  ', '  none']);
assert.deepEqual(renderOperatorEvent({ event_kind: 'carrier_host_command_started', payload: { command_text: 'echo hidden' } }, renderStateForTest), []);
assert.deepEqual(renderOperatorEvent({ event_kind: 'carrier_host_command_completed', payload: { command_text: 'echo host-ok', terminal_state: 'completed', exit_code: 0, stdout: 'host-ok\n' } }, renderStateForTest), ['carrier host:', '  $ echo host-ok', '  status: completed (0)', '  host-ok']);
assert.deepEqual(renderOperatorEvent({ event: 'carrier_host_command_failed', command_text: 'fail-for-test', terminal_state: 'failed', exit_code: 7, stderr: 'bad\n' }, renderStateForTest), ['carrier host:', '  $ fail-for-test', '  status: failed (7)', '  bad']);
assert.deepEqual(renderOperatorEvent({ event: 'directive_received', directive_id: 'dir_heartbeat', terminal_state: 'accepted', source: 'system_directive' }, renderStateForTest), []);
assert.deepEqual(renderOperatorEvent({ event: 'directive_complete', directive_id: 'dir_heartbeat', terminal_state: 'completed_without_provider', source: 'system_directive' }, renderStateForTest), []);
assert.deepEqual(renderOperatorEvent({ event: 'turn_started', agent_id: 'narada.test' }, { streamedTurns: new Set(), now: '2026-06-22T13:23:00.000Z' }), ['narada.test: thinking...']);
const thinkingAssistantRenderStateForTest = { streamedTurns: new Set(), timestamps: false };
assert.deepEqual(renderOperatorEvent({ event: 'turn_started', agent_id: 'narada.test' }, thinkingAssistantRenderStateForTest), ['narada.test: thinking...']);
assert.deepEqual(renderOperatorEvent({ event: 'assistant_message', agent_id: 'narada.test', content: 'done thinking' }, thinkingAssistantRenderStateForTest), [{ raw: '\x1b[1A\r\x1b[K', newline: false }, 'narada.test:', '  done thinking']);
const thinkingToolRenderStateForTest = { streamedTurns: new Set(), timestamps: false };
assert.deepEqual(renderOperatorEvent({ event: 'turn_started', agent_id: 'narada.test' }, thinkingToolRenderStateForTest), ['narada.test: thinking...']);
assert.deepEqual(renderOperatorEvent({ event: 'tool_call', agent_id: 'narada.test', tool: 'fs_read_file' }, thinkingToolRenderStateForTest), [{ raw: '\x1b[1A\r\x1b[K', newline: false }, 'narada.test -> agent-cli: fs_read_file']);
const thinkingHiddenToolRenderStateForTest = { streamedTurns: new Set(), timestamps: false, toolOutputs: 'hidden' };
assert.deepEqual(renderOperatorEvent({ event: 'turn_started', agent_id: 'narada.test' }, thinkingHiddenToolRenderStateForTest), ['narada.test: thinking...']);
assert.deepEqual(renderOperatorEvent({ event: 'tool_call', agent_id: 'narada.test', tool: 'hidden_tool' }, thinkingHiddenToolRenderStateForTest), [{ raw: '\x1b[1A\r\x1b[K', newline: false }]);
assert.deepEqual(formatTerminalMessageBlockLines({ label: 'agent', lines: ['line one', 'line two'] }), ['agent:', '  line one', '  line two']);
assert.deepEqual(renderOperatorEvent({ event: 'assistant_message', agent_id: 'narada.test', content: 'line one\nline two' }, renderStateForTest), ['narada.test:', '  line one', '  line two']);
assert.deepEqual(renderOperatorEvent({ event: 'assistant_message', agent_id: 'narada.test', content: '# Heading\n- facade_only\n| A | B |\n|---|---|\n| one | `two` |' }, renderStateForTest), ['narada.test:', '  Heading', '  • facade_only', '  A    B  ', '  one  two']);
assert.deepEqual(renderOperatorEvent({ event: 'assistant_message', agent_id: 'narada.test', content: 'line one\nline two' }, { streamedTurns: new Set(), now: '2026-06-22T13:24:00.000Z' }), ['narada.test:', '  line one', '  line two 2026-06-22T13:24:00']);
const renderedInlineCodeForTest = renderOperatorEvent({ event: 'assistant_message', agent_id: 'narada.test', content: 'Use `narada-sonar` now.' }, { streamedTurns: new Set(), style: { ...sharedColorStyleForTest, agent: sharedColorStyleForTest.label, ok: sharedColorStyleForTest.success } });
assert.equal(stripAnsiForTest(renderedInlineCodeForTest.join('\n')).includes('Use narada-sonar now.'), true);
assert.equal(renderedInlineCodeForTest.join('\n').includes('\x1b[90mnarada-sonar\x1b[0m'), true);
assert.deepEqual(renderOperatorEvent({ event: 'assistant_message', agent_id: 'narada.test', content: 'alpha beta gamma delta epsilon zeta eta theta iota kappa' }, { streamedTurns: new Set(), terminalColumns: 50, timestamps: false }), ['narada.test:', '  alpha beta gamma delta epsilon zeta eta theta', '  iota kappa']);
const streamRenderStateForTest = { streamedTurns: new Set(), timestamps: false };
assert.deepEqual(renderOperatorEvent({ event: 'assistant_message_stream', turn_id: 'turn_stream_test', agent_id: 'narada.test', content: 'line one\nline two' }, streamRenderStateForTest), [{ raw: 'narada.test:\n  line one\n  line two', newline: false }]);
assert.deepEqual(renderOperatorEvent({ event: 'assistant_message_stream', turn_id: 'turn_stream_timestamp_test', agent_id: 'narada.test', content: 'line one\nline two' }, { streamedTurns: new Set(), now: '2026-06-22T13:25:00.000Z' }), [{ raw: 'narada.test:\n  line one\n  line two', newline: false }]);
const renderedStreamInlineCodeForTest = renderOperatorEvent({ event: 'assistant_message_stream', turn_id: 'turn_stream_code_test', agent_id: 'narada.test', content: 'Use `narada-sonar` now.' }, { streamedTurns: new Set(), style: { ...sharedColorStyleForTest, agent: sharedColorStyleForTest.label, ok: sharedColorStyleForTest.success } });
assert.equal(stripAnsiForTest(renderedStreamInlineCodeForTest[0].raw).includes('Use narada-sonar now.'), true);
assert.equal(renderedStreamInlineCodeForTest[0].raw.includes('\x1b[90mnarada-sonar\x1b[0m'), true);
assert.deepEqual(renderOperatorEvent({ event: 'assistant_message_stream', turn_id: 'turn_stream_wrap_test', agent_id: 'narada.test', content: 'alpha beta gamma delta epsilon zeta eta theta iota kappa' }, { streamedTurns: new Set(), terminalColumns: 50, timestamps: false }), [{ raw: 'narada.test:\n  alpha beta gamma delta epsilon zeta eta theta\n  iota kappa', newline: false }]);
const streamFinalSuffixStateForTest = { streamedTurns: new Set(), terminalColumns: 80, timestamps: false };
assert.deepEqual(renderOperatorEvent({ event: 'assistant_message_stream', turn_id: 'turn_stream_suffix_test', agent_id: 'narada.test', content: 'Latest checkpoint says the prior task was completed, with one local code guard patch in' }, streamFinalSuffixStateForTest), [{ raw: 'narada.test:\n  Latest checkpoint says the prior task was completed, with one local code guard\n  patch in', newline: false }]);
assert.deepEqual(renderOperatorEvent({ event: 'assistant_message', turn_id: 'turn_stream_suffix_test', agent_id: 'narada.test', content: 'Latest checkpoint says the prior task was completed, with one local code guard patch in `scripts/narada-sonar-legacy.mjs` and no blockers.' }, streamFinalSuffixStateForTest), ['\n  scripts/narada-sonar-legacy.mjs and no blockers.']);
assert.deepEqual(renderOperatorEvent({ event: 'assistant_message_stream', turn_id: 'turn_stream_test', agent_id: 'narada.test', content: '\nline three' }, streamRenderStateForTest), [{ raw: '\n  line three', newline: false }]);
assert.deepEqual(renderOperatorEvent({ event: 'tool_call', tool: 'agent_context_startup_sequence' }, streamRenderStateForTest), ['\nagent -> agent-cli: agent_context_startup_sequence']);
assert.deepEqual(renderOperatorEvent({ event: 'assistant_message_stream', turn_id: 'turn_stream_test', agent_id: 'narada.test', content: 'after tool' }, streamRenderStateForTest), [{ raw: 'narada.test:\n  after tool', newline: false }]);

assert.equal(createProjectedSlashCommandAction('/model gpt-projected-test').frame.params.value, 'gpt-projected-test');
assert.equal(createProjectedSlashCommandAction('/thinking high').frame.params.value, 'high');
assert.equal(createProjectedSlashCommandAction('/tool-output off').frame.params.value, 'off');

function stopChildProcess(proc) {
  if (!proc || proc.exitCode !== null) return Promise.resolve();
  return new Promise((resolveStop) => {
    proc.once('exit', () => resolveStop());
  });
}
function stripAnsiForTest(text) {
  return String(text).replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

function delayForTest(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

