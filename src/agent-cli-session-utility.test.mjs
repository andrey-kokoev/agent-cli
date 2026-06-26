import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync, mkdirSync, mkdtempSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { formatPreflightWorkflowEvent, formatPreflightWorkflowSummary, formatRuntimeMcpFaultEvent, formatRuntimeMcpFaultSummary, formatSessionWorkflowEvent, formatSessionWorkflowSummary, formatStartupMcpEvent, formatStartupMcpSummary, formatWrapperStatusEvent } from './runtime-server-events.mjs';
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

assert.deepEqual(parseArgs(['--stream', '--model', 'gpt-x']), { stream: true, model: 'gpt-x' });
assert.deepEqual(parseArgs(['--no-stream', '--thinking', 'low']), { stream: false, thinking: 'low' });
assert.deepEqual(parseArgs(['--color', '--no-color']), { color: false });
assert.deepEqual(parseArgs(['--message', 'hello']), { removedConversationArgs: ['--message'] });
assert.deepEqual(parseArgs(['--message-file', 'message.txt']), { removedConversationArgs: ['--message-file'] });
assert.deepEqual(parseArgs(['--operator-directive', '--system-directive']), { removedConversationArgs: ['--operator-directive', '--system-directive'] });
assert.deepEqual(parseArgs(['--enable-startup-system-directive']), { removedConversationArgs: ['--enable-startup-system-directive'] });
assert.deepEqual(parseArgs(['--startup-system-directive', 'run startup sequence', '--startup-system-directive-delay-ms', '10000']), {
  removedConversationArgs: ['--startup-system-directive', '--startup-system-directive-delay-ms'],
});
assert.deepEqual(parseArgs(['--no-startup-system-directive']), { removedConversationArgs: ['--no-startup-system-directive'] });
assert.deepEqual(parseArgs(['--interactive-after-message']), { removedConversationArgs: ['--interactive-after-message'] });
assert.deepEqual(parseArgs(['--auto-approve']), { removedConversationArgs: ['--auto-approve'] });
assert.deepEqual(parseArgs(['--control-jsonl', '.narada/control.jsonl']), { removedConversationArgs: ['--control-jsonl'] });
assert.deepEqual(parseArgs(['--mcp-preflight']), { mcpPreflight: true });
assert.deepEqual(parseArgs(['--mcp-preflight-json']), { mcpPreflightJson: true });
assert.deepEqual(parseArgs(['--mcp-preflight-read']), { mcpPreflightRead: true });
assert.deepEqual(parseArgs(['--mcp-preflight-read-json']), { mcpPreflightReadJson: true });
assert.deepEqual(parseArgs(['--mcp-preflight-inventory']), { mcpPreflightInventory: true });
assert.deepEqual(parseArgs(['--mcp-preflight-inventory-json']), { mcpPreflightInventoryJson: true });
assert.deepEqual(parseArgs(['--mcp-preflight-actions']), { mcpPreflightActions: true });
assert.deepEqual(parseArgs(['--mcp-preflight-actions-json']), { mcpPreflightActionsJson: true });
assert.deepEqual(parseArgs(['--mcp-preflight-recovery']), { mcpPreflightRecovery: true });
assert.deepEqual(parseArgs(['--mcp-preflight-recovery-json']), { mcpPreflightRecoveryJson: true });
assert.deepEqual(parseArgs(['--mcp-preflight-diagnostics']), { mcpPreflightDiagnostics: true });
assert.deepEqual(parseArgs(['--mcp-preflight-diagnostics-json']), { mcpPreflightDiagnosticsJson: true });
assert.deepEqual(parseArgs(['--mcp-preflight-filter', 'mcp_state', '--mcp-preflight-match', 'startup_degraded']), { mcpPreflightFilter: 'mcp_state', mcpPreflightMatch: 'startup_degraded' });
assert.deepEqual(parseArgs(['--mcp-preflight-diagnostics-filter', 'runtime']), { mcpPreflightDiagnosticsFilter: 'runtime' });
assert.deepEqual(parseArgs(['--session-inventory']), { sessionInventory: true });
assert.deepEqual(parseArgs(['--session-inventory-json']), { sessionInventoryJson: true });
assert.deepEqual(parseArgs(['--session-inventory-operations']), { sessionInventoryOperations: true });
assert.deepEqual(parseArgs(['--session-inventory-operations-json']), { sessionInventoryOperationsJson: true });
assert.deepEqual(parseArgs(['--session-inventory-host-commands']), { sessionInventoryHostCommands: true });
assert.deepEqual(parseArgs(['--session-inventory-host-commands-json']), { sessionInventoryHostCommandsJson: true });
assert.deepEqual(parseArgs(['--session-inventory-actions']), { sessionInventoryActions: true });
assert.deepEqual(parseArgs(['--session-inventory-actions-json']), { sessionInventoryActionsJson: true });
assert.deepEqual(parseArgs(['--session-inventory-recovery']), { sessionInventoryRecovery: true });
assert.deepEqual(parseArgs(['--session-inventory-recovery-json']), { sessionInventoryRecoveryJson: true });
assert.deepEqual(parseArgs(['--session-inventory-events']), { sessionInventoryEvents: true });
assert.deepEqual(parseArgs(['--session-inventory-events-json']), { sessionInventoryEventsJson: true });
assert.deepEqual(parseArgs(['--session-operations']), { sessionOperations: true });
assert.deepEqual(parseArgs(['--session-operations-json']), { sessionOperationsJson: true });
assert.deepEqual(parseArgs(['--session-recovery']), { sessionRecovery: true });
assert.deepEqual(parseArgs(['--session-recovery-json']), { sessionRecoveryJson: true });
assert.deepEqual(parseArgs(['--session-sync']), { sessionSync: true });
assert.deepEqual(parseArgs(['--session-sync-json']), { sessionSyncJson: true });
assert.deepEqual(parseArgs(['--session-sync-target', '/tmp/site-sync-target']), { sessionSyncTarget: '/tmp/site-sync-target' });
assert.deepEqual(parseArgs(['--session-sync-target', 'file:///tmp/site-sync-file-target']), { sessionSyncTarget: 'file:///tmp/site-sync-file-target' });
assert.deepEqual(parseArgs(['--session-sync-target', 'site:dev']), { sessionSyncTarget: 'site:dev' });
assert.deepEqual(parseArgs(['--session-sync-target', 'cloud:beta']), { sessionSyncTarget: 'cloud:beta' });
assert.deepEqual(parseArgs(['--session-sync-direction', 'bidirectional']), { sessionSyncDirection: 'bidirectional' });
assert.deepEqual(parseArgs(['--session-sync-dry-run']), { sessionSyncDryRun: true });
assert.deepEqual(parseArgs(['--session-sync-delete']), { sessionSyncDelete: true });
assert.equal(isAgentCliUtilityCommandMode(parseArgs(['--session-read'])), true);
assert.equal(isAgentCliUtilityCommandMode(parseArgs(['--mcp-preflight'])), true);
assert.equal(isAgentCliUtilityCommandMode(parseArgs(['--message', 'hello'])), false);
assert.equal(isAgentCliUtilityCommandMode(parseArgs(['--identity', 'narada.test'])), false);

const sessionSyncSourceRoot = mkdtempSync(join(tmpdir(), 'agent-cli-session-sync-source-'));
const sessionSyncTargetRoot = mkdtempSync(join(tmpdir(), 'agent-cli-session-sync-target-'));
const sessionSyncSession = 'operator-session-sync';
const sourceSessionRoot = join(sessionSyncSourceRoot, 'agent-sessions');
const sourceCarrierRoot = join(sessionSyncSourceRoot, '.narada', 'crew', 'nars-sessions', sessionSyncSession);
const targetSessionRoot = join(sessionSyncTargetRoot, 'agent-sessions');
const targetCarrierRoot = join(sessionSyncTargetRoot, '.narada', 'crew', 'nars-sessions', sessionSyncSession);
const sessionSyncNaradaDir = join(sessionSyncSourceRoot, '.narada');
mkdirSync(sourceSessionRoot, { recursive: true });
mkdirSync(sourceCarrierRoot, { recursive: true });
mkdirSync(targetSessionRoot, { recursive: true });
mkdirSync(targetCarrierRoot, { recursive: true });

writeFileSync(join(sourceSessionRoot, 'session.jsonl'), `${JSON.stringify({
  schema: 'narada.session_test.v1',
  event: 'created',
}, null, 2)}\n`, 'utf8');
writeFileSync(join(sourceCarrierRoot, 'heartbeat.json'), `${JSON.stringify({
  schema: 'narada.heartbeat_test.v1',
  session: sessionSyncSession,
}, null, 2)}\n`, 'utf8');

