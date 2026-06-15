import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { formatRuntimeMcpFaultEvent, formatRuntimeMcpFaultSummary, formatStartupMcpEvent, formatStartupMcpSummary, formatWrapperStatusEvent } from '../bin/agent-runtime-server.mjs';
import { commandTokens } from '@narada2/carrier-command-contract';
import {
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
  buildProgrammaticInputs,
  buildAnthropicMessagesRequest,
  buildCodexMcpRequest,
  buildChildProcessEnv,
  buildCodexExecArgs,
  codexExecMcpConfigArgs,
  codexExecConfigToml,
  codexExecMcpToolEventSummary,
  buildOpenAiChatRequest,
  codexExecEventText,
  copyToClipboard,
  consumeOperatorDirectiveInputText,
  createCarrierDirectiveEmitter,
  createInteractiveHeaderRows,
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
  formatProgressStatus,
  formatTimestamp,
  formatToolResultContent,
  formatObserverPosture,
  handleGoalCommand,
  handleInteractiveControlLine,
  handleObserverCommand,
  handleSlashCommand,
  messagesWithCarrierGoal,
  mcpToolEffectAdmissionEvidence,
  handleToolOutputDisplayCommand,
  runCodexTranscriptStats,
  inputRecordDisplayLabel,
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
  readSessionInventory,
  recordMcpPreflightArtifactLinkage,
  renderMarkdownForTerminal,
  rewriteSubmittedPromptForTest,
  runConversationTurn,
  runSessionInventory,
  runServerMode,
  serverStatus,
  sanitizeOperatorDirectiveDraftForDisplay,
  resolveProviderAdapter,
  resolveProviderSupportState,
  sessionEventEntry,
  sessionLogEntry,
  shouldDeferInteractiveInput,
  shouldDisplayToolOutputs,
  observerVisibility,
  styleInputRouteLabel,
  shouldSuppressMcpStderr,
  startInteractiveControlJsonlWatcher,
  toolDirectionLabel,
  wrapTerminalLine,
} from './agent-cli.mjs';

