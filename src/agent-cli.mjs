#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { StringDecoder } from 'node:string_decoder';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { pathToFileURL } from 'node:url';
import { loadSiteMcpFabric, projectServerEnvironment } from '@narada2/mcp-fabric';
import {
  argumentSummary,
  classifyCarrierActionRequest,
  createAndWriteCarrierActionAdmission,
  inspectPayloadForSecrets,
} from '@narada2/carrier-action-admission';
import {
  createPayloadRef,
  createSessionEvent as createCarrierSessionEvent,
  createTurnTerminalPayload,
  normalizeControlInputRecord,
  normalizeInputEvent as normalizeCarrierInputEvent,
} from '@narada2/carrier-protocol';
import { buildFallbackToolMetadata, resolveToolMetadata } from '@narada2/carrier-action-admission/tool-metadata';
import {
  DEFAULT_AGENT_CLI_PROVIDER,
  PROVIDER_SUPPORT_STATES,
  loadProviderMetadata,
  providerEnvironment,
} from './provider-resolution.mjs';

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
const SITE_ROOT = resolve(process.env.NARADA_SITE_ROOT ?? process.cwd());
const SITE_ID = process.env.NARADA_SITE_ID ?? process.env.NARADA_SITE_NAME ?? 'unknown-site';
const REQUEST_ADAPTERS = Object.freeze({
  'openai-compatible-chat-completions': {
    buildRequest: buildOpenAiChatRequest,
    parseResponse: (response) => response,
  },
  'anthropic-messages': {
    buildRequest: buildAnthropicMessagesRequest,
    parseResponse: parseAnthropicMessagesResponse,
  },
  'codex-mcp-server': {
    buildRequest: buildCodexMcpRequest,
    parseResponse: parseCodexMcpResponse,
  },
});
let codexSubscriptionThreadId = null;

const options = parseArgs(process.argv.slice(2));
const IDENTITY = options.identity ?? 'narada.architect';
const SESSION = options.session ?? IDENTITY.replace(/\./g, '-');
const AUTO_APPROVE = true;
const PROGRAMMATIC_INPUTS = buildProgrammaticInputs(options);
const EXIT_AFTER_PROGRAMMATIC_INPUT = PROGRAMMATIC_INPUTS.length > 0 && options.interactiveAfterMessage !== true;
const SERVER_MODE = options.server === true;
const sessionSettings = {
  model: options.model ?? MODEL,
  thinking: normalizeThinkingLevel(options.thinking ?? THINKING_LEVEL),
  stream: options.stream ?? parseBooleanEnv(process.env.NARADA_AGENT_CLI_STREAM, !SERVER_MODE),
};
const STARTUP_SYSTEM_DIRECTIVE = options.startupSystemDirectiveText
  ?? process.env.NARADA_AGENT_CLI_STARTUP_SYSTEM_DIRECTIVE
  ?? 'run startup sequence';
const STARTUP_SYSTEM_DIRECTIVE_DELAY_MS = Number(options.startupSystemDirectiveDelayMs ?? process.env.NARADA_AGENT_CLI_STARTUP_SYSTEM_DIRECTIVE_DELAY_MS ?? 10000);
const STARTUP_SYSTEM_DIRECTIVE_ENABLED = options.startupSystemDirective === true
  || options.startupSystemDirectiveText !== undefined
  || parseBooleanEnv(process.env.NARADA_AGENT_CLI_STARTUP_SYSTEM_DIRECTIVE_ENABLE, false);
const SHOULD_RUN_STARTUP_SYSTEM_DIRECTIVE = STARTUP_SYSTEM_DIRECTIVE_ENABLED
  && !SERVER_MODE
  && PROGRAMMATIC_INPUTS.length === 0
  && STARTUP_SYSTEM_DIRECTIVE.trim().length > 0
  && Number.isFinite(STARTUP_SYSTEM_DIRECTIVE_DELAY_MS)
  && STARTUP_SYSTEM_DIRECTIVE_DELAY_MS >= 0;

const CHILD_PROCESS_ENV_ALLOWLIST = Object.freeze([
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'USERNAME',
  'USERDOMAIN',
  'APPDATA',
  'LOCALAPPDATA',
  'HOME',
  'PROGRAMFILES',
  'ProgramFiles',
  'PROGRAMFILES(X86)',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'PROCESSOR_ARCHITECTURE',
  'CODEX_HOME',
  'CODEX_CONFIG_DIR',
  'NARADA_AGENT_ID',
  'NARADA_AGENT_START_EVENT_ID',
  'NARADA_CARRIER_SESSION_ID',
  'NARADA_SITE_ROOT',
  'NARADA_WORKSPACE_ROOT',
  'NARADA_AGENT_CONTEXT_DB',
  'NARADA_PC_SITE_ROOT',
  'NARADA_PROPER_ROOT',
  'NARADA_INTELLIGENCE_PROVIDER',
  'NARADA_AI_BASE_URL',
  'NARADA_AI_MODEL',
  'NARADA_AI_THINKING',
  'NARADA_THINKING_LEVEL',
  'NARADA_CODEX_MODEL',
  'NARADA_CODEX_SUBSCRIPTION_TRANSPORT',
  'NARADA_AI_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
]);

