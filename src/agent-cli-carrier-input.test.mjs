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

const transcriptProjectionCases = JSON.parse(readFileSync(new URL('../../narada/packages/carrier-protocol/fixtures/transcript-projection-cases.json', import.meta.url), 'utf8'));
const inputPipelineCases = JSON.parse(readFileSync(new URL('../../narada/packages/carrier-protocol/fixtures/carrier-input-pipeline-cases.json', import.meta.url), 'utf8'));
const directiveEmitterRegistryCases = JSON.parse(readFileSync(new URL('../../narada/packages/carrier-protocol/fixtures/carrier-directive-emitter-registry-cases.json', import.meta.url), 'utf8'));

assert.equal(transcriptProjectionCases.schema, 'narada.carrier.transcript_projection_cases.v1');
for (const entry of transcriptProjectionCases.cases) {
  const sessionEvent = JSON.parse(readFileSync(new URL(`../../narada/packages/carrier-protocol/fixtures/${entry.fixture}`, import.meta.url), 'utf8'));
  assert.deepEqual(validateSessionEvent(sessionEvent), [], entry.name);
  assert.equal(typeof entry.expected_actor, 'string');
  assert.equal(typeof entry.expected_text, 'string');
}
assert.equal(inputPipelineCases.schema, 'narada.carrier.input_pipeline_cases.v1');
for (const entry of inputPipelineCases.cases) {
  const normalized = normalizeInputEvent(entry.input);
  const queueAdmission = classifyCarrierInputQueueAdmission(normalized, entry.state);
  const hold = classifyCarrierInputHold(normalized, entry.state);
  assert.equal(queueAdmission.admission_action, entry.expected.admission_action, entry.name);
  assert.equal(queueAdmission.creates_turn, entry.expected.creates_turn, entry.name);
  assert.equal(queueAdmission.complete_without_provider, entry.expected.complete_without_provider, entry.name);
  assert.equal(queueAdmission.dispatch_to_provider, entry.expected.dispatch_to_provider, entry.name);
  if (Object.hasOwn(entry.expected, 'directive_visibility')) assert.equal(queueAdmission.directive_visibility, entry.expected.directive_visibility, entry.name);
  assert.deepEqual(queueAdmission.queue_events.map((event) => event.event_kind), entry.expected.queue_event_kinds, entry.name);
  assert.deepEqual(queueAdmission.admission_events.map((event) => event.event_kind), entry.expected.admission_event_kinds, entry.name);
  assert.deepEqual(queueAdmission.visible_events.map((event) => event.event_kind), entry.expected.visible_event_kinds ?? [], entry.name);
  assert.equal(hold.hold_action, entry.expected.hold_action, entry.name);
  assert.equal(hold.should_defer, entry.expected.should_defer, entry.name);
  assert.equal(shouldDeferQueuedInput(normalized, {
    rl: { line: entry.state.composerHasDraft ? 'draft' : '' },
    promptState: { active: true },
  }), entry.expected.should_defer, entry.name);
}