await withSilencedStdout(async () => {
const sessionSyncUploadCode = await runSessionSync({
  session: sessionSyncSession,
  target: sessionSyncTargetRoot,
  direction: 'upload',
  siteRoot: sessionSyncSourceRoot,
  naradaDir: sessionSyncNaradaDir,
});
assert.equal(sessionSyncUploadCode, 0);
assert.equal(existsSync(join(targetSessionRoot, 'session.jsonl')), true);
assert.equal(existsSync(join(targetCarrierRoot, 'heartbeat.json')), true);

const sessionSyncMatchAtime = new Date('2026-01-01T12:00:00.000Z');
const sourceSessionFile = join(targetSessionRoot, 'session.jsonl');
const sourceCarrierFile = join(targetCarrierRoot, 'heartbeat.json');
writeFileSync(sourceSessionFile, 'first-write', 'utf8');
writeFileSync(sourceCarrierFile, 'payload-one', 'utf8');
utimesSync(sourceSessionFile, sessionSyncMatchAtime, sessionSyncMatchAtime);
utimesSync(sourceCarrierFile, sessionSyncMatchAtime, sessionSyncMatchAtime);
writeFileSync(join(sessionSyncSourceRoot, 'agent-sessions', 'session.jsonl'), 'first-write', 'utf8');
writeFileSync(join(sourceCarrierRoot, 'heartbeat.json'), 'payload-one', 'utf8');
utimesSync(join(sessionSyncSourceRoot, 'agent-sessions', 'session.jsonl'), sessionSyncMatchAtime, sessionSyncMatchAtime);
utimesSync(join(sourceCarrierRoot, 'heartbeat.json'), sessionSyncMatchAtime, sessionSyncMatchAtime);
const targetCarrierBeforeDryRun = readFileSync(sourceCarrierFile, 'utf8');
const targetSessionBeforeDryRun = readFileSync(sourceSessionFile, 'utf8');
const sessionSyncDryRunCode = await runSessionSync({
  session: sessionSyncSession,
  target: sessionSyncTargetRoot,
  direction: 'bidirectional',
  siteRoot: sessionSyncSourceRoot,
  dryRun: true,
});
assert.equal(sessionSyncDryRunCode, 0);
const targetCarrierAfterDryRun = readFileSync(sourceCarrierFile, 'utf8');
assert.equal(targetCarrierAfterDryRun, targetCarrierBeforeDryRun);
const targetSessionAfterDryRun = readFileSync(sourceSessionFile, 'utf8');
assert.equal(targetSessionAfterDryRun, targetSessionBeforeDryRun);
const sessionSyncEqualHashCode = await runSessionSync({
  session: sessionSyncSession,
  target: sessionSyncTargetRoot,
  direction: 'bidirectional',
  siteRoot: sessionSyncSourceRoot,
});
assert.equal(sessionSyncEqualHashCode, 0);

writeFileSync(join(targetSessionRoot, 'orphan-session-entry.json'), 'stale-session-entry');
writeFileSync(join(targetCarrierRoot, 'orphan-carrier-entry.json'), 'stale-carrier-entry');

const sessionSyncDeleteMissingDefaultCode = await runSessionSync({
  session: sessionSyncSession,
  target: sessionSyncTargetRoot,
  direction: 'upload',
  siteRoot: sessionSyncSourceRoot,
  naradaDir: sessionSyncNaradaDir,
});
assert.equal(sessionSyncDeleteMissingDefaultCode, 0);
assert.equal(existsSync(join(targetSessionRoot, 'orphan-session-entry.json')), true);
assert.equal(existsSync(join(targetCarrierRoot, 'orphan-carrier-entry.json')), true);

const sessionSyncDeleteMissingCode = await runSessionSync({
  session: sessionSyncSession,
  target: sessionSyncTargetRoot,
  direction: 'upload',
  siteRoot: sessionSyncSourceRoot,
  deleteMissing: true,
  naradaDir: sessionSyncNaradaDir,
});
assert.equal(sessionSyncDeleteMissingCode, 0);
assert.equal(existsSync(join(targetSessionRoot, 'orphan-session-entry.json')), false);
assert.equal(existsSync(join(targetCarrierRoot, 'orphan-carrier-entry.json')), false);

const sessionSyncOperatorEvents = readPersistedSessionEvents({ session: sessionSyncSession, naradaDir: sessionSyncNaradaDir });
const requestedSessionSyncEvents = sessionSyncOperatorEvents.filter((entry) => entry.event === 'session_sync_requested');
const completedSessionSyncEvents = sessionSyncOperatorEvents.filter((entry) => entry.event === 'session_sync_completed');
assert.equal(requestedSessionSyncEvents.length >= 1, true);
assert.equal(completedSessionSyncEvents.length, requestedSessionSyncEvents.length);
const sessionSyncFirstRequest = requestedSessionSyncEvents[requestedSessionSyncEvents.length - 1];
assert.equal(sessionSyncFirstRequest?.event, 'session_sync_requested');
assert.equal(sessionSyncFirstRequest?.method, 'session.sync');
assert.equal(sessionSyncFirstRequest?.transport, 'cli');
assert.equal(typeof sessionSyncFirstRequest?.operation_id, 'string');
assert.equal(sessionSyncFirstRequest?.operation_status, 'requested');
assert.equal(typeof sessionSyncFirstRequest?.requested_at, 'string');
assert.equal(
  completedSessionSyncEvents.find((entry) => entry.operation_id === sessionSyncFirstRequest?.operation_id)?.event,
  'session_sync_completed',
);
const completedSessionSyncEntry = completedSessionSyncEvents.find(
  (entry) => entry.operation_id === sessionSyncFirstRequest?.operation_id,
);
assert.equal(completedSessionSyncEntry?.event, 'session_sync_completed');
assert.equal(completedSessionSyncEntry?.operation_status, 'succeeded');
assert.equal(typeof completedSessionSyncEntry?.requested_at, 'string');
assert.equal(typeof completedSessionSyncEntry?.completed_at, 'string');
assert.equal(typeof completedSessionSyncEntry?.duration_ms, 'number');
assert.equal(completedSessionSyncEntry?.duration_ms >= 0, true);

writeFileSync(join(sourceCarrierRoot, 'heartbeat.json'), 'payload-two', 'utf8');
utimesSync(join(sourceCarrierRoot, 'heartbeat.json'), sessionSyncMatchAtime, sessionSyncMatchAtime);
const sessionSyncConflictCode = await runSessionSync({
  session: sessionSyncSession,
  target: sessionSyncTargetRoot,
  direction: 'bidirectional',
  siteRoot: sessionSyncSourceRoot,
  naradaDir: sessionSyncNaradaDir,
});
assert.equal(sessionSyncConflictCode, 1);
assert.equal(existsSync(join(targetSessionRoot, '.session-sync-staging')), false);
assert.equal(existsSync(join(targetCarrierRoot, '.session-sync-staging')), false);
assert.equal(existsSync(join(sourceSessionRoot, '.session-sync-staging')), false);
assert.equal(existsSync(join(sourceCarrierRoot, '.session-sync-staging')), false);

const sessionSyncMissingAliasEnvKey = 'MISSING_ALIAS_FOR_TEST';
const sessionSyncUnresolvedAliasCode = await runSessionSync({
  session: sessionSyncSession,
  target: `site:${sessionSyncMissingAliasEnvKey}`,
  siteRoot: sessionSyncSourceRoot,
  naradaDir: sessionSyncNaradaDir,
});
assert.equal(sessionSyncUnresolvedAliasCode, 1);
const sessionSyncUnresolvedCloudAliasCode = await runSessionSync({
  session: sessionSyncSession,
  target: `cloud:${sessionSyncMissingAliasEnvKey}`,
  siteRoot: sessionSyncSourceRoot,
  naradaDir: sessionSyncNaradaDir,
});
assert.equal(sessionSyncUnresolvedCloudAliasCode, 1);
const sessionSyncAliasSourceRoot = mkdtempSync(join(tmpdir(), 'agent-cli-session-sync-alias-source-'));
const sessionSyncAliasTargetRoot = mkdtempSync(join(tmpdir(), 'agent-cli-session-sync-alias-target-'));
const sessionSyncAliasSession = 'operator-session-sync-alias';
const alias = 'team-alpha';
const sessionSyncAliasNaradaDir = join(sessionSyncAliasSourceRoot, '.narada');
const aliasEnvKey = `NARADA_SITE_ROOT_${alias.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`;
const priorAliasEnv = process.env[aliasEnvKey];
process.env[aliasEnvKey] = sessionSyncAliasTargetRoot;

const aliasSourceSessionRoot = join(sessionSyncAliasSourceRoot, 'agent-sessions');
const aliasSourceCarrierRoot = join(sessionSyncAliasSourceRoot, '.narada', 'crew', 'nars-sessions', sessionSyncAliasSession);
const aliasTargetSessionRoot = join(sessionSyncAliasTargetRoot, 'agent-sessions');
const aliasTargetCarrierRoot = join(sessionSyncAliasTargetRoot, '.narada', 'crew', 'nars-sessions', sessionSyncAliasSession);
mkdirSync(aliasSourceSessionRoot, { recursive: true });
mkdirSync(aliasSourceCarrierRoot, { recursive: true });
mkdirSync(aliasTargetSessionRoot, { recursive: true });
mkdirSync(aliasTargetCarrierRoot, { recursive: true });
writeFileSync(
  join(aliasSourceSessionRoot, 'session.jsonl'),
  `${JSON.stringify(
    {
      schema: 'narada.session_test.v1',
      event: 'created',
    },
    null,
    2,
  )}\n`,
  'utf8',
);

const sessionSyncAliasUploadCode = await runSessionSync({
  session: sessionSyncAliasSession,
  target: `site:${alias}`,
  direction: 'upload',
  siteRoot: sessionSyncAliasSourceRoot,
  naradaDir: sessionSyncAliasNaradaDir,
});
assert.equal(sessionSyncAliasUploadCode, 0);
assert.equal(existsSync(join(aliasTargetSessionRoot, 'session.jsonl')), true);
const aliasSessionSyncEvents = readPersistedSessionEvents({
  session: sessionSyncAliasSession,
  naradaDir: sessionSyncAliasNaradaDir,
});
const aliasSyncRequested = aliasSessionSyncEvents.find((entry) => entry.event === 'session_sync_requested');
assert.equal(aliasSyncRequested?.target_scheme, 'site');
assert.equal(aliasSyncRequested?.target_alias, alias);
assert.equal(aliasSyncRequested?.target_resolved_root, sessionSyncAliasTargetRoot);
if (priorAliasEnv === undefined) {
  delete process.env[aliasEnvKey];
} else {
  process.env[aliasEnvKey] = priorAliasEnv;
}
const cloudAlias = 'team-cloud';
const cloudAliasEnvKey = `NARADA_CLOUD_ROOT_${cloudAlias.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`;
const priorCloudAliasEnv = process.env[cloudAliasEnvKey];
const cloudAliasSourceRoot = mkdtempSync(join(tmpdir(), 'agent-cli-session-sync-cloud-source-'));
const cloudAliasDestinationRoot = mkdtempSync(join(tmpdir(), 'agent-cli-session-sync-cloud-destination-'));
process.env[cloudAliasEnvKey] = cloudAliasDestinationRoot;

const cloudAliasSession = 'operator-session-sync-cloud';
const cloudAliasSourceSessionRoot = join(cloudAliasSourceRoot, 'agent-sessions');
const cloudAliasSourceCarrierRoot = join(cloudAliasSourceRoot, '.narada', 'crew', 'nars-sessions', cloudAliasSession);
const cloudAliasDestSessionRoot = join(cloudAliasDestinationRoot, 'agent-sessions');
const cloudAliasDestCarrierRoot = join(cloudAliasDestinationRoot, '.narada', 'crew', 'nars-sessions', cloudAliasSession);
const cloudAliasNaradaDir = join(cloudAliasSourceRoot, '.narada');
mkdirSync(cloudAliasSourceSessionRoot, { recursive: true });
mkdirSync(cloudAliasSourceCarrierRoot, { recursive: true });
mkdirSync(cloudAliasDestSessionRoot, { recursive: true });
mkdirSync(cloudAliasDestCarrierRoot, { recursive: true });
const cloudSourceSessionFile = join(cloudAliasSourceSessionRoot, 'session.jsonl');
writeFileSync(cloudSourceSessionFile, `${JSON.stringify({
  schema: 'narada.session_test.v1',
  event: 'cloud alias created',
}, null, 2)}\n`, 'utf8');

const sessionSyncCloudAliasUploadCode = await runSessionSync({
  session: cloudAliasSession,
  target: `cloud:${cloudAlias}`,
  direction: 'upload',
  siteRoot: cloudAliasSourceRoot,
  naradaDir: cloudAliasNaradaDir,
});
assert.equal(sessionSyncCloudAliasUploadCode, 0);
assert.equal(existsSync(join(cloudAliasDestSessionRoot, 'session.jsonl')), true);
const cloudSessionSyncEvents = readPersistedSessionEvents({
  session: cloudAliasSession,
  naradaDir: cloudAliasNaradaDir,
});
const cloudSyncRequested = cloudSessionSyncEvents.find((entry) => entry.event === 'session_sync_requested');
assert.equal(cloudSyncRequested?.target_scheme, 'cloud');
assert.equal(cloudSyncRequested?.target_alias, cloudAlias);
if (priorCloudAliasEnv === undefined) {
  delete process.env[cloudAliasEnvKey];
} else {
  process.env[cloudAliasEnvKey] = priorCloudAliasEnv;
}
rmSync(aliasSourceSessionRoot, { recursive: true, force: true });
rmSync(aliasSourceCarrierRoot, { recursive: true, force: true });
rmSync(aliasTargetSessionRoot, { recursive: true, force: true });
rmSync(aliasTargetCarrierRoot, { recursive: true, force: true });
rmSync(sessionSyncAliasSourceRoot, { recursive: true, force: true });
rmSync(sessionSyncAliasTargetRoot, { recursive: true, force: true });
rmSync(cloudAliasSourceSessionRoot, { recursive: true, force: true });
rmSync(cloudAliasSourceCarrierRoot, { recursive: true, force: true });
rmSync(cloudAliasDestSessionRoot, { recursive: true, force: true });
rmSync(cloudAliasDestCarrierRoot, { recursive: true, force: true });
rmSync(cloudAliasDestinationRoot, { recursive: true, force: true });
rmSync(cloudAliasSourceRoot, { recursive: true, force: true });
rmSync(sourceSessionRoot, { recursive: true, force: true });
rmSync(sourceCarrierRoot, { recursive: true, force: true });
rmSync(targetSessionRoot, { recursive: true, force: true });
rmSync(targetCarrierRoot, { recursive: true, force: true });
rmSync(sessionSyncSourceRoot, { recursive: true, force: true });
rmSync(sessionSyncTargetRoot, { recursive: true, force: true });
});

assert.deepEqual(parseArgs(['--host-command-output-read']), { hostCommandOutputRead: true });
assert.deepEqual(parseArgs(['--host-command-output-read-json']), { hostCommandOutputReadJson: true });
assert.deepEqual(parseArgs(['--host-command-output-ref', 'mcp_payload:carrier_host_command_output:test@v1']), { hostCommandOutputRef: 'mcp_payload:carrier_host_command_output:test@v1' });
assert.equal(parseColorEnv('off', true), false);
const heartbeatRoot = mkdtempSync(join(tmpdir(), 'narada-agent-cli-heartbeat-'));
const heartbeatSession = 'carrier_session_heartbeat_test';
const heartbeatRun = spawnSync(process.execPath, [
  fileURLToPath(new URL('./agent-cli.mjs', import.meta.url)),
  '--help',
  '--identity',
  'sonar.resident',
  '--session',
  heartbeatSession,
], {
  cwd: heartbeatRoot,
  env: { ...process.env, NARADA_SITE_ROOT: heartbeatRoot },
  encoding: 'utf8',
});
assert.equal(heartbeatRun.status, 0);
assert.equal(
  existsSync(join(heartbeatRoot, '.narada', 'crew', 'nars-sessions', heartbeatSession, 'heartbeat.json')),
  false,
);
rmSync(heartbeatRoot, { recursive: true, force: true });