function buildChildProcessEnv(extra = {}, baseEnv = process.env) {
  const env = {};
  for (const key of CHILD_PROCESS_ENV_ALLOWLIST) {
    if (baseEnv[key] !== undefined) env[key] = baseEnv[key];
  }
  return { ...env, ...extra, FORCE_COLOR: '0', NO_COLOR: '1' };
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

const terminalStyle = createTerminalStyle({
  enabled: options.color ?? parseColorEnv(process.env.NARADA_AGENT_CLI_COLOR, process.stdout.isTTY && !SERVER_MODE),
});

// Session persistence
const PC_RUNTIME = resolve('C:/ProgramData/Narada/sites/pc/desktop-sunroom-2/runtime');
const SESSION_DIR = SERVER_MODE
  ? join(SITE_ROOT, '.narada', 'crew', 'nars-sessions', SESSION)
  : (existsSync(PC_RUNTIME) ? join(PC_RUNTIME, 'agent-sessions') : resolve(SITE_ROOT, '.ai', 'runtime', 'agent-sessions'));
if (!existsSync(SESSION_DIR)) mkdirSync(SESSION_DIR, { recursive: true });
const SESSION_PATH = SERVER_MODE ? join(SESSION_DIR, 'session.jsonl') : join(SESSION_DIR, `${SESSION}.jsonl`);
const EVENTS_PATH = join(SESSION_DIR, 'events.jsonl');
const CARRIER_SESSION_DIR = join(SITE_ROOT, '.narada', 'crew', 'nars-sessions', SESSION);
if (!existsSync(CARRIER_SESSION_DIR)) mkdirSync(CARRIER_SESSION_DIR, { recursive: true });
const HEARTBEAT_PATH = join(CARRIER_SESSION_DIR, 'heartbeat.json');
const HEARTBEAT_ENABLED = parseBooleanEnv(process.env.NARADA_AGENT_CLI_HEARTBEAT_ENABLE, true);
let activeHeartbeat = null;

// Set window title for OSL binding
if (process.title !== IDENTITY) {
  process.title = IDENTITY;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  if (HEARTBEAT_ENABLED) {
    activeHeartbeat = startCarrierHeartbeat({
      path: HEARTBEAT_PATH,
      session: SESSION,
      identity: IDENTITY,
      runtime: 'agent-cli',
      mode: SERVER_MODE ? 'server' : 'interactive',
      sessionDir: SESSION_DIR,
      carrierSessionDir: CARRIER_SESSION_DIR,
    });
  }
  if (SERVER_MODE) {
    await runServerMode();
    return;
  }

  const mcpServers = await discoverAndStartMcpServers(SITE_ROOT);
  const allTools = aggregateTools(mcpServers);
  const rolePrompt = loadRolePrompt(IDENTITY, SITE_ROOT);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let controlWatcher = null;
  const promptState = { active: false };

  printHeaderRows([
    ['Identity', IDENTITY],
    ['Session', SESSION],
    ['Provider', INTELLIGENCE_PROVIDER],
    ['Model', sessionSettings.model],
    ['Thinking', sessionSettings.thinking],
    ['Stream', sessionSettings.stream ? 'on' : 'off'],
    ['MCP servers', Object.keys(mcpServers).length],
    ...Object.entries(mcpServers).map(([name, srv]) => [`  ${name}`, `${srv.tools.length} tools`]),
    ['Tools', allTools.length],
    ['Approvals', 'disabled'],
    ['Help', '/help'],
  ], { before: true, after: true });

  let messages = loadSession(SESSION_PATH);
  if (messages.length === 0 && rolePrompt) {
    messages.push({ role: 'system', content: rolePrompt });
  }
  const inputQueue = createInputQueue({
    drain: (event) => submitUserInput({ input: event, messages, tools: allTools, mcpServers, rl, inputQueue }),
    shouldDefer: (event) => shouldDeferInteractiveInput(event, { rl, promptState }),
    onDeferred: (event, queueState) => {
      if (event.source === 'system_directive') {
        const count = queueState.pendingSystemDirectiveCount ?? 1;
        printCliMessage(`Queued ${count} system directive${count === 1 ? '' : 's'}; waiting for operator input to be submitted or cleared.`);
      }
    },
  });

  for (const input of PROGRAMMATIC_INPUTS) {
    await inputQueue.enqueue(normalizeInputEvent(input, { transport: 'programmatic' }), { drain: true });
  }
  if (EXIT_AFTER_PROGRAMMATIC_INPUT) {
    inputQueue.finalizeSession();
    rl.close();
    for (const server of Object.values(mcpServers)) {
      if (server.process) server.process.kill();
    }
    printHeader('Programmatic input processed. Goodbye.', { before: true });
    return;
  }

  if (SHOULD_RUN_STARTUP_SYSTEM_DIRECTIVE) {
    printCliMessage(`System directive scheduled in ${formatDuration(STARTUP_SYSTEM_DIRECTIVE_DELAY_MS)}.`);
    setTimeout(() => {
      inputQueue.enqueue(normalizeInputEvent({
        content: STARTUP_SYSTEM_DIRECTIVE,
        source: 'system_directive',
        authority_ref: 'agent-cli-startup-system-directive',
      }, { transport: 'programmatic' }), { drain: true }).catch((error) => {
        printCliMessage(`Startup system directive failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, STARTUP_SYSTEM_DIRECTIVE_DELAY_MS);
  }

  if (options.controlJsonl) {
    controlWatcher = startInteractiveControlJsonlWatcher({
      controlPath: resolve(options.controlJsonl),
      inputQueue,
    });
  }

  while (true) {
    const promptLabel = `operator -> ${IDENTITY}`;
    promptState.active = true;
    const userInput = await question(rl, `${styleInputRouteLabel(promptLabel)}${terminalStyle.muted('>')} `);
    promptState.active = false;
    if (userInput === '__READLINE_CLOSED__') break;
    rewriteSubmittedPrompt(promptLabel, userInput);
    const slashCommand = await handleSlashCommand(userInput, { mcpServers, allTools, inputQueue });
    if (slashCommand === 'exit') break;
    if (slashCommand === 'handled') {
      await inputQueue.drainUntilIdle();
      continue;
    }
    if (userInput.trim().length === 0) {
      await inputQueue.drainUntilIdle();
      continue;
    }

    await inputQueue.enqueue(normalizeInputEvent(
      { content: userInput, source: 'manual_operator' },
      { transport: 'terminal' },
    ), { drain: true });
  }

  rl.close();
  inputQueue.finalizeSession();
  controlWatcher?.stop();
  for (const server of Object.values(mcpServers)) {
    if (server.process) server.process.kill();
  }
  printHeader('Session saved. Goodbye.', { before: true });
}

function startInteractiveControlJsonlWatcher({ controlPath, inputQueue }) {
  mkdirSync(resolve(controlPath, '..'), { recursive: true });
  if (!existsSync(controlPath)) writeFileSync(controlPath, '', 'utf8');
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
      chain = chain.then(() => handleInteractiveControlLine(line, { inputQueue })).catch((error) => {
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

function shouldDeferInteractiveInput(event, { rl, promptState } = {}) {
  if (event?.source !== 'system_directive') return false;
  return Boolean(promptState?.active && readlineHasNonWhitespaceInput(rl));
}

async function handleInteractiveControlLine(line, { inputQueue }) {
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
  if (request?.method !== 'system_directive.deliver') {
    throw new Error(`unsupported_control_method:${request?.method ?? '<missing>'}`);
  }
  const directive = request?.params?.directive ?? null;
  const message = String(request?.params?.message ?? directive?.content?.text ?? '');
  if (!message.trim()) throw new Error('empty_system_directive_control_frame');
  return normalizeControlInputRecord({
    content: message,
    source: 'system_directive',
    source_id: request?.params?.source_id ?? 'agent-cli.system_directive',
    authority_ref: request?.params?.authority_ref ?? directive?.directive_id ?? request?.params?.directive_id ?? null,
    directive_id: directive?.directive_id ?? request?.params?.directive_id ?? null,
    transport: 'control_jsonl',
  }, { transport: 'control_jsonl' });
}

function recordCarrierDiagnostic(level, message, extra = {}) {
  appendSession(SESSION_PATH, carrierSessionEventEntry('carrier_diagnostic_recorded', {
    level,
    message,
    ...extra,
  }));
}

async function handleSlashCommand(input, { mcpServers, allTools, inputQueue = null, statsRunner = runCodexTranscriptStats }) {
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
      '/stats [args]         Show local Codex transcript statistics',
      '/model <name>         Set model for later turns',
      '/thinking <level>     none, low, medium, high',
      '/queue                Show queued carrier input',
      '/queue clear          Clear queued operator steering',
      '/queue drop <index>   Drop one queued operator steering item',
      '/clear                Clear terminal display',
      '/exit                 Save and quit',
    ].join('\n'));
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
    printCliMessage(formatKeyValueRows({
      Identity: IDENTITY,
      Session: SESSION,
      Provider: INTELLIGENCE_PROVIDER,
      Model: sessionSettings.model,
      Thinking: sessionSettings.thinking,
      Stream: sessionSettings.stream ? 'on' : 'off',
      'MCP servers': Object.keys(mcpServers).length,
      Tools: allTools.length,
    }));
    appendSession(SESSION_PATH, sessionEventEntry('session_command', { command: '/status' }));
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

function runCodexTranscriptStats(value = '') {
  const extraArgs = shellLikeWords(value);
  const defaultArgs = extraArgs.length === 0 ? ['--top', '10'] : extraArgs;
  const configuredRoot = process.env.NARADA_TOOLS_ROOT;
  const defaultRoot = process.platform === 'win32' ? 'D:/code/narada-tools' : '/home/andrey/src/narada-tools';
  const candidateRoot = configuredRoot || defaultRoot;
  const scriptPath = join(candidateRoot, 'packages', 'codex-transcript-stats', 'src', 'codex-transcript-stats.mjs');
  const command = existsSync(scriptPath) ? process.execPath : 'codex-transcript-stats';
  const args = existsSync(scriptPath) ? [scriptPath, ...defaultArgs] : defaultArgs;
  const cwd = existsSync(candidateRoot) ? candidateRoot : process.cwd();
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    env: process.env,
  });
  if (result.error) {
    return {
      status: 'unavailable',
      message: [
        'Codex transcript stats unavailable.',
        `Expected tool at ${scriptPath} or codex-transcript-stats on PATH.`,
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
  const record = normalizeInputRecord(input);
  const receivedAt = defaults.received_at ?? input?.received_at ?? new Date().toISOString();
  const legacySource = record.source;
  const protocolSourceKind = input?.source_kind ?? sourceKindForLegacyInputSource(legacySource);
  const protocolMetadata = {
    ...(input?.metadata ?? {}),
    legacy_source: legacySource,
    ...(protocolSourceKind === 'system' && record.directive_id ? { directive_provenance: { kind: 'system_directive' } } : {}),
    ...(legacySource === 'operator_directive' ? { directive_provenance: { kind: 'explicit_operator_directive_surface' } } : {}),
  };
  const protocolEvent = normalizeCarrierInputEvent({
    schema: 'narada.carrier.input_event.v1',
    event_id: input?.event_id ?? `input_${randomId()}`,
    source_kind: protocolSourceKind,
    source_id: input?.source_id ?? sourceIdForLegacyInputSource(legacySource),
    transport: normalizeLegacyTransport(input?.transport ?? defaults.transport ?? transportForInputSource(legacySource)),
    delivery_mode: input?.delivery_mode ?? deliveryModeForLegacyInputSource(legacySource),
    hold_condition: input?.hold_condition ?? null,
    content: record.content,
    created_at: receivedAt,
    authority_ref: record.authority_ref,
    directive_id: input?.directive_id ?? record.directive_id ?? null,
    metadata: protocolMetadata,
  });
  return {
    ...protocolEvent,
    received_at: protocolEvent.created_at,
    content: record.content,
    source: legacySource,
    authority_ref: record.authority_ref,
    directive_id: protocolEvent.directive_id,
    request_id: input?.request_id ?? null,
    transport: protocolEvent.transport,
  };
}

function transportForInputSource(source) {
  if (source === 'automation_jsonl') return 'control_jsonl';
  if (source === 'programmatic_operator' || source === 'operator_directive' || source === 'system_directive') return 'carrier_server_api';
  return 'interactive_terminal';
}

function normalizeLegacyTransport(transport) {
  if (transport === 'terminal') return 'interactive_terminal';
  if (transport === 'programmatic') return 'carrier_server_api';
  if (transport === 'jsonl_stdio') return 'control_jsonl';
  return transport;
}

function sourceKindForLegacyInputSource(source) {
  if (source === 'system_directive') return 'system';
  return 'operator';
}

function sourceIdForLegacyInputSource(source) {
  if (source === 'system_directive') return 'agent-cli.system_directive';
  return 'operator';
}

function deliveryModeForLegacyInputSource(source) {
  if (source === 'operator_steering') return 'admit_after_active_turn';
  return 'admit_for_current_turn';
}

function createInputQueue({ drain, shouldDefer = () => false, onDeferred = null } = {}) {
  const pending = [];
  const state = { running: false, deferredNotified: new Set(), heldSystemDirectives: new Set() };
  return {
    get isRunning() { return state.running; },
    get pendingCount() { return pending.length; },
    get pendingSystemDirectiveCount() { return pending.filter((event) => event.source === 'system_directive').length; },
    get pendingOperatorDirectiveCount() { return pending.filter((event) => event.source === 'operator_steering').length; },
    enqueue: async (event, options = {}) => {
      const normalized = normalizeInputEvent(event);
      pending.push(normalized);
      appendSession(SESSION_PATH, sessionEventEntry('input_event_queued', {
        event_id: normalized.event_id,
        source: normalized.source,
        transport: normalized.transport,
        authority_ref: normalized.authority_ref,
        directive_id: normalized.directive_id,
      }));
      if (normalized.delivery_mode === 'admit_after_active_turn') {
        appendSession(SESSION_PATH, carrierSessionEventEntry('input_queued_for_turn_boundary', {
          input_event_id: normalized.event_id,
          queue_state: 'queued_for_turn_boundary',
        }));
      }
      if (options.drain) await drainUntilIdle();
      return normalized;
    },
    drainOnce,
    drainUntilIdle,
    state: queueSnapshot,
    items: queueItems,
    clearOperatorSteering,
    dropOperatorSteering,
    finalizeSession,
  };

  function queueSnapshot() {
    return {
      running: state.running,
      pendingCount: pending.length,
      pendingSystemDirectiveCount: pending.filter((event) => event.source === 'system_directive').length,
      pendingOperatorDirectiveCount: pending.filter((event) => event.source === 'operator_steering').length,
    };
  }

  function queueItems() {
    return pending.map((event, index) => ({
      index: index + 1,
      event_id: event.event_id,
      source: event.source,
      source_kind: event.source_kind,
      source_id: event.source_id,
      transport: event.transport,
      delivery_mode: event.delivery_mode,
      hold_condition: event.hold_condition ?? null,
      created_at: event.created_at,
      received_at: event.received_at,
      content: event.content,
    }));
  }

  function clearOperatorSteering() {
    const dropped = [];
    for (let index = pending.length - 1; index >= 0; index--) {
      if (pending[index].source !== 'operator_steering') continue;
      const [event] = pending.splice(index, 1);
      dropped.unshift(event);
    }
    for (const event of dropped) recordDroppedByOperator(event, 'queue_clear');
    return dropped;
  }

  function dropOperatorSteering(index) {
    const operatorSteering = pending
      .map((event, pendingIndex) => ({ event, pendingIndex }))
      .filter(({ event }) => event.source === 'operator_steering');
    const target = operatorSteering[index - 1];
    if (!target) return null;
    const [event] = pending.splice(target.pendingIndex, 1);
    recordDroppedByOperator(event, 'queue_drop');
    return event;
  }

  function recordDroppedByOperator(event, dropReason) {
    appendSession(SESSION_PATH, carrierSessionEventEntry('input_dropped_by_operator', {
      input_event_id: event.event_id,
      drop_reason: dropReason,
    }));
  }

  function finalizeSession() {
    const abandoned = pending.splice(0, pending.length);
    for (const event of abandoned) {
      appendSession(SESSION_PATH, carrierSessionEventEntry('input_abandoned_on_session_end', {
        input_event_id: event.event_id,
      }));
      state.deferredNotified.delete(event.event_id);
      state.heldSystemDirectives.delete(event.event_id);
    }
    return abandoned;
  }

  async function drainOnce() {
    if (state.running || pending.length === 0) return null;
    if (shouldDefer(pending[0])) {
      const event = pending[0];
      if (event && !state.deferredNotified.has(event.event_id)) {
        state.deferredNotified.add(event.event_id);
        recordSystemDirectiveHeld(event);
        onDeferred?.(event, queueSnapshot());
      }
      return null;
    }
    const event = pending.shift();
    state.deferredNotified.delete(event.event_id);
    recordSystemDirectiveReleased(event);
    state.running = true;
    appendSession(SESSION_PATH, sessionEventEntry('input_event_started', {
      event_id: event.event_id,
      source: event.source,
      transport: event.transport,
      authority_ref: event.authority_ref,
      directive_id: event.directive_id,
    }));
    appendSession(SESSION_PATH, carrierSessionEventEntry('input_admitted_to_turn', {
      input_event_id: event.event_id,
    }));
    if (event.source === 'system_directive' && event.directive_id) {
      appendSession(SESSION_PATH, sessionEventEntry('directive_receipt_recorded', directiveReceiptEvidence(event, {
        agentId: IDENTITY,
        carrierSessionId: SESSION,
      })));
      appendSession(SESSION_PATH, sessionEventEntry('directive_carrier_accepted_recorded', directiveAcceptedEvidence(event, {
        agentId: IDENTITY,
        carrierSessionId: SESSION,
      })));
    }
    try {
      const result = await drain(event);
      appendSession(SESSION_PATH, sessionEventEntry('input_event_completed', {
        event_id: event.event_id,
        terminal_state: result?.terminal_state ?? 'completed',
      }));
      appendSession(SESSION_PATH, carrierSessionEventEntry('input_completed', {
        input_event_id: event.event_id,
        terminal_state: result?.terminal_state ?? 'completed',
      }));
      return result;
    } finally {
      state.running = false;
    }
  }

  function recordSystemDirectiveHeld(event) {
    if (event?.source !== 'system_directive') return;
    if (state.heldSystemDirectives.has(event.event_id)) return;
    state.heldSystemDirectives.add(event.event_id);
    appendSession(SESSION_PATH, carrierSessionEventEntry('system_directive_held', {
      input_event_id: event.event_id,
      ...(event.directive_id ? { directive_id: event.directive_id } : {}),
      held_at: new Date().toISOString(),
      held_reason: 'composer_nonempty',
      original_delivery_mode: event.delivery_mode,
    }));
  }

  function recordSystemDirectiveReleased(event) {
    if (event?.source !== 'system_directive') return;
    if (!state.heldSystemDirectives.has(event.event_id)) return;
    state.heldSystemDirectives.delete(event.event_id);
    appendSession(SESSION_PATH, carrierSessionEventEntry('system_directive_released', {
      input_event_id: event.event_id,
      ...(event.directive_id ? { directive_id: event.directive_id } : {}),
      released_at: new Date().toISOString(),
    }));
  }

  async function drainUntilIdle() {
    let last = null;
    while (!state.running && pending.length > 0 && !shouldDefer(pending[0])) {
      last = await drainOnce();
    }
    if (!state.running && pending.length > 0 && shouldDefer(pending[0])) await drainOnce();
    return last;
  }
}

function readlineHasPartialInput(rl) {
  return Boolean(rl && typeof rl.line === 'string' && rl.line.length > 0);
}

function readlineHasNonWhitespaceInput(rl) {
  return Boolean(rl && typeof rl.line === 'string' && rl.line.trim().length > 0);
}

async function submitUserInput({ input, messages, tools, mcpServers, rl, inputQueue = null, turn = null, emit = null, callChatApiFn = callChatApi }) {
  const record = normalizeInputRecord(input);
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
  const progress = !emit && !turn ? startInteractiveTurnProgress({
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
    return await runConversationTurn(messages, tools, mcpServers, rl, { turn: turn ?? progress?.turn ?? null, emit, callChatApiFn, inputEventId: input?.event_id ?? null });
  } finally {
    progress?.stop();
  }
}

async function runConversationTurn(messages, tools, mcpServers, rl, options = {}) {
  const emit = options.emit ?? null;
  const turn = options.turn ?? null;
  const callChatApiFn = options.callChatApiFn ?? callChatApi;
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
      response = await callChatApiFn(messages, tools, { ...sessionSettings, turn, abortSignal: turn?.abortSignal, emit, mcpServers });
    } catch (error) {
      if (turn?.interruptRequested || isAbortError(error)) {
        emit?.('turn_interrupted', { turn_id: turn?.turnId ?? null, terminal_state: 'interrupted' });
        recordTurnTerminal('turn_interrupted');
        return { terminal_state: 'interrupted' };
      }
      recordTurnTerminal('turn_failed', { error_summary: error instanceof Error ? error.message : String(error) });
      throw error;
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
        const result = await executeMcpTool(toolCall, mcpServers, rl, { emit, turn, turnId: turn?.turnId ?? null, serverMode: !!emit });
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
  appendSession(SESSION_PATH, carrierSessionEventEntry('tool_call_requested', {
    tool_name: name || '<missing>',
    arguments_summary: argSummaryText,
    requesting_agent_id: IDENTITY,
  }));
  const recordToolResult = (status, contentOrSummary, extra = {}) => {
    appendSession(SESSION_PATH, carrierSessionEventEntry('tool_result_received', {
      tool_name: name || '<missing>',
      status,
      duration_ms: Date.now() - startedAt,
      result_summary: summarizeToolResult(contentOrSummary),
      ...extra,
    }));
  };
  const admissionClassification = serverMode
    ? classifyCarrierActionRequest(name, args, { toolAvailable: !!server, toolMetadata })
    : null;
  const category = serverMode
    ? (admissionClassification.decision === 'read_only_admitted' ? 'auto' : 'prompt')
    : classifyTool(name, args);
  const admissionRequired = serverMode && admissionClassification.decision !== 'read_only_admitted';

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
        carrier_mutation_admitted: false,
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
      printToolResultLine(`blocked ${name} in ${formatDuration(Date.now() - startedAt)} · blocklist`, { level: 'warn' });
    }
    emit?.('tool_result', { turn_id: turnId, tool: name, status: 'blocked' });
    recordToolResult('blocked', `Tool ${name} is blocked by policy.`);
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
      recordToolResult('admission_required', 'action_admission_required');
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
    recordToolResult('error', `Tool ${name} not found in any MCP server.`);
    if (!serverMode) {
      turn?.clearStatus?.();
      printToolResultLine(`failed ${name} in ${formatDuration(Date.now() - startedAt)} · tool not found`, { level: 'error' });
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
    recordToolResult('admission_required', 'action_admission_required');
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

  try {
    const result = await sendMcpRequest(server, {
      jsonrpc: '2.0',
      id: randomId(),
      method: 'tools/call',
      params: { name, arguments: args },
    });

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
            });
            const autoContent = autoResult.content?.[0]?.text ?? JSON.stringify(autoResult);
            turn?.clearStatus?.();
            printToolResultLine(`ok ${name} in ${formatDuration(Date.now() - startedAt)} · ${formatToolResultContent(autoContent)}`);
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
      printToolResultLine(`ok ${name} in ${formatDuration(Date.now() - startedAt)} · ${formatToolResultContent(content)}`);
    }
    emit?.('tool_result', {
      turn_id: turnId,
      tool: name,
      status: 'ok',
      decision: serverMode ? 'read_only_admitted' : undefined,
      output_ref: extractOutputRef(content),
    });
    recordToolResult('ok', content, { result_ref: payloadRefFromOutputRef(extractOutputRef(content)) });

    return {
      role: 'tool',
      tool_call_id: toolCall.id,
      content,
    };
  } catch (err) {
    const recovery = toolFailureRecovery(err?.message);
    if (!serverMode) {
      turn?.clearStatus?.();
      printToolResultLine(`failed ${name} in ${formatDuration(Date.now() - startedAt)} · ${err.message}${recovery ? `\n${recovery}` : ''}`, { level: 'error' });
    }
    emit?.('tool_result', { turn_id: turnId, tool: name, status: 'error', error: err.message, recovery });
    recordToolResult('error', err.message, recovery ? { recovery } : {});
    return {
      role: 'tool',
      tool_call_id: toolCall.id,
      content: JSON.stringify({ error: err.message, ...(recovery ? { recovery } : {}) }),
    };
  }
}

function toolFailureRecovery(message) {
  const text = String(message ?? '');
  if (!text.includes('inline_payload_too_long')) return null;
  return 'Recovery: call mcp_payload_create with {"payload":{...}}, then retry the original tool with {"payload_ref":"mcp_payload:<id>@v1"}. Do not print JSON as prose.';
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

function classifyTool(name, args) {
  const metadata = buildFallbackToolMetadata(name);
  if (metadata?.read_only === true) return 'auto';
  return 'prompt';
}

// ---------------------------------------------------------------------------
// MCP Server Discovery & Management
// ---------------------------------------------------------------------------
async function discoverAndStartMcpServers(siteRoot) {
  const fabric = loadSiteMcpFabric(siteRoot, { required: false });

  const servers = {};
  for (const [serverName, serverConfig] of Object.entries(fabric.servers)) {
    try {
      const args = [...serverConfig.args];
      // Interactive agent-cli keeps its legacy shell affordance. Agent Runtime Server
      // mode must not widen authority when materializing the MCP fabric.
      if (!SERVER_MODE && serverName.includes('shell')) {
        if (!args.includes('--auto-approve')) args.push('--auto-approve');
      }

      const proc = spawn(serverConfig.command, args, {
        cwd: siteRoot,
        windowsHide: true,
        env: buildChildProcessEnv(projectServerEnvironment(serverConfig)),
      });

      let buffer = '';
      proc.stdout.setEncoding('utf-8');
      proc.stderr.setEncoding('utf-8');
      proc.stderr.on('data', (d) => {
        const msg = d.toString().trim();
        if (shouldSuppressMcpStderr(msg)) return;
        if (msg) process.stderr.write(`[${serverName}] ${msg}\n`);
      });

      const pending = new Map();
      proc.stdout.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.id != null && pending.has(msg.id)) {
              const request = pending.get(msg.id);
              clearTimeout(request.timeout);
              request.resolve(msg);
              pending.delete(msg.id);
            }
          } catch {
            // ignore malformed
          }
        }
      });

      const send = (req, timeoutMs = 15000) => new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          if (pending.has(req.id)) {
            pending.delete(req.id);
            reject(new Error(`MCP request timeout after ${timeoutMs}ms`));
          }
        }, timeoutMs);
        pending.set(req.id, { resolve, reject, timeout });
        proc.stdin.write(`${JSON.stringify(req)}\n`);
      });

      // Initialize with timeout
      let initResult, toolsResult;
      try {
        initResult = await send({ jsonrpc: '2.0', id: randomId(), method: 'initialize', params: { protocolVersion: '2024-11-05' } }, 10000);
        toolsResult = await send({ jsonrpc: '2.0', id: randomId(), method: 'tools/list', params: {} }, 10000);
      } catch (err) {
        console.error(`[agent-cli] Failed to initialize MCP server ${serverName}: ${err.message}`);
        proc.kill();
        continue;
      }

      servers[serverName] = {
        process: proc,
        send,
        tools: toolsResult.result?.tools ?? [],
        config: serverConfig,
        registry_tools: serverConfig.registry_tools ?? {},
        registry_source: serverConfig.registry_source ?? null,
        registry_metadata_authoritative: serverConfig.registry_metadata_authoritative === true,
      };
    } catch (err) {
      console.error(`[agent-cli] Failed to start MCP server ${serverName}: ${err.message}`);
    }
  }

  return servers;
}

function shouldSuppressMcpStderr(message) {
  if (!message) return true;
  return (
    message.includes('ExperimentalWarning: SQLite is an experimental feature') ||
    message.includes('Use `node --trace-warnings ...` to show where the warning was created')
  );
}

function aggregateTools(mcpServers) {
  const all = [];
  const seen = new Set();
  for (const [serverName, server] of Object.entries(mcpServers)) {
    for (const tool of server.tools) {
      if (seen.has(tool.name)) continue;
      seen.add(tool.name);
      all.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description ?? '',
          parameters: tool.inputSchema ?? { type: 'object', properties: {} },
        },
      });
    }
  }
  return all;
}

function findToolServer(name, mcpServers) {
  return findToolBinding(name, mcpServers)?.server ?? null;
}

function findToolBinding(name, mcpServers) {
  for (const [serverName, server] of Object.entries(mcpServers)) {
    const tool = server.tools.find((t) => t.name === name);
    if (tool) return { server: { ...server, name: serverName }, tool };
  }
  return null;
}

async function sendMcpRequest(server, request) {
  const response = await server.send(request);
  if (response.error) throw new Error(response.error.message);
  return response.result;
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
  appendFileSync(path, JSON.stringify(entry) + '\n', 'utf-8');
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

function startInteractiveTurnProgress({ onOperatorDirective = null, readlineInterface = null } = {}) {
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
    for (const char of operatorDirectiveDecoder.write(buffer)) {
      if (char === '\r' || char === '\n') {
        const content = operatorDirectiveBuffer.trim();
        operatorDirectiveBuffer = '';
        if (!content) {
          forceNextStatus = true;
          continue;
        }
        Promise.resolve(onOperatorDirective(content)).then((queueState) => {
          queuedOperatorDirectiveCount = queueState?.pendingOperatorDirectiveCount ?? queuedOperatorDirectiveCount + 1;
          printProgressMessage(terminalStyle.operatorDirective(`operator directive queued (${queuedOperatorDirectiveCount})`));
        }).catch((error) => {
          printProgressMessage(terminalStyle.warn(`operator directive queue failed: ${error instanceof Error ? error.message : String(error)}`));
        });
        continue;
      }
      if (char === '\x7f' || char === '\b') {
        operatorDirectiveBuffer = Array.from(operatorDirectiveBuffer).slice(0, -1).join('');
        forceNextStatus = true;
        continue;
      }
      if (char >= ' ') {
        operatorDirectiveBuffer += char;
        forceNextStatus = true;
      }
    }
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

function normalizeInputRecord(input) {
  if (typeof input === 'string') return { content: input, source: 'manual_operator' };
  if (input?.source_kind === 'system' && !input?.source) {
    return {
      content: String(input?.content ?? ''),
      source: 'system_directive',
      authority_ref: input?.authority_ref ?? null,
      directive_id: input?.directive_id ?? null,
    };
  }
  if (input?.delivery_mode === 'admit_after_active_turn' && !input?.source) {
    return {
      content: String(input?.content ?? ''),
      source: 'operator_steering',
      authority_ref: input?.authority_ref ?? null,
      directive_id: input?.directive_id ?? null,
    };
  }
  return {
    content: String(input?.content ?? ''),
    source: input?.source ?? 'manual_operator',
    authority_ref: input?.authority_ref ?? null,
    directive_id: input?.directive_id ?? null,
  };
}

function buildProgrammaticInputs(opts) {
  const inputs = [];
  const source = opts.systemDirective === true
    ? 'system_directive'
    : opts.operatorDirective === true
      ? 'operator_directive'
      : 'programmatic_operator';
  for (const message of opts.messages ?? []) {
    inputs.push({ content: message, source, authority_ref: opts.authorityRef ?? null });
  }
  for (const filePath of opts.messageFiles ?? []) {
    inputs.push({ content: readFileSync(resolve(filePath), 'utf8'), source, authority_ref: opts.authorityRef ?? null });
  }
  return inputs;
}

// ---------------------------------------------------------------------------
// Agent Runtime Server JSONL Mode
// ---------------------------------------------------------------------------
async function runServerMode({ input = process.stdin, output = process.stdout, callChatApiFn = callChatApi } = {}) {
  const mcpServers = await discoverAndStartMcpServers(SITE_ROOT);
  const allTools = aggregateTools(mcpServers);
  const rolePrompt = loadRolePrompt(IDENTITY, SITE_ROOT);
  const state = {
    activeTurn: null,
    closed: false,
    pendingRequests: new Set(),
  };
  let messages = loadSession(SESSION_PATH);
  if (messages.length === 0 && rolePrompt) {
    messages.push({ role: 'system', content: rolePrompt });
  }
  state.inputQueue = createInputQueue({
    drain: (event) => {
      const requestId = event.request_id ?? event.event_id;
      if (state.closed) {
        emit('error', {
          request_id: requestId,
          code: 'session_closed',
          message: 'Session is closed.',
        });
        return { terminal_state: 'rejected' };
      }
      return runServerConversationTurn({
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

  const emit = (event, payload = {}) => emitServerEvent(output, {
    event,
    agent_id: IDENTITY,
    session_id: SESSION,
    timestamp: new Date().toISOString(),
    ...payload,
  });

  emit('session_started', {
    transport: 'jsonl_stdio',
    site_root: SITE_ROOT,
    provider: INTELLIGENCE_PROVIDER,
    model: sessionSettings.model,
    thinking: sessionSettings.thinking,
    mcp_server_count: Object.keys(mcpServers).length,
    tool_count: allTools.length,
    session_path: SESSION_PATH,
    events_path: EVENTS_PATH,
  });

  input.setEncoding('utf8');
  let buffer = '';
  const dispatchRequestLine = (line) => {
    const pending = handleServerRequestLine(line, { state, messages, allTools, mcpServers, emit, callChatApiFn })
      .catch((error) => {
        emit('error', {
          request_id: null,
          code: 'request_dispatch_failed',
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        state.pendingRequests.delete(pending);
      });
    state.pendingRequests.add(pending);
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
  closeMcpServers(mcpServers);
}

async function handleServerRequestLine(line, context) {
  let request;
  try {
    request = JSON.parse(line);
  } catch (error) {
    context.emit('error', {
      request_id: null,
      code: 'invalid_json',
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  await handleServerRequest(request, context);
}

async function handleServerRequest(request, { state, messages, allTools, mcpServers, emit, callChatApiFn }) {
  const requestId = request?.id ?? null;
  const method = request?.method;
  try {
    if (state.closed && method !== 'session.status' && method !== 'session.close') {
      emit('error', {
        request_id: requestId,
        code: 'session_closed',
        message: 'Session is closed.',
      });
      return;
    }
    if (method === 'session.status') {
      emit('session_status', serverStatus({ requestId, state, allTools, mcpServers }));
      return;
    }
    if (method === 'conversation.interrupt') {
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
      return;
    }
    if (method === 'session.close') {
      state.closed = true;
      if (state.activeTurn) requestTurnInterrupt(state.activeTurn);
      emit('session_closed', {
        request_id: requestId,
        terminal_state: 'closed',
      });
      return;
    }
    if (method === 'system_directive.deliver') {
      const directive = request?.params?.directive ?? null;
      const message = String(request?.params?.message ?? directive?.content?.text ?? '');
      const directiveId = directive?.directive_id ?? request?.params?.directive_id ?? null;
      if (!message.trim()) {
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
      }, { transport: 'jsonl_stdio' }), { drain: true });
      return;
    }
    if (method !== 'conversation.send') {
      emit('error', {
        request_id: requestId,
        code: 'unsupported_method',
        message: `Unsupported method: ${method}`,
      });
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
      source: 'automation_jsonl',
      authority_ref: request?.params?.authority_ref ?? null,
      request_id: requestId,
    }, { transport: 'jsonl_stdio' }), { drain: true });
  } catch (error) {
    emit('error', {
      request_id: requestId,
      code: 'request_failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
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

function serverStatus({ requestId, state, allTools, mcpServers }) {
  return {
    request_id: requestId,
    transport: 'jsonl_stdio',
    provider: INTELLIGENCE_PROVIDER,
    model: sessionSettings.model,
    thinking: sessionSettings.thinking,
    stream: sessionSettings.stream,
    active_turn_state: state.activeTurn ? 'running' : 'idle',
    active_turn_id: state.activeTurn?.turnId ?? null,
    mcp_server_count: Object.keys(mcpServers).length,
    tool_count: allTools.length,
    session_path: SESSION_PATH,
    events_path: EVENTS_PATH,
  };
}

function emitServerEvent(output, event) {
  const line = `${JSON.stringify(event)}\n`;
  appendFileSync(EVENTS_PATH, line, 'utf8');
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
  if (provider === 'anthropic-api') {
    throw new Error('Missing API key for anthropic-api. Set ANTHROPIC_API_KEY or NARADA_AI_API_KEY.');
  }
  throw new Error(`Missing API key for ${provider}. Set NARADA_AI_API_KEY.`);
}

function normalizeThinkingLevel(value) {
  const normalized = String(value ?? 'medium').trim().toLowerCase();
  if (['none', 'low', 'medium', 'high'].includes(normalized)) return normalized;
  return 'medium';
}

function reasoningEffort(thinking) {
  if (thinking === 'none') return null;
  if (thinking === 'low') return 'low';
  if (thinking === 'high') return 'high';
  return 'medium';
}

function buildCodexMcpRequest(messages, tools = [], { model = MODEL, thinking = THINKING_LEVEL, siteRoot = SITE_ROOT } = {}) {
  const latestUserIndex = findLastMessageIndex(messages, 'user');
  const latestToolIndex = findLastMessageIndex(messages, 'tool');
  const latestUser = latestUserIndex >= 0 ? messages[latestUserIndex] : null;
  const latestTool = latestToolIndex >= 0 ? messages[latestToolIndex] : null;
  const system = messages
    .filter((message) => message.role === 'system')
    .map((message) => String(message.content ?? ''))
    .filter(Boolean)
    .join('\n\n');
  const prompt = latestTool && latestToolIndex > latestUserIndex
    ? [
      `Narada tool result (${latestTool.tool_call_id ?? 'tool'}):`,
      String(latestTool.content ?? ''),
      '',
      'Answer the original request using this tool result.',
    ].join('\n')
    : latestUser ? String(latestUser.content ?? '') : '';
  if (!prompt.trim()) throw new Error('codex_subscription_prompt_missing');
  const developerInstructions = [system, codexToolProtocolInstructions(tools)].filter(Boolean).join('\n\n');

  if (codexSubscriptionThreadId) {
    return {
      tool: 'codex-reply',
      arguments: {
        threadId: codexSubscriptionThreadId,
        prompt,
        model,
        ...(reasoningEffort(thinking) ? { 'reasoning-effort': reasoningEffort(thinking) } : {}),
      },
    };
  }

  return {
    tool: 'codex',
    arguments: {
      prompt,
      cwd: siteRoot,
      model,
      ...(reasoningEffort(thinking) ? { 'reasoning-effort': reasoningEffort(thinking) } : {}),
      sandbox: process.platform === 'win32' ? 'danger-full-access' : 'workspace-write',
      'approval-policy': 'never',
      ...(developerInstructions ? { 'developer-instructions': developerInstructions } : {}),
    },
  };
}

function findLastMessageIndex(messages, role) {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === role) return index;
  }
  return -1;
}

function codexToolProtocolInstructions(tools = []) {
  if (!Array.isArray(tools) || tools.length === 0) return '';
  const toolLines = tools
    .map((tool) => {
      const fn = tool.function ?? {};
      return `- ${fn.name}: ${String(fn.description ?? '').slice(0, 180)}`;
    })
    .join('\n');
  return [
    'Narada MCP tools are available through agent-cli, not through native Codex tool discovery.',
    'When a Narada MCP tool is needed, respond with exactly one JSON object and no prose:',
    '{"narada_tool_call":{"name":"tool_name","arguments":{}}}',
    'Do not claim a listed Narada MCP tool is unavailable. Request it using the JSON object above.',
    'Available Narada MCP tools:',
    toolLines,
  ].join('\n');
}

function parseCodexMcpResponse(response) {
  if (response?.threadId) codexSubscriptionThreadId = response.threadId;
  const toolCall = parseNaradaToolCall(response?.content ?? '');
  if (toolCall) {
    return {
      id: response?.threadId ?? `codex-${Date.now()}`,
      object: 'chat.completion',
      streaming_rendered: false,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: `narada_tool_${Date.now()}`,
            type: 'function',
            function: {
              name: toolCall.name,
              arguments: JSON.stringify(toolCall.arguments ?? {}),
            },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    };
  }
  return {
    id: response?.threadId ?? `codex-${Date.now()}`,
    object: 'chat.completion',
    streaming_rendered: response?.streaming_rendered === true,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: response?.content ?? '',
      },
      finish_reason: 'stop',
    }],
  };
}

function parseNaradaToolCall(content) {
  const text = stripAnsi(String(content ?? '')).trim();
  if (!text) return null;
  const candidates = [
    text,
    text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim(),
    extractJsonObject(text),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const call = parsed?.narada_tool_call;
      if (call && typeof call.name === 'string') {
        return {
          name: call.name,
          arguments: call.arguments && typeof call.arguments === 'object' && !Array.isArray(call.arguments)
            ? call.arguments
            : {},
        };
      }
    } catch {
      // Try next candidate.
    }
  }
  return null;
}

function isPotentialNaradaToolCallText(content) {
  const text = stripAnsi(String(content ?? '')).trimStart();
  if (!text) return false;
  if (text.startsWith('```')) return /^```(?:json)?\s*\{?/i.test(text);
  if (!text.startsWith('{')) return false;
  const compactPrefix = text.replace(/\s+/g, '').slice(0, 48);
  return '{"narada_tool_call"'.startsWith(compactPrefix)
    || compactPrefix.startsWith('{"narada_tool_call"');
}

function extractJsonObject(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : null;
}

function buildOpenAiChatRequest(messages, tools, { baseUrl = BASE_URL, model = MODEL, apiKey = API_KEY, thinking = THINKING_LEVEL } = {}) {
  const body = {
    model,
    messages: cleanOpenAiMessages(messages),
    tools: tools.length > 0 ? tools : undefined,
    tool_choice: tools.length > 0 ? 'auto' : undefined,
    temperature: INTELLIGENCE_PROVIDER === 'kimi-api' ? 1 : 0.2,
  };
  const effort = reasoningEffort(thinking);
  if (effort && INTELLIGENCE_PROVIDER === 'openai-api') body.reasoning_effort = effort;
  return {
    url: new URL('/v1/chat/completions', baseUrl),
    body,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
  };
}

function cleanOpenAiMessages(messages) {
  return messages.map((m) => {
    const clean = { role: m.role };
    if (m.role === 'tool') {
      clean.content = m.content ?? '';
      clean.tool_call_id = m.tool_call_id ?? '';
    } else if (m.role === 'assistant') {
      clean.content = m.content ?? null;
      if (m.tool_calls && m.tool_calls.length > 0) {
        clean.tool_calls = m.tool_calls;
        if (INTELLIGENCE_PROVIDER === 'kimi-api') {
          clean.reasoning_content = m.reasoning_content ?? '';
        }
      }
    } else {
      clean.content = m.content ?? '';
    }
    return clean;
  });
}

function buildAnthropicMessagesRequest(messages, tools, { baseUrl = BASE_URL, model = MODEL, apiKey = API_KEY, thinking = THINKING_LEVEL } = {}) {
  const { system, anthropicMessages } = cleanAnthropicMessages(messages);
  const body = {
    model,
    max_tokens: 4096,
    messages: anthropicMessages,
    tools: tools.length > 0 ? tools.map(toAnthropicTool) : undefined,
    temperature: 0.2,
  };
  if (system) body.system = system;
  if (thinking === 'high') body.thinking = { type: 'enabled', budget_tokens: 4096 };
  else if (thinking === 'medium') body.thinking = { type: 'enabled', budget_tokens: 2048 };
  return {
    url: new URL('/v1/messages', baseUrl),
    body,
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': apiKey,
    },
  };
}

function cleanAnthropicMessages(messages) {
  const systemParts = [];
  const anthropicMessages = [];
  for (const message of messages) {
    if (message.role === 'system') {
      systemParts.push(String(message.content ?? ''));
    } else if (message.role === 'tool') {
      anthropicMessages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: message.tool_call_id ?? '',
          content: stringifyContent(message.content),
        }],
      });
    } else if (message.role === 'assistant') {
      const content = [];
      if (message.content) content.push({ type: 'text', text: String(message.content) });
      for (const toolCall of message.tool_calls ?? []) {
        content.push({
          type: 'tool_use',
          id: toolCall.id,
          name: toolCall.function?.name ?? '',
          input: parseJson(toolCall.function?.arguments ?? '{}'),
        });
      }
      anthropicMessages.push({ role: 'assistant', content: content.length > 0 ? content : '' });
    } else {
      anthropicMessages.push({ role: 'user', content: String(message.content ?? '') });
    }
  }
  return {
    system: systemParts.filter(Boolean).join('\n\n'),
    anthropicMessages,
  };
}

function toAnthropicTool(tool) {
  const fn = tool.function ?? {};
  return {
    name: fn.name,
    description: fn.description ?? '',
    input_schema: fn.parameters ?? { type: 'object', properties: {} },
  };
}

function parseAnthropicMessagesResponse(response) {
  const content = Array.isArray(response.content) ? response.content : [];
  const text = content.filter((item) => item?.type === 'text').map((item) => item.text ?? '').join('');
  const toolCalls = content
    .filter((item) => item?.type === 'tool_use')
    .map((item) => ({
      id: item.id,
      type: 'function',
      function: {
        name: item.name,
        arguments: JSON.stringify(item.input ?? {}),
      },
    }));
  const message = { role: 'assistant', content: text || null };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return {
    id: response.id,
    object: 'chat.completion',
    choices: [{
      index: 0,
      message,
      finish_reason: toolCalls.length > 0 ? 'tool_calls' : response.stop_reason ?? null,
    }],
    usage: response.usage,
  };
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
        signal: settings.abortSignal,
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
      }
    );
    req.on('error', reject);
    settings.abortSignal?.addEventListener('abort', () => {
      req.destroy(new Error('agent_cli_interrupt_requested'));
    }, { once: true });
    req.write(serializedBody);
    req.end();
  });
}