const heartbeatEmitterEvents = [];
const heartbeatEmitterDrained = [];
const heartbeatEmitterQueue = createInputQueue({
  drain: async (event) => {
    heartbeatEmitterDrained.push(event);
    return { terminal_state: 'completed_without_provider' };
  },
});
const heartbeatEmitter = createOperationHeartbeatDirectiveEmitter({
  inputQueue: heartbeatEmitterQueue,
  appendSessionFn: (event) => heartbeatEmitterEvents.push(event),
  carrierSessionEventEntryFn: (eventKind, payload) => createSessionEvent({
    event_kind: eventKind,
    carrier_session_id: 'carrier_session_heartbeat_test',
    agent_id: 'narada.test',
    site_id: 'site_test',
    site_root: 'test://site',
    payload,
  }),
  session: 'carrier_session_heartbeat_test',
  identity: 'narada.test',
  siteId: 'site_test',
  operationId: 'operation_heartbeat_test',
  now: () => '2026-05-30T00:01:00.000Z',
});
const firstHeartbeat = await heartbeatEmitter.emitOnce();
assert.equal(firstHeartbeat.ok, true);
assert.deepEqual(heartbeatEmitterEvents.map((event) => event.event_kind), [
  'directive_emission_authorized',
  'directive_emission_rule_recorded',
  'directive_emitted',
]);
for (const event of heartbeatEmitterEvents) assert.deepEqual(validateSessionEvent(event), [], event.event_kind);
assert.equal(heartbeatEmitterDrained.length, 1);
assert.equal(heartbeatEmitterDrained[0].metadata.directive.kind, 'operation_heartbeat');
assert.equal(heartbeatEmitterDrained[0].metadata.directive.visibility, 'record_only');
assert.equal(heartbeatEmitterDrained[0].metadata.directive.operation_id, 'operation_heartbeat_test');
const secondHeartbeat = await heartbeatEmitter.emitOnce();
assert.equal(secondHeartbeat.ok, true);
assert.equal(heartbeatEmitterEvents.at(-1).event_kind, 'directive_emitted');
assert.equal(heartbeatEmitterEvents.filter((event) => event.event_kind === 'directive_emission_authorized').length, 1);
assert.equal(heartbeatEmitterDrained.length, 2);

assert.equal(directiveEmitterRegistryCases.schema, 'narada.carrier.directive_emitter_registry_cases.v1');
const attentionFixture = directiveEmitterRegistryCases.cases.find((entry) => entry.name === 'operation_attention_runtime_trigger_operator_visible_operation_target');
const attentionEmitterEvents = [];
const attentionEmitterDrained = [];
const attentionEmitterQueue = createInputQueue({
  drain: async (event) => {
    attentionEmitterDrained.push(event);
    return { terminal_state: 'completed_without_provider' };
  },
});
const attentionEmitter = createCarrierDirectiveEmitter({
  inputQueue: attentionEmitterQueue,
  directiveKind: attentionFixture.directive_kind,
  appendSessionFn: (event) => attentionEmitterEvents.push(event),
  carrierSessionEventEntryFn: (eventKind, payload) => createSessionEvent({
    event_kind: eventKind,
    carrier_session_id: 'carrier_session_attention_test',
    agent_id: 'narada.test',
    site_id: 'site_test',
    site_root: 'test://site',
    payload,
  }),
  session: 'carrier_session_attention_test',
  identity: 'narada.test',
  siteId: 'site_test',
  operationId: attentionFixture.operation_id,
  target: attentionFixture.target,
  now: () => '2026-05-30T00:02:00.000Z',
});
const attention = await attentionEmitter.emitOnce();
assert.equal(attention.ok, true);
assert.equal(attention.directive_kind, attentionFixture.directive_kind);
assert.deepEqual(attentionEmitterEvents.map((event) => event.event_kind), [
  'directive_emission_authorized',
  'directive_emission_rule_recorded',
  'directive_emitted',
]);
for (const event of attentionEmitterEvents) assert.deepEqual(validateSessionEvent(event), [], event.event_kind);
assert.equal(attentionEmitterDrained.length, 1);
assert.equal(attentionEmitterDrained[0].metadata.directive.kind, attentionFixture.directive_kind);
assert.equal(attentionEmitterDrained[0].metadata.directive.visibility, attentionFixture.expected.default_visibility);
assert.equal(attentionEmitterDrained[0].metadata.directive.trigger_kind, attentionFixture.expected.trigger_kind);
assert.deepEqual(attentionEmitterDrained[0].metadata.directive.target, attentionFixture.target);
const suppressedAttention = await attentionEmitter.emitOnce({ enabled: false });
assert.deepEqual(suppressedAttention, {
  ok: false,
  code: 'directive_emission_disabled',
  directive_kind: attentionFixture.directive_kind,
});