const inventoryRoot = mkdtempSync(join(tmpdir(), 'narada-agent-cli-session-inventory-'));
const inventoryNaradaDir = join(inventoryRoot, '.narada');
const inventorySessionsDir = join(inventoryNaradaDir, 'crew', 'nars-sessions');
mkdirSync(join(inventorySessionsDir, 'healthy-session'), { recursive: true });
mkdirSync(join(inventorySessionsDir, 'faulted-session'), { recursive: true });
mkdirSync(join(inventorySessionsDir, 'healthy-session', 'host-command-output'), { recursive: true });
mkdirSync(join(inventoryNaradaDir, 'runtime', 'agent-cli', 'mcp-preflight'), { recursive: true });
writeFileSync(join(inventorySessionsDir, 'healthy-session', 'heartbeat.json'), `${JSON.stringify({
  schema: 'narada.carrier_heartbeat.v1',
  status: 'alive',
  carrier_session_id: 'healthy-session',
  agent_id: 'narada.test',
  runtime: 'agent-cli',
  mode: 'server',
  started_at: '2026-06-14T11:50:00.000Z',
  heartbeat_at: '2026-06-14T12:00:00.000Z',
}, null, 2)}\n`, 'utf8');
writeFileSync(join(inventorySessionsDir, 'faulted-session', 'heartbeat.json'), `${JSON.stringify({
  schema: 'narada.carrier_heartbeat.v1',
  status: 'alive',
  carrier_session_id: 'faulted-session',
  agent_id: 'narada.test',
  runtime: 'agent-cli',
  mode: 'server',
  started_at: '2026-06-14T11:40:00.000Z',
  heartbeat_at: '2026-06-14T11:59:00.000Z',
}, null, 2)}\n`, 'utf8');
writeFileSync(join(inventorySessionsDir, 'healthy-session', 'session.jsonl'), `${JSON.stringify(sessionEventEntry('mcp_preflight_artifact_linked', {
  artifact_path: join(inventoryNaradaDir, 'runtime', 'agent-cli', 'mcp-preflight', 'healthy-session.json'),
  generated_at: '2026-06-14T11:58:00.000Z',
  mcp_operational_state: 'healthy',
  mcp_startup_failure_summary: '0',
  mcp_runtime_fault_summary: '0',
}))}\n${JSON.stringify({ event_kind: 'directive_emission_authorized', timestamp: '2026-06-14T11:58:40.000Z', payload: { directive_kind: 'operation_heartbeat', visibility: 'record_only', operation_id: 'operation_inventory_1' } })}\n${JSON.stringify({ event_kind: 'directive_emission_rule_recorded', timestamp: '2026-06-14T11:58:41.000Z', payload: { directive_kind: 'operation_heartbeat', visibility: 'record_only', operation_id: 'operation_inventory_1' } })}\n${JSON.stringify({ event_kind: 'directive_emitted', timestamp: '2026-06-14T11:58:42.000Z', payload: { directive_kind: 'operation_heartbeat', visibility: 'record_only', operation_id: 'operation_inventory_1' } })}\n${JSON.stringify({ event_kind: 'carrier_host_command_requested', timestamp: '2026-06-14T11:59:00.000Z', payload: { command_id: 'host_command_inventory_1', command_summary: 'git status' } })}\n${JSON.stringify({ event_kind: 'carrier_host_command_admitted', timestamp: '2026-06-14T11:59:01.000Z', payload: { command_id: 'host_command_inventory_1', command_summary: 'git status' } })}\n${JSON.stringify({ event_kind: 'carrier_host_command_started', timestamp: '2026-06-14T11:59:02.000Z', payload: { command_id: 'host_command_inventory_1', command_summary: 'git status' } })}\n${JSON.stringify({ event_kind: 'carrier_host_command_completed', timestamp: '2026-06-14T11:59:03.000Z', payload: { command_id: 'host_command_inventory_1', command_summary: 'git status', terminal_state: 'completed', output_ref: { payload_ref: 'mcp_payload:carrier_host_command_output:host_command_inventory_1@v1', reader_tool: 'carrier_host_command_output_read' } } })}\n${JSON.stringify({ event_kind: 'input_completed', timestamp: '2026-06-14T12:00:01.000Z', payload: { terminal_state: 'completed' } })}\n${JSON.stringify({ event: 'session_closed', timestamp: '2026-06-14T12:00:05.000Z', request_id: 'close-healthy-1', terminal_state: 'closed' })}\n`, 'utf8');
writeFileSync(join(inventorySessionsDir, 'healthy-session', 'host-command-output', 'host_command_inventory_1.json'), `${JSON.stringify({
  schema: 'narada.carrier.host_command_output.v1',
  command_id: 'host_command_inventory_1',
  output_truncated: false,
  stdout: 'On branch main',
  stderr: '',
}, null, 2)}\n`, 'utf8');
writeFileSync(join(inventorySessionsDir, 'faulted-session', 'session.jsonl'), [
  JSON.stringify({
    event_kind: 'carrier_diagnostic_recorded',
    timestamp: '2026-06-14T11:58:30.000Z',
    payload: { server_name: 'degraded', diagnostic_code: 'mcp_stdout_pollution' },
  }),
  JSON.stringify({
    event_kind: 'carrier_diagnostic_recorded',
    timestamp: '2026-06-14T11:59:30.000Z',
    payload: { server_name: 'runtime', diagnostic_code: 'mcp_runtime_fault', tool_name: 'fs_read_file' },
  }),
  JSON.stringify({
    event: 'error',
    timestamp: '2026-06-14T11:59:40.000Z',
    request_id: null,
    code: 'invalid_json',
    message: 'Unexpected token',
  }),
  JSON.stringify({
    event: 'error',
    timestamp: '2026-06-14T11:59:41.000Z',
    request_id: 'closed-1',
    code: 'session_closed',
    message: 'Session is closed.',
  }),
  JSON.stringify({
    event: 'error',
    timestamp: '2026-06-14T11:59:42.000Z',
    request_id: null,
    code: 'request_dispatch_failed',
    message: 'dispatch failed',
  }),
  JSON.stringify({
    event: 'error',
    timestamp: '2026-06-14T11:59:43.000Z',
    request_id: 'failed-1',
    code: 'request_failed',
    message: 'request failed',
  }),
  JSON.stringify({
    event_kind: 'input_completed',
    timestamp: '2026-06-14T11:59:45.000Z',
    payload: { terminal_state: 'failed' },
  }),
  'not-json-line',
].join('\n') + '\n', 'utf8');
writeFileSync(join(inventoryNaradaDir, 'runtime', 'agent-cli', 'mcp-preflight', 'healthy-session.json'), `${JSON.stringify({
  schema: 'narada.agent_cli.mcp_preflight_artifact.v1',
  session: 'healthy-session',
  identity: 'narada.test',
  site_root: inventoryRoot,
  generated_at: '2026-06-14T11:58:00.000Z',
  mcp_operational_state: 'healthy',
  mcp_startup_failure_summary: '0',
  mcp_runtime_fault_summary: '0',
}, null, 2)}\n`, 'utf8');
const inventoryEntries = readSessionInventory({ siteRoot: inventoryRoot, naradaDir: inventoryNaradaDir });
assert.equal(inventoryEntries.length, 2);
assert.equal(filterSessionInventory(inventoryEntries, { filterKey: 'operational_posture', filterValue: 'mcp_runtime_faulted' }).length, 1);
assert.equal(filterSessionInventory(inventoryEntries, { filterKey: 'request_posture', filterValue: 'runtime_failures' }).length, 1);
assert.equal(filterSessionInventory(inventoryEntries, { filterKey: 'mcp_state', filterValue: 'healthy' }).length, 1);
const inventoryGroups = summarizeSessionInventoryGroups(inventoryEntries);
assert.equal(inventoryGroups.operational_posture.healthy[0].session, 'healthy-session');
assert.equal(inventoryGroups.operational_posture.mcp_runtime_faulted[0].session, 'faulted-session');
assert.equal(inventoryGroups.request_posture.runtime_failures[0].session, 'faulted-session');
assert.equal(inventoryGroups.mcp_state.runtime_faulted[0].session, 'faulted-session');
assert.equal(inventoryEntries[0].session, 'healthy-session');
assert.equal(inventoryEntries[0].agent_id, 'narada.test');
assert.equal(inventoryEntries[0].runtime, 'agent-cli');
assert.equal(inventoryEntries[0].mode, 'server');
assert.equal(inventoryEntries[0].started_at, '2026-06-14T11:50:00.000Z');
assert.equal(inventoryEntries[0].mcp_operational_state, 'healthy');
assert.equal(inventoryEntries[0].session_event_count, 10);
assert.equal(inventoryEntries[0].session_jsonl_parse_error_count, 0);
assert.deepEqual(inventoryEntries[0].session_jsonl_parse_error_sample, []);
assert.equal(inventoryEntries[0].last_event_kind, 'session_closed');
assert.equal(inventoryEntries[0].last_event_at, '2026-06-14T12:00:05.000Z');
assert.equal(inventoryEntries[0].last_terminal_state, 'completed');
assert.equal(inventoryEntries[0].operational_posture, 'healthy');
assert.equal(inventoryEntries[0].operational_posture_display, 'healthy');
assert.equal(inventoryEntries[0].last_lifecycle_event_kind, 'session_closed');
assert.equal(inventoryEntries[0].last_lifecycle_at, '2026-06-14T12:00:05.000Z');
assert.equal(inventoryEntries[0].last_lifecycle_state, 'closed');
assert.deepEqual(inventoryEntries[0].lifecycle_state_counts, { completed: 1, closed: 1 });
assert.equal(inventoryEntries[0].lifecycle_state_summary, '1 (closed), 1 (completed)');
assert.equal(inventoryEntries[0].request_outcome_total, 0);
assert.equal(inventoryEntries[0].request_posture, 'clean');
assert.equal(inventoryEntries[0].request_posture_display, 'clean');
assert.equal(inventoryEntries[0].operation_event_count, 3);
assert.deepEqual(inventoryEntries[0].directive_kind_counts, { operation_heartbeat: 3 });
assert.equal(inventoryEntries[0].directive_kind_summary, '3 (operation_heartbeat)');
assert.deepEqual(inventoryEntries[0].directive_visibility_counts, { record_only: 3 });
assert.equal(inventoryEntries[0].directive_visibility_summary, '3 (record_only)');
assert.deepEqual(inventoryEntries[0].operation_id_counts, { operation_inventory_1: 3 });
assert.equal(inventoryEntries[0].operation_id_summary, '3 (operation_inventory_1)');
assert.equal(inventoryEntries[0].last_operation_id, 'operation_inventory_1');
assert.equal(inventoryEntries[0].last_directive_kind, 'operation_heartbeat');
assert.equal(inventoryEntries[0].last_directive_visibility, 'record_only');
assert.equal(inventoryEntries[0].host_command_event_count, 4);
assert.deepEqual(inventoryEntries[0].host_command_terminal_state_counts, { completed: 1 });
assert.equal(inventoryEntries[0].host_command_terminal_state_summary, '1 (completed)');
assert.equal(inventoryEntries[0].last_host_command_id, 'host_command_inventory_1');
assert.equal(inventoryEntries[0].last_host_command_summary, 'git status');
assert.equal(inventoryEntries[0].last_host_command_terminal_state, 'completed');
assert.equal(inventoryEntries[0].last_host_command_output_ref, 'mcp_payload:carrier_host_command_output:host_command_inventory_1@v1');
assert.equal(inventoryEntries[0].mcp_preflight_artifact_path, join(inventoryNaradaDir, 'runtime', 'agent-cli', 'mcp-preflight', 'healthy-session.json'));
assert.equal(inventoryEntries[0].mcp_preflight_operational_state, 'healthy');
assert.equal(inventoryEntries[0].mcp_preflight_recommended_action, 'start_session');
assert.equal(inventoryEntries[0].mcp_preflight_recommended_action_display, 'start session');
assert.equal(inventoryEntries[0].mcp_preflight_recommended_command, null);
assert.equal(inventoryEntries[0].mcp_preflight_handoffs.mcp_preflight_diagnostics, 'narada-agent-cli --identity narada.test --session healthy-session --mcp-preflight-diagnostics --mcp-preflight-diagnostics-filter all');
assert.equal(inventoryEntries[0].handoffs.session_read, 'narada-agent-cli --identity narada.test --session healthy-session --session-read');
assert.equal(inventoryEntries[0].handoffs.session_recovery, 'narada-agent-cli --identity narada.test --session healthy-session --session-recovery');
assert.equal(inventoryEntries[0].handoffs.session_recovery_json, 'narada-agent-cli --identity narada.test --session healthy-session --session-recovery-json');
assert.equal(inventoryEntries[0].handoffs.host_command_output_read, 'narada-agent-cli --identity narada.test --session healthy-session --host-command-output-read --host-command-output-ref mcp_payload:carrier_host_command_output:host_command_inventory_1@v1');
assert.equal(inventoryEntries[0].recommended_action, 'review_session_summary');
assert.equal(inventoryEntries[0].recommended_command, 'narada-agent-cli --identity narada.test --session healthy-session --session-read');
assert.equal(inventoryEntries[0].recovery_kind, 'no_recovery');
assert.equal(inventoryEntries[0].recovery_primary_command, 'narada-agent-cli --identity narada.test --session healthy-session --session-read');
assert.equal(inventoryEntries[0].recovery_followup_command, null);
assert.equal(inventoryEntries[1].session, 'faulted-session');
assert.equal(inventoryEntries[1].agent_id, 'narada.test');
assert.equal(inventoryEntries[1].started_at, '2026-06-14T11:40:00.000Z');
assert.equal(inventoryEntries[1].mcp_operational_state, 'runtime_faulted');
assert.equal(inventoryEntries[1].session_event_count, 7);
assert.equal(inventoryEntries[1].session_jsonl_parse_error_count, 1);
assert.deepEqual(inventoryEntries[1].session_jsonl_parse_error_sample, [
  { line: 'not-json-line', error: 'invalid_json' },
]);
assert.equal(inventoryEntries[1].last_event_kind, 'input_completed');
assert.equal(inventoryEntries[1].last_event_at, '2026-06-14T11:59:45.000Z');
assert.equal(inventoryEntries[1].last_terminal_state, 'failed');
assert.equal(inventoryEntries[1].operational_posture, 'mcp_runtime_faulted');
assert.equal(inventoryEntries[1].operational_posture_display, 'mcp_runtime_faulted [mcp=runtime_faulted; request=runtime_failures; lifecycle=failed]');
assert.equal(inventoryEntries[1].last_lifecycle_event_kind, 'input_completed');
assert.equal(inventoryEntries[1].last_lifecycle_at, '2026-06-14T11:59:45.000Z');
assert.equal(inventoryEntries[1].last_lifecycle_state, 'failed');
assert.deepEqual(inventoryEntries[1].lifecycle_state_counts, { failed: 1 });
assert.equal(inventoryEntries[1].lifecycle_state_summary, '1 (failed)');
assert.equal(inventoryEntries[1].request_outcome_total, 4);
assert.equal(inventoryEntries[1].request_posture, 'runtime_failures');
assert.equal(inventoryEntries[1].request_posture_display, 'runtime_failures (4)');
assert.equal(inventoryEntries[1].recommended_action, 'review_runtime_diagnostics');
assert.equal(inventoryEntries[1].recommended_command, 'narada-agent-cli --identity narada.test --session faulted-session --session-recovery');
assert.equal(inventoryEntries[1].recovery_kind, 'diagnostic_review');
assert.equal(inventoryEntries[1].recovery_primary_command, 'narada-agent-cli --identity narada.test --session faulted-session --session-events --session-events-filter diagnostics --session-events-count 20');
assert.equal(inventoryEntries[1].recovery_followup_command, 'narada-agent-cli --identity narada.test --session faulted-session --session-read');
assert.deepEqual(inventoryEntries[1].request_outcome_counts, {
  dispatch_failure: 1,
  invalid_request: 1,
  rejected_closed: 1,
  request_runtime_failure: 1,
});
assert.equal(inventoryEntries[1].request_outcome_summary, '1 (dispatch_failure), 1 (invalid_request), 1 (rejected_closed), 1 (request_runtime_failure)');
assert.deepEqual(inventoryEntries[1].request_issue_counts, {
  invalid_json: 1,
  request_dispatch_failed: 1,
  request_failed: 1,
  session_closed: 1,
});
assert.equal(inventoryEntries[1].request_issue_summary, '1 (invalid_json), 1 (request_dispatch_failed), 1 (request_failed), 1 (session_closed)');
assert.equal(inventoryEntries[1].mcp_startup_failure_summary, '1 (degraded:mcp_stdout_pollution)');
assert.equal(inventoryEntries[1].mcp_runtime_fault_summary, '1 (runtime:fs_read_file)');
const sessionInventoryRun = spawnSync(process.execPath, [
  fileURLToPath(new URL('./agent-cli.mjs', import.meta.url)),
  '--session-inventory',
  '--identity',
  'sonar.resident',
  '--session',
  'inventory-scan-test',
], {
  cwd: inventoryRoot,
  env: { ...process.env, NARADA_SITE_ROOT: inventoryRoot },
  encoding: 'utf8',
});
assert.equal(sessionInventoryRun.status, 0);
assert.equal(sessionInventoryRun.stdout.includes('Carrier sessions'), true);
assert.equal(sessionInventoryRun.stdout.includes('Heartbeat states'), true);
assert.equal(sessionInventoryRun.stdout.includes('Operational posture'), true);
assert.equal(sessionInventoryRun.stdout.includes('MCP states'), true);
assert.equal(sessionInventoryRun.stdout.includes('Terminal states'), true);
assert.equal(sessionInventoryRun.stdout.includes('Lifecycle states'), true);
assert.equal(sessionInventoryRun.stdout.includes('Lifecycle outcomes'), true);
assert.equal(sessionInventoryRun.stdout.includes('Request posture'), true);
assert.equal(sessionInventoryRun.stdout.includes('Request outcomes'), true);
assert.equal(sessionInventoryRun.stdout.includes('Request issues'), true);
assert.equal(sessionInventoryRun.stdout.includes('Host command states'), true);
assert.equal(sessionInventoryRun.stdout.includes('Operation ids'), true);
assert.equal(sessionInventoryRun.stdout.includes('Host command output review'), true);
assert.equal(sessionInventoryRun.stdout.includes('Recommended actions'), true);
assert.equal(sessionInventoryRun.stdout.includes('Recommended commands'), true);
assert.equal(sessionInventoryRun.stdout.includes('Recovery primary commands'), true);
assert.equal(sessionInventoryRun.stdout.includes('Recovery followups'), true);
assert.equal(sessionInventoryRun.stdout.includes('Inventory action groups: review_runtime_diagnostics (1)'), true);
assert.equal(sessionInventoryRun.stdout.includes('healthy-session'), true);
assert.equal(sessionInventoryRun.stdout.includes('healthy'), true);
assert.equal(sessionInventoryRun.stdout.includes('faulted-session'), true);
assert.equal(sessionInventoryRun.stdout.includes('runtime_faulted'), true);
assert.equal(sessionInventoryRun.stdout.includes('degraded:mcp_stdout_pollution'), true);
assert.equal(sessionInventoryRun.stdout.includes('runtime:fs_read_file'), true);
assert.equal(sessionInventoryRun.stdout.includes('review runtime diagnostics'), true);
assert.equal(sessionInventoryRun.stdout.includes('narada-agent-cli --identity narada.test --session faulted-session --session-recovery'), true);
assert.equal(sessionInventoryRun.stdout.includes('narada-agent-cli --identity narada.test --session faulted-session --session-events --session-events-filter diagnostics --session-events-count 20'), true);
assert.equal(sessionInventoryRun.stdout.includes('narada-agent-cli --identity narada.test --session faulted-session --session-read'), true);
assert.equal(sessionInventoryRun.stdout.includes('narada-agent-cli --identity narada.test --session faulted-session --session-events --session-events-filter issues --session-events-count 20'), true);
assert.equal(existsSync(join(inventoryRoot, '.narada', 'crew', 'nars-sessions', 'inventory-scan-test')), false);
const sessionInventoryJsonRun = spawnSync(process.execPath, [
  fileURLToPath(new URL('./agent-cli.mjs', import.meta.url)),
  '--session-inventory-json',
  '--identity',
  'sonar.resident',
  '--session',
  'inventory-scan-json-test',
], {
  cwd: inventoryRoot,
  env: { ...process.env, NARADA_SITE_ROOT: inventoryRoot },
  encoding: 'utf8',
});
assert.equal(sessionInventoryJsonRun.status, 0);
const sessionInventoryJson = JSON.parse(sessionInventoryJsonRun.stdout);
assert.equal(sessionInventoryJson.schema, 'narada.agent_cli.session_inventory.v1');
assert.equal(sessionInventoryJson.site_root, inventoryRoot);
assert.equal(sessionInventoryJson.carrier_session_count, 2);
assert.deepEqual(sessionInventoryJson.summary, {
  heartbeat_status_counts: { alive: 2 },
  heartbeat_status_summary: '2 (alive)',
  operational_posture_counts: { healthy: 1, mcp_runtime_faulted: 1 },
  operational_posture_summary: '1 (healthy), 1 (mcp_runtime_faulted)',
  mcp_operational_state_counts: { healthy: 1, runtime_faulted: 1 },
  mcp_operational_state_summary: '1 (healthy), 1 (runtime_faulted)',
  last_terminal_state_counts: { completed: 1, failed: 1 },
  last_terminal_state_summary: '1 (completed), 1 (failed)',
  last_lifecycle_state_counts: { closed: 1, failed: 1 },
  last_lifecycle_state_summary: '1 (closed), 1 (failed)',
  lifecycle_outcome_counts: { closed: 1, completed: 1, failed: 1 },
  lifecycle_outcome_summary: '1 (closed), 1 (completed), 1 (failed)',
  request_posture_counts: { clean: 1, runtime_failures: 1 },
  request_posture_summary: '1 (clean), 1 (runtime_failures)',
  request_outcome_counts: {
    dispatch_failure: 1,
    invalid_request: 1,
    rejected_closed: 1,
    request_runtime_failure: 1,
  },
  request_outcome_summary: '1 (dispatch_failure), 1 (invalid_request), 1 (rejected_closed), 1 (request_runtime_failure)',
  request_issue_counts: {
    invalid_json: 1,
    request_dispatch_failed: 1,
    request_failed: 1,
    session_closed: 1,
  },
  request_issue_summary: '1 (invalid_json), 1 (request_dispatch_failed), 1 (request_failed), 1 (session_closed)',
  host_command_terminal_state_counts: { completed: 1 },
  host_command_terminal_state_summary: '1 (completed)',
  recommended_action_counts: {
    review_runtime_diagnostics: 1,
    review_session_summary: 1,
  },
  recommended_action_summary: '1 (review_runtime_diagnostics), 1 (review_session_summary)',
  recommended_command_counts: {
    'narada-agent-cli --identity narada.test --session faulted-session --session-recovery': 1,
    'narada-agent-cli --identity narada.test --session healthy-session --session-read': 1,
  },
  recommended_command_summary: '1 (narada-agent-cli --identity narada.test --session faulted-session --session-recovery), 1 (narada-agent-cli --identity narada.test --session healthy-session --session-read)',
  recovery_primary_counts: {
    'narada-agent-cli --identity narada.test --session faulted-session --session-events --session-events-filter diagnostics --session-events-count 20': 1,
    'narada-agent-cli --identity narada.test --session healthy-session --session-read': 1,
  },
  recovery_primary_summary: '1 (narada-agent-cli --identity narada.test --session faulted-session --session-events --session-events-filter diagnostics --session-events-count 20), 1 (narada-agent-cli --identity narada.test --session healthy-session --session-read)',
  recovery_followup_counts: {
    'narada-agent-cli --identity narada.test --session faulted-session --session-read': 1,
    none: 1,
  },
  recovery_followup_summary: '1 (narada-agent-cli --identity narada.test --session faulted-session --session-read), 1 (none)',
});
assert.equal(sessionInventoryJson.workflow_groups.review_session_summary.display, 'review session summary');
assert.deepEqual(sessionInventoryJson.workflow_groups.review_session_summary.recommended_command_counts, {
  'narada-agent-cli --identity narada.test --session healthy-session --session-read': 1,
});
assert.equal(sessionInventoryJson.workflow_groups.review_runtime_diagnostics.display, 'review runtime diagnostics');
assert.deepEqual(sessionInventoryJson.workflow_groups.review_runtime_diagnostics.recommended_command_counts, {
  'narada-agent-cli --identity narada.test --session faulted-session --session-recovery': 1,
});
assert.deepEqual(sessionInventoryJson.workflow_groups.review_runtime_diagnostics.recovery_primary_counts, {
  'narada-agent-cli --identity narada.test --session faulted-session --session-events --session-events-filter diagnostics --session-events-count 20': 1,
});
assert.deepEqual(sessionInventoryJson.workflow_groups.review_runtime_diagnostics.recovery_followup_counts, {
  'narada-agent-cli --identity narada.test --session faulted-session --session-read': 1,
});
assert.equal(sessionInventoryJson.workflow_groups.review_runtime_diagnostics.sessions[0].session, 'faulted-session');
assert.equal(sessionInventoryJson.groups.operational_posture.healthy[0].session, 'healthy-session');
assert.equal(sessionInventoryJson.groups.operational_posture.mcp_runtime_faulted[0].session, 'faulted-session');
assert.equal(sessionInventoryJson.groups.request_posture.runtime_failures[0].session, 'faulted-session');
assert.equal(sessionInventoryJson.groups.mcp_state.runtime_faulted[0].session, 'faulted-session');
assert.equal(Array.isArray(sessionInventoryJson.sessions), true);
assert.equal(sessionInventoryJson.sessions[0].session, 'healthy-session');
assert.equal(sessionInventoryJson.sessions[0].agent_id, 'narada.test');
assert.equal(sessionInventoryJson.sessions[0].last_terminal_state, 'completed');
assert.equal(sessionInventoryJson.sessions[0].operational_posture, 'healthy');
assert.equal(sessionInventoryJson.sessions[0].operational_posture_display, 'healthy');
assert.equal(sessionInventoryJson.sessions[0].last_lifecycle_state, 'closed');
assert.equal(sessionInventoryJson.sessions[0].last_lifecycle_event_kind, 'session_closed');
assert.equal(sessionInventoryJson.sessions[0].request_outcome_total, 0);
assert.equal(sessionInventoryJson.sessions[0].request_posture, 'clean');
assert.equal(sessionInventoryJson.sessions[0].request_posture_display, 'clean');
assert.equal(sessionInventoryJson.sessions[0].mcp_operational_state, 'healthy');
assert.equal(sessionInventoryJson.sessions[0].host_command_event_count, 4);
assert.equal(sessionInventoryJson.sessions[0].host_command_terminal_state_summary, '1 (completed)');
assert.equal(sessionInventoryJson.sessions[0].last_host_command_summary, 'git status');
assert.equal(sessionInventoryJson.sessions[0].last_host_command_terminal_state, 'completed');
assert.equal(sessionInventoryJson.sessions[0].last_host_command_output_ref, 'mcp_payload:carrier_host_command_output:host_command_inventory_1@v1');
assert.equal(sessionInventoryJson.sessions[0].handoffs.session_events, 'narada-agent-cli --identity narada.test --session healthy-session --session-events --session-events-filter all --session-events-count 20');
assert.equal(sessionInventoryJson.sessions[0].recommended_action, 'review_session_summary');
assert.equal(sessionInventoryJson.sessions[1].session, 'faulted-session');
assert.equal(sessionInventoryJson.sessions[1].started_at, '2026-06-14T11:40:00.000Z');
assert.equal(sessionInventoryJson.sessions[1].last_terminal_state, 'failed');
assert.equal(sessionInventoryJson.sessions[1].operational_posture, 'mcp_runtime_faulted');
assert.equal(sessionInventoryJson.sessions[1].operational_posture_display, 'mcp_runtime_faulted [mcp=runtime_faulted; request=runtime_failures; lifecycle=failed]');
assert.equal(sessionInventoryJson.sessions[1].last_lifecycle_state, 'failed');
assert.equal(sessionInventoryJson.sessions[1].last_lifecycle_event_kind, 'input_completed');
assert.equal(sessionInventoryJson.sessions[1].request_outcome_total, 4);
assert.equal(sessionInventoryJson.sessions[1].request_posture, 'runtime_failures');
assert.equal(sessionInventoryJson.sessions[1].request_posture_display, 'runtime_failures (4)');
assert.equal(sessionInventoryJson.sessions[1].mcp_operational_state, 'runtime_faulted');
assert.equal(sessionInventoryJson.sessions[1].recommended_action, 'review_runtime_diagnostics');
assert.equal(sessionInventoryJson.sessions[1].recommended_command, 'narada-agent-cli --identity narada.test --session faulted-session --session-recovery');
assert.equal(existsSync(join(inventoryRoot, '.narada', 'crew', 'nars-sessions', 'inventory-scan-json-test')), false);
const sessionInventoryActionsRun = spawnSync(process.execPath, [
  fileURLToPath(new URL('./agent-cli.mjs', import.meta.url)),
  '--session-inventory-actions',
  '--identity',
  'sonar.resident',
  '--session',
  'inventory-actions-test',
], {
  cwd: inventoryRoot,
  env: { ...process.env, NARADA_SITE_ROOT: inventoryRoot },
  encoding: 'utf8',
});
assert.equal(sessionInventoryActionsRun.status, 0);
assert.equal(sessionInventoryActionsRun.stdout.includes('Action queue'), true);
assert.equal(sessionInventoryActionsRun.stdout.includes('Recommended actions'), true);
assert.equal(sessionInventoryActionsRun.stdout.includes('Recommended commands'), true);
assert.equal(sessionInventoryActionsRun.stdout.includes('Recovery primary commands'), true);
assert.equal(sessionInventoryActionsRun.stdout.includes('Recovery followups'), true);
assert.equal(sessionInventoryActionsRun.stdout.includes('review runtime diagnostics'), true);
assert.equal(sessionInventoryActionsRun.stdout.includes('Action groups: review_runtime_diagnostics (1)'), true);
assert.equal(sessionInventoryActionsRun.stdout.includes('Recommended commands: 1 (narada-agent-cli --identity narada.test --session faulted-session --session-recovery)'), true);
assert.equal(sessionInventoryActionsRun.stdout.includes('narada-agent-cli --identity narada.test --session faulted-session --session-recovery'), true);
assert.equal(sessionInventoryActionsRun.stdout.includes('narada-agent-cli --identity narada.test --session faulted-session --session-events --session-events-filter diagnostics --session-events-count 20'), true);
assert.equal(existsSync(join(inventoryRoot, '.narada', 'crew', 'nars-sessions', 'inventory-actions-test')), false);
const sessionInventoryActionsJsonRun = spawnSync(process.execPath, [
  fileURLToPath(new URL('./agent-cli.mjs', import.meta.url)),
  '--session-inventory-actions-json',
  '--identity',
  'sonar.resident',
  '--session',
  'inventory-actions-json-test',
], {
  cwd: inventoryRoot,
  env: { ...process.env, NARADA_SITE_ROOT: inventoryRoot },
  encoding: 'utf8',
});
assert.equal(sessionInventoryActionsJsonRun.status, 0);
const sessionInventoryActionsJson = JSON.parse(sessionInventoryActionsJsonRun.stdout);
assert.equal(sessionInventoryActionsJson.schema, 'narada.agent_cli.session_inventory_actions.v1');
assert.equal(sessionInventoryActionsJson.site_root, inventoryRoot);
assert.equal(sessionInventoryActionsJson.carrier_session_count, 2);
assert.equal(sessionInventoryActionsJson.total_carrier_session_count, 2);
assert.deepEqual(sessionInventoryActionsJson.summary, {
  recommended_action_counts: {
    review_runtime_diagnostics: 1,
    review_session_summary: 1,
  },
  recommended_action_summary: '1 (review_runtime_diagnostics), 1 (review_session_summary)',
  recommended_command_counts: {
    'narada-agent-cli --identity narada.test --session faulted-session --session-recovery': 1,
    'narada-agent-cli --identity narada.test --session healthy-session --session-read': 1,
  },
  recommended_command_summary: '1 (narada-agent-cli --identity narada.test --session faulted-session --session-recovery), 1 (narada-agent-cli --identity narada.test --session healthy-session --session-read)',
  recovery_primary_counts: {
    'narada-agent-cli --identity narada.test --session faulted-session --session-events --session-events-filter diagnostics --session-events-count 20': 1,
    'narada-agent-cli --identity narada.test --session healthy-session --session-read': 1,
  },
  recovery_primary_summary: '1 (narada-agent-cli --identity narada.test --session faulted-session --session-events --session-events-filter diagnostics --session-events-count 20), 1 (narada-agent-cli --identity narada.test --session healthy-session --session-read)',
  recovery_followup_counts: {
    'narada-agent-cli --identity narada.test --session faulted-session --session-read': 1,
    none: 1,
  },
  recovery_followup_summary: '1 (narada-agent-cli --identity narada.test --session faulted-session --session-read), 1 (none)',
});
assert.equal(sessionInventoryActionsJson.workflow_groups.review_session_summary.display, 'review session summary');
assert.deepEqual(sessionInventoryActionsJson.workflow_groups.review_session_summary.recommended_command_counts, {
  'narada-agent-cli --identity narada.test --session healthy-session --session-read': 1,
});
assert.equal(sessionInventoryActionsJson.workflow_groups.review_runtime_diagnostics.display, 'review runtime diagnostics');
assert.deepEqual(sessionInventoryActionsJson.workflow_groups.review_runtime_diagnostics.recommended_command_counts, {
  'narada-agent-cli --identity narada.test --session faulted-session --session-recovery': 1,
});
assert.deepEqual(sessionInventoryActionsJson.workflow_groups.review_runtime_diagnostics.recovery_primary_counts, {
  'narada-agent-cli --identity narada.test --session faulted-session --session-events --session-events-filter diagnostics --session-events-count 20': 1,
});
assert.deepEqual(sessionInventoryActionsJson.workflow_groups.review_runtime_diagnostics.recovery_followup_counts, {
  'narada-agent-cli --identity narada.test --session faulted-session --session-read': 1,
});
assert.equal(sessionInventoryActionsJson.workflow_groups.review_runtime_diagnostics.sessions[0].session, 'faulted-session');
assert.equal(sessionInventoryActionsJson.actions[0].session, 'healthy-session');
assert.equal(sessionInventoryActionsJson.actions[0].recommended_action, 'review_session_summary');
assert.equal(sessionInventoryActionsJson.actions[1].session, 'faulted-session');
assert.equal(sessionInventoryActionsJson.actions[1].recommended_action, 'review_runtime_diagnostics');
assert.equal(sessionInventoryActionsJson.actions[1].recommended_command, 'narada-agent-cli --identity narada.test --session faulted-session --session-recovery');
assert.equal(existsSync(join(inventoryRoot, '.narada', 'crew', 'nars-sessions', 'inventory-actions-json-test')), false);
const sessionInventoryRecoveryRun = spawnSync(process.execPath, [
  fileURLToPath(new URL('./agent-cli.mjs', import.meta.url)),
  '--session-inventory-recovery',
  '--identity',
  'sonar.resident',
  '--session',
  'inventory-recovery-test',
], {
  cwd: inventoryRoot,
  env: { ...process.env, NARADA_SITE_ROOT: inventoryRoot },
  encoding: 'utf8',
});
assert.equal(sessionInventoryRecoveryRun.status, 0);
assert.equal(sessionInventoryRecoveryRun.stdout.includes('Recovery queue'), true);
assert.equal(sessionInventoryRecoveryRun.stdout.includes('faulted-session'), true);
assert.equal(sessionInventoryRecoveryRun.stdout.includes('healthy-session'), false);
assert.equal(sessionInventoryRecoveryRun.stdout.includes('Recovery primary commands'), true);
assert.equal(sessionInventoryRecoveryRun.stdout.includes('Recovery followups'), true);
assert.equal(sessionInventoryRecoveryRun.stdout.includes('Recovery groups: review_runtime_diagnostics (1)'), true);
assert.equal(sessionInventoryRecoveryRun.stdout.includes('Primary commands: 1 (narada-agent-cli --identity narada.test --session faulted-session --session-events --session-events-filter diagnostics --session-events-count 20)'), true);
assert.equal(sessionInventoryRecoveryRun.stdout.includes('Followup commands: 1 (narada-agent-cli --identity narada.test --session faulted-session --session-read)'), true);
assert.equal(existsSync(join(inventoryRoot, '.narada', 'crew', 'nars-sessions', 'inventory-recovery-test')), false);
const sessionInventoryRecoveryJsonRun = spawnSync(process.execPath, [
  fileURLToPath(new URL('./agent-cli.mjs', import.meta.url)),
  '--session-inventory-recovery-json',
  '--identity',
  'sonar.resident',
  '--session',
  'inventory-recovery-json-test',
], {
  cwd: inventoryRoot,
  env: { ...process.env, NARADA_SITE_ROOT: inventoryRoot },
  encoding: 'utf8',
});
assert.equal(sessionInventoryRecoveryJsonRun.status, 0);
const sessionInventoryRecoveryJson = JSON.parse(sessionInventoryRecoveryJsonRun.stdout);
assert.equal(sessionInventoryRecoveryJson.schema, 'narada.agent_cli.session_inventory_recovery.v1');
assert.equal(sessionInventoryRecoveryJson.site_root, inventoryRoot);
assert.equal(sessionInventoryRecoveryJson.carrier_session_count, 1);
assert.equal(sessionInventoryRecoveryJson.total_carrier_session_count, 2);
assert.deepEqual(sessionInventoryRecoveryJson.summary, {
  recommended_action_counts: {
    review_runtime_diagnostics: 1,
  },
  recommended_action_summary: '1 (review_runtime_diagnostics)',
  recovery_kind_counts: {
    diagnostic_review: 1,
  },
  recovery_kind_summary: '1 (diagnostic_review)',
  recovery_primary_counts: {
    'narada-agent-cli --identity narada.test --session faulted-session --session-events --session-events-filter diagnostics --session-events-count 20': 1,
  },
  recovery_primary_summary: '1 (narada-agent-cli --identity narada.test --session faulted-session --session-events --session-events-filter diagnostics --session-events-count 20)',
  recovery_followup_counts: {
    'narada-agent-cli --identity narada.test --session faulted-session --session-read': 1,
  },
  recovery_followup_summary: '1 (narada-agent-cli --identity narada.test --session faulted-session --session-read)',
});
assert.equal(sessionInventoryRecoveryJson.groups.review_runtime_diagnostics[0].session, 'faulted-session');
assert.equal(sessionInventoryRecoveryJson.workflow_groups.review_runtime_diagnostics.display, 'review runtime diagnostics');
assert.deepEqual(sessionInventoryRecoveryJson.workflow_groups.review_runtime_diagnostics.recovery_kind_counts, { diagnostic_review: 1 });
assert.deepEqual(sessionInventoryRecoveryJson.workflow_groups.review_runtime_diagnostics.recovery_primary_counts, {
  'narada-agent-cli --identity narada.test --session faulted-session --session-events --session-events-filter diagnostics --session-events-count 20': 1,
});
assert.deepEqual(sessionInventoryRecoveryJson.workflow_groups.review_runtime_diagnostics.recovery_followup_counts, {
  'narada-agent-cli --identity narada.test --session faulted-session --session-read': 1,
});
assert.equal(sessionInventoryRecoveryJson.workflow_groups.review_runtime_diagnostics.sessions[0].session, 'faulted-session');
assert.equal(sessionInventoryRecoveryJson.actions.length, 1);
assert.equal(sessionInventoryRecoveryJson.actions[0].session, 'faulted-session');
assert.equal(sessionInventoryRecoveryJson.actions[0].recommended_action, 'review_runtime_diagnostics');
assert.equal(sessionInventoryRecoveryJson.actions[0].recovery_kind, 'diagnostic_review');
assert.equal(sessionInventoryRecoveryJson.actions[0].recovery_primary_command, 'narada-agent-cli --identity narada.test --session faulted-session --session-events --session-events-filter diagnostics --session-events-count 20');
assert.equal(sessionInventoryRecoveryJson.actions[0].recovery_followup_command, 'narada-agent-cli --identity narada.test --session faulted-session --session-read');
assert.equal(existsSync(join(inventoryRoot, '.narada', 'crew', 'nars-sessions', 'inventory-recovery-json-test')), false);
const filteredInventoryRun = spawnSync(process.execPath, [
  fileURLToPath(new URL('./agent-cli.mjs', import.meta.url)),
  '--session-inventory',
  '--session-inventory-filter',
  'operational_posture',
  '--session-inventory-match',
  'mcp_runtime_faulted',
  '--identity',
  'sonar.resident',
  '--session',
  'inventory-filter-test',
], {
  cwd: inventoryRoot,
  env: { ...process.env, NARADA_SITE_ROOT: inventoryRoot },
  encoding: 'utf8',
});
assert.equal(filteredInventoryRun.status, 0);
assert.equal(filteredInventoryRun.stdout.includes('Inventory filter'), true);
assert.equal(filteredInventoryRun.stdout.includes('operational_posture:mcp_runtime_faulted'), true);
assert.equal(filteredInventoryRun.stdout.includes('Matched sessions'), true);
assert.equal(filteredInventoryRun.stdout.includes('faulted-session'), true);
assert.equal(filteredInventoryRun.stdout.includes('healthy-session'), false);
assert.equal(filteredInventoryRun.stdout.includes('Groups: operational_posture'), true);
const filteredInventoryJsonRun = spawnSync(process.execPath, [
  fileURLToPath(new URL('./agent-cli.mjs', import.meta.url)),
  '--session-inventory-json',
  '--session-inventory-filter',
  'request_posture',
  '--session-inventory-match',
  'runtime_failures',
  '--identity',
  'sonar.resident',
  '--session',
  'inventory-filter-json-test',
], {
  cwd: inventoryRoot,
  env: { ...process.env, NARADA_SITE_ROOT: inventoryRoot },
  encoding: 'utf8',
});
assert.equal(filteredInventoryJsonRun.status, 0);
const filteredInventoryJson = JSON.parse(filteredInventoryJsonRun.stdout);
assert.equal(filteredInventoryJson.schema, 'narada.agent_cli.session_inventory.v1');
assert.equal(filteredInventoryJson.inventory_filter, 'request_posture:runtime_failures');
assert.equal(filteredInventoryJson.carrier_session_count, 1);
assert.equal(filteredInventoryJson.total_carrier_session_count, 2);
assert.equal(filteredInventoryJson.sessions.length, 1);
assert.equal(filteredInventoryJson.sessions[0].session, 'faulted-session');
assert.deepEqual(filteredInventoryJson.summary.operational_posture_counts, { mcp_runtime_faulted: 1 });
assert.deepEqual(filteredInventoryJson.summary.request_posture_counts, { runtime_failures: 1 });
assert.equal(filteredInventoryJson.groups.operational_posture.mcp_runtime_faulted[0].session, 'faulted-session');
assert.equal(filteredInventoryJson.groups.request_posture.runtime_failures[0].session, 'faulted-session');
const filteredInventoryMissJsonRun = spawnSync(process.execPath, [
  fileURLToPath(new URL('./agent-cli.mjs', import.meta.url)),
  '--session-inventory-json',
  '--session-inventory-filter',
  'heartbeat_status',
  '--session-inventory-match',
  'missing',
  '--identity',
  'sonar.resident',
  '--session',
  'inventory-filter-miss-json-test',
], {
  cwd: inventoryRoot,
  env: { ...process.env, NARADA_SITE_ROOT: inventoryRoot },
  encoding: 'utf8',
});
assert.equal(filteredInventoryMissJsonRun.status, 0);
const filteredInventoryMissJson = JSON.parse(filteredInventoryMissJsonRun.stdout);
assert.equal(filteredInventoryMissJson.inventory_filter, 'heartbeat_status:missing');
assert.equal(filteredInventoryMissJson.carrier_session_count, 0);
assert.equal(filteredInventoryMissJson.total_carrier_session_count, 2);
assert.deepEqual(filteredInventoryMissJson.groups.operational_posture, {});
assert.deepEqual(filteredInventoryMissJson.sessions, []);
const filteredRecoveryJsonRun = spawnSync(process.execPath, [
  fileURLToPath(new URL('./agent-cli.mjs', import.meta.url)),
  '--session-inventory-recovery-json',
  '--session-inventory-filter',
  'recovery_kind',
  '--session-inventory-match',
  'diagnostic_review',
  '--identity',
  'sonar.resident',
  '--session',
  'inventory-recovery-filter-json-test',
], {
  cwd: inventoryRoot,
  env: { ...process.env, NARADA_SITE_ROOT: inventoryRoot },
  encoding: 'utf8',
});
assert.equal(filteredRecoveryJsonRun.status, 0);
const filteredRecoveryJson = JSON.parse(filteredRecoveryJsonRun.stdout);
assert.equal(filteredRecoveryJson.inventory_filter, 'recovery_kind:diagnostic_review');
assert.equal(filteredRecoveryJson.carrier_session_count, 1);
assert.equal(filteredRecoveryJson.total_carrier_session_count, 2);
assert.equal(filteredRecoveryJson.actions.length, 1);
assert.equal(filteredRecoveryJson.actions[0].session, 'faulted-session');
assert.equal(filteredRecoveryJson.actions[0].recovery_kind, 'diagnostic_review');
const filteredRecommendedActionInventoryJsonRun = spawnSync(process.execPath, [
  fileURLToPath(new URL('./agent-cli.mjs', import.meta.url)),
  '--session-inventory-json',
  '--session-inventory-filter',
  'recommended_action',
  '--session-inventory-match',
  'review_session_summary',
  '--identity',
  'sonar.resident',
  '--session',
  'inventory-recommended-filter-json-test',
], {
  cwd: inventoryRoot,
  env: { ...process.env, NARADA_SITE_ROOT: inventoryRoot },
  encoding: 'utf8',
});
assert.equal(filteredRecommendedActionInventoryJsonRun.status, 0);
const filteredRecommendedActionInventoryJson = JSON.parse(filteredRecommendedActionInventoryJsonRun.stdout);
assert.equal(filteredRecommendedActionInventoryJson.inventory_filter, 'recommended_action:review_session_summary');
assert.equal(filteredRecommendedActionInventoryJson.carrier_session_count, 1);
assert.equal(filteredRecommendedActionInventoryJson.sessions[0].session, 'healthy-session');
assert.equal(filteredRecommendedActionInventoryJson.sessions[0].recommended_action, 'review_session_summary');
const sessionInventoryEventsRun = spawnSync(process.execPath, [
  fileURLToPath(new URL('./agent-cli.mjs', import.meta.url)),
  '--session-inventory-events',
  '--identity',
  'sonar.resident',
  '--session',
  'inventory-events-test',
], {
  cwd: inventoryRoot,
  env: { ...process.env, NARADA_SITE_ROOT: inventoryRoot },
  encoding: 'utf8',
});
assert.equal(sessionInventoryEventsRun.status, 0);
assert.equal(sessionInventoryEventsRun.stdout.includes('Event filter'), true);
assert.equal(sessionInventoryEventsRun.stdout.includes('Sessions with events'), true);
assert.equal(sessionInventoryEventsRun.stdout.includes('Event kinds'), true);
assert.equal(sessionInventoryEventsRun.stdout.includes('Issue codes'), true);
assert.equal(sessionInventoryEventsRun.stdout.includes('Terminal states'), true);
assert.equal(sessionInventoryEventsRun.stdout.includes('Recommended actions'), true);
assert.equal(sessionInventoryEventsRun.stdout.includes('Recommended commands'), true);
assert.equal(sessionInventoryEventsRun.stdout.includes('Recovery primary commands'), true);
assert.equal(sessionInventoryEventsRun.stdout.includes('Recovery followups'), true);
assert.equal(sessionInventoryEventsRun.stdout.includes('Recent events:'), true);
assert.equal(sessionInventoryEventsRun.stdout.includes('Event action groups: review_runtime_diagnostics (1)'), true);
assert.equal(sessionInventoryEventsRun.stdout.includes('Event groups: event_kind'), true);
assert.equal(sessionInventoryEventsRun.stdout.includes('Recommended action'), true);
assert.equal(sessionInventoryEventsRun.stdout.includes('Recommended command'), true);
assert.equal(sessionInventoryEventsRun.stdout.includes('narada-agent-cli --identity narada.test --session faulted-session --session-read'), true);
assert.equal(sessionInventoryEventsRun.stdout.includes('faulted-session'), true);
assert.equal(sessionInventoryEventsRun.stdout.includes('healthy-session'), true);
assert.equal(existsSync(join(inventoryRoot, '.narada', 'crew', 'nars-sessions', 'inventory-events-test')), false);
const sessionInventoryEventsJsonRun = spawnSync(process.execPath, [
  fileURLToPath(new URL('./agent-cli.mjs', import.meta.url)),
  '--session-inventory-events-json',
  '--session-inventory-events-filter',
  'diagnostics',
  '--session-inventory-events-count',
  '5',
  '--identity',
  'sonar.resident',
  '--session',
  'inventory-events-json-test',
], {
  cwd: inventoryRoot,
  env: { ...process.env, NARADA_SITE_ROOT: inventoryRoot },
  encoding: 'utf8',
});
assert.equal(sessionInventoryEventsJsonRun.status, 0);
const sessionInventoryEventsJson = JSON.parse(sessionInventoryEventsJsonRun.stdout);
assert.equal(sessionInventoryEventsJson.schema, 'narada.agent_cli.session_inventory_events.v1');
assert.equal(sessionInventoryEventsJson.inventory_filter, 'all');
assert.equal(sessionInventoryEventsJson.event_filter, 'diagnostics');
assert.equal(sessionInventoryEventsJson.carrier_session_count, 2);
assert.equal(sessionInventoryEventsJson.total_carrier_session_count, 2);
assert.equal(sessionInventoryEventsJson.sessions_with_events, 1);
assert.equal(sessionInventoryEventsJson.event_count, 2);
assert.deepEqual(sessionInventoryEventsJson.event_kind_counts, { carrier_diagnostic_recorded: 2 });
assert.equal(sessionInventoryEventsJson.event_kind_summary, '2 (carrier_diagnostic_recorded)');
assert.deepEqual(sessionInventoryEventsJson.issue_code_counts, {});
assert.equal(sessionInventoryEventsJson.issue_code_summary, '0');
assert.deepEqual(sessionInventoryEventsJson.terminal_state_counts, {});
assert.equal(sessionInventoryEventsJson.terminal_state_summary, '0');
assert.deepEqual(sessionInventoryEventsJson.recommended_action_counts, { review_runtime_diagnostics: 1 });
assert.equal(sessionInventoryEventsJson.recommended_action_summary, '1 (review_runtime_diagnostics)');
assert.deepEqual(sessionInventoryEventsJson.recommended_command_counts, {
  'narada-agent-cli --identity narada.test --session faulted-session --session-recovery': 1,
});
assert.equal(sessionInventoryEventsJson.recommended_command_summary, '1 (narada-agent-cli --identity narada.test --session faulted-session --session-recovery)');
assert.deepEqual(sessionInventoryEventsJson.recovery_primary_counts, {
  'narada-agent-cli --identity narada.test --session faulted-session --session-events --session-events-filter diagnostics --session-events-count 20': 1,
});
assert.equal(sessionInventoryEventsJson.recovery_primary_summary, '1 (narada-agent-cli --identity narada.test --session faulted-session --session-events --session-events-filter diagnostics --session-events-count 20)');
assert.deepEqual(sessionInventoryEventsJson.recovery_followup_counts, {
  'narada-agent-cli --identity narada.test --session faulted-session --session-read': 1,
});
assert.equal(sessionInventoryEventsJson.recovery_followup_summary, '1 (narada-agent-cli --identity narada.test --session faulted-session --session-read)');
assert.equal(sessionInventoryEventsJson.groups.event_kind.carrier_diagnostic_recorded.length, 2);
assert.deepEqual(sessionInventoryEventsJson.groups.issue_code, {});
assert.deepEqual(sessionInventoryEventsJson.groups.terminal_state, {});
assert.equal(sessionInventoryEventsJson.workflow_groups.review_runtime_diagnostics.display, 'review runtime diagnostics');
assert.deepEqual(sessionInventoryEventsJson.workflow_groups.review_runtime_diagnostics.recommended_command_counts, {
  'narada-agent-cli --identity narada.test --session faulted-session --session-recovery': 1,
});
assert.deepEqual(sessionInventoryEventsJson.workflow_groups.review_runtime_diagnostics.recovery_primary_counts, {
  'narada-agent-cli --identity narada.test --session faulted-session --session-events --session-events-filter diagnostics --session-events-count 20': 1,
});
assert.deepEqual(sessionInventoryEventsJson.workflow_groups.review_runtime_diagnostics.recovery_followup_counts, {
  'narada-agent-cli --identity narada.test --session faulted-session --session-read': 1,
});
assert.equal(sessionInventoryEventsJson.workflow_groups.review_runtime_diagnostics.sessions[0].session, 'faulted-session');
assert.equal(sessionInventoryEventsJson.sessions.length, 1);
assert.equal(sessionInventoryEventsJson.sessions[0].session, 'faulted-session');
assert.equal(sessionInventoryEventsJson.sessions[0].event_count, 2);
assert.equal(sessionInventoryEventsJson.sessions[0].handoffs.session_events_diagnostics, 'narada-agent-cli --identity narada.test --session faulted-session --session-events --session-events-filter diagnostics --session-events-count 20');
assert.equal(sessionInventoryEventsJson.sessions[0].recommended_action, 'review_runtime_diagnostics');
assert.equal(sessionInventoryEventsJson.recent_events.length, 2);
assert.equal(sessionInventoryEventsJson.recent_events[0].session, 'faulted-session');
assert.equal(sessionInventoryEventsJson.recent_events[0].event_kind, 'carrier_diagnostic_recorded');
const filteredSessionInventoryEventsJsonRun = spawnSync(process.execPath, [
  fileURLToPath(new URL('./agent-cli.mjs', import.meta.url)),
  '--session-inventory-events-json',
  '--session-inventory-filter',
  'operational_posture',
  '--session-inventory-match',
  'mcp_runtime_faulted',
  '--session-inventory-events-filter',
  'lifecycle',
  '--identity',
  'sonar.resident',
  '--session',
  'inventory-events-filter-json-test',
], {
  cwd: inventoryRoot,
  env: { ...process.env, NARADA_SITE_ROOT: inventoryRoot },
  encoding: 'utf8',
});
assert.equal(filteredSessionInventoryEventsJsonRun.status, 0);
const filteredSessionInventoryEventsJson = JSON.parse(filteredSessionInventoryEventsJsonRun.stdout);
assert.equal(filteredSessionInventoryEventsJson.inventory_filter, 'operational_posture:mcp_runtime_faulted');
assert.equal(filteredSessionInventoryEventsJson.event_filter, 'lifecycle');
assert.equal(filteredSessionInventoryEventsJson.carrier_session_count, 1);
assert.equal(filteredSessionInventoryEventsJson.sessions_with_events, 1);
assert.equal(filteredSessionInventoryEventsJson.event_count, 1);
assert.deepEqual(filteredSessionInventoryEventsJson.event_kind_counts, { input_completed: 1 });
assert.deepEqual(filteredSessionInventoryEventsJson.issue_code_counts, {});
assert.deepEqual(filteredSessionInventoryEventsJson.terminal_state_counts, { failed: 1 });
assert.equal(filteredSessionInventoryEventsJson.groups.event_kind.input_completed[0].session, 'faulted-session');
assert.equal(filteredSessionInventoryEventsJson.groups.terminal_state.failed[0].terminal_state, 'failed');
assert.equal(filteredSessionInventoryEventsJson.sessions[0].session, 'faulted-session');
assert.equal(filteredSessionInventoryEventsJson.recent_events[0].terminal_state, 'failed');
const sessionReadRun = spawnSync(process.execPath, [
  fileURLToPath(new URL('./agent-cli.mjs', import.meta.url)),
  '--session-read',
  '--identity',
  'sonar.resident',
  '--session',
  'faulted-session',
], {
  cwd: inventoryRoot,
  env: { ...process.env, NARADA_SITE_ROOT: inventoryRoot },
  encoding: 'utf8',
});
assert.equal(sessionReadRun.status, 0);
assert.equal(sessionReadRun.stdout.includes('faulted-session'), true);
assert.equal(sessionReadRun.stdout.includes('mcp_runtime_faulted [mcp=runtime_faulted; request=runtime_failures; lifecycle=failed]'), true);
assert.equal(sessionReadRun.stdout.includes('runtime_failures (4)'), true);
assert.equal(sessionReadRun.stdout.includes('failed'), true);
assert.equal(sessionReadRun.stdout.includes('1 (invalid_json), 1 (request_dispatch_failed), 1 (request_failed), 1 (session_closed)'), true);
assert.equal(sessionReadRun.stdout.includes('Recovery kind'), true);
assert.equal(sessionReadRun.stdout.includes('diagnostic review'), true);
assert.equal(sessionReadRun.stdout.includes('Recovery primary'), true);
assert.equal(sessionReadRun.stdout.includes('Recovery followup'), true);
assert.equal(sessionReadRun.stdout.includes('Event count'), true);
assert.equal(sessionReadRun.stdout.includes('Event kinds'), true);
assert.equal(sessionReadRun.stdout.includes('Issue codes'), true);
assert.equal(sessionReadRun.stdout.includes('Terminal states'), true);
assert.equal(sessionReadRun.stdout.includes('Host command output review'), true);
assert.equal(sessionReadRun.stdout.includes('review runtime diagnostics'), true);
assert.equal(sessionReadRun.stdout.includes('narada-agent-cli --identity narada.test --session faulted-session --session-events --session-events-filter diagnostics --session-events-count 20'), true);
assert.equal(sessionReadRun.stdout.includes('narada-agent-cli --identity narada.test --session faulted-session --session-recovery'), true);
assert.equal(existsSync(join(inventoryRoot, '.narada', 'crew', 'nars-sessions', 'faulted-session')), true);
const sessionRecoveryRun = spawnSync(process.execPath, [
  fileURLToPath(new URL('./agent-cli.mjs', import.meta.url)),
  '--session-recovery',
  '--identity',
  'sonar.resident',
  '--session',
  'faulted-session',
], {
  cwd: inventoryRoot,
  env: { ...process.env, NARADA_SITE_ROOT: inventoryRoot },
  encoding: 'utf8',
});
assert.equal(sessionRecoveryRun.status, 0);
assert.equal(sessionRecoveryRun.stdout.includes('Session'), true);
assert.equal(sessionRecoveryRun.stdout.includes('Recovery kind'), true);
assert.equal(sessionRecoveryRun.stdout.includes('diagnostic review'), true);
assert.equal(sessionRecoveryRun.stdout.includes('Recovery primary'), true);
assert.equal(sessionRecoveryRun.stdout.includes('Recovery followup'), true);
assert.equal(sessionRecoveryRun.stdout.includes('Event count'), true);
assert.equal(sessionRecoveryRun.stdout.includes('Event kinds'), true);
assert.equal(sessionRecoveryRun.stdout.includes('Issue codes'), true);
assert.equal(sessionRecoveryRun.stdout.includes('Terminal states'), true);
assert.equal(sessionRecoveryRun.stdout.includes('narada-agent-cli --identity narada.test --session faulted-session --session-events --session-events-filter diagnostics --session-events-count 20'), true);
assert.equal(sessionRecoveryRun.stdout.includes('narada-agent-cli --identity narada.test --session faulted-session --session-read'), true);
const sessionRecoveryJsonRun = spawnSync(process.execPath, [
  fileURLToPath(new URL('./agent-cli.mjs', import.meta.url)),
  '--session-recovery-json',
  '--identity',
  'sonar.resident',
  '--session',
  'healthy-session',
], {
  cwd: inventoryRoot,
  env: { ...process.env, NARADA_SITE_ROOT: inventoryRoot },
  encoding: 'utf8',
});
assert.equal(sessionRecoveryJsonRun.status, 0);
const sessionRecoveryJson = JSON.parse(sessionRecoveryJsonRun.stdout);
assert.equal(sessionRecoveryJson.schema, 'narada.agent_cli.session_recovery.v1');
assert.equal(sessionRecoveryJson.site_root, inventoryRoot);
assert.equal(sessionRecoveryJson.session, 'healthy-session');
assert.equal(sessionRecoveryJson.found, true);
assert.equal(sessionRecoveryJson.recovery.recovery_kind, 'no_recovery');
assert.equal(sessionRecoveryJson.recovery.recovery_primary_command, 'narada-agent-cli --identity narada.test --session healthy-session --session-read');
assert.equal(sessionRecoveryJson.recovery.recovery_followup_command, null);
assert.equal(sessionRecoveryJson.preflight.operational_state, 'healthy');
assert.equal(sessionRecoveryJson.preflight.recommended_action, 'start_session');
assert.equal(sessionRecoveryJson.preflight.handoffs.mcp_preflight_diagnostics, 'narada-agent-cli --identity narada.test --session healthy-session --mcp-preflight-diagnostics --mcp-preflight-diagnostics-filter all');
assert.equal(sessionRecoveryJson.event_summary.event_count, 10);
assert.deepEqual(sessionRecoveryJson.event_summary.event_kind_counts, {
  carrier_host_command_admitted: 1,
  carrier_host_command_completed: 1,
  carrier_host_command_requested: 1,
  carrier_host_command_started: 1,
  directive_emission_authorized: 1,
  directive_emission_rule_recorded: 1,
  directive_emitted: 1,
  input_completed: 1,
  mcp_preflight_artifact_linked: 1,
  session_closed: 1,
});
assert.equal(sessionRecoveryJson.event_summary.event_kind_summary, '1 (carrier_host_command_admitted), 1 (carrier_host_command_completed), 1 (carrier_host_command_requested), 1 (carrier_host_command_started), 1 (directive_emission_authorized), 1 (directive_emission_rule_recorded), 1 (directive_emitted), 1 (input_completed), 1 (mcp_preflight_artifact_linked), 1 (session_closed)');
assert.deepEqual(sessionRecoveryJson.event_summary.issue_code_counts, {});
assert.equal(sessionRecoveryJson.event_summary.issue_code_summary, '0');
assert.deepEqual(sessionRecoveryJson.event_summary.terminal_state_counts, { completed: 2, closed: 1 });
assert.equal(sessionRecoveryJson.event_summary.terminal_state_summary, '2 (completed), 1 (closed)');
assert.deepEqual(sessionRecoveryJson.event_summary.recommended_action_counts, { review_session_summary: 1 });
assert.equal(sessionRecoveryJson.event_summary.recommended_action_summary, '1 (review_session_summary)');
assert.deepEqual(sessionRecoveryJson.event_summary.recommended_command_counts, {
  'narada-agent-cli --identity narada.test --session healthy-session --session-read': 1,
});
assert.equal(sessionRecoveryJson.event_summary.recommended_command_summary, '1 (narada-agent-cli --identity narada.test --session healthy-session --session-read)');
assert.equal(sessionRecoveryJson.event_summary.groups.event_kind.session_closed[0].session, 'healthy-session');
assert.equal(sessionRecoveryJson.event_summary.workflow_groups.review_session_summary.display, 'review session summary');
assert.equal(sessionRecoveryJson.record.recommended_action, 'review_session_summary');
const sessionReadJsonRun = spawnSync(process.execPath, [
  fileURLToPath(new URL('./agent-cli.mjs', import.meta.url)),
  '--session-read-json',
  '--identity',
  'sonar.resident',
  '--session',
  'healthy-session',
], {
  cwd: inventoryRoot,
  env: { ...process.env, NARADA_SITE_ROOT: inventoryRoot },
  encoding: 'utf8',
});
assert.equal(sessionReadJsonRun.status, 0);
const sessionReadJson = JSON.parse(sessionReadJsonRun.stdout);
assert.equal(sessionReadJson.schema, 'narada.agent_cli.session_read.v1');
assert.equal(sessionReadJson.site_root, inventoryRoot);
assert.equal(sessionReadJson.session, 'healthy-session');
assert.equal(sessionReadJson.found, true);
assert.equal(sessionReadJson.record.session, 'healthy-session');
assert.equal(sessionReadJson.recovery.recovery_kind, 'no_recovery');
assert.equal(sessionReadJson.recovery.recovery_primary_command, 'narada-agent-cli --identity narada.test --session healthy-session --session-read');
assert.equal(sessionReadJson.recovery.recovery_followup_command, null);
assert.equal(sessionReadJson.preflight.operational_state, 'healthy');
assert.equal(sessionReadJson.preflight.recommended_action_display, 'start session');
assert.equal(sessionReadJson.preflight.handoffs.mcp_preflight_diagnostics, 'narada-agent-cli --identity narada.test --session healthy-session --mcp-preflight-diagnostics --mcp-preflight-diagnostics-filter all');
assert.equal(sessionReadJson.event_summary.event_count, 10);
assert.deepEqual(sessionReadJson.event_summary.event_kind_counts, {
  carrier_host_command_admitted: 1,
  carrier_host_command_completed: 1,
  carrier_host_command_requested: 1,
  carrier_host_command_started: 1,
  directive_emission_authorized: 1,
  directive_emission_rule_recorded: 1,
  directive_emitted: 1,
  input_completed: 1,
  mcp_preflight_artifact_linked: 1,
  session_closed: 1,
});
assert.equal(sessionReadJson.event_summary.event_kind_summary, '1 (carrier_host_command_admitted), 1 (carrier_host_command_completed), 1 (carrier_host_command_requested), 1 (carrier_host_command_started), 1 (directive_emission_authorized), 1 (directive_emission_rule_recorded), 1 (directive_emitted), 1 (input_completed), 1 (mcp_preflight_artifact_linked), 1 (session_closed)');
assert.deepEqual(sessionReadJson.event_summary.issue_code_counts, {});
assert.equal(sessionReadJson.event_summary.issue_code_summary, '0');
assert.deepEqual(sessionReadJson.event_summary.terminal_state_counts, { completed: 2, closed: 1 });
assert.equal(sessionReadJson.event_summary.terminal_state_summary, '2 (completed), 1 (closed)');
assert.deepEqual(sessionReadJson.event_summary.recommended_action_counts, { review_session_summary: 1 });
assert.equal(sessionReadJson.event_summary.recommended_action_summary, '1 (review_session_summary)');
assert.deepEqual(sessionReadJson.event_summary.recommended_command_counts, {
  'narada-agent-cli --identity narada.test --session healthy-session --session-read': 1,
});
assert.equal(sessionReadJson.event_summary.recommended_command_summary, '1 (narada-agent-cli --identity narada.test --session healthy-session --session-read)');
assert.equal(sessionReadJson.event_summary.groups.event_kind.session_closed[0].session, 'healthy-session');
assert.equal(sessionReadJson.event_summary.workflow_groups.review_session_summary.display, 'review session summary');
assert.equal(sessionReadJson.record.operational_posture, 'healthy');
assert.equal(sessionReadJson.record.last_lifecycle_state, 'closed');
assert.equal(sessionReadJson.record.request_posture, 'clean');
assert.equal(sessionReadJson.record.host_command_terminal_state_summary, '1 (completed)');
assert.equal(sessionReadJson.record.last_host_command_summary, 'git status');
assert.equal(sessionReadJson.record.last_host_command_output_ref, 'mcp_payload:carrier_host_command_output:host_command_inventory_1@v1');
assert.equal(sessionReadJson.record.handoffs.host_command_output_read, 'narada-agent-cli --identity narada.test --session healthy-session --host-command-output-read --host-command-output-ref mcp_payload:carrier_host_command_output:host_command_inventory_1@v1');
assert.equal(sessionReadJson.host_command_output.output_ref, 'mcp_payload:carrier_host_command_output:host_command_inventory_1@v1');
assert.equal(sessionReadJson.host_command_output.handoffs.host_command_output_read_json, 'narada-agent-cli --identity narada.test --session healthy-session --host-command-output-read-json --host-command-output-ref mcp_payload:carrier_host_command_output:host_command_inventory_1@v1');
assert.equal(sessionReadJson.record.handoffs.session_read_json, 'narada-agent-cli --identity narada.test --session healthy-session --session-read-json');
assert.equal(sessionReadJson.record.handoffs.session_recovery, 'narada-agent-cli --identity narada.test --session healthy-session --session-recovery');
assert.equal(sessionReadJson.record.recommended_action, 'review_session_summary');
const persistedEvents = readPersistedSessionEvents({ session: 'faulted-session', naradaDir: inventoryNaradaDir });
assert.equal(persistedEvents.length, 7);
assert.equal(persistedEvents.at(-1).event_kind, 'input_completed');
assert.equal(filterPersistedSessionEvents(persistedEvents, { eventFilter: 'lifecycle' }).length, 1);
assert.equal(filterPersistedSessionEvents(persistedEvents, { eventFilter: 'issues' }).length, 4);
assert.equal(filterPersistedSessionEvents(persistedEvents, { eventFilter: 'diagnostics' }).length, 2);
const persistedEventsWithOperations = [
  { event_kind: 'directive_emission_authorized', timestamp: '2026-06-14T12:00:10.000Z', payload: { directive_kind: 'operation_heartbeat', visibility: 'record_only', operation_id: 'op-1' } },
  { event_kind: 'directive_emission_rule_recorded', timestamp: '2026-06-14T12:00:11.000Z', payload: { directive_kind: 'operation_heartbeat', visibility: 'record_only', operation_id: 'op-1' } },
  { event_kind: 'directive_emitted', timestamp: '2026-06-14T12:00:12.000Z', payload: { directive_kind: 'operation_heartbeat', visibility: 'record_only', operation_id: 'op-1' } },
  ...persistedEvents,
];
assert.equal(filterPersistedSessionEvents(persistedEventsWithOperations, { eventFilter: 'operations' }).length, 3);
const sessionEventsRun = spawnSync(process.execPath, [
  fileURLToPath(new URL('./agent-cli.mjs', import.meta.url)),
  '--session-events',
  '--identity',
  'sonar.resident',
  '--session',
  'faulted-session',
], {
  cwd: inventoryRoot,
  env: { ...process.env, NARADA_SITE_ROOT: inventoryRoot },
  encoding: 'utf8',
});
assert.equal(sessionEventsRun.status, 0);
assert.equal(sessionEventsRun.stdout.includes('Event count'), true);
assert.equal(sessionEventsRun.stdout.includes('Event kinds'), true);
assert.equal(sessionEventsRun.stdout.includes('Issue codes'), true);
assert.equal(sessionEventsRun.stdout.includes('Terminal states'), true);
assert.equal(sessionEventsRun.stdout.includes('Recovery kind'), true);
assert.equal(sessionEventsRun.stdout.includes('Recovery primary'), true);
assert.equal(sessionEventsRun.stdout.includes('Recovery followup'), true);
assert.equal(sessionEventsRun.stdout.includes('Recent events:'), true);
assert.equal(sessionEventsRun.stdout.includes('carrier_diagnostic_recorded'), true);
assert.equal(sessionEventsRun.stdout.includes('input_completed [terminal=failed]'), true);
assert.equal(sessionEventsRun.stdout.includes('review runtime diagnostics'), true);
assert.equal(sessionEventsRun.stdout.includes('narada-agent-cli --identity narada.test --session faulted-session --session-events --session-events-filter issues --session-events-count 20'), true);
const sessionEventsLifecycleJsonRun = spawnSync(process.execPath, [
  fileURLToPath(new URL('./agent-cli.mjs', import.meta.url)),
  '--session-events-json',
  '--session-events-filter',
  'lifecycle',
  '--session-events-count',
  '5',
  '--identity',
  'sonar.resident',
  '--session',
  'faulted-session',
], {
  cwd: inventoryRoot,
  env: { ...process.env, NARADA_SITE_ROOT: inventoryRoot },
  encoding: 'utf8',
});
assert.equal(sessionEventsLifecycleJsonRun.status, 0);
const sessionEventsLifecycleJson = JSON.parse(sessionEventsLifecycleJsonRun.stdout);
assert.equal(sessionEventsLifecycleJson.event_filter, 'lifecycle');
assert.equal(sessionEventsLifecycleJson.event_count, 1);
assert.equal(sessionEventsLifecycleJson.total_event_count, 7);
assert.deepEqual(sessionEventsLifecycleJson.event_kind_counts, { input_completed: 1 });
assert.equal(sessionEventsLifecycleJson.event_kind_summary, '1 (input_completed)');
assert.deepEqual(sessionEventsLifecycleJson.issue_code_counts, {});
assert.equal(sessionEventsLifecycleJson.issue_code_summary, '0');
assert.deepEqual(sessionEventsLifecycleJson.terminal_state_counts, { failed: 1 });
assert.equal(sessionEventsLifecycleJson.terminal_state_summary, '1 (failed)');
assert.deepEqual(sessionEventsLifecycleJson.recommended_action_counts, { review_runtime_diagnostics: 1 });
assert.equal(sessionEventsLifecycleJson.recommended_action_summary, '1 (review_runtime_diagnostics)');
assert.deepEqual(sessionEventsLifecycleJson.recommended_command_counts, {
  'narada-agent-cli --identity narada.test --session faulted-session --session-recovery': 1,
});
assert.equal(sessionEventsLifecycleJson.recommended_command_summary, '1 (narada-agent-cli --identity narada.test --session faulted-session --session-recovery)');
assert.deepEqual(sessionEventsLifecycleJson.recovery_primary_counts, {
  'narada-agent-cli --identity narada.test --session faulted-session --session-events --session-events-filter diagnostics --session-events-count 20': 1,
});
assert.equal(sessionEventsLifecycleJson.recovery_primary_summary, '1 (narada-agent-cli --identity narada.test --session faulted-session --session-events --session-events-filter diagnostics --session-events-count 20)');
assert.deepEqual(sessionEventsLifecycleJson.recovery_followup_counts, {
  'narada-agent-cli --identity narada.test --session faulted-session --session-read': 1,
});
assert.equal(sessionEventsLifecycleJson.recovery_followup_summary, '1 (narada-agent-cli --identity narada.test --session faulted-session --session-read)');
assert.equal(sessionEventsLifecycleJson.groups.event_kind.input_completed[0].session, 'faulted-session');
assert.deepEqual(sessionEventsLifecycleJson.groups.issue_code, {});
assert.equal(sessionEventsLifecycleJson.groups.terminal_state.failed[0].terminal_state, 'failed');
assert.equal(sessionEventsLifecycleJson.workflow_groups.review_runtime_diagnostics.display, 'review runtime diagnostics');
assert.deepEqual(sessionEventsLifecycleJson.workflow_groups.review_runtime_diagnostics.recommended_command_counts, {
  'narada-agent-cli --identity narada.test --session faulted-session --session-recovery': 1,
});
assert.equal(sessionEventsLifecycleJson.recovery.recovery_kind, 'diagnostic_review');
assert.equal(sessionEventsLifecycleJson.recovery.recovery_primary_command, 'narada-agent-cli --identity narada.test --session faulted-session --session-events --session-events-filter diagnostics --session-events-count 20');
assert.equal(sessionEventsLifecycleJson.recovery.recovery_followup_command, 'narada-agent-cli --identity narada.test --session faulted-session --session-read');
assert.equal(sessionEventsLifecycleJson.recent_events.length, 1);
assert.equal(sessionEventsLifecycleJson.recent_events[0].event_kind, 'input_completed');
const sessionEventsIssuesRun = spawnSync(process.execPath, [
  fileURLToPath(new URL('./agent-cli.mjs', import.meta.url)),
  '--session-events',
  '--session-events-filter',
  'issues',
  '--session-events-count',
  '2',
  '--identity',
  'sonar.resident',
  '--session',
  'faulted-session',
], {
  cwd: inventoryRoot,
  env: { ...process.env, NARADA_SITE_ROOT: inventoryRoot },
  encoding: 'utf8',
});
assert.equal(sessionEventsIssuesRun.status, 0);
assert.equal(sessionEventsIssuesRun.stdout.includes('Event filter'), true);
assert.equal(sessionEventsIssuesRun.stdout.includes('issues'), true);
assert.equal(sessionEventsIssuesRun.stdout.includes('Event count'), true);
assert.equal(sessionEventsIssuesRun.stdout.includes('4'), true);
assert.equal(sessionEventsIssuesRun.stdout.includes('Total event count'), true);
assert.equal(sessionEventsIssuesRun.stdout.includes('7'), true);
const sessionEventsJsonRun = spawnSync(process.execPath, [
  fileURLToPath(new URL('./agent-cli.mjs', import.meta.url)),
  '--session-events-json',
  '--identity',
  'sonar.resident',
  '--session',
  'healthy-session',
], {
  cwd: inventoryRoot,
  env: { ...process.env, NARADA_SITE_ROOT: inventoryRoot },
  encoding: 'utf8',
});
assert.equal(sessionEventsJsonRun.status, 0);
const sessionEventsJson = JSON.parse(sessionEventsJsonRun.stdout);
assert.equal(sessionEventsJson.schema, 'narada.agent_cli.session_events_read.v1');
assert.equal(sessionEventsJson.site_root, inventoryRoot);
assert.equal(sessionEventsJson.session, 'healthy-session');
assert.equal(sessionEventsJson.found, true);
assert.equal(sessionEventsJson.event_count, 10);
assert.equal(Array.isArray(sessionEventsJson.recent_events), true);
assert.equal(sessionEventsJson.recent_events.at(-1).event, 'session_closed');
assert.equal(sessionEventsJson.preflight.operational_state, 'healthy');
assert.equal(sessionEventsJson.preflight.recommended_action, 'start_session');
assert.equal(sessionEventsJson.preflight.handoffs.mcp_preflight_diagnostics, 'narada-agent-cli --identity narada.test --session healthy-session --mcp-preflight-diagnostics --mcp-preflight-diagnostics-filter all');
assert.equal(sessionEventsJson.record.last_lifecycle_state, 'closed');
const sessionInventoryHostCommandsJsonRun = spawnSync(process.execPath, [
  fileURLToPath(new URL('./agent-cli.mjs', import.meta.url)),
  '--session-inventory-host-commands-json',
  '--identity',
  'sonar.resident',
  '--session',
  'inventory-scan-test',
], {
  cwd: inventoryRoot,
  env: { ...process.env, NARADA_SITE_ROOT: inventoryRoot },
  encoding: 'utf8',
});
assert.equal(sessionInventoryHostCommandsJsonRun.status, 0);
const sessionInventoryHostCommandsJson = JSON.parse(sessionInventoryHostCommandsJsonRun.stdout);
assert.equal(sessionInventoryHostCommandsJson.schema, 'narada.agent_cli.session_inventory_host_commands.v1');
assert.equal(sessionInventoryHostCommandsJson.site_root, inventoryRoot);
assert.equal(sessionInventoryHostCommandsJson.carrier_session_count, 1);
assert.equal(sessionInventoryHostCommandsJson.total_carrier_session_count, 2);
assert.deepEqual(sessionInventoryHostCommandsJson.host_command_terminal_state_counts, { completed: 1 });
assert.equal(sessionInventoryHostCommandsJson.host_command_terminal_state_summary, '1 (completed)');
assert.equal(sessionInventoryHostCommandsJson.host_command_output_ref_count, 1);
assert.equal(sessionInventoryHostCommandsJson.sessions[0].session, 'healthy-session');
assert.equal(sessionInventoryHostCommandsJson.sessions[0].last_host_command_summary, 'git status');
assert.equal(sessionInventoryHostCommandsJson.sessions[0].handoffs.host_command_output_read, 'narada-agent-cli --identity narada.test --session healthy-session --host-command-output-read --host-command-output-ref mcp_payload:carrier_host_command_output:host_command_inventory_1@v1');
const sessionInventoryOperationsJsonRun = spawnSync(process.execPath, [
  fileURLToPath(new URL('./agent-cli.mjs', import.meta.url)),
  '--session-inventory-operations-json',
  '--identity',
  'sonar.resident',
  '--session',
  'inventory-scan-test',
], {
  cwd: inventoryRoot,
  env: { ...process.env, NARADA_SITE_ROOT: inventoryRoot },
  encoding: 'utf8',
});
assert.equal(sessionInventoryOperationsJsonRun.status, 0);
const sessionInventoryOperationsJson = JSON.parse(sessionInventoryOperationsJsonRun.stdout);
assert.equal(sessionInventoryOperationsJson.schema, 'narada.agent_cli.session_inventory_operations.v1');
assert.equal(sessionInventoryOperationsJson.site_root, inventoryRoot);
assert.equal(sessionInventoryOperationsJson.carrier_session_count, 1);
assert.equal(sessionInventoryOperationsJson.total_carrier_session_count, 2);
assert.deepEqual(sessionInventoryOperationsJson.directive_kind_counts, { operation_heartbeat: 3 });
assert.equal(sessionInventoryOperationsJson.directive_kind_summary, '3 (operation_heartbeat)');
assert.deepEqual(sessionInventoryOperationsJson.directive_visibility_counts, { record_only: 3 });
assert.equal(sessionInventoryOperationsJson.operation_id_summary, '3 (operation_inventory_1)');
assert.equal(sessionInventoryOperationsJson.sessions[0].session, 'healthy-session');
assert.equal(sessionInventoryOperationsJson.sessions[0].last_operation_id, 'operation_inventory_1');
assert.equal(sessionInventoryOperationsJson.sessions[0].last_directive_kind, 'operation_heartbeat');
assert.equal(sessionInventoryOperationsJson.sessions[0].last_directive_visibility, 'record_only');
const sessionOperationsRun = spawnSync(process.execPath, [
  fileURLToPath(new URL('./agent-cli.mjs', import.meta.url)),
  '--session-operations',
  '--identity',
  'sonar.resident',
  '--session',
  'healthy-session',
], {
  cwd: inventoryRoot,
  env: { ...process.env, NARADA_SITE_ROOT: inventoryRoot },
  encoding: 'utf8',
});
assert.equal(sessionOperationsRun.status, 0);
assert.equal(sessionOperationsRun.stdout.includes('Operation events'), true);
assert.equal(sessionOperationsRun.stdout.includes('Directive kinds'), true);
assert.equal(sessionOperationsRun.stdout.includes('Directive visibility'), true);
assert.equal(sessionOperationsRun.stdout.includes('Operation ids'), true);
assert.equal(sessionOperationsRun.stdout.includes('Session operations'), true);
assert.equal(sessionOperationsRun.stdout.includes('narada-agent-cli --identity narada.test --session healthy-session --session-operations'), true);
const sessionOperationsJsonRun = spawnSync(process.execPath, [
  fileURLToPath(new URL('./agent-cli.mjs', import.meta.url)),
  '--session-operations-json',
  '--identity',
  'sonar.resident',
  '--session',
  'healthy-session',
], {
  cwd: inventoryRoot,
  env: { ...process.env, NARADA_SITE_ROOT: inventoryRoot },
  encoding: 'utf8',
});
assert.equal(sessionOperationsJsonRun.status, 0);
const sessionOperationsJson = JSON.parse(sessionOperationsJsonRun.stdout);
assert.equal(sessionOperationsJson.schema, 'narada.agent_cli.session_operations.v1');
assert.equal(sessionOperationsJson.site_root, inventoryRoot);
assert.equal(sessionOperationsJson.session, 'healthy-session');
assert.equal(sessionOperationsJson.found, true);
assert.equal(sessionOperationsJson.operation.operation_event_summary, '1 (directive_emission_authorized), 1 (directive_emission_rule_recorded), 1 (directive_emitted)');
assert.deepEqual(sessionOperationsJson.operation.operation_event_counts, {
  directive_emission_authorized: 1,
  directive_emission_rule_recorded: 1,
  directive_emitted: 1,
});
assert.deepEqual(sessionOperationsJson.operation.directive_kind_counts, { operation_heartbeat: 3 });
assert.equal(sessionOperationsJson.operation.directive_visibility_summary, '3 (record_only)');
assert.equal(sessionOperationsJson.operation.operation_id_summary, '3 (operation_inventory_1)');
assert.equal(sessionOperationsJson.event_summary.event_count, 10);
assert.equal(sessionOperationsJson.preflight.operational_state, 'healthy');
assert.equal(sessionOperationsJson.recovery.recovery_kind, 'no_recovery');
assert.equal(sessionOperationsJson.record.operation_id_summary, '3 (operation_inventory_1)');
const hostCommandOutputReadJsonRun = spawnSync(process.execPath, [
  fileURLToPath(new URL('./agent-cli.mjs', import.meta.url)),
  '--host-command-output-read-json',
  '--identity',
  'sonar.resident',
  '--session',
  'healthy-session',
  '--host-command-output-ref',
  'mcp_payload:carrier_host_command_output:host_command_inventory_1@v1',
], {
  cwd: inventoryRoot,
  env: { ...process.env, NARADA_SITE_ROOT: inventoryRoot },
  encoding: 'utf8',
});
assert.equal(hostCommandOutputReadJsonRun.status, 0);
const hostCommandOutputReadJson = JSON.parse(hostCommandOutputReadJsonRun.stdout);
assert.equal(hostCommandOutputReadJson.schema, 'narada.agent_cli.host_command_output_read.v1');
assert.equal(hostCommandOutputReadJson.site_root, inventoryRoot);
assert.equal(hostCommandOutputReadJson.session, 'healthy-session');
assert.equal(hostCommandOutputReadJson.found, true);
assert.equal(hostCommandOutputReadJson.command_id, 'host_command_inventory_1');
assert.equal(hostCommandOutputReadJson.command_summary, 'git status');
assert.equal(hostCommandOutputReadJson.output_ref, 'mcp_payload:carrier_host_command_output:host_command_inventory_1@v1');
assert.equal(hostCommandOutputReadJson.stdout, 'On branch main');
assert.equal(hostCommandOutputReadJson.stderr, '');
assert.equal(hostCommandOutputReadJson.handoffs.host_command_output_read_json, 'narada-agent-cli --identity narada.test --session healthy-session --host-command-output-read-json --host-command-output-ref mcp_payload:carrier_host_command_output:host_command_inventory_1@v1');
const missingSessionRoot = mkdtempSync(join(tmpdir(), 'narada-agent-cli-session-read-missing-'));
const missingSessionReadJsonRun = spawnSync(process.execPath, [
  fileURLToPath(new URL('./agent-cli.mjs', import.meta.url)),
  '--session-read-json',
  '--identity',
  'sonar.resident',
  '--session',
  'missing-session',
], {
  cwd: missingSessionRoot,
  env: { ...process.env, NARADA_SITE_ROOT: missingSessionRoot },
  encoding: 'utf8',
});
assert.equal(missingSessionReadJsonRun.status, 0);
const missingSessionReadJson = JSON.parse(missingSessionReadJsonRun.stdout);
assert.equal(missingSessionReadJson.schema, 'narada.agent_cli.session_read.v1');
assert.equal(missingSessionReadJson.site_root, missingSessionRoot);
assert.equal(missingSessionReadJson.session, 'missing-session');
assert.equal(missingSessionReadJson.found, false);
const missingSessionEventsJsonRun = spawnSync(process.execPath, [
  fileURLToPath(new URL('./agent-cli.mjs', import.meta.url)),
  '--session-events-json',
  '--identity',
  'sonar.resident',
  '--session',
  'missing-session',
], {
  cwd: missingSessionRoot,
  env: { ...process.env, NARADA_SITE_ROOT: missingSessionRoot },
  encoding: 'utf8',
});
assert.equal(missingSessionEventsJsonRun.status, 0);
const missingSessionEventsJson = JSON.parse(missingSessionEventsJsonRun.stdout);
assert.equal(missingSessionEventsJson.schema, 'narada.agent_cli.session_events_read.v1');
assert.equal(missingSessionEventsJson.site_root, missingSessionRoot);
assert.equal(missingSessionEventsJson.session, 'missing-session');
assert.equal(missingSessionEventsJson.found, false);
assert.equal(missingSessionEventsJson.event_count, 0);
assert.deepEqual(missingSessionEventsJson.recent_events, []);
const missingHostCommandOutputJsonRun = spawnSync(process.execPath, [
  fileURLToPath(new URL('./agent-cli.mjs', import.meta.url)),
  '--host-command-output-read-json',
  '--identity',
  'sonar.resident',
  '--session',
  'missing-session',
], {
  cwd: missingSessionRoot,
  env: { ...process.env, NARADA_SITE_ROOT: missingSessionRoot },
  encoding: 'utf8',
});
assert.equal(missingHostCommandOutputJsonRun.status, 0);
const missingHostCommandOutputJson = JSON.parse(missingHostCommandOutputJsonRun.stdout);
assert.equal(missingHostCommandOutputJson.schema, 'narada.agent_cli.host_command_output_read.v1');
assert.equal(missingHostCommandOutputJson.site_root, missingSessionRoot);
assert.equal(missingHostCommandOutputJson.session, 'missing-session');
assert.equal(missingHostCommandOutputJson.found, false);
assert.equal(missingHostCommandOutputJson.output_ref, null);
rmSync(missingSessionRoot, { recursive: true, force: true });
rmSync(inventoryRoot, { recursive: true, force: true });

assert.equal(createTerminalStyle({ enabled: false }).prompt('narada> '), 'narada> ');
assert.equal(createTerminalStyle({ enabled: true }).prompt('narada> ').includes('\x1b['), true);
assert.equal(stripAnsiForTest(styleInputRouteLabel('operator -> narada.architect')), 'operator -> narada.architect');
assert.equal(formatToolResultContent({ content: [{ type: 'text', text: 'ok' }] }), '{"content":[{"type":"text","text":"ok"}]}');
assert.equal(formatToolResultContent('{"status":"success","schema":"narada.test.v1","directive_count":2,"extra":true}'), '{"status":"success","schema":"narada.test.v1","directive_count":2,"extra":true}');


function stripAnsiForTest(text) {
  return String(text).replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

async function withSilencedStdout(fn) {
  const originalWrite = process.stdout.write;
  process.stdout.write = () => true;
  try {
    return await fn();
  } finally {
    process.stdout.write = originalWrite;
  }
}