const metadata = JSON.parse(readFileSync(new URL('./intelligence-providers.json', import.meta.url), 'utf8')).providers;
const windowsWrapperTemplate = readFileSync(new URL('../templates/Start-AgentCliSession.ps1', import.meta.url), 'utf8');
const naradaToolCallEnvelope = JSON.parse(readFileSync(new URL('../../narada/packages/carrier-provider-contract/contracts/narada-tool-call-envelope.json', import.meta.url), 'utf8'));
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
  assert.equal(shouldDeferInteractiveInput(normalized, {
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

const tempDir = resolve('.ai/tmp-agent-cli-programmatic-test');
mkdirSync(tempDir, { recursive: true });
const messageFile = resolve(tempDir, 'message.txt');
writeFileSync(messageFile, 'file supplied message', 'utf8');

const hugeEnv = {
  Path: 'C:\\Windows\\System32',
  APPDATA: 'C:\\Users\\Andrey\\AppData\\Roaming',
  NARADA_AGENT_ID: 'narada-andrey.Kevin',
  NARADA_SITE_ROOT: 'C:\\Users\\Andrey\\Narada',
  NARADA_PROPER_ROOT: 'D:\\code\\narada',
  NARADA_AI_MODEL: 'gpt-5.5',
  GIANT_UNRELATED_ENV: 'x'.repeat(100000),
};
const childEnv = buildChildProcessEnv({ MCP_SERVER_NAME: 'narada-andrey-task-lifecycle' }, hugeEnv);
assert.equal(childEnv.Path, hugeEnv.Path);
assert.equal(childEnv.NARADA_AGENT_ID, 'narada-andrey.Kevin');
assert.equal(childEnv.NARADA_SITE_ROOT, 'C:\\Users\\Andrey\\Narada');
assert.equal(childEnv.NARADA_PROPER_ROOT, 'D:\\code\\narada');
assert.equal(childEnv.NARADA_AI_MODEL, 'gpt-5.5');
assert.equal(childEnv.MCP_SERVER_NAME, 'narada-andrey-task-lifecycle');
assert.equal(childEnv.GIANT_UNRELATED_ENV, undefined);
assert.equal(childEnv.FORCE_COLOR, '0');
assert.equal(childEnv.NO_COLOR, '1');
assert.ok(environmentBlockLength(childEnv) < 32767);

const programmaticInputs = buildProgrammaticInputs({
  messages: ['flag supplied message'],
  messageFiles: [messageFile],
  authorityRef: 'task:1186',
});
assert.deepEqual(programmaticInputs, [
  { content: 'flag supplied message', source: 'programmatic_operator', authority_ref: 'task:1186' },
  { content: 'file supplied message', source: 'programmatic_operator', authority_ref: 'task:1186' },
]);
assert.deepEqual(buildProgrammaticInputs({ messages: ['op'], operatorDirective: true }), [
  { content: 'op', source: 'operator_directive', authority_ref: null },
]);
assert.deepEqual(buildProgrammaticInputs({ messages: ['sys'], systemDirective: true }), [
  { content: 'sys', source: 'system_directive', authority_ref: null },
]);
assert.equal(inputRecordDisplayLabel({ source: 'operator_directive' }), 'operator directive -> narada.architect');
assert.equal(inputRecordDisplayLabel({ source: 'operator_steering' }), 'operator steering -> narada.architect');
assert.equal(inputRecordDisplayLabel({ source: 'system_directive' }), 'system directive');
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
assert.equal(shouldDeferInteractiveInput({ source: 'manual_operator' }, { promptState: { active: true } }), false);
assert.equal(shouldDeferInteractiveInput({ source: 'system_directive' }, { rl: { line: '' }, promptState: { active: true } }), false);
assert.equal(shouldDeferInteractiveInput({ source: 'system_directive' }, { rl: { line: '   ' }, promptState: { active: true } }), false);
assert.equal(shouldDeferInteractiveInput({ source: 'system_directive' }, { rl: { line: 'partial' }, promptState: { active: true } }), true);
assert.equal(shouldDeferInteractiveInput({ source: 'system_directive' }, { rl: { line: 'partial' }, promptState: { active: false } }), false);
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
const watcher = startInteractiveControlJsonlWatcher({ controlPath: controlJsonlPath, inputQueue: controlQueue });
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
await handleInteractiveControlLine(JSON.stringify({
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
const observerControlEvents = [];
const observerControlQueue = createInputQueue({
  drain: async (event) => { observerControlEvents.push(event); return { terminal_state: 'completed_without_provider' }; },
});
await handleInteractiveControlLine(JSON.stringify({
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
assert.deepEqual(parseArgs(['--stream', '--model', 'gpt-x']), { stream: true, model: 'gpt-x' });
assert.deepEqual(parseArgs(['--no-stream', '--thinking', 'low']), { stream: false, thinking: 'low' });
assert.deepEqual(parseArgs(['--color', '--no-color']), { color: false });
assert.deepEqual(parseArgs(['--operator-directive', '--system-directive']), { operatorDirective: true, systemDirective: true });
assert.deepEqual(parseArgs(['--enable-startup-system-directive']), { startupSystemDirective: true });
assert.deepEqual(parseArgs(['--startup-system-directive', 'run startup sequence', '--startup-system-directive-delay-ms', '10000']), {
  startupSystemDirective: true,
  startupSystemDirectiveText: 'run startup sequence',
  startupSystemDirectiveDelayMs: 10000,
});
assert.deepEqual(parseArgs(['--no-startup-system-directive']), { startupSystemDirective: false });
assert.deepEqual(parseArgs(['--control-jsonl', '.narada/control.jsonl']), { controlJsonl: '.narada/control.jsonl' });
assert.deepEqual(parseArgs(['--mcp-preflight']), { mcpPreflight: true });
assert.deepEqual(parseArgs(['--mcp-preflight-json']), { mcpPreflightJson: true });
assert.deepEqual(parseArgs(['--session-inventory']), { sessionInventory: true });
assert.deepEqual(parseArgs(['--session-inventory-json']), { sessionInventoryJson: true });
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
}))}\n${JSON.stringify({ event_kind: 'input_completed', timestamp: '2026-06-14T12:00:01.000Z', payload: { terminal_state: 'completed' } })}\n${JSON.stringify({ event: 'session_closed', timestamp: '2026-06-14T12:00:05.000Z', request_id: 'close-healthy-1', terminal_state: 'closed' })}\n`, 'utf8');
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
assert.equal(inventoryEntries[0].session, 'healthy-session');
assert.equal(inventoryEntries[0].agent_id, 'narada.test');
assert.equal(inventoryEntries[0].runtime, 'agent-cli');
assert.equal(inventoryEntries[0].mode, 'server');
assert.equal(inventoryEntries[0].started_at, '2026-06-14T11:50:00.000Z');
assert.equal(inventoryEntries[0].mcp_operational_state, 'healthy');
assert.equal(inventoryEntries[0].session_event_count, 3);
assert.equal(inventoryEntries[0].last_event_kind, 'session_closed');
assert.equal(inventoryEntries[0].last_event_at, '2026-06-14T12:00:05.000Z');
assert.equal(inventoryEntries[0].last_terminal_state, 'completed');
assert.equal(inventoryEntries[0].last_lifecycle_event_kind, 'session_closed');
assert.equal(inventoryEntries[0].last_lifecycle_at, '2026-06-14T12:00:05.000Z');
assert.equal(inventoryEntries[0].last_lifecycle_state, 'closed');
assert.deepEqual(inventoryEntries[0].lifecycle_state_counts, { completed: 1, closed: 1 });
assert.equal(inventoryEntries[0].lifecycle_state_summary, '1 (closed), 1 (completed)');
assert.equal(inventoryEntries[0].request_outcome_total, 0);
assert.equal(inventoryEntries[0].request_posture, 'clean');
assert.equal(inventoryEntries[0].request_posture_display, 'clean');
assert.equal(inventoryEntries[0].mcp_preflight_artifact_path, join(inventoryNaradaDir, 'runtime', 'agent-cli', 'mcp-preflight', 'healthy-session.json'));
assert.equal(inventoryEntries[1].session, 'faulted-session');
assert.equal(inventoryEntries[1].agent_id, 'narada.test');
assert.equal(inventoryEntries[1].started_at, '2026-06-14T11:40:00.000Z');
assert.equal(inventoryEntries[1].mcp_operational_state, 'runtime_faulted');
assert.equal(inventoryEntries[1].session_event_count, 7);
assert.equal(inventoryEntries[1].last_event_kind, 'input_completed');
assert.equal(inventoryEntries[1].last_event_at, '2026-06-14T11:59:45.000Z');
assert.equal(inventoryEntries[1].last_terminal_state, 'failed');
assert.equal(inventoryEntries[1].last_lifecycle_event_kind, 'input_completed');
assert.equal(inventoryEntries[1].last_lifecycle_at, '2026-06-14T11:59:45.000Z');
assert.equal(inventoryEntries[1].last_lifecycle_state, 'failed');
assert.deepEqual(inventoryEntries[1].lifecycle_state_counts, { failed: 1 });
assert.equal(inventoryEntries[1].lifecycle_state_summary, '1 (failed)');
assert.equal(inventoryEntries[1].request_outcome_total, 4);
assert.equal(inventoryEntries[1].request_posture, 'runtime_failures');
assert.equal(inventoryEntries[1].request_posture_display, 'runtime_failures (4)');
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
assert.equal(sessionInventoryRun.stdout.includes('MCP states'), true);
assert.equal(sessionInventoryRun.stdout.includes('Terminal states'), true);
assert.equal(sessionInventoryRun.stdout.includes('Lifecycle states'), true);
assert.equal(sessionInventoryRun.stdout.includes('Lifecycle outcomes'), true);
assert.equal(sessionInventoryRun.stdout.includes('Request posture'), true);
assert.equal(sessionInventoryRun.stdout.includes('Request outcomes'), true);
assert.equal(sessionInventoryRun.stdout.includes('Request issues'), true);
assert.equal(sessionInventoryRun.stdout.includes('healthy-session'), true);
assert.equal(sessionInventoryRun.stdout.includes('healthy'), true);
assert.equal(sessionInventoryRun.stdout.includes('faulted-session'), true);
assert.equal(sessionInventoryRun.stdout.includes('runtime_faulted'), true);
assert.equal(sessionInventoryRun.stdout.includes('MCP startup failures  1 (degraded:mcp_stdout_pollution)'), true);
assert.equal(sessionInventoryRun.stdout.includes('MCP runtime faults    1 (runtime:fs_read_file)'), true);
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
});
assert.equal(Array.isArray(sessionInventoryJson.sessions), true);
assert.equal(sessionInventoryJson.sessions[0].session, 'healthy-session');
assert.equal(sessionInventoryJson.sessions[0].agent_id, 'narada.test');
assert.equal(sessionInventoryJson.sessions[0].last_terminal_state, 'completed');
assert.equal(sessionInventoryJson.sessions[0].last_lifecycle_state, 'closed');
assert.equal(sessionInventoryJson.sessions[0].last_lifecycle_event_kind, 'session_closed');
assert.equal(sessionInventoryJson.sessions[0].request_outcome_total, 0);
assert.equal(sessionInventoryJson.sessions[0].request_posture, 'clean');
assert.equal(sessionInventoryJson.sessions[0].request_posture_display, 'clean');
assert.equal(sessionInventoryJson.sessions[0].mcp_operational_state, 'healthy');
assert.equal(sessionInventoryJson.sessions[1].session, 'faulted-session');
assert.equal(sessionInventoryJson.sessions[1].started_at, '2026-06-14T11:40:00.000Z');
assert.equal(sessionInventoryJson.sessions[1].last_terminal_state, 'failed');
assert.equal(sessionInventoryJson.sessions[1].last_lifecycle_state, 'failed');
assert.equal(sessionInventoryJson.sessions[1].last_lifecycle_event_kind, 'input_completed');
assert.equal(sessionInventoryJson.sessions[1].request_outcome_total, 4);
assert.equal(sessionInventoryJson.sessions[1].request_posture, 'runtime_failures');
assert.equal(sessionInventoryJson.sessions[1].request_posture_display, 'runtime_failures (4)');
assert.equal(sessionInventoryJson.sessions[1].mcp_operational_state, 'runtime_faulted');
assert.equal(existsSync(join(inventoryRoot, '.narada', 'crew', 'nars-sessions', 'inventory-scan-json-test')), false);
rmSync(inventoryRoot, { recursive: true, force: true });

assert.equal(createTerminalStyle({ enabled: false }).prompt('narada> '), 'narada> ');
assert.equal(createTerminalStyle({ enabled: true }).prompt('narada> ').includes('\x1b['), true);
assert.equal(stripAnsiForTest(styleInputRouteLabel('operator -> narada.architect')), 'operator -> narada.architect');
assert.equal(styleInputRouteLabel('operator -> narada.architect').includes('\x1b[1;32moperator\x1b[0m'), true);
assert.equal(styleInputRouteLabel('operator -> narada.architect').includes('\x1b[1;36mnarada.architect\x1b[0m'), true);
assert.equal(formatToolResultContent('{"status":"success","schema":"narada.test.v1","directive_count":2,"extra":true}'), '{"status":"success","schema":"narada.test.v1","directive_count":2,"extra":true}');
assert.equal(formatToolResultContent({ content: [{ type: 'text', text: 'ok' }] }), '{"content":[{"type":"text","text":"ok"}]}');
assert.equal(copyToClipboard('hello', () => ({ status: 0 }), 'win32'), true);
assert.equal(copyToClipboard('hello', () => ({ status: 1 }), 'win32'), false);
assert.equal(copyToClipboard('hello', () => ({ error: new Error('missing') }), 'linux'), false);
assert.equal(formatKeyValueRows({ A: 1, Longer: 'two' }), 'A       1\nLonger  two');
assert.equal(formatDuration(1250), '1s');
assert.equal(formatDuration(65000), '1m 5s');
assert.equal(formatDuration(3661000), '1h 1m 1s');
assert.equal(formatTimestamp(new Date('2026-05-28T16:37:21Z')), '2026-05-28Z16:37');
assert.equal(formatProgressStatus({ spinner: '-', phase: 'thinking', totalMs: 6000, phaseMs: 6000 }), '- thinking 6s · Enter queues note · Esc to interrupt');
assert.equal(formatProgressStatus({ spinner: '/', phase: 'calling fs_read_file', totalMs: 7000, phaseMs: 1200 }), '/ calling fs_read_file 1s · total 7s · Enter queues note · Esc to interrupt');
assert.equal(formatProgressStatus({ spinner: '/', phase: 'calling fs_read_file', totalMs: 65000, phaseMs: 61000 }), '/ calling fs_read_file 1m 1s · total 1m 5s · Enter queues note · Esc to interrupt');
assert.equal(formatProgressStatus({ spinner: '|', phase: 'thinking', totalMs: 8000, phaseMs: 8000, operatorDirectiveDraftLength: 12, queuedOperatorDirectiveCount: 2 }), '| thinking 8s · queued operator directives 2 · Enter queues note · Esc to interrupt · typing operator directive (12)');
assert.equal(formatHeaderRow('Identity', 'narada.architect', {}).includes('Identity'), true);
assert.equal(formatHeaderRow('Stream', 'on', {}).includes('on'), true);
assert.equal(formatHeaderRow('Identity', 'narada.architect', {}).includes('\x1b[90m[agent-cli]\x1b[0m \x1b[33mIdentity'), true);
const headerRows = stripAnsiForTest(formatHeaderRows([['MCP servers', 1], ['  narada-proper', '29 tools']]));
assert.equal(headerRows.includes('MCP servers     1'), true);
assert.equal(headerRows.includes('  narada-proper 29 tools'), true);
const interactiveHeaderRows = stripAnsiForTest(formatHeaderRows(createInteractiveHeaderRows({
  mcpServers: Object.assign(Object.create(null), {
    narada: { tools: [{ name: 'fs_read_file' }] },
    __mcp_startup_failures: [{ server_name: 'polluted', code: 'mcp_stdout_pollution' }],
    __mcp_runtime_diagnostics: [{ server_name: 'narada', tool_name: 'fs_read_file' }],
  }),
  allTools: [{ name: 'fs_read_file' }],
  sessionSettings: { model: 'gpt-5', thinking: 'medium', stream: true, goal: null },
  transcriptDisplaySettings: { toolOutputs: true },
})));
assert.equal(interactiveHeaderRows.includes('MCP state            runtime_faulted'), true);
assert.equal(interactiveHeaderRows.includes('MCP startup failures 1 (polluted:mcp_stdout_pollution)'), true);
assert.equal(interactiveHeaderRows.includes('MCP runtime faults   1 (narada:fs_read_file)'), true);
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
assert.equal(formatRuntimeMcpFaultSummary({ event: 'carrier_diagnostic_recorded', diagnostic_code: 'other' }), null);
assert.equal(formatRuntimeMcpFaultEvent({ event: 'carrier_diagnostic_recorded', diagnostic_code: 'other' }), null);
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
});
assert.deepEqual(createMcpPreflightArtifactSnapshot({
  artifact_path: '/tmp/preflight.json',
  generated_at: '2026-06-14T00:00:00.000Z',
  mcp_operational_state: 'startup_degraded',
  mcp_startup_failure_summary: '1 (degraded:mcp_stdout_pollution)',
  mcp_runtime_fault_summary: '0',
}), {
  mcp_preflight_artifact_path: '/tmp/preflight.json',
  mcp_preflight_artifact_generated_at: '2026-06-14T00:00:00.000Z',
  mcp_preflight_operational_state: 'startup_degraded',
  mcp_preflight_startup_failure_summary: '1 (degraded:mcp_stdout_pollution)',
  mcp_preflight_runtime_fault_summary: '0',
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
  mode: 'interactive',
  started_at: '2026-06-14T00:00:00.000Z',
  session_event_count: 3,
  last_event_kind: 'input_completed',
  last_event_at: '2026-06-14T00:01:00.000Z',
  last_terminal_state: 'completed',
});
assert.deepEqual(wrapTerminalLine('alpha beta gamma', 10), ['alpha beta', 'gamma']);
assert.equal(renderMarkdownForTerminal('- `code`').includes('• '), true);
assert.equal(renderMarkdownForTerminal('- `code`').includes('\x1b[90mcode\x1b[0m'), true);
assert.equal(renderMarkdownForTerminal('Site: `narada-proper`').includes('\x1b[90mnarada-proper\x1b[0m'), true);
assert.equal(normalizeDisplayTerms('authority_locus: narada_proper and authority_posture: facade_only'), 'authority locus: `narada_proper` and authority posture: `facade_only`');
assert.equal(normalizeDisplayTerms('authority_locus: `narada_proper`'), 'authority locus: `narada_proper`');
assert.equal(renderMarkdownForTerminal('  ```powershell\n    narada\n  ```').includes('```'), false);
assert.equal(renderMarkdownForTerminal('  ```powershell\n    narada\n  ```').includes('narada'), true);
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
  assert.equal(/\n\s+\d{4}-\d{2}-\d{2}Z\d{2}:\d{2}\s*$/.test(printedAgentMessage), false);
  assert.match(printedAgentMessage, /hello \d{4}-\d{2}-\d{2}Z\d{2}:\d{2}\n\n$/);
} finally {
  process.stdout.write = originalStdoutWrite;
}
assert.equal(stripAnsiForTest(toolDirectionLabel('invoke')), 'narada.architect -> agent-cli');
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
assert.equal(stripAnsiForTest(rewriteSubmittedPromptForTest('operator -> narada.architect', 'short', 120, fixedTimestamp)).replace(/\r/g, ''), '\noperator -> narada.architect: short 2026-05-28Z16:37\n');
assert.equal(
  stripAnsiForTest(rewriteSubmittedPromptForTest('operator -> narada.architect', 'review what has been going on in commits since checkpoint', 64, fixedTimestamp)).replace(/\r/g, ''),
  '\noperator -> narada.architect: review what has been going on in\n  commits since checkpoint 2026-05-28Z16:37\n'
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
assert.equal(windowsWrapperTemplate.includes("$IntelligenceProvider -eq 'kimi-code-api' -and $env:NARADA_KIMI_CODE_API_BASE_URL"), true);
assert.equal(windowsWrapperTemplate.includes("$IntelligenceProvider -eq 'kimi-code-api' -and $env:NARADA_KIMI_CODE_MODEL"), true);
assert.equal(windowsWrapperTemplate.includes('[switch]$SessionInventory'), true);
assert.equal(windowsWrapperTemplate.includes('[switch]$SessionInventoryJson'), true);
assert.equal(windowsWrapperTemplate.includes('[switch]$McpPreflightJson'), true);
assert.equal(windowsWrapperTemplate.includes("'--session-inventory'"), true);
assert.equal(windowsWrapperTemplate.includes("'--session-inventory-json'"), true);
assert.equal(windowsWrapperTemplate.includes("$preflightArgs = @($AgentCliPath, '--identity', $IdentityName, '--session', $SessionName, '--mcp-preflight-json')"), true);
assert.equal(windowsWrapperTemplate.includes('ConvertFrom-Json'), true);
assert.equal(windowsWrapperTemplate.includes('MCP preflight reported degraded startup posture; continuing interactive attach.'), true);
assert.equal(windowsWrapperTemplate.includes('MCP state:'), true);
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
if (process.platform === 'win32') {
  assert.equal(codexMcpRequest.arguments.sandbox, 'danger-full-access');
} else {
  assert.equal(codexMcpRequest.arguments.sandbox, 'workspace-write');
}
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
    },
  },
});
assert.match(codexConfigToml, /\[mcp_servers\."narada-proper"\]/);
assert.match(codexConfigToml, /default_tools_approval_mode = "approve"/);
assert.match(codexConfigToml, /packages\/narada-proper-mcp\/src\/main\.ts/);
const codexMcpConfigArgs = codexExecMcpConfigArgs({
  'narada-proper': {
    config: {
      command: 'node',
      args: ['--import', 'tsx', 'D:\\code\\narada\\packages\\narada-proper-mcp\\src\\main.ts'],
    },
  },
});
assert.equal(codexMcpConfigArgs.includes('-c'), true);
assert.equal(codexMcpConfigArgs.some((arg) => arg.includes('mcp_servers."narada-proper".command=')), true);
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
assert.equal(await handleSlashCommand('/help', { mcpServers: {}, allTools: [] }), 'handled');
assert.equal(await handleSlashCommand('/bad', { mcpServers: {}, allTools: [] }), 'handled');
assert.equal(await handleSlashCommand('plain message', { mcpServers: {}, allTools: [] }), 'none');
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
  state: { activeTurn: null },
  allTools: tools,
  mcpServers: toolsFixtureServers,
});
assert.equal(toolStatus.request_id, 'status-tools');
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
  },
});
assert.equal(toolStatusWithPreflight.mcp_preflight_artifact_path, 'D:/tmp/preflight.json');
assert.equal(toolStatusWithPreflight.mcp_preflight_operational_state, 'healthy');
const printedStatusMessages = [];
process.stdout.write = (value = '') => { printedStatusMessages.push(stripAnsiForTest(String(value))); return true; };
try {
  assert.equal(await handleSlashCommand('/status', { mcpServers: toolsFixtureServers, allTools: tools }), 'handled');
} finally {
  process.stdout.write = originalSlashStdoutWrite;
}
assert.equal(printedStatusMessages.some((message) => message.includes('polluted:mcp_stdout_pollution')), true);
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
  /Missing API key for anthropic-api\. Set ANTHROPIC_API_KEY or NARADA_AI_API_KEY\./,
);
assert.throws(
  () => assertApiKeyConfigured('openai-api', ''),
  /Missing API key for openai-api\. Set NARADA_AI_API_KEY\./,
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
const mcpAbortStart = Date.now();
setTimeout(() => mcpAbortTurn.requestInterrupt(), 20);
const mcpAbortResult = await executeMcpTool(
  { id: 'call_abort', type: 'function', function: { name: 'fs_read_file', arguments: '{}' } },
  {
    fixture: {
      tools: [{ name: 'fs_read_file' }],
      send: async (_req, _timeoutMs, _timeoutCode, abortSignal) => new Promise((_resolve, rejectDelay) => {
        abortSignal?.addEventListener('abort', () => rejectDelay(new Error('agent_cli_interrupt_requested')), { once: true });
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
assert.equal(Date.now() - mcpAbortStart < 100, true, 'MCP tool abort should resolve quickly, not wait for timeout');
const mcpAbortContent = JSON.parse(mcpAbortResult.content);
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

const serverSite = mkdtempSync(join(tmpdir(), 'narada-agent-cli-server-'));
mkdirSync(join(serverSite, '.ai', 'mcp'), { recursive: true });
const child = spawn(process.execPath, [
  fileURLToPath(new URL('./agent-cli.mjs', import.meta.url)),
  '--server',
  '--identity', 'narada.test',
  '--session', 'server-test',
], {
  env: {
    ...process.env,
    NARADA_SITE_ROOT: serverSite,
    NARADA_INTELLIGENCE_PROVIDER: 'codex-subscription',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => { stdout += chunk; });
child.stderr.on('data', (chunk) => { stderr += chunk; });
child.stdin.write('not json\n');
child.stdin.write(`${JSON.stringify({ id: 'status-1', method: 'session.status', params: {} })}\n`);
child.stdin.write(`${JSON.stringify({ id: 'close-1', method: 'session.close', params: {} })}\n`);
child.stdin.end();
const exitCode = await new Promise((resolveExit) => child.on('exit', resolveExit));
assert.equal(exitCode, 0);
const serverEvents = stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
assert.equal(serverEvents[0].event, 'session_started');
assert.equal(serverEvents[0].mcp_operational_state, 'healthy');
assert.equal(serverEvents[0].mcp_startup_failure_summary, '0');
assert.equal(serverEvents[0].mcp_runtime_fault_summary, '0');
assert.deepEqual(serverEvents[0].mcp_startup_failures, []);
assert.deepEqual(serverEvents[0].mcp_runtime_faults, []);
assert.equal(serverEvents[0].agent_id, 'narada.test');
assert.equal(serverEvents[0].runtime, 'agent-cli');
assert.equal(serverEvents[0].mode, 'server');
assert.equal(serverEvents[0].session_event_count, 1);
assert.equal(serverEvents[0].last_event_kind, 'session_started');
assert.equal(serverEvents[0].last_terminal_state, null);
assert.equal(serverEvents.some((event) => event.event === 'error' && event.code === 'invalid_json'), true);
assert.equal(serverEvents.some((event) => event.event === 'session_status' && event.request_id === 'status-1'), true);
assert.deepEqual(serverEvents.find((event) => event.event === 'session_status' && event.request_id === 'status-1')?.mcp_tools, []);
assert.equal(serverEvents.find((event) => event.event === 'session_status' && event.request_id === 'status-1')?.session_event_count >= 2, true);
assert.equal(serverEvents.find((event) => event.event === 'session_status' && event.request_id === 'status-1')?.last_event_kind, 'session_status_requested');
const serverClosedEvent = serverEvents.find((event) => event.event === 'session_closed' && event.request_id === 'close-1');
assert.equal(serverClosedEvent?.event, 'session_closed');
assert.equal(serverClosedEvent?.terminal_state, 'closed');
assert.equal(serverClosedEvent?.last_event_kind, 'session_closed');
assert.equal(serverClosedEvent?.last_terminal_state, 'closed');
assert.equal(serverClosedEvent?.session_event_count >= 3, true);
const serverHeartbeat = JSON.parse(readFileSync(join(serverSite, '.narada', 'crew', 'nars-sessions', 'server-test', 'heartbeat.json'), 'utf8'));
assert.equal(serverHeartbeat.schema, 'narada.carrier_heartbeat.v1');
assert.equal(serverHeartbeat.carrier_session_id, 'server-test');
assert.equal(serverHeartbeat.agent_id, 'narada.test');
assert.equal(serverHeartbeat.runtime, 'agent-cli');
assert.equal(stdout.includes('[agent-cli]'), false);
assert.equal(stderr.includes('Fatal error'), false);
rmSync(serverSite, { recursive: true, force: true });

const degradedServerSite = mkdtempSync(join(tmpdir(), 'narada-agent-cli-degraded-server-'));
mkdirSync(join(degradedServerSite, '.ai', 'mcp'), { recursive: true });
const degradedServerPath = join(degradedServerSite, 'degraded-mcp-server.mjs');
writeFileSync(degradedServerPath, `
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
writeFileSync(join(degradedServerSite, '.ai', 'mcp', 'degraded-mcp.json'), `${JSON.stringify({
  mcpServers: {
    degraded: {
      transport: 'stdio',
      command: 'node',
      args: [degradedServerPath],
    },
  },
}, null, 2)}\n`, 'utf8');
const degradedChild = spawn(process.execPath, [
  fileURLToPath(new URL('./agent-cli.mjs', import.meta.url)),
  '--server',
  '--identity', 'narada.test',
  '--session', 'degraded-server-test',
], {
  env: {
    ...process.env,
    NARADA_SITE_ROOT: degradedServerSite,
    NARADA_INTELLIGENCE_PROVIDER: 'codex-subscription',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let degradedStdout = '';
degradedChild.stdout.setEncoding('utf8');
degradedChild.stdout.on('data', (chunk) => { degradedStdout += chunk; });
degradedChild.stdin.write(`${JSON.stringify({ id: 'status-degraded-1', method: 'session.status', params: {} })}\n`);
degradedChild.stdin.write(`${JSON.stringify({ id: 'close-degraded-1', method: 'session.close', params: {} })}\n`);
degradedChild.stdin.end();
const degradedExitCode = await new Promise((resolveExit) => degradedChild.on('exit', resolveExit));
assert.equal(degradedExitCode, 0);
const degradedEvents = degradedStdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
assert.equal(degradedEvents[0].event, 'session_started');
assert.equal(degradedEvents[0].mcp_operational_state, 'startup_degraded');
assert.equal(degradedEvents[0].mcp_startup_failure_count, 1);
assert.equal(degradedEvents[0].mcp_startup_failure_summary, '1 (degraded:mcp_stdout_pollution)');
assert.equal(degradedEvents[0].mcp_startup_failures[0].server_name, 'degraded');
assert.equal(degradedEvents[0].mcp_startup_failures[0].code, 'mcp_stdout_pollution');
assert.equal(degradedEvents[0].mcp_startup_failures[0].message, 'MCP server degraded emitted non-JSON stdout during startup');
assert.deepEqual(degradedEvents[0].mcp_startup_failures[0].stdout_pollution, ['startup banner']);
assert.equal(degradedEvents[0].mcp_runtime_fault_summary, '0');
assert.deepEqual(degradedEvents[0].mcp_runtime_faults, []);
assert.equal(degradedEvents[0].session_event_count, 1);
assert.equal(degradedEvents[0].last_event_kind, 'session_started');
assert.equal(degradedEvents.some((event) => event.event === 'carrier_diagnostic_recorded' && event.server_name === 'degraded' && event.diagnostic_code === 'mcp_stdout_pollution'), true);
assert.equal(degradedEvents.some((event) => event.event === 'session_status' && event.request_id === 'status-degraded-1' && event.mcp_startup_failure_count === 1 && event.mcp_startup_failure_summary === '1 (degraded:mcp_stdout_pollution)'), true);
assert.equal(degradedEvents.some((event) => event.event === 'session_closed' && event.request_id === 'close-degraded-1' && event.terminal_state === 'closed' && event.last_event_kind === 'session_closed' && event.last_terminal_state === 'closed'), true);
const degradedSessionEntries = readFileSync(join(degradedServerSite, '.narada', 'crew', 'nars-sessions', 'degraded-server-test', 'session.jsonl'), 'utf8')
  .trim()
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));
assert.equal(degradedSessionEntries.some((entry) => entry.event_kind === 'carrier_diagnostic_recorded' && entry.payload?.server_name === 'degraded' && entry.payload?.diagnostic_code === 'mcp_stdout_pollution'), true);
rmSync(degradedServerSite, { recursive: true, force: true });

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
assert.equal(preflightHealthy.stdout.includes('MCP state    healthy'), true);
assert.equal(preflightHealthy.stdout.includes('MCP servers  1'), true);
assert.equal(preflightHealthy.stdout.includes('Tools        1'), true);
const preflightHealthyArtifactPath = join(preflightHealthySite, '.narada', 'runtime', 'agent-cli', 'mcp-preflight', 'preflight-healthy-test.json');
assert.equal(preflightHealthy.stdout.includes(`Artifact     ${preflightHealthyArtifactPath}`), true);
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
  mcp_startup_failure_summary: '0',
  mcp_runtime_fault_summary: '0',
  session: 'preflight-healthy-test',
  identity: 'narada.test',
  site_root: preflightHealthySite,
});
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
const preflightLinkedChild = spawn(process.execPath, [
  fileURLToPath(new URL('./agent-cli.mjs', import.meta.url)),
  '--server',
  '--identity', 'narada.test',
  '--session', 'preflight-healthy-test',
], {
  env: {
    ...process.env,
    NARADA_SITE_ROOT: preflightHealthySite,
    NARADA_INTELLIGENCE_PROVIDER: 'codex-subscription',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let preflightLinkedStdout = '';
preflightLinkedChild.stdout.setEncoding('utf8');
preflightLinkedChild.stdout.on('data', (chunk) => { preflightLinkedStdout += chunk; });
preflightLinkedChild.stdin.write(`${JSON.stringify({ id: 'status-preflight-link-1', method: 'session.status', params: {} })}\n`);
preflightLinkedChild.stdin.write(`${JSON.stringify({ id: 'close-preflight-link-1', method: 'session.close', params: {} })}\n`);
preflightLinkedChild.stdin.end();
const preflightLinkedExitCode = await new Promise((resolveExit) => preflightLinkedChild.on('exit', resolveExit));
assert.equal(preflightLinkedExitCode, 0);
const preflightLinkedEvents = preflightLinkedStdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
assert.equal(preflightLinkedEvents[0].event, 'session_started');
assert.equal(preflightLinkedEvents[0].mcp_preflight_artifact_path, preflightHealthyArtifactPath);
assert.equal(preflightLinkedEvents[0].mcp_preflight_operational_state, 'healthy');
assert.equal(preflightLinkedEvents.some((event) => event.event === 'mcp_preflight_artifact_linked' && event.artifact_path === preflightHealthyArtifactPath), true);
assert.equal(preflightLinkedEvents.some((event) => event.event === 'session_status' && event.request_id === 'status-preflight-link-1' && event.mcp_preflight_artifact_path === preflightHealthyArtifactPath), true);
const preflightLinkedSessionEntries = readFileSync(join(preflightHealthySite, '.narada', 'crew', 'nars-sessions', 'preflight-healthy-test', 'session.jsonl'), 'utf8')
  .trim()
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));
assert.equal(preflightLinkedSessionEntries.some((entry) => entry.event === 'mcp_preflight_artifact_linked' && entry.artifact_path === preflightHealthyArtifactPath), true);
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
assert.equal(preflightDegraded.stdout.includes('MCP servers           0'), true);
assert.equal(preflightDegraded.stdout.includes('MCP state             startup_degraded'), true);
assert.equal(preflightDegraded.stdout.includes('MCP startup failures  1 (degraded:mcp_stdout_pollution)'), true);
const preflightDegradedArtifactPath = join(preflightDegradedSite, '.narada', 'runtime', 'agent-cli', 'mcp-preflight', 'preflight-degraded-test.json');
assert.equal(preflightDegraded.stdout.includes(`Artifact              ${preflightDegradedArtifactPath}`), true);
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
assert.equal(preflightDegradedJsonPayload.artifact_path, preflightDegradedArtifactPath);
assert.equal(existsSync(join(preflightDegradedSite, '.narada', 'crew', 'nars-sessions', 'preflight-degraded-test')), false);
rmSync(preflightDegradedSite, { recursive: true, force: true });

const runtimeServerSite = mkdtempSync(join(tmpdir(), 'narada-agent-runtime-server-'));
mkdirSync(join(runtimeServerSite, '.ai', 'mcp'), { recursive: true });
const runtimeServerPath = join(runtimeServerSite, 'degraded-mcp-server.mjs');
writeFileSync(runtimeServerPath, `
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
writeFileSync(join(runtimeServerSite, '.ai', 'mcp', 'degraded-mcp.json'), `${JSON.stringify({
  mcpServers: {
    degraded: {
      transport: 'stdio',
      command: 'node',
      args: [runtimeServerPath],
    },
  },
}, null, 2)}\n`, 'utf8');
const runtimeServerChild = spawn(process.execPath, [
  fileURLToPath(new URL('../bin/agent-runtime-server.mjs', import.meta.url)),
  '--wrapper-events-jsonl',
  '--identity', 'narada.test',
  '--session', 'runtime-wrapper-test',
], {
  env: {
    ...process.env,
    NARADA_SITE_ROOT: runtimeServerSite,
    NARADA_INTELLIGENCE_PROVIDER: 'codex-subscription',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let runtimeServerStdout = '';
let runtimeServerStderr = '';
runtimeServerChild.stdout.setEncoding('utf8');
runtimeServerChild.stderr.setEncoding('utf8');
runtimeServerChild.stdout.on('data', (chunk) => { runtimeServerStdout += chunk; });
runtimeServerChild.stderr.on('data', (chunk) => { runtimeServerStderr += chunk; });
runtimeServerChild.stdin.write(`${JSON.stringify({ id: 'status-runtime-wrapper-1', method: 'session.status', params: {} })}\n`);
runtimeServerChild.stdin.write(`${JSON.stringify({ id: 'close-runtime-wrapper-1', method: 'session.close', params: {} })}\n`);
runtimeServerChild.stdin.end();
const runtimeServerExitCode = await new Promise((resolveExit) => runtimeServerChild.on('exit', resolveExit));
assert.equal(runtimeServerExitCode, 0);
const runtimeServerEvents = runtimeServerStdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
assert.equal(runtimeServerEvents[0].event, 'session_started');
assert.equal(runtimeServerEvents[0].mcp_operational_state, 'startup_degraded');
assert.equal(runtimeServerStderr.includes('[agent-runtime-server] MCP state=startup_degraded | startup=1 (degraded:mcp_stdout_pollution)'), true);
const runtimeServerStderrEvents = runtimeServerStderr.split(/\r?\n/).filter((line) => line.trim().startsWith('{')).map((line) => JSON.parse(line));
assert.equal(runtimeServerStderrEvents.some((event) => event.schema === 'narada.agent_runtime_server.wrapper_event.v1' && event.event === 'session_status_snapshot' && event.source_event === 'session_started' && event.mcp_operational_state === 'startup_degraded' && event.last_event_kind === 'session_started'), true);
assert.equal(runtimeServerStderrEvents.some((event) => event.schema === 'narada.agent_runtime_server.wrapper_event.v1' && event.event === 'session_status_snapshot' && event.source_event === 'session_status' && event.request_id === 'status-runtime-wrapper-1' && event.mcp_operational_state === 'startup_degraded'), true);
assert.equal(runtimeServerStderrEvents.some((event) => event.schema === 'narada.agent_runtime_server.wrapper_event.v1' && event.event === 'mcp_startup_status' && event.mcp_operational_state === 'startup_degraded' && event.mcp_startup_failure_summary === '1 (degraded:mcp_stdout_pollution)'), true);
assert.equal(runtimeServerStderrEvents.some((event) => event.schema === 'narada.agent_runtime_server.wrapper_event.v1' && event.event === 'session_status_snapshot' && event.source_event === 'session_closed' && event.request_id === 'close-runtime-wrapper-1' && event.terminal_state === 'closed' && event.last_event_kind === 'session_closed' && event.last_terminal_state === 'closed'), true);
assert.equal(runtimeServerEvents.some((event) => event.event === 'session_status' && event.request_id === 'status-runtime-wrapper-1' && event.mcp_startup_failure_summary === '1 (degraded:mcp_stdout_pollution)'), true);
assert.equal(runtimeServerEvents.some((event) => event.event === 'session_closed' && event.request_id === 'close-runtime-wrapper-1' && event.terminal_state === 'closed' && event.last_event_kind === 'session_closed' && event.last_terminal_state === 'closed'), true);
rmSync(runtimeServerSite, { recursive: true, force: true });

const directiveServerSite = mkdtempSync(join(tmpdir(), 'narada-agent-cli-directive-server-'));
mkdirSync(join(directiveServerSite, '.ai', 'mcp'), { recursive: true });
const previousSiteRoot = process.env.NARADA_SITE_ROOT;
process.env.NARADA_SITE_ROOT = directiveServerSite;
try {
  const input = new PassThrough();
  const output = new PassThrough();
  let directiveStdout = '';
  output.setEncoding('utf8');
  output.on('data', (chunk) => { directiveStdout += chunk; });
  const serverDone = runServerMode({
    input,
    output,
    callChatApiFn: async () => ({
      choices: [{ message: { role: 'assistant', content: 'ack directive' } }],
    }),
  });
  input.write(`${JSON.stringify({
    id: 'directive-1',
    method: 'system_directive.deliver',
    params: {
      directive_id: 'dir_test',
      message: 'run startup sequence',
      authority_ref: 'dir_test',
    },
  })}\n`);
  input.end();
  await serverDone;
  const directiveEvents = directiveStdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(directiveEvents.some((event) => event.event === 'directive_received' && event.directive_id === 'dir_test'), true);
  assert.equal(directiveEvents.some((event) => event.event === 'directive_receipt_recorded' && event.directive_id === 'dir_test' && event.receipt_id?.startsWith('dirrcpt_')), true);
  assert.equal(directiveEvents.some((event) => event.event === 'directive_carrier_accepted_recorded' && event.directive_id === 'dir_test' && event.acceptance_id?.startsWith('diraccept_')), true);
  assert.equal(directiveEvents.some((event) => event.event === 'turn_complete' && event.directive_id === 'dir_test'), true);

  const heartbeatInput = new PassThrough();
  const heartbeatOutput = new PassThrough();
  let heartbeatStdout = '';
  let heartbeatChatCalls = 0;
  heartbeatOutput.setEncoding('utf8');
  heartbeatOutput.on('data', (chunk) => { heartbeatStdout += chunk; });
  const heartbeatServerDone = runServerMode({
    input: heartbeatInput,
    output: heartbeatOutput,
    callChatApiFn: async () => {
      heartbeatChatCalls += 1;
      return { choices: [{ message: { role: 'assistant', content: 'unexpected heartbeat turn' } }] };
    },
  });
  heartbeatInput.write(`${JSON.stringify({
    id: 'heartbeat-1',
    method: 'system_directive.deliver',
    params: {
      directive_id: 'dir_heartbeat',
      authority_ref: 'auth_operation_heartbeat',
      directive: {
        directive_id: 'dir_heartbeat',
        kind: 'operation_heartbeat',
        visibility: 'record_only',
        cadence: 'PT1M',
        operation_id: 'operation_test',
        reason: 'operation_continuity_heartbeat',
      },
    },
  })}\n`);
  heartbeatInput.end();
  await heartbeatServerDone;
  const heartbeatEvents = heartbeatStdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(heartbeatChatCalls, 0);
  assert.equal(heartbeatEvents.some((event) => event.event === 'directive_received' && event.directive_id === 'dir_heartbeat'), true);
  assert.equal(heartbeatEvents.some((event) => event.event === 'directive_receipt_recorded' && event.directive_id === 'dir_heartbeat'), true);
  assert.equal(heartbeatEvents.some((event) => event.event === 'directive_carrier_accepted_recorded' && event.directive_id === 'dir_heartbeat'), true);
  assert.equal(heartbeatEvents.some((event) => event.event === 'directive_complete' && event.directive_id === 'dir_heartbeat' && event.terminal_state === 'completed_without_provider'), true);
  assert.equal(heartbeatEvents.some((event) => event.event === 'turn_started' && event.directive_id === 'dir_heartbeat'), false);
} finally {
  if (previousSiteRoot === undefined) delete process.env.NARADA_SITE_ROOT;
  else process.env.NARADA_SITE_ROOT = previousSiteRoot;
  rmSync(directiveServerSite, { recursive: true, force: true });
}

const observerServerSite = mkdtempSync(join(tmpdir(), 'narada-agent-cli-observer-server-'));
mkdirSync(join(observerServerSite, '.ai', 'mcp'), { recursive: true });
process.env.NARADA_SITE_ROOT = observerServerSite;
try {
  const observerInputRequest = ({ id, visibility, content }) => ({
    id,
    method: 'carrier.input.deliver',
    params: {
      input: {
        schema: 'narada.carrier.control.input_event.v1',
        control_event_id: `control_${id}`,
        input_event_id: `input_${id}`,
        written_at: new Date().toISOString(),
        input: {
          schema: 'narada.carrier.input_event.v1',
          event_id: `input_${id}`,
          source_kind: 'agent',
          source_id: 'narada.observer',
          transport: 'control_jsonl',
          delivery_mode: 'admit_after_active_turn',
          hold_condition: null,
          content,
          created_at: new Date().toISOString(),
          authority_ref: null,
          directive_id: null,
          metadata: {
            observer: {
              role: 'observer',
              rule_id: 'server-observer-smoke',
              visibility,
            },
          },
        },
      },
    },
  });
  const input = new PassThrough();
  const output = new PassThrough();
  let observerStdout = '';
  let providerCalls = 0;
  output.setEncoding('utf8');
  output.on('data', (chunk) => { observerStdout += chunk; });
  const serverDone = runServerMode({
    input,
    output,
    callChatApiFn: async () => {
      providerCalls += 1;
      return { choices: [{ message: { role: 'assistant', content: 'should not run' } }] };
    },
  });
  input.write(`${JSON.stringify({ id: 'observer-status-1', method: 'observers.status', params: {} })}\n`);
  input.write(`${JSON.stringify(observerInputRequest({
    id: 'observer_visible_1',
    visibility: 'operator_visible',
    content: 'operator visible observer note',
  }))}\n`);
  input.write(`${JSON.stringify({ id: 'observer-mute-1', method: 'observer.mute', params: {} })}\n`);
  input.write(`${JSON.stringify(observerInputRequest({
    id: 'observer_agent_muted_1',
    visibility: 'agent_visible',
    content: 'agent visible observer note',
  }))}\n`);
  input.write(`${JSON.stringify(observerInputRequest({
    id: 'observer_conversation_muted_1',
    visibility: 'conversation_visible',
    content: 'conversation visible observer note',
  }))}\n`);
  input.end();
  await serverDone;
  const observerEvents = observerStdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(observerEvents.some((event) => event.event === 'observer_status' && event.request_id === 'observer-status-1' && event.observer_muted === false), true);
  assert.equal(observerEvents.some((event) => event.event === 'observer_status' && event.request_id === 'observer-mute-1' && event.observer_muted === true), true);
  assert.equal(observerEvents.some((event) => event.event === 'observer_interjection_visible' && event.request_id === 'observer_visible_1' && event.content === 'operator visible observer note'), true);
  assert.equal(observerEvents.some((event) => event.event === 'observer_input_complete' && event.request_id === 'observer_visible_1' && event.visibility === 'operator_visible'), true);
  assert.equal(observerEvents.some((event) => event.event === 'observer_input_complete' && event.request_id === 'observer_agent_muted_1' && event.visibility === 'agent_visible'), true);
  assert.equal(observerEvents.some((event) => event.event === 'observer_input_complete' && event.request_id === 'observer_conversation_muted_1' && event.visibility === 'conversation_visible'), true);
  assert.equal(observerEvents.some((event) => event.event === 'observer_interjection_visible' && event.request_id === 'observer_conversation_muted_1'), false);
  assert.equal(observerEvents.some((event) => event.event === 'turn_started' && String(event.request_id).startsWith('observer_')), false);
  assert.equal(providerCalls, 0);
} finally {
  if (previousSiteRoot === undefined) delete process.env.NARADA_SITE_ROOT;
  else process.env.NARADA_SITE_ROOT = previousSiteRoot;
  rmSync(observerServerSite, { recursive: true, force: true });
}

const interruptServerSite = mkdtempSync(join(tmpdir(), 'narada-agent-cli-interrupt-server-'));
mkdirSync(join(interruptServerSite, '.ai', 'mcp'), { recursive: true });
process.env.NARADA_SITE_ROOT = interruptServerSite;
try {
  const input = new PassThrough();
  const output = new PassThrough();
  let interruptStdout = '';
  output.setEncoding('utf8');
  output.on('data', (chunk) => { interruptStdout += chunk; });
  const serverDone = runServerMode({
    input,
    output,
    callChatApiFn: async () => {
      await delayForTest(75);
      return { choices: [{ message: { role: 'assistant', content: 'late ack' } }] };
    },
  });
  input.write(`${JSON.stringify({ id: 'send-1', method: 'conversation.send', params: { message: 'long turn' } })}\n`);
  await delayForTest(15);
  input.write(`${JSON.stringify({ id: 'interrupt-1', method: 'conversation.interrupt', params: {} })}\n`);
  input.end();
  await serverDone;
  const interruptEvents = interruptStdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(interruptEvents.some((event) => event.event === 'turn_interrupted' && event.request_id === 'interrupt-1'), true);
  assert.equal(interruptEvents.some((event) => event.event === 'turn_complete' && event.request_id === 'send-1' && event.terminal_state === 'interrupted'), true);
} finally {
  if (previousSiteRoot === undefined) delete process.env.NARADA_SITE_ROOT;
  else process.env.NARADA_SITE_ROOT = previousSiteRoot;
  rmSync(interruptServerSite, { recursive: true, force: true });
}

const closedServerSite = mkdtempSync(join(tmpdir(), 'narada-agent-cli-closed-server-'));
mkdirSync(join(closedServerSite, '.ai', 'mcp'), { recursive: true });
process.env.NARADA_SITE_ROOT = closedServerSite;
try {
  const input = new PassThrough();
  const output = new PassThrough();
  let closedStdout = '';
  output.setEncoding('utf8');
  output.on('data', (chunk) => { closedStdout += chunk; });
  const serverDone = runServerMode({ input, output, callChatApiFn: async () => ({ choices: [{ message: { role: 'assistant', content: 'should not run' } }] }) });
  input.write(`${JSON.stringify({ id: 'close-before-send', method: 'session.close', params: {} })}\n`);
  input.write(`${JSON.stringify({ id: 'send-after-close', method: 'conversation.send', params: { message: 'after close' } })}\n`);
  input.end();
  await serverDone;
  const closedEvents = closedStdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(closedEvents.some((event) => event.event === 'session_closed' && event.request_id === 'close-before-send'), true);
  assert.equal(closedEvents.some((event) => event.event === 'error' && event.request_id === 'send-after-close' && event.code === 'session_closed'), true);
} finally {
  if (previousSiteRoot === undefined) delete process.env.NARADA_SITE_ROOT;
  else process.env.NARADA_SITE_ROOT = previousSiteRoot;
  rmSync(closedServerSite, { recursive: true, force: true });
}

console.log('agent-cli adapter tests PASSED.');

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

function delayForTest(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