function buildCodexExecArgs(request, { model = MODEL, thinking = THINKING_LEVEL, siteRoot = SITE_ROOT } = {}) {
  const effort = reasoningEffort(thinking);
  const common = [
    '--json',
    '--dangerously-bypass-approvals-and-sandbox',
    '-m',
    request.arguments?.model ?? model,
    '-c',
    'approval_policy="never"',
  ];
  if (effort) common.push('-c', `model_reasoning_effort="${effort}"`);
  if (request.tool === 'codex-reply') {
    return ['exec', 'resume', ...common, request.arguments.threadId, '-'];
  }
  return ['exec', ...common, '-C', request.arguments?.cwd ?? siteRoot, '-'];
}

function codexExecPrompt(request) {
  const prompt = String(request.arguments?.prompt ?? '');
  const developerInstructions = request.arguments?.['developer-instructions'];
  if (!developerInstructions) return prompt;
  return [
    '<developer-instructions>',
    String(developerInstructions),
    '</developer-instructions>',
    '',
    prompt,
  ].join('\n');
}

function sendCodexExecJsonRequest(request, settings = {}) {
  return new Promise((resolveRequest, rejectRequest) => {
    const command = codexCommand();
    const args = buildCodexExecArgs(request, settings);
    const prompt = codexExecPrompt(request);
    const child = spawn(command.command, [...command.prefixArgs, ...args], {
      cwd: request.arguments?.cwd ?? settings.siteRoot ?? SITE_ROOT,
      windowsHide: true,
      env: buildChildProcessEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end(prompt);
    let stdoutBuffer = '';
    let stderr = '';
    let threadId = request.arguments?.threadId ?? null;
    let content = '';
    let rendered = false;
    let aborted = false;
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
        if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
          threadId = event.thread_id;
        }
        const text = codexExecEventText(event);
        if (text) {
          content += text;
          if (isPotentialNaradaToolCallText(content) || parseNaradaToolCall(content)) continue;
          if (settings.emit) {
            settings.emit('assistant_message_stream', { turn_id: settings.turn?.turnId ?? null, content: text });
          } else {
            process.stdout.write('\r\x1b[K');
            rendered = printAgentMessage(text) || rendered;
          }
        }
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
        if (text) content += text;
      }
      if (code !== 0) {
        rejectRequest(new Error(`codex exec --json failed with exit ${code}${stderr.trim() ? `; ${stderr.trim().slice(0, 1000)}` : ''}`));
        return;
      }
      resolveRequest({
        threadId,
        content,
        streaming_rendered: rendered,
      });
    });
  });
}

