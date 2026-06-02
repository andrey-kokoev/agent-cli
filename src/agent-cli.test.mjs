import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
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
  buildOpenAiChatRequest,
  codexExecEventText,
  createInputQueue,
  createTerminalStyle,
  environmentBlockLength,
  directiveReceiptEvidence,
  discoverAndStartMcpServers,
  executeMcpTool,
  formatDuration,
  formatHeaderRow,
  formatHeaderRows,
  formatKeyValueRows,
  formatProgressStatus,
  formatTimestamp,
  formatToolResultContent,
  handleInteractiveControlLine,
  handleSlashCommand,
  runCodexTranscriptStats,
  inputRecordDisplayLabel,
  normalizeDisplayTerms,
  normalizeInputEvent,
  normalizeInputRecord,
  normalizeThinkingLevel,
  parseArgs,
  parseBooleanEnv,
  parseColorEnv,
  parseCodexMcpResponse,
  removeInvalidToolHistory,
  parseAnthropicMessagesResponse,
  parseCodexExecJsonLine,
  parseNaradaToolCall,
  isPotentialNaradaToolCallText,
  printAgentMessage,
  renderMarkdownForTerminal,
  rewriteSubmittedPromptForTest,
  runConversationTurn,
  runServerMode,
  resolveProviderAdapter,
  resolveProviderSupportState,
  sessionEventEntry,
  sessionLogEntry,
  shouldDeferInteractiveInput,
  styleInputRouteLabel,
  shouldSuppressMcpStderr,
  startInteractiveControlJsonlWatcher,
  toolDirectionLabel,
  wrapTerminalLine,
} from './agent-cli.mjs';

const metadata = JSON.parse(readFileSync(new URL('./intelligence-providers.json', import.meta.url), 'utf8')).providers;
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
assert.equal(createTerminalStyle({ enabled: false }).prompt('narada> '), 'narada> ');
assert.equal(createTerminalStyle({ enabled: true }).prompt('narada> ').includes('\x1b['), true);
assert.equal(stripAnsiForTest(styleInputRouteLabel('operator -> narada.architect')), 'operator -> narada.architect');
assert.equal(styleInputRouteLabel('operator -> narada.architect').includes('\x1b[1;32moperator\x1b[0m'), true);
assert.equal(styleInputRouteLabel('operator -> narada.architect').includes('\x1b[1;36mnarada.architect\x1b[0m'), true);
assert.equal(formatToolResultContent('{"status":"success","schema":"narada.test.v1","directive_count":2,"extra":true}'), 'success · narada.test.v1 · directives=2\nkeys: status, schema, directive_count, extra');
assert.equal(formatKeyValueRows({ A: 1, Longer: 'two' }), 'A       1\nLonger  two');
assert.equal(formatDuration(1250), '1s');
assert.equal(formatDuration(65000), '1m 5s');
assert.equal(formatDuration(3661000), '1h 1m 1s');
assert.equal(formatTimestamp(new Date('2026-05-28T16:37:21Z')), '2026-05-28Z16:37');
assert.equal(formatProgressStatus({ spinner: '-', phase: 'thinking', totalMs: 6000, phaseMs: 6000 }), '- thinking 6s · Enter queues note · Esc to interrupt');
assert.equal(formatProgressStatus({ spinner: '/', phase: 'calling fs_read_file', totalMs: 7000, phaseMs: 1200 }), '/ calling fs_read_file 1s · total 7s · Enter queues note · Esc to interrupt');
assert.equal(formatProgressStatus({ spinner: '/', phase: 'calling fs_read_file', totalMs: 65000, phaseMs: 61000 }), '/ calling fs_read_file 1m 1s · total 1m 5s · Enter queues note · Esc to interrupt');
assert.equal(formatProgressStatus({ spinner: '|', phase: 'thinking', totalMs: 8000, phaseMs: 8000, operatorDirectiveDraftLength: 12, queuedOperatorDirectiveCount: 2 }), '| thinking 8s · queued operator directives 2 · typing operator directive (12) · Enter queues note · Esc to interrupt');
assert.equal(formatHeaderRow('Identity', 'narada.architect', {}).includes('Identity'), true);
assert.equal(formatHeaderRow('Stream', 'on', {}).includes('on'), true);
assert.equal(formatHeaderRow('Identity', 'narada.architect', {}).includes('\x1b[90m[agent-cli]\x1b[0m \x1b[33mIdentity'), true);
const headerRows = stripAnsiForTest(formatHeaderRows([['MCP servers', 1], ['  narada-proper', '29 tools']]));
assert.equal(headerRows.includes('MCP servers     1'), true);
assert.equal(headerRows.includes('  narada-proper 29 tools'), true);
assert.deepEqual(wrapTerminalLine('alpha beta gamma', 10), ['alpha beta', 'gamma']);
assert.equal(renderMarkdownForTerminal('- `code`').includes('• '), true);
assert.equal(renderMarkdownForTerminal('- `code`').includes('\x1b[90mcode\x1b[0m'), true);
assert.equal(renderMarkdownForTerminal('Site: `narada-proper`').includes('\x1b[90mnarada-proper\x1b[0m'), true);
assert.equal(normalizeDisplayTerms('authority_locus: narada_proper and authority_posture: facade_only'), 'authority locus: `narada_proper` and authority posture: `facade_only`');
assert.equal(normalizeDisplayTerms('authority_locus: `narada_proper`'), 'authority locus: `narada_proper`');
assert.equal(renderMarkdownForTerminal('  ```powershell\n    narada\n  ```').includes('```'), false);
assert.equal(renderMarkdownForTerminal('  ```powershell\n    narada\n  ```').includes('narada'), true);
const originalConsoleLog = console.log;
const printedAgentMessages = [];
console.log = (value = '') => { printedAgentMessages.push(String(value)); };
try {
  assert.equal(printAgentMessage('   \x1b[0m   '), false);
  assert.deepEqual(printedAgentMessages, []);
  assert.equal(printAgentMessage('hello'), true);
  assert.equal(printedAgentMessages.length, 1);
  assert.equal(stripAnsiForTest(printedAgentMessages[0]).includes('narada.architect:\n  hello'), true);
} finally {
  console.log = originalConsoleLog;
}
assert.equal(stripAnsiForTest(toolDirectionLabel('invoke')), 'narada.architect -> agent-cli');
assert.equal(stripAnsiForTest(toolDirectionLabel('result')), 'agent-cli -> narada.architect');
assert.equal(shouldSuppressMcpStderr('(node:1) ExperimentalWarning: SQLite is an experimental feature and might change at any time'), true);
assert.equal(shouldSuppressMcpStderr('(Use `node --trace-warnings ...` to show where the warning was created)'), true);
assert.equal(shouldSuppressMcpStderr('real MCP server error'), false);
const fixedTimestamp = new Date('2026-05-28T16:37:21Z');
assert.equal(stripAnsiForTest(rewriteSubmittedPromptForTest('operator -> narada.architect', 'short', 120, fixedTimestamp)).replace(/\r/g, ''), '\noperator -> narada.architect: short\n  2026-05-28Z16:37\n');
assert.equal(
  stripAnsiForTest(rewriteSubmittedPromptForTest('operator -> narada.architect', 'review what has been going on in commits since checkpoint', 64, fixedTimestamp)).replace(/\r/g, ''),
  '\noperator -> narada.architect: review what has been going on in\n  commits since checkpoint\n  2026-05-28Z16:37\n'
);
rmSync(tempDir, { recursive: true, force: true });