for (const entry of [
  {
    name: 'agent_cli_read_only_mcp_tool_result_admitted',
    status: 'ok',
    classification: { decision: 'read_only_admitted', authority_owner: 'filesystem_service' },
    expected: { admission_action: 'admit', admission_reason: 'read_only_tool_effect_admitted' },
  },
  {
    name: 'agent_cli_mutating_mcp_tool_result_requires_admission',
    status: 'denied',
    classification: { decision: 'routed', authority_owner: 'task_governance_service' },
    expected: { admission_action: 'deny', admission_reason: 'tool_effect_admission_required' },
  },
  {
    name: 'agent_cli_refused_mcp_tool_result_denied',
    status: 'denied',
    classification: { decision: 'refused', authority_owner: null },
    expected: { admission_action: 'deny', admission_reason: 'unsupported_tool_effect' },
  },
]) {
  const payload = createToolResultPayload({
    tool_name: 'fixture_tool',
    status: entry.status,
    duration_ms: 1,
    result_summary: entry.name,
    ...mcpToolEffectAdmissionEvidence({
      serverMode: true,
      admissionClassification: entry.classification,
      status: entry.status,
      category: 'prompt',
    }),
  });
  assert.equal(payload.admission_action, entry.expected.admission_action, entry.name);
  assert.equal(payload.admission_reason, entry.expected.admission_reason, entry.name);
  assert.deepEqual(validateSessionEvent(createSessionEvent({
    event_kind: 'tool_result_received',
    carrier_session_id: 'carrier_session_agent_cli_fixture',
    agent_id: 'narada.test',
    site_id: 'site_fixture',
    site_root: 'file:///fixture',
    payload,
  })), [], entry.name);
}

const hugeEnv = {
  Path: 'C:\\Windows\\System32',
  APPDATA: 'C:\\Users\\Andrey\\AppData\\Roaming',
  NARADA_AGENT_ID: 'narada-andrey.Kevin',
  NARADA_SITE_ROOT: 'C:\\Users\\Andrey\\Narada',
  NARADA_PROPER_ROOT: 'D:\\code\\narada',
  OPENAI_MODEL: 'gpt-5.5',
  DEEPSEEK_API_KEY: 'deepseek-secret-test-key',
  DEEPSEEK_API_BASE_URL: 'https://deepseek.example.test',
  NARADA_WORKER_MCP_CONFIG: 'D:\\code\\narada.sonar\\.narada\\worker-mcp.json',
  GIANT_UNRELATED_ENV: 'x'.repeat(100000),
};
const childEnv = buildChildProcessEnv({ MCP_SERVER_NAME: 'narada-andrey-task-lifecycle' }, hugeEnv);
assert.equal(childEnv.Path, hugeEnv.Path);
assert.equal(childEnv.NARADA_AGENT_ID, 'narada-andrey.Kevin');
assert.equal(childEnv.NARADA_SITE_ROOT, 'C:\\Users\\Andrey\\Narada');
assert.equal(childEnv.NARADA_PROPER_ROOT, 'D:\\code\\narada');
assert.equal(childEnv.OPENAI_MODEL, 'gpt-5.5');
assert.equal(childEnv.DEEPSEEK_API_KEY, 'deepseek-secret-test-key');
assert.equal(childEnv.DEEPSEEK_API_BASE_URL, 'https://deepseek.example.test');
assert.equal(childEnv.NARADA_WORKER_MCP_CONFIG, 'D:\\code\\narada.sonar\\.narada\\worker-mcp.json');
assert.equal(childEnv.MCP_SERVER_NAME, 'narada-andrey-task-lifecycle');
assert.equal(childEnv.GIANT_UNRELATED_ENV, undefined);
assert.equal(childEnv.FORCE_COLOR, '0');
assert.equal(childEnv.NO_COLOR, '1');
assert.ok(environmentBlockLength(childEnv) < 32767);