function sendCodexExecJsonBufferedRequest(request, settings = {}) {
  return new Promise((resolveRequest, rejectRequest) => {
    const command = codexCommand();
    const args = buildCodexExecArgs(request, settings);
    const prompt = codexExecPrompt(request);
    const child = spawn(command.command, [...command.prefixArgs, ...args], {
      cwd: request.arguments?.cwd ?? settings.siteRoot ?? SITE_ROOT,
      windowsHide: true,
      env: buildChildProcessEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end(prompt);
    let stdoutBuffer = '';
    let stderr = '';
    let threadId = request.arguments?.threadId ?? null;
    let content = '';
    let aborted = false;
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

function parseCodexExecJsonLine(line) {
  try {
    return JSON.parse(stripAnsi(String(line)));
  } catch {
    return null;
  }
}

function codexExecEventText(event) {
  if (event?.type !== 'item.completed') return '';
  const item = event.item;
  if (item?.type === 'agent_message' && typeof item.text === 'string') return item.text;
  return '';
}

function stripAnsi(text) {
  return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

function codexCommand() {
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

function writeCodexExecHomeConfig(mcpServers, sessionDir = SESSION_DIR) {
  const codexHome = join(sessionDir, 'codex-home');
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, 'config.toml'), `${codexExecConfigToml(mcpServers)}\n`, 'utf8');
  return codexHome;
}

function codexExecMcpConfigArgs(mcpServers) {
  const args = [];
  for (const [name, server] of Object.entries(mcpServers)) {
    const config = server.config ?? {};
    args.push('-c', `mcp_servers."${tomlKey(name)}".command=${tomlString(config.command ?? '')}`);
    args.push('-c', `mcp_servers."${tomlKey(name)}".args=${JSON.stringify((config.args ?? []).map((arg) => String(arg).replaceAll('\\', '/')))}`);
    args.push('-c', `mcp_servers."${tomlKey(name)}".default_tools_approval_mode="approve"`);
  }
  return args;
}

function codexExecConfigToml(mcpServers) {
  const lines = [
    '# Generated by packages/agent-cli/src/agent-cli.mjs for nested codex exec --json.',
    '# Mirrors the target Site MCP fabric; does not import User Site MCP servers.',
    '',
  ];
  for (const [name, server] of Object.entries(mcpServers)) {
    const config = server.config ?? {};
    lines.push(`[mcp_servers."${tomlKey(name)}"]`);
    lines.push(`command = ${tomlString(config.command ?? '')}`);
    lines.push(`args = ${JSON.stringify((config.args ?? []).map((arg) => String(arg).replaceAll('\\', '/')))}`);
    lines.push('default_tools_approval_mode = "approve"');
    lines.push('');
  }
  return lines.join('\n');
}

function tomlString(value) {
  return JSON.stringify(String(value).replaceAll('\\', '/'));
}

function tomlKey(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function sendCodexMcpRequest(request, settings = {}) {
  return new Promise((resolve, reject) => {
    const command = codexCommand();
    const args = ['mcp-server', ...codexExecMcpConfigArgs(settings.mcpServers ?? {})];
    const child = spawn(command.command, [...command.prefixArgs, ...args], {
      cwd: SITE_ROOT,
      windowsHide: true,
      env: buildChildProcessEnv(),
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

// ---------------------------------------------------------------------------
// Terminal presentation
// ---------------------------------------------------------------------------
function createTerminalStyle({ enabled = true } = {}) {
  const color = (code, text) => enabled ? `\x1b[${code}m${text}\x1b[0m` : text;
  return {
    enabled,
    header: (text) => color('36', text),
    tool: (text) => color('35', text),
    assistant: (text) => color('37', text),
    label: (text) => color('1;36', text),
    operator: (text) => color('1;32', text),
    operatorDirective: (text) => color('1;33', text),
    systemDirective: (text) => color('1;35', text),
    muted: (text) => color('2', text),
    source: (text) => color('90', text),
    timestamp: (text) => color('2;90', text),
    key: (text) => color('33', text),
    code: (text) => color('90', text),
    success: (text) => color('32', text),
    prompt: (text) => color('1;32', text),
    progress: (text) => color('2;33', text),
    warn: (text) => color('33', text),
    error: (text) => color('31', text),
  };
}

function printHeader(text, { before = false, after = false, level = 'info' } = {}) {
  const styled = level === 'warn'
    ? terminalStyle.warn(`[agent-cli] ${text}`)
    : terminalStyle.header(`[agent-cli] ${text}`);
  console.log(`${before ? '\n' : ''}${styled}${after ? '\n' : ''}`);
}

function clearTerminalDisplay() {
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
}

function printHeaderRow(key, value, { before = false, after = false } = {}) {
  console.log(formatHeaderRow(key, value, { before, after }));
}

function printHeaderRows(rows, { before = false, after = false } = {}) {
  printMessageBlock({
    label: 'agent-cli',
    text: formatHeaderRows(rows),
    before,
    after,
    labelStyle: terminalStyle.tool,
    bodyStyle: (value) => value,
  });
}

function formatHeaderRows(rows) {
  const width = rows.reduce((max, [key]) => Math.max(max, stripAnsi(String(key)).length), 0);
  return rows.map(([key, value]) => formatHeaderRow(key, value, { width, includePrefix: false })).join('\n');
}

function formatHeaderRow(key, value, { before = false, after = false, width = 12, includePrefix = true } = {}) {
  const prefix = includePrefix ? `${terminalStyle.source('[agent-cli]')} ` : '';
  const keyText = terminalStyle.key(String(key).padEnd(width));
  const valueText = String(value) === 'on'
    ? terminalStyle.success(String(value))
    : terminalStyle.header(String(value));
  return `${before ? '\n' : ''}${prefix}${keyText} ${valueText}${after ? '\n' : ''}`;
}

function printToolRequestLine(text, { before = false } = {}) {
  printInlineEvent(toolDirectionLabel('invoke'), text, {
    before,
    timestamp: true,
    bodyStyle: terminalStyle.muted,
  });
}

function printToolResultLine(text, { before = false, level = 'info' } = {}) {
  const label = toolDirectionLabel('result');
  const bodyStyle = level === 'error' ? terminalStyle.error : level === 'warn' ? terminalStyle.warn : terminalStyle.muted;
  if (!String(text ?? '').includes('\n')) {
    printInlineEvent(label, text, { before, timestamp: true, labelStyle: level === 'error' ? terminalStyle.error : level === 'warn' ? terminalStyle.warn : (value) => value, bodyStyle });
    return;
  }
  printMessageBlock({ label, text, before, timestamp: true, labelStyle: level === 'error' ? terminalStyle.error : level === 'warn' ? terminalStyle.warn : (value) => value, bodyStyle });
}

function toolDirectionLabel(direction) {
  const arrow = terminalStyle.muted('->');
  if (direction === 'result') return `${terminalStyle.tool('agent-cli')} ${arrow} ${terminalStyle.label(IDENTITY)}`;
  return `${terminalStyle.label(IDENTITY)} ${arrow} ${terminalStyle.tool('agent-cli')}`;
}

function styleInputRouteLabel(label) {
  const manual = `operator -> ${IDENTITY}`;
  const directive = `operator directive -> ${IDENTITY}`;
  const arrow = terminalStyle.muted('->');
  if (label === manual) return `${terminalStyle.operator('operator')} ${arrow} ${terminalStyle.label(IDENTITY)}`;
  if (label === directive) return `${terminalStyle.operatorDirective('operator directive')} ${arrow} ${terminalStyle.label(IDENTITY)}`;
  return terminalStyle.prompt(label);
}

function printInlineEvent(label, text, { before = false, timestamp = false, labelStyle = (value) => value, bodyStyle = (value) => value } = {}) {
  const suffix = timestamp ? ` ${terminalStyle.timestamp(formatTimestamp())}` : '';
  console.log(`${before ? '\n' : ''}${labelStyle(label)}${terminalStyle.muted(':')} ${bodyStyle(String(text ?? ''))}${suffix}`);
}

function printAgentMessage(text) {
  const normalized = String(text ?? '').trim();
  if (!stripAnsi(normalized).trim()) return false;
  const renderedText = renderMarkdownForTerminal(normalized);
  if (!stripAnsi(renderedText).trim()) return false;
  printMessageBlock({
    label: IDENTITY,
    text: renderedText,
    before: true,
    after: false,
    timestamp: true,
    labelStyle: terminalStyle.label,
    bodyStyle: (value) => value,
  });
  return true;
}

function printCliMessage(text) {
  const normalized = String(text ?? '').trim();
  if (!normalized) return;
  printMessageBlock({
    label: 'agent-cli',
    text: renderMarkdownForTerminal(normalized),
    before: true,
    after: true,
    labelStyle: terminalStyle.tool,
    bodyStyle: (value) => value,
  });
}

function printInputRecord(record) {
  const label = inputRecordDisplayLabel(record);
  const labelStyle = record.source === 'system_directive'
    ? terminalStyle.systemDirective
    : styleInputRouteLabel;
  printMessageBlock({
    label,
    text: String(record.content ?? '').trim(),
    before: true,
    timestamp: true,
    labelStyle,
    bodyStyle: (value) => value,
  });
}

function inputRecordDisplayLabel(record) {
  if (record?.source === 'system_directive') return 'system directive';
  if (record?.source === 'operator_directive') return `operator directive -> ${IDENTITY}`;
  if (record?.source === 'operator_steering') return `operator steering -> ${IDENTITY}`;
  return `operator -> ${IDENTITY}`;
}

function printOperatorMessage(text) {
  const normalized = String(text ?? '').trim();
  if (!normalized) return;
  printMessageBlock({
    label: 'operator',
    text: normalized,
    before: true,
    timestamp: true,
    labelStyle: terminalStyle.prompt,
    bodyStyle: (value) => value,
  });
}

function rewriteSubmittedPrompt(promptLabel, input) {
  if (!process.stdout.isTTY) return;
  const rewritten = rewriteSubmittedPromptForTest(promptLabel, input, process.stdout.columns || 80);
  if (rewritten) process.stdout.write(rewritten);
}

function rewriteSubmittedPromptForTest(promptLabel, input, columns = 80, now = new Date()) {
  const text = String(input ?? '');
  if (text.includes('\n') || text.includes('\r')) return null;
  const rawPromptRows = Math.max(1, Math.ceil(stripAnsi(`${promptLabel}> ${text}`).length / Math.max(1, columns)));
  return `${clearPreviousTerminalRows(rawPromptRows)}\n${formatSubmittedPrompt(promptLabel, text, columns, now)}`;
}

function clearPreviousTerminalRows(rows) {
  if (rows <= 1) return '\x1b[1A\r\x1b[K';
  let sequence = `\x1b[${rows}A`;
  for (let index = 0; index < rows; index++) {
    sequence += '\r\x1b[2K';
    if (index < rows - 1) sequence += '\x1b[1B';
  }
  return `${sequence}\x1b[${rows - 1}A\r`;
}

function formatSubmittedPrompt(promptLabel, text, columns = 80, now = new Date()) {
  const prefix = `${promptLabel}: `;
  const firstLineWidth = Math.max(16, columns - stripAnsi(prefix).length);
  const lines = wrapTerminalLine(String(text ?? ''), firstLineWidth);
  const [first = '', ...rest] = lines;
  return [
    `${styleInputRouteLabel(promptLabel)}${terminalStyle.muted(':')} ${first}`,
    ...rest.map((line) => `  ${line}`),
    `  ${terminalStyle.timestamp(formatTimestamp(now))}`,
  ].join('\n') + '\n';
}

function printMessageBlock({ label, text, before = false, after = false, timestamp = false, labelStyle = (value) => value, bodyStyle = (value) => value }) {
  const width = terminalWidth();
  const labelLine = `${labelStyle(label)}${terminalStyle.muted(':')}`;
  const bodyWidth = Math.max(32, width - 2);
  const lines = String(text ?? '').split(/\r?\n/).flatMap((line) => wrapTerminalLine(line, bodyWidth));
  const rendered = [
    labelLine,
    ...lines.map((line) => `  ${bodyStyle(line)}`),
    ...(timestamp ? [`  ${terminalStyle.timestamp(formatTimestamp())}`] : []),
  ].join('\n');
  console.log(`${before ? '\n' : ''}${rendered}${after ? '\n' : ''}`);
}

function formatTimestamp(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}Z${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

function renderMarkdownForTerminal(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  let inFence = false;
  return lines.map((line) => {
    const fenceMatch = line.match(/^(\s*)```/);
    if (fenceMatch) {
      inFence = !inFence;
      return null;
    }
    if (inFence) return terminalStyle.code(`  ${line.replace(/^\s{0,4}/, '')}`);
    if (/^#{1,6}\s+/.test(line)) return terminalStyle.label(line.replace(/^#{1,6}\s+/, ''));
    const normalizedLine = normalizeDisplayTerms(line);
    const bulletLine = /^\s*[-*]\s+/.test(normalizedLine)
      ? normalizedLine.replace(/^(\s*)[-*]\s+/, '$1• ')
      : normalizedLine;
    return styleInlineCode(bulletLine);
  }).filter((line) => line !== null).join('\n');
}

function styleInlineCode(line) {
  return String(line ?? '').replace(/`([^`]+)`/g, (_match, code) => terminalStyle.code(code));
}

function normalizeDisplayTerms(line) {
  return transformOutsideInlineCode(String(line ?? ''), (chunk) => chunk
    .replace(/\bauthority_locus\b/g, 'authority locus')
    .replace(/\bauthority_posture\b/g, 'authority posture')
    .replace(/\bfacade_only\b/g, '`facade_only`')
    .replace(/\bnarada_proper\b/g, '`narada_proper`'));
}

function transformOutsideInlineCode(text, transform) {
  return String(text ?? '').split(/(`[^`]*`)/g)
    .map((part) => part.startsWith('`') && part.endsWith('`') ? part : transform(part))
    .join('');
}

function terminalWidth() {
  return Math.max(50, Math.min(120, process.stdout.columns || 88));
}

function wrapTerminalLine(line, width) {
  if (line.trim() === '') return [''];
  const visible = stripAnsi(line);
  if (visible.length <= width) return [line];
  const words = line.split(/(\s+)/);
  const lines = [];
  let current = '';
  for (const word of words) {
    if (!word) continue;
    if (stripAnsi(current + word).length > width && current.trim()) {
      lines.push(current.trimEnd());
      current = word.trimStart();
    } else {
      current += word;
    }
  }
  if (current.trim()) lines.push(current.trimEnd());
  return lines.length ? lines : [line];
}

function formatToolResultContent(content) {
  const text = String(content ?? '');
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const keys = Object.keys(parsed);
      const status = typeof parsed.status === 'string' ? `${parsed.status}` : null;
      const schema = typeof parsed.schema === 'string' ? parsed.schema : null;
      const count = typeof parsed.directive_count === 'number'
        ? `directives=${parsed.directive_count}`
        : typeof parsed.directiveCount === 'number'
          ? `directives=${parsed.directiveCount}`
          : null;
      const shownKeys = keys.slice(0, 8);
      const keySummary = shownKeys.length
        ? `keys: ${shownKeys.join(', ')}${keys.length > shownKeys.length ? ', ...' : ''}`
        : null;
      return [
        [status, schema, count].filter(Boolean).join(' · '),
        keySummary,
      ].filter(Boolean).join('\n');
    }
    if (Array.isArray(parsed)) return `array(${parsed.length})`;
  } catch {
    // Fall through to text summary.
  }
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

function formatKeyValueRows(record) {
  const entries = Object.entries(record);
  const width = entries.reduce((max, [key]) => Math.max(max, key.length), 0);
  return entries.map(([key, value]) => `${key.padEnd(width)}  ${value}`).join('\n');
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function formatProgressStatus({ spinner, phase, totalMs, phaseMs, operatorDirectiveDraftLength = 0, queuedOperatorDirectiveCount = 0 }) {
  const phaseText = String(phase ?? 'working');
  const phaseDuration = formatDuration(phaseMs ?? totalMs ?? 0);
  const totalDuration = formatDuration(totalMs ?? 0);
  const totalSuffix = phaseText === 'thinking' ? '' : ` · total ${totalDuration}`;
  const queuedSuffix = queuedOperatorDirectiveCount > 0 ? ` · queued operator directives ${queuedOperatorDirectiveCount}` : '';
  const draftSuffix = operatorDirectiveDraftLength > 0 ? ` · typing operator directive (${operatorDirectiveDraftLength})` : '';
  return `${spinner} ${phaseText} ${phaseDuration}${totalSuffix}${queuedSuffix}${draftSuffix} · Enter queues note · Esc to interrupt`;
}

function parseColorEnv(value, defaultValue) {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  return parseBooleanEnv(value, defaultValue);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function question(rl, prompt) {
  return new Promise((resolve) => {
    if (rl.closed) {
      resolve('__READLINE_CLOSED__');
      return;
    }
    const onClose = () => resolve('__READLINE_CLOSED__');
    rl.once('close', onClose);
    try {
      rl.question(prompt, (answer) => {
        rl.removeListener('close', onClose);
        resolve(answer);
      });
    } catch {
      rl.removeListener('close', onClose);
      resolve('__READLINE_CLOSED__');
    }
  });
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--identity' && i + 1 < argv.length) {
      opts.identity = argv[i + 1];
      i++;
    } else if (argv[i] === '--session' && i + 1 < argv.length) {
      opts.session = argv[i + 1];
      i++;
    } else if (argv[i] === '--message' && i + 1 < argv.length) {
      opts.messages = [...(opts.messages ?? []), argv[i + 1]];
      i++;
    } else if (argv[i] === '--message-file' && i + 1 < argv.length) {
      opts.messageFiles = [...(opts.messageFiles ?? []), argv[i + 1]];
      i++;
    } else if (argv[i] === '--authority-ref' && i + 1 < argv.length) {
      opts.authorityRef = argv[i + 1];
      i++;
    } else if (argv[i] === '--operator-directive') {
      opts.operatorDirective = true;
    } else if (argv[i] === '--system-directive') {
      opts.systemDirective = true;
    } else if (argv[i] === '--enable-startup-system-directive') {
      opts.startupSystemDirective = true;
    } else if (argv[i] === '--startup-system-directive' && i + 1 < argv.length) {
      opts.startupSystemDirective = true;
      opts.startupSystemDirectiveText = argv[i + 1];
      i++;
    } else if (argv[i] === '--startup-system-directive-delay-ms' && i + 1 < argv.length) {
      opts.startupSystemDirectiveDelayMs = Number(argv[i + 1]);
      i++;
    } else if (argv[i] === '--no-startup-system-directive') {
      opts.startupSystemDirective = false;
    } else if (argv[i] === '--interactive-after-message') {
      opts.interactiveAfterMessage = true;
    } else if (argv[i] === '--auto-approve') {
      opts.autoApprove = true;
    } else if (argv[i] === '--server') {
      opts.server = true;
    } else if (argv[i] === '--stream') {
      opts.stream = true;
    } else if (argv[i] === '--no-stream') {
      opts.stream = false;
    } else if (argv[i] === '--color') {
      opts.color = true;
    } else if (argv[i] === '--no-color') {
      opts.color = false;
    } else if (argv[i] === '--control-jsonl' && i + 1 < argv.length) {
      opts.controlJsonl = argv[i + 1];
      i++;
    } else if (argv[i] === '--model' && i + 1 < argv.length) {
      opts.model = argv[i + 1];
      i++;
    } else if (argv[i] === '--thinking' && i + 1 < argv.length) {
      opts.thinking = argv[i + 1];
      i++;
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      opts.help = true;
    }
  }
  return opts;
}

function parseBooleanEnv(value, defaultValue) {
  if (value === undefined || value === null || String(value).trim() === '') return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

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
  PROVIDER_SUPPORT_STATES,
  REQUEST_ADAPTERS,
  assertApiKeyConfigured,
  buildProgrammaticInputs,
  buildAnthropicMessagesRequest,
  buildCodexExecArgs,
  codexExecMcpConfigArgs,
  codexExecConfigToml,
  buildCodexMcpRequest,
  buildOpenAiChatRequest,
  buildChildProcessEnv,
  clearTerminalDisplay,
  cleanAnthropicMessages,
  cleanOpenAiMessages,
  codexExecEventText,
  discoverAndStartMcpServers,
  environmentBlockLength,
  executeMcpTool,
  handleInteractiveControlLine,
  handleSlashCommand,
  runCodexTranscriptStats,
  createInputQueue,
  normalizeInputEvent,
  normalizeProviderSupportState,
  normalizeThinkingLevel,
  normalizeInputRecord,
  shouldDeferInteractiveInput,
  startInteractiveControlJsonlWatcher,
  parseArgs,
  parseBooleanEnv,
  parseColorEnv,
  removeInvalidToolHistory,
  shouldSuppressMcpStderr,
  parseAnthropicMessagesResponse,
  parseCodexExecJsonLine,
  parseCodexMcpResponse,
  parseNaradaToolCall,
  isPotentialNaradaToolCallText,
  createTerminalStyle,
  formatDuration,
  formatHeaderRow,
  formatHeaderRows,
  formatKeyValueRows,
  formatProgressStatus,
  formatTimestamp,
  formatToolResultContent,
  normalizeDisplayTerms,
  printAgentMessage,
  printCliMessage,
  printInputRecord,
  printOperatorMessage,
  printInlineEvent,
  rewriteSubmittedPromptForTest,
  toolDirectionLabel,
  inputRecordDisplayLabel,
  rewriteSubmittedPrompt,
  renderMarkdownForTerminal,
  wrapTerminalLine,
  runConversationTurn,
  runServerMode,
  resolveProviderAdapter,
  resolveProviderSupportState,
  directiveAcceptedEvidence,
  directiveReceiptEvidence,
  sessionEventEntry,
  sessionLogEntry,
  styleInputRouteLabel,
};

if (isEntrypoint) {
  if (options.help) {
    console.log(`Usage: narada-agent-cli --identity <name> [--session <name>] [--server] [--stream|--no-stream] [--color|--no-color] [--control-jsonl <path>] [--message <text>] [--message-file <path>] [--operator-directive|--system-directive] [--enable-startup-system-directive|--startup-system-directive <text>|--no-startup-system-directive] [--interactive-after-message] [--auto-approve]`);
    console.log('Programmatic input: --message and --message-file are explicit control inputs; do not use raw stdin piping as the control API.');
    console.log(`Environment: NARADA_INTELLIGENCE_PROVIDER, ANTHROPIC_API_KEY, NARADA_AI_API_KEY, NARADA_AI_BASE_URL, NARADA_AI_MODEL, NARADA_AGENT_CLI_STREAM, NARADA_AGENT_CLI_COLOR, NARADA_AGENT_CLI_STARTUP_SYSTEM_DIRECTIVE_ENABLE, NARADA_AGENT_CLI_STARTUP_SYSTEM_DIRECTIVE, NARADA_AGENT_CLI_STARTUP_SYSTEM_DIRECTIVE_DELAY_MS, NARADA_SITE_ROOT`);
    process.exit(0);
  }

  main().catch((err) => {
    activeHeartbeat?.stop();
    console.error(`[agent-cli] Fatal error: ${err.message}`);
    process.exit(1);
  });
}