const expectedAdapters = {
  'openai-api': 'openai-compatible-chat-completions',
  'kimi-api': 'openai-compatible-chat-completions',
  'anthropic-api': 'anthropic-messages',
  'codex-subscription': 'codex-mcp-server',
};
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
});
assert.equal(codexMcpRequest.tool, 'codex');
assert.equal(codexMcpRequest.arguments.prompt, 'Say ok.');
assert.equal(codexMcpRequest.arguments.model, 'gpt-5.5');
assert.equal(codexMcpRequest.arguments['reasoning-effort'], 'high');
assert.equal(codexMcpRequest.arguments['developer-instructions'].startsWith('You are a test agent.'), true);
assert.equal(codexMcpRequest.arguments['developer-instructions'].includes('narada_tool_call'), true);
assert.equal(codexMcpRequest.arguments['developer-instructions'].includes('fs_read_file'), true);
if (process.platform === 'win32') {
  assert.equal(codexMcpRequest.arguments.sandbox, 'danger-full-access');
} else {
  assert.equal(codexMcpRequest.arguments.sandbox, 'workspace-write');
}

const parsedCodex = parseCodexMcpResponse({ threadId: 'thread_123', content: 'ok' });
assert.equal(parsedCodex.choices[0].message.content, 'ok');
assert.equal(parsedCodex.choices[0].finish_reason, 'stop');
assert.deepEqual(parseNaradaToolCall('{"narada_tool_call":{"name":"agent_context_startup_sequence","arguments":{}}}'), {
  name: 'agent_context_startup_sequence',
  arguments: {},
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

assert.equal(await handleSlashCommand('/help', { mcpServers: {}, allTools: [] }), 'handled');
assert.equal(await handleSlashCommand('/bad', { mcpServers: {}, allTools: [] }), 'handled');
assert.equal(await handleSlashCommand('plain message', { mcpServers: {}, allTools: [] }), 'none');
const printedStatsMessages = [];
console.log = (value = '') => { printedStatsMessages.push(stripAnsiForTest(String(value))); };
try {
  assert.equal(await handleSlashCommand('/stats --date 2026-06-01 --top 3', {
    mcpServers: {},
    allTools: [],
    statsRunner: (value) => ({ status: 'ok', message: `stats args: ${value}` }),
  }), 'handled');
} finally {
  console.log = originalConsoleLog;
}
assert.equal(printedStatsMessages.some((message) => message.includes('stats args: --date 2026-06-01 --top 3')), true);
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
assert.equal(serverEvents.some((event) => event.event === 'error' && event.code === 'invalid_json'), true);
assert.equal(serverEvents.some((event) => event.event === 'session_status' && event.request_id === 'status-1'), true);
assert.equal(serverEvents.at(-1).event, 'session_closed');
const serverHeartbeat = JSON.parse(readFileSync(join(serverSite, '.narada', 'crew', 'nars-sessions', 'server-test', 'heartbeat.json'), 'utf8'));
assert.equal(serverHeartbeat.schema, 'narada.carrier_heartbeat.v1');
assert.equal(serverHeartbeat.carrier_session_id, 'server-test');
assert.equal(serverHeartbeat.agent_id, 'narada.test');
assert.equal(serverHeartbeat.runtime, 'agent-cli');
assert.equal(stdout.includes('[agent-cli]'), false);
assert.equal(stderr.includes('Fatal error'), false);
rmSync(serverSite, { recursive: true, force: true });

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
} finally {
  if (previousSiteRoot === undefined) delete process.env.NARADA_SITE_ROOT;
  else process.env.NARADA_SITE_ROOT = previousSiteRoot;
  rmSync(directiveServerSite, { recursive: true, force: true });
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