assert.equal(inputRecordDisplayLabel({ source: 'operator_directive' }), 'operator directive -> narada.architect');
assert.equal(inputRecordDisplayLabel({ source: 'operator_steering' }), 'operator steering -> narada.architect');
assert.equal(inputRecordDisplayLabel({ source: 'system_directive' }), 'system directive');
assert.equal(CARRIER_CONTROL_METHODS.includes('agent-cli.command'), true);
assert.equal(classifyCarrierControlRequest({ id: 'command-1', method: 'agent-cli.command', params: { command: '/model', value: 'gpt-test' } }).method_kind, 'agent_cli_command');
assert.deepEqual(normalizeInputRecord('typed message'), { content: 'typed message', source: 'manual_operator' });
const normalizedEvent = normalizeInputEvent(
  { content: 'run startup sequence', source: 'system_directive', authority_ref: 'dir_1', directive_id: 'dir_1' },
  { transport: 'control_jsonl' },
);
assert.equal(normalizedEvent.source, 'system_directive');
assert.equal(normalizedEvent.transport, 'control_jsonl');
assert.equal(normalizedEvent.source_kind, 'system');
assert.equal(normalizedEvent.delivery_mode, 'admit_for_current_turn');
assert.equal(normalizedEvent.directive_id, 'dir_1');
assert.match(normalizedEvent.event_id, /^input_/);
const observerEvent = normalizeInputEvent({
  content: 'Ask what evidence is missing.',
  source: 'observer',
  rule_id: 'hesitation-source-check',
  visibility: 'operator_visible',
  confidence: 'medium',
}, { transport: 'control_jsonl' });
assert.equal(observerEvent.source, 'observer');
assert.equal(observerEvent.source_kind, 'agent');
assert.equal(observerEvent.source_id, 'narada.observer');
assert.equal(observerEvent.delivery_mode, 'admit_after_active_turn');
assert.equal(observerEvent.metadata.observer.role, 'observer');
assert.equal(observerEvent.metadata.observer.rule_id, 'hesitation-source-check');
assert.equal(observerEvent.metadata.observer.visibility, 'operator_visible');
assert.equal(isObserverInputEvent(observerEvent), true);
assert.equal(isObserverInputEvent({ source_kind: 'agent', source_id: 'observerish-agent', metadata: { agent_control_input: true } }), false);
assert.equal(observerVisibility(observerEvent), 'operator_visible');
assert.equal(inputRecordDisplayLabel(observerEvent), 'narada.observer -> operator');
const receiptEvidence = directiveReceiptEvidence(normalizedEvent, {
  agentId: 'narada.architect',
  carrierSessionId: 'carrier_session_test',
  receivedAt: '2026-05-28T00:00:00.000Z',
});
assert.equal(receiptEvidence.schema, 'narada.directive.carrier_receipt_evidence.v1');
assert.equal(receiptEvidence.directive_id, 'dir_1');
assert.equal(receiptEvidence.agent_id, 'narada.architect');
assert.match(receiptEvidence.receipt_id, /^dirrcpt_/);
const queueDrainOrder = [];
const queue = createInputQueue({ drain: async (event) => { queueDrainOrder.push(event.content); return { terminal_state: 'completed' }; } });
await queue.enqueue(normalizeInputEvent({ content: 'operator', source: 'manual_operator' }, { transport: 'terminal' }));
await queue.enqueue(normalizeInputEvent({ content: 'system', source: 'system_directive' }, { transport: 'control_jsonl' }), { drain: true });
assert.deepEqual(queueDrainOrder, ['operator', 'system']);
let defer = true;
let deferredNotice = null;
const deferredQueue = createInputQueue({
  drain: async (event) => { queueDrainOrder.push(event.content); return { terminal_state: 'completed' }; },
  shouldDefer: () => defer,
  onDeferred: (event, queueState) => { deferredNotice = `${event.content}:${queueState.pendingSystemDirectiveCount}`; },
});
await deferredQueue.enqueue(normalizeInputEvent({ content: 'queued-system', source: 'system_directive' }, { transport: 'control_jsonl' }), { drain: true });
assert.equal(deferredQueue.pendingCount, 1);
assert.equal(deferredQueue.pendingSystemDirectiveCount, 1);
assert.equal(deferredQueue.pendingOperatorDirectiveCount, 0);
assert.equal(deferredNotice, 'queued-system:1');
defer = false;
await deferredQueue.drainUntilIdle();
assert.equal(deferredQueue.pendingCount, 0);
const observerQueue = createInputQueue({ drain: async () => ({ terminal_state: 'completed_without_provider' }) });
await observerQueue.enqueue(observerEvent);
assert.equal(observerQueue.pendingObserverCount, 1);
assert.equal(observerQueue.state().pendingObserverCount, 1);
const abandonedQueue = createInputQueue({ drain: async () => ({ terminal_state: 'completed' }) });
await abandonedQueue.enqueue(normalizeInputEvent({ content: 'abandon me', source: 'operator_steering' }, { transport: 'terminal' }));
assert.equal(abandonedQueue.pendingCount, 1);
const abandoned = abandonedQueue.finalizeSession();
assert.equal(abandoned.length, 1);
assert.equal(abandonedQueue.pendingCount, 0);
assert.deepEqual(abandonedQueue.finalizeSession(), []);
assert.equal(shouldDeferQueuedInput({ source: 'manual_operator' }, { promptState: { active: true } }), false);
assert.equal(shouldDeferQueuedInput({ source: 'system_directive' }, { rl: { line: '' }, promptState: { active: true } }), false);
assert.equal(shouldDeferQueuedInput({ source: 'system_directive' }, { rl: { line: '   ' }, promptState: { active: true } }), false);
assert.equal(shouldDeferQueuedInput({ source: 'system_directive' }, { rl: { line: 'partial' }, promptState: { active: true } }), true);
assert.equal(shouldDeferQueuedInput({ source: 'system_directive' }, { rl: { line: 'partial' }, promptState: { active: false } }), false);
assert.equal(sanitizeOperatorDirectiveDraftForDisplay('keep this full draft'), 'keep this full draft');
assert.equal(sanitizeOperatorDirectiveDraftForDisplay('line\r\nbreak\tand\u0003control'), 'line break andcontrol');
const submittedOperatorDirectiveLines = [];
assert.equal(consumeOperatorDirectiveInputText('draft', {
  initialBuffer: '',
  submitLine: (content) => submittedOperatorDirectiveLines.push(content),
}), 'draft');
assert.deepEqual(submittedOperatorDirectiveLines, []);
assert.equal(consumeOperatorDirectiveInputText('one\r\ntwo\nthree', {
  initialBuffer: '',
  submitLine: (content) => submittedOperatorDirectiveLines.push(content),
}), '');
assert.deepEqual(submittedOperatorDirectiveLines, ['one', 'two', 'three']);
const progressWithDraft = formatProgressStatus({
  spinner: '-',
  phase: 'thinking',
  totalMs: 1000,
  phaseMs: 1000,
  operatorDirectiveDraft: 'please keep editing visible',
  operatorDirectiveDraftLength: 27,
});
assert.match(progressWithDraft, /Esc to interrupt · typing: please keep editing visible$/);
const controlJsonlDir = mkdtempSync(join(tmpdir(), 'narada-agent-cli-control-jsonl-'));
const controlJsonlPath = join(controlJsonlDir, 'control.jsonl');
const controlEvents = [];
const controlQueue = createInputQueue({
  drain: async (event) => { controlEvents.push(event); return { terminal_state: 'completed' }; },
});
const watcher = startControlJsonlWatcher({ controlPath: controlJsonlPath, inputQueue: controlQueue });
const controlFrame = JSON.stringify({
  method: 'system_directive.deliver',
  params: { directive_id: 'dir_partial', message: 'run startup sequence' },
});
appendFileSync(controlJsonlPath, controlFrame.slice(0, 20), 'utf8');
await delayForTest(350);
assert.equal(controlEvents.length, 0);
appendFileSync(controlJsonlPath, `${controlFrame.slice(20)}\n`, 'utf8');
await delayForTest(500);
watcher.stop();
assert.equal(controlEvents.length, 1);
assert.equal(controlEvents[0].directive_id, 'dir_partial');
rmSync(controlJsonlDir, { recursive: true, force: true });
const nativeControlEvents = [];
const nativeControlQueue = createInputQueue({
  drain: async (event) => { nativeControlEvents.push(event); return { terminal_state: 'completed' }; },
});
await handleControlLine(JSON.stringify({
  schema: 'narada.carrier.control.input_event.v1',
  control_event_id: 'control_native_1',
  input_event_id: 'input_native_1',
  written_at: '2026-05-30T00:00:00.000Z',
  input: {
    schema: 'narada.carrier.input_event.v1',
    event_id: 'input_native_1',
    source_kind: 'system',
    source_id: 'narada-proper.system.directive_emitter',
    transport: 'control_jsonl',
    delivery_mode: 'admit_for_current_turn',
    hold_condition: null,
    content: 'native control directive',
    created_at: '2026-05-30T00:00:00.000Z',
    authority_ref: 'auth_native',
    directive_id: 'dir_native',
    metadata: { directive_provenance: { kind: 'system_directive' } },
  },
}), { inputQueue: nativeControlQueue });
assert.equal(nativeControlEvents.length, 1);
assert.equal(nativeControlEvents[0].source, 'system_directive');
assert.equal(nativeControlEvents[0].source_kind, 'system');
assert.equal(nativeControlEvents[0].directive_id, 'dir_native');
const carrierInputDeliverEvents = [];
const carrierInputDeliverQueue = createInputQueue({
  drain: async (event) => { carrierInputDeliverEvents.push(event); return { terminal_state: 'completed' }; },
});
await handleControlLine(JSON.stringify({
  method: 'carrier.input.deliver',
  params: {
    input: {
      schema: 'narada.carrier.input_event.v1',
      event_id: 'input_carrier_deliver_system_1',
      source_kind: 'system',
      source_id: 'sonar.system.directive_emitter',
      transport: 'carrier_server_api',
      delivery_mode: 'admit_for_current_turn',
      hold_condition: null,
      content: 'carrier input deliver directive',
      created_at: '2026-05-30T00:00:00.000Z',
      authority_ref: 'dir_carrier_deliver_system',
      directive_id: 'dir_carrier_deliver_system',
      metadata: { directive_provenance: { kind: 'system_directive' } },
    },
  },
}), { inputQueue: carrierInputDeliverQueue });
assert.equal(carrierInputDeliverEvents.length, 1);
assert.equal(carrierInputDeliverEvents[0].source_kind, 'system');
assert.equal(carrierInputDeliverEvents[0].directive_id, 'dir_carrier_deliver_system');
const observerControlEvents = [];
const observerControlQueue = createInputQueue({
  drain: async (event) => { observerControlEvents.push(event); return { terminal_state: 'completed_without_provider' }; },
});
await handleControlLine(JSON.stringify({
  schema: 'narada.carrier.control.input_event.v1',
  control_event_id: 'control_observer_1',
  input_event_id: 'input_observer_1',
  written_at: '2026-05-30T00:00:00.000Z',
  input: {
    schema: 'narada.carrier.input_event.v1',
    event_id: 'input_observer_1',
    source_kind: 'agent',
    source_id: 'narada.observer',
    transport: 'control_jsonl',
    delivery_mode: 'admit_after_active_turn',
    hold_condition: null,
    content: 'Ask what evidence is missing.',
    created_at: '2026-05-30T00:00:00.000Z',
    authority_ref: null,
    directive_id: null,
    metadata: {
      observer: {
        role: 'observer',
        rule_id: 'hesitation-source-check',
        visibility: 'operator_visible',
        confidence: 'medium',
      },
    },
  },
}), { inputQueue: observerControlQueue });
assert.equal(observerControlEvents.length, 1);
assert.equal(observerControlEvents[0].source, 'observer');
assert.equal(observerControlEvents[0].source_kind, 'agent');
assert.equal(observerControlEvents[0].metadata.observer.visibility, 'operator_visible');
assert.deepEqual(removeInvalidToolHistory([
  { schema: 'narada.carrier.session_event.v1', event_kind: 'session_started' },
  { role: undefined, content: 'not a provider message' },
  { role: 'user', content: 'run startup sequence' },
  { role: 'tool', content: '{}', tool_call_id: 'orphan:0' },
  {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'call:1', type: 'function', function: { name: 'startup_sequence', arguments: '{}' } }],
    reasoning_content: '',
  },
  { role: 'tool', content: '{"status":"ok"}', tool_call_id: 'call:1' },
]), [
  { role: 'user', content: 'run startup sequence' },
  {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'call:1', type: 'function', function: { name: 'startup_sequence', arguments: '{}' } }],
    reasoning_content: '',
  },
  { role: 'tool', content: '{"status":"ok"}', tool_call_id: 'call:1' },
]);
const programmaticInputs = [{ content: 'flag supplied message', source: 'programmatic_operator', authority_ref: 'task:1186' }];
const programmaticLogEntry = sessionLogEntry({ role: 'user', content: programmaticInputs[0].content, source: programmaticInputs[0].source, authorityRef: programmaticInputs[0].authority_ref });
assert.equal(programmaticLogEntry.role, 'user');
assert.equal(programmaticLogEntry.content, 'flag supplied message');
assert.equal(programmaticLogEntry.source, 'programmatic_operator');
assert.equal(programmaticLogEntry.authority_ref, 'task:1186');
assert.match(programmaticLogEntry.timestamp, /T/);
const eventEntry = sessionEventEntry('session_setting_changed', { setting: 'model', value: 'gpt-5.5' });
assert.equal(eventEntry.role, 'event');
assert.equal(eventEntry.event, 'session_setting_changed');
assert.equal(eventEntry.setting, 'model');
assert.equal(eventEntry.value, 'gpt-5.5');
assert.equal(normalizeThinkingLevel('HIGH'), 'high');
assert.equal(normalizeThinkingLevel('bad'), 'medium');
assert.equal(parseBooleanEnv('1', false), true);
assert.equal(parseBooleanEnv('off', true), false);
assert.equal(parseBooleanEnv(undefined, true), true);
assert.deepEqual(classifyCarrierHostCommandInput('! git status'), {
  is_host_command: true,
  command_text: 'git status',
  admission_action: 'execute',
  admission_reason: 'host_command_enabled',
  execution_surface: 'carrier_host_shell',
  creates_provider_turn: false,
});
assert.equal(classifyCarrierHostCommandInput('hello ! git status').is_host_command, false);
assert.equal(classifyCarrierHostCommandInput('/status').is_host_command, false);
assert.deepEqual(classifyCarrierHostCommandInput('!   '), {
  is_host_command: true,
  command_text: '',
  admission_action: 'reject',
  admission_reason: 'empty_host_command',
  execution_surface: 'carrier_host_shell',
  creates_provider_turn: false,
});
assert.equal(classifyCarrierHostCommandInput('! git status', { enabled: false }).admission_reason, 'host_commands_disabled');
assert.equal(classifyCarrierHostCommandInput('! git status', { approvalMode: 'prompt_for_approval' }).admission_action, 'prompt_for_approval');

function delayForTest(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

console.log('agent-cli carrier input tests PASSED.');
