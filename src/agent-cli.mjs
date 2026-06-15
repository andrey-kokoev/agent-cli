#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createInterface, emitKeypressEvents } from 'node:readline';
import { StringDecoder } from 'node:string_decoder';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
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
  observerMetadata as protocolObserverMetadata,
  observerPayload as protocolObserverPayload,
  observerVisibility as protocolObserverVisibility,
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
const CODEX_NATIVE_MCP_TOOLS = parseBooleanEnv(process.env.NARADA_CODEX_NATIVE_MCP_TOOLS, true);
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
const MCP_PREFLIGHT_MODE = options.mcpPreflight === true;
const MCP_PREFLIGHT_JSON_MODE = options.mcpPreflightJson === true;
const SESSION_INVENTORY_MODE = options.sessionInventory === true;
const SESSION_INVENTORY_JSON_MODE = options.sessionInventoryJson === true;
const SERVER_MODE = options.server === true;
const sessionSettings = {
  model: options.model ?? MODEL,
  thinking: normalizeThinkingLevel(options.thinking ?? THINKING_LEVEL),
  stream: options.stream ?? parseBooleanEnv(process.env.NARADA_AGENT_CLI_STREAM, !SERVER_MODE),
  goal: createCarrierGoalState(process.env.NARADA_AGENT_CLI_GOAL ?? process.env.NARADA_CARRIER_GOAL ?? process.env.NARADA_GOAL ?? ''),
};
const transcriptDisplaySettings = {
  toolOutputs: parseBooleanEnv(process.env.NARADA_AGENT_CLI_TOOL_OUTPUTS, true),
  observerMuted: parseBooleanEnv(process.env.NARADA_AGENT_CLI_OBSERVER_MUTED, false),
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
  'KIMI_CODE_API_KEY',
  'NARADA_KIMI_CODE_API_BASE_URL',
  'NARADA_KIMI_CODE_MODEL',
]);
const MCP_STARTUP_FAILURES_KEY = '__mcp_startup_failures';
const MCP_RUNTIME_DIAGNOSTICS_KEY = '__mcp_runtime_diagnostics';

function buildChildProcessEnv(extra = {}, baseEnv = process.env) {
  const env = {};
  for (const key of CHILD_PROCESS_ENV_ALLOWLIST) {
    if (baseEnv[key] !== undefined) env[key] = baseEnv[key];
  }
  return { ...env, ...extra, FORCE_COLOR: '0', NO_COLOR: '1' };
}

function attachMcpStartupFailures(mcpServers, failures = []) {
  Object.defineProperty(mcpServers, MCP_STARTUP_FAILURES_KEY, {
    value: Array.isArray(failures) ? failures.slice() : [],
    enumerable: false,
    configurable: true,
  });
  if (!Object.prototype.hasOwnProperty.call(mcpServers, MCP_RUNTIME_DIAGNOSTICS_KEY)) {
    Object.defineProperty(mcpServers, MCP_RUNTIME_DIAGNOSTICS_KEY, {
      value: [],
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  return mcpServers;
}

function getMcpStartupFailures(mcpServers) {
  const failures = mcpServers?.[MCP_STARTUP_FAILURES_KEY];
  return Array.isArray(failures) ? failures : [];
}

function formatMcpStartupFailureSummary(failures) {
  const normalized = Array.isArray(failures) ? failures : [];
  if (normalized.length === 0) return '0';
  const details = normalized
    .slice(0, 3)
    .map((failure) => `${failure.server_name ?? 'unknown'}:${failure.code ?? 'error'}`)
    .join(', ');
  return normalized.length > 3 ? `${normalized.length} (${details}, ...)` : `${normalized.length} (${details})`;
}

function getMcpRuntimeDiagnostics(mcpServers) {
  const diagnostics = mcpServers?.[MCP_RUNTIME_DIAGNOSTICS_KEY];
  return Array.isArray(diagnostics) ? diagnostics : [];
}

function rememberMcpRuntimeDiagnostic(mcpServers, diagnostic) {
  if (!mcpServers) return [];
  if (!Object.prototype.hasOwnProperty.call(mcpServers, MCP_RUNTIME_DIAGNOSTICS_KEY)) {
    Object.defineProperty(mcpServers, MCP_RUNTIME_DIAGNOSTICS_KEY, {
      value: [],
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  const diagnostics = mcpServers[MCP_RUNTIME_DIAGNOSTICS_KEY];
  diagnostics.push(diagnostic);
  if (diagnostics.length > 10) diagnostics.splice(0, diagnostics.length - 10);
  return diagnostics;
}

function formatMcpRuntimeDiagnosticSummary(diagnostics) {
  const normalized = Array.isArray(diagnostics) ? diagnostics : [];
  if (normalized.length === 0) return '0';
  const details = normalized
    .slice(-3)
    .map((diagnostic) => `${diagnostic.server_name ?? 'unknown'}:${diagnostic.tool_name ?? '<missing>'}`)
    .join(', ');
  return normalized.length > 3 ? `${normalized.length} (${details}, ...)` : `${normalized.length} (${details})`;
}

function mcpOperationalState(mcpServers) {
  const startupFailures = getMcpStartupFailures(mcpServers);
  const runtimeDiagnostics = getMcpRuntimeDiagnostics(mcpServers);
  if (startupFailures.length === 0 && runtimeDiagnostics.length === 0) return 'healthy';
  if (runtimeDiagnostics.length > 0) return 'runtime_faulted';
  return 'startup_degraded';
}

function createMcpStatusSnapshot(mcpServers) {
  const startupFailures = getMcpStartupFailures(mcpServers);
  const runtimeDiagnostics = getMcpRuntimeDiagnostics(mcpServers);
  return {
    mcp_operational_state: mcpOperationalState(mcpServers),
    mcp_startup_failure_count: startupFailures.length,
    mcp_startup_failures: startupFailures,
    mcp_startup_failure_summary: formatMcpStartupFailureSummary(startupFailures),
    mcp_runtime_fault_count: runtimeDiagnostics.length,
    mcp_runtime_faults: runtimeDiagnostics,
    mcp_runtime_fault_summary: formatMcpRuntimeDiagnosticSummary(runtimeDiagnostics),
  };
}

function noteSessionActivity(state, eventKind, occurredAt = new Date().toISOString(), terminalState = null) {
  if (!state) return;
  state.sessionEventCount = (state.sessionEventCount ?? 0) + 1;
  state.lastEventKind = eventKind;
  state.lastEventAt = occurredAt;
  if (terminalState) state.lastTerminalState = terminalState;
}

function createSessionActivitySnapshot(state = {}) {
  return {
    agent_id: IDENTITY,
    runtime: 'agent-cli',
    mode: SERVER_MODE ? 'server' : 'interactive',
    started_at: state.startedAt ?? null,
    session_event_count: state.sessionEventCount ?? 0,
    last_event_kind: state.lastEventKind ?? null,
    last_event_at: state.lastEventAt ?? null,
    last_terminal_state: state.lastTerminalState ?? null,
  };
}

function createMcpPreflightArtifactSnapshot(preflightArtifact) {
  if (!preflightArtifact) {
    return {
      mcp_preflight_artifact_path: null,
      mcp_preflight_artifact_generated_at: null,
      mcp_preflight_operational_state: null,
      mcp_preflight_startup_failure_summary: null,
      mcp_preflight_runtime_fault_summary: null,
    };
  }
  return {
    mcp_preflight_artifact_path: preflightArtifact.artifact_path,
    mcp_preflight_artifact_generated_at: preflightArtifact.generated_at,
    mcp_preflight_operational_state: preflightArtifact.mcp_operational_state,
    mcp_preflight_startup_failure_summary: preflightArtifact.mcp_startup_failure_summary,
    mcp_preflight_runtime_fault_summary: preflightArtifact.mcp_runtime_fault_summary,
  };
}

function createInteractiveHeaderRows({
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
const NARADA_DIR = basename(SITE_ROOT) === '.narada' ? SITE_ROOT : join(SITE_ROOT, '.narada');
const SESSION_DIR = SERVER_MODE
  ? join(NARADA_DIR, 'crew', 'nars-sessions', SESSION)
  : (existsSync(PC_RUNTIME) ? join(PC_RUNTIME, 'agent-sessions') : resolve(SITE_ROOT, '.ai', 'runtime', 'agent-sessions'));
if (!MCP_PREFLIGHT_MODE && !MCP_PREFLIGHT_JSON_MODE && !SESSION_INVENTORY_MODE && !SESSION_INVENTORY_JSON_MODE && !existsSync(SESSION_DIR)) mkdirSync(SESSION_DIR, { recursive: true });
const SESSION_PATH = SERVER_MODE ? join(SESSION_DIR, 'session.jsonl') : join(SESSION_DIR, `${SESSION}.jsonl`);
const EVENTS_PATH = join(SESSION_DIR, 'events.jsonl');
const CARRIER_SESSION_DIR = join(NARADA_DIR, 'crew', 'nars-sessions', SESSION);
if (!MCP_PREFLIGHT_MODE && !MCP_PREFLIGHT_JSON_MODE && !SESSION_INVENTORY_MODE && !SESSION_INVENTORY_JSON_MODE && !existsSync(CARRIER_SESSION_DIR)) mkdirSync(CARRIER_SESSION_DIR, { recursive: true });
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
  if (SESSION_INVENTORY_MODE) {
    process.exitCode = await runSessionInventory();
    return;
  }
  if (SESSION_INVENTORY_JSON_MODE) {
    process.exitCode = await runSessionInventory({ jsonOutput: true });
    return;
  }
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
  const mcpPreflightArtifact = readMcpPreflightArtifact();

  recordMcpStartupFailures(mcpServers);
  const allTools = aggregateTools(mcpServers);
  const rolePrompt = loadRolePrompt(IDENTITY, SITE_ROOT);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let controlWatcher = null;
  const promptState = { active: false };

  printHeaderRows(createInteractiveHeaderRows({
    mcpServers,
    allTools,
    sessionSettings,
    transcriptDisplaySettings,
  }), { before: true, after: true });

  let messages = loadSession(SESSION_PATH);
  if (messages.length === 0 && rolePrompt) {
    messages.push({ role: 'system', content: rolePrompt });
  }
  recordMcpPreflightArtifactLinkage({ preflightArtifact: mcpPreflightArtifact });

  if (process.stdin.isTTY) {
    emitKeypressEvents(process.stdin, rl);
    process.stdin.on('keypress', (str, key) => {
      if (!key) return;
      if (key.ctrl && key.name === 'o') {
        const lastAssistant = messages.slice().reverse().find((m) => m.role === 'assistant');
        if (lastAssistant) {
          const content = typeof lastAssistant.content === 'string'
            ? lastAssistant.content
            : JSON.stringify(lastAssistant.content);
          if (copyToClipboard(content)) {
            printCliMessage('Copied last assistant message to clipboard.');
          } else {
            printCliMessage('Failed to copy to clipboard.');
          }
        } else {
          printCliMessage('No assistant message to copy.');
        }
      }
    });
    process.stdout.write('\x1b[?2004h');
  }

  const inputQueue = createInputQueue({
    drain: (event) => submitUserInput({
      input: event,
      messages,
      tools: allTools,
      mcpServers,
      rl,
      inputQueue,
      displaySettings: transcriptDisplaySettings,
    }),
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
    try {
      const promptLabel = `operator -> ${IDENTITY}`;
      promptState.active = true;
      const userInput = await question(rl, `${styleInputRouteLabel(promptLabel)}${terminalStyle.muted('>')} `);
      promptState.active = false;
      if (userInput === '__READLINE_CLOSED__') break;
      rewriteSubmittedPrompt(promptLabel, userInput);
      const slashCommand = await handleSlashCommand(userInput, { mcpServers, allTools, inputQueue, executeGoalOnSet: true });
      if (slashCommand === 'exit') break;
      if (slashCommand && typeof slashCommand === 'object' && slashCommand.action === 'dispatch_goal') {
        await inputQueue.enqueue(normalizeInputEvent(
          { content: slashCommand.content, source: 'manual_operator' },
          { transport: 'terminal' },
        ), { drain: true });
        continue;
      }
      if (slashCommand === 'handled') {
        await inputQueue.drainUntilIdle();
        continue;
      }
      const hostCommand = classifyCarrierHostCommandInput(userInput);
      if (hostCommand.is_host_command) {
        await executeCarrierHostCommand(hostCommand);
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      printCliMessage(`Turn failed: ${message}`);
      appendSession(SESSION_PATH, carrierSessionEventEntry('interactive_loop_error', {
        error_message: message,
        error_stack: error instanceof Error ? error.stack : null,
      }));
    }
  }

  if (process.stdin.isTTY) {
    process.stdout.write('\x1b[?2004l');
  }
  rl.close();
  inputQueue.finalizeSession();
  controlWatcher?.stop();
  for (const server of Object.values(mcpServers)) {
    if (server.process) server.process.kill();
  }
  printHeader('Session saved. Goodbye.', { before: true });
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
    if (jsonOutput) {
      console.log(`${JSON.stringify({
        schema: 'narada.agent_cli.mcp_preflight.v1',
        identity: IDENTITY,
        session: SESSION,
        site_root: SITE_ROOT,
        mcp_server_count: Object.keys(mcpServers).length,
        tool_count: allTools.length,
        artifact_path: artifactPath,
        ...mcpStatus,
      }, null, 2)}\n`);
    } else {
      console.log(formatKeyValueRows({
        Identity: IDENTITY,
        Session: SESSION,
        SiteRoot: SITE_ROOT,
        'MCP servers': Object.keys(mcpServers).length,
        'MCP state': mcpStatus.mcp_operational_state,
        ...(mcpStatus.mcp_startup_failure_count > 0 ? { 'MCP startup failures': mcpStatus.mcp_startup_failure_summary } : {}),
        ...(mcpStatus.mcp_runtime_fault_count > 0 ? { 'MCP runtime faults': mcpStatus.mcp_runtime_fault_summary } : {}),
        Tools: allTools.length,
        Artifact: artifactPath,
      }));
    }
    return mcpStatus.mcp_operational_state === 'healthy' ? 0 : 2;
  } finally {
    closeMcpServers(mcpServers);
  }
}

async function runSessionInventory({ siteRoot = SITE_ROOT, naradaDir = NARADA_DIR, jsonOutput = false } = {}) {
  const inventory = readSessionInventory({ siteRoot, naradaDir });
  const inventoryRollup = summarizeSessionInventoryRollup(inventory);
  if (jsonOutput) {
    console.log(`${JSON.stringify({
      schema: 'narada.agent_cli.session_inventory.v1',
      site_root: siteRoot,
      carrier_session_count: inventory.length,
      summary: inventoryRollup,
      sessions: inventory,
    }, null, 2)}\n`);
    return 0;
  }
  const summary = {
    SiteRoot: siteRoot,
    'Carrier sessions': inventory.length,
    'Heartbeat states': inventoryRollup.heartbeat_status_summary,
    'MCP states': inventoryRollup.mcp_operational_state_summary,
    'Terminal states': inventoryRollup.last_terminal_state_summary,
    'Lifecycle states': inventoryRollup.last_lifecycle_state_summary,
  };
  if (inventory.length === 0) {
    summary.Status = 'no persisted carrier sessions';
    console.log(formatKeyValueRows(summary));
    return 0;
  }
  const blocks = [formatKeyValueRows(summary)];
  for (const item of inventory) {
    blocks.push(formatKeyValueRows({
      Session: item.session,
      Heartbeat: item.heartbeat_display,
      'MCP state': item.mcp_operational_state,
      'MCP startup failures': item.mcp_startup_failure_summary,
      'MCP runtime faults': item.mcp_runtime_fault_summary,
      'Preflight artifact': item.mcp_preflight_artifact_path ?? 'none',
      'Session path': item.session_path,
    }));
  }
  console.log(blocks.join('\n\n'));
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
    return {
      artifact_path: artifactPath,
      generated_at: artifact.generated_at ?? null,
      mcp_operational_state: artifact.mcp_operational_state ?? null,
      mcp_startup_failure_summary: artifact.mcp_startup_failure_summary ?? null,
      mcp_runtime_fault_summary: artifact.mcp_runtime_fault_summary ?? null,
      session: artifact.session,
      identity: artifact.identity,
      site_root: artifact.site_root,
    };
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
  };
  appendSession(sessionPath, sessionEventEntry('mcp_preflight_artifact_linked', payload));
  emit?.('mcp_preflight_artifact_linked', payload);
  return payload;
}

function readSessionInventory({ siteRoot = SITE_ROOT, naradaDir = NARADA_DIR } = {}) {
  const sessionsRoot = join(naradaDir, 'crew', 'nars-sessions');
  return readDirFiles(sessionsRoot)
    .map((session) => {
      const sessionDir = join(sessionsRoot, session);
      try {
        if (!statSync(sessionDir).isDirectory()) return null;
      } catch {
        return null;
      }
      return summarizePersistedSession({ session, sessionDir, siteRoot, naradaDir });
    })
    .filter(Boolean)
    .sort((left, right) => String(right?.heartbeat_at ?? '').localeCompare(String(left?.heartbeat_at ?? '')) || left.session.localeCompare(right.session));
}

function summarizeSessionInventoryRollup(inventory = []) {
  const heartbeatCounts = {};
  const mcpStateCounts = {};
  const terminalStateCounts = {};
  const lifecycleStateCounts = {};
  for (const item of inventory) {
    incrementInventoryCounter(heartbeatCounts, item?.heartbeat_status ?? 'unknown');
    incrementInventoryCounter(mcpStateCounts, item?.mcp_operational_state ?? 'unknown');
    incrementInventoryCounter(terminalStateCounts, item?.last_terminal_state ?? 'unknown');
    incrementInventoryCounter(lifecycleStateCounts, item?.last_lifecycle_state ?? 'unknown');
  }
  return {
    heartbeat_status_counts: heartbeatCounts,
    heartbeat_status_summary: formatInventoryCounts(heartbeatCounts),
    mcp_operational_state_counts: mcpStateCounts,
    mcp_operational_state_summary: formatInventoryCounts(mcpStateCounts),
    last_terminal_state_counts: terminalStateCounts,
    last_terminal_state_summary: formatInventoryCounts(terminalStateCounts),
    last_lifecycle_state_counts: lifecycleStateCounts,
    last_lifecycle_state_summary: formatInventoryCounts(lifecycleStateCounts),
  };
}

function incrementInventoryCounter(counts, key) {
  counts[key] = (counts[key] ?? 0) + 1;
}

function formatInventoryCounts(counts) {
  const entries = Object.entries(counts);
  if (entries.length === 0) return '0';
  return entries
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([key, count]) => `${count} (${key})`)
    .join(', ');
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

function summarizePersistedSession({ session, sessionDir, siteRoot = SITE_ROOT, naradaDir = NARADA_DIR } = {}) {
  const heartbeat = readJsonFile(join(sessionDir, 'heartbeat.json'));
  const entries = readJsonlFile(join(sessionDir, 'session.jsonl'));
  const startupFailures = [];
  const runtimeDiagnostics = [];
  let linkedPreflight = null;
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
      lastLifecycleEventKind = lifecycleEventKind ?? lastLifecycleEventKind;
      lastLifecycleAt = lifecycleOccurredAt ?? lastLifecycleAt;
      lastLifecycleState = lifecycleState;
    }
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
  let mcpOperationalState = 'unknown';
  if (runtimeDiagnostics.length > 0) mcpOperationalState = 'runtime_faulted';
  else if (startupFailures.length > 0) mcpOperationalState = 'startup_degraded';
  else if (linkedPreflight?.mcp_operational_state) mcpOperationalState = linkedPreflight.mcp_operational_state;
  else if (preflightArtifact?.mcp_operational_state) mcpOperationalState = preflightArtifact.mcp_operational_state;
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
    last_event_kind: lastEventKind,
    last_event_at: lastEventAt,
    last_terminal_state: lastTerminalState,
    last_lifecycle_event_kind: lastLifecycleEventKind,
    last_lifecycle_at: lastLifecycleAt,
    last_lifecycle_state: lastLifecycleState,
    mcp_operational_state: mcpOperationalState,
    mcp_startup_failure_summary: startupFailures.length > 0
      ? formatMcpStartupFailureSummary(startupFailures)
      : (linkedPreflight?.mcp_startup_failure_summary ?? preflightArtifact?.mcp_startup_failure_summary ?? '0'),
    mcp_runtime_fault_summary: runtimeDiagnostics.length > 0
      ? formatMcpRuntimeDiagnosticSummary(runtimeDiagnostics)
      : (linkedPreflight?.mcp_runtime_fault_summary ?? preflightArtifact?.mcp_runtime_fault_summary ?? '0'),
    mcp_preflight_artifact_path: linkedPreflight?.artifact_path ?? preflightArtifact?.artifact_path ?? null,
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
    return readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
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
  return classifyInputRuntimeHold(event, {
    composerHasDraft: Boolean(promptState?.active && readlineHasNonWhitespaceInput(rl)),
  }).should_defer;
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
  const rawInput = String(input ?? '');
  const trimmedStart = rawInput.trimStart();
  const isHostCommand = trimmedStart.startsWith('!');
  const commandText = isHostCommand ? trimmedStart.slice(1).trim() : '';
  const base = {
    is_host_command: isHostCommand,
    command_text: commandText,
    admission_action: 'none',
    admission_reason: null,
    execution_surface: 'carrier_host_shell',
    creates_provider_turn: false,
  };
  if (!isHostCommand) return base;
  if (!commandText) {
    return {
      ...base,
      admission_action: 'reject',
      admission_reason: 'empty_host_command',
    };
  }
  if (enabled !== true) {
    return {
      ...base,
      admission_action: 'reject',
      admission_reason: 'host_commands_disabled',
    };
  }
  if (approvalMode === 'prompt_for_approval') {
    return {
      ...base,
      admission_action: 'prompt_for_approval',
      admission_reason: 'approval_required',
    };
  }
  return {
    ...base,
    admission_action: 'execute',
    admission_reason: 'host_command_enabled',
  };
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
  if (!admission?.is_host_command) return { handled: false };
  const commandText = String(admission.command_text ?? '').trim();
  const requestedPayload = {
    command_id: commandId,
    command_text: commandText,
    command_summary: summarizeHostCommandText(commandText),
    redaction_applied: false,
    working_directory: cwd,
    execution_surface: admission.execution_surface ?? 'carrier_host_shell',
  };
  appendSessionFn(carrierSessionEventEntry('carrier_host_command_requested', requestedPayload));
  if (admission.admission_action !== 'execute') {
    const terminalState = admission.admission_action === 'prompt_for_approval' ? 'rejected' : 'rejected';
    const result = {
      handled: true,
      command_id: commandId,
      terminal_state: terminalState,
      admission_action: admission.admission_action,
      admission_reason: admission.admission_reason,
      exit_code: null,
      stdout: '',
      stderr: '',
      output_truncated: false,
      creates_provider_turn: false,
    };
    appendSessionFn(carrierSessionEventEntry('carrier_host_command_rejected', {
      ...requestedPayload,
      admission_action: admission.admission_action,
      admission_reason: admission.admission_reason,
      terminal_state: terminalState,
    }));
    if (printResult) printHostCommandResult({ ...result, command_text: commandText });
    return result;
  }

  appendSessionFn(carrierSessionEventEntry('carrier_host_command_admitted', {
    ...requestedPayload,
    admission_action: admission.admission_action,
    admission_reason: admission.admission_reason,
  }));
  const startedAt = now();
  appendSessionFn(carrierSessionEventEntry('carrier_host_command_started', {
    command_id: commandId,
    started_at: startedAt.toISOString(),
  }));

  const shell = shellCommandForHost(commandText);
  return await new Promise((resolveResult) => {
    let stdout = '';
    let stderr = '';
    let outputTruncated = false;
    let settled = false;
    const capture = (current, chunk) => {
      const next = current + String(chunk ?? '');
      if (next.length <= HOST_COMMAND_OUTPUT_CAPTURE_LIMIT) return next;
      outputTruncated = true;
      return next.slice(0, HOST_COMMAND_OUTPUT_CAPTURE_LIMIT);
    };
    const finish = ({ eventKind, exitCode = null, error = null }) => {
      if (settled) return;
      settled = true;
      const completedAt = now();
      const terminalState = error ? 'failed' : exitCode === 0 ? 'completed' : 'failed';
      const outputEvidence = hostCommandOutputEvidence({
        commandId,
        stdout,
        stderr,
        outputTruncated,
        outputDir,
      });
      const payload = {
        command_id: commandId,
        command_text: commandText,
        command_summary: summarizeHostCommandText(commandText),
        redaction_applied: false,
        working_directory: cwd,
        exit_code: exitCode,
        terminal_state: terminalState,
        duration_ms: Math.max(0, completedAt.getTime() - startedAt.getTime()),
        output_truncated: outputTruncated,
        ...outputEvidence,
        ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
      };
      appendSessionFn(carrierSessionEventEntry(eventKind, payload));
      const result = {
        handled: true,
        command_id: commandId,
        command_text: commandText,
        terminal_state: terminalState,
        exit_code: exitCode,
        stdout,
        stderr,
        output_truncated: outputTruncated,
        output_ref: outputEvidence.output_ref ?? null,
        output_path: outputEvidence.output_path ?? null,
        creates_provider_turn: false,
      };
      if (printResult) printHostCommandResult(result);
      resolveResult(result);
    };

    let child;
    try {
      child = spawnFn(shell.command, shell.args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      finish({ eventKind: 'carrier_host_command_failed', error });
      return;
    }
    child.stdout?.on('data', (chunk) => { stdout = capture(stdout, chunk); });
    child.stderr?.on('data', (chunk) => { stderr = capture(stderr, chunk); });
    child.once('error', (error) => finish({ eventKind: 'carrier_host_command_failed', error }));
    child.once('close', (code) => {
      setImmediate(() => finish({
        eventKind: code === 0 ? 'carrier_host_command_completed' : 'carrier_host_command_failed',
        exitCode: typeof code === 'number' ? code : null,
      }));
    });
  });
}

function shellCommandForHost(commandText) {
  if (process.platform === 'win32') {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', commandText],
    };
  }
  return {
    command: process.env.SHELL || '/bin/sh',
    args: ['-lc', commandText],
  };
}

function summarizeHostCommandText(commandText) {
  const text = String(commandText ?? '').replace(/\s+/g, ' ').trim();
  return text.length > 240 ? `${text.slice(0, 239)}…` : text;
}

function hostCommandOutputEvidence({ commandId, stdout, stderr, outputTruncated, outputDir }) {
  const output = { stdout, stderr };
  const inline = JSON.stringify(output).length <= HOST_COMMAND_OUTPUT_INLINE_LIMIT && !outputTruncated;
  if (inline) {
    return {
      stdout,
      stderr,
    };
  }
  mkdirSync(outputDir, { recursive: true });
  const outputPath = join(outputDir, `${commandId}.json`);
  writeFileSync(outputPath, `${JSON.stringify({
    schema: 'narada.carrier.host_command_output.v1',
    command_id: commandId,
    output_truncated: outputTruncated,
    stdout,
    stderr,
  }, null, 2)}\n`, 'utf8');
  return {
    output_ref: createPayloadRef({
      payload_ref: `mcp_payload:carrier_host_command_output:${commandId}@v1`,
      reader_tool: 'carrier_host_command_output_read',
      summary: `carrier host command output stored at ${outputPath}`,
    }),
    output_path: outputPath,
  };
}

function readCarrierHostCommandOutputRef(payloadRef, { outputDir = join(CARRIER_SESSION_DIR, 'host-command-output') } = {}) {
  const ref = typeof payloadRef === 'string' ? payloadRef : payloadRef?.payload_ref;
  const match = /^mcp_payload:carrier_host_command_output:([A-Za-z0-9_.:-]+)@v\d+$/.exec(String(ref ?? ''));
  if (!match) throw new Error(`invalid_carrier_host_command_output_ref:${String(ref ?? '')}`);
  const outputPath = join(outputDir, `${match[1]}.json`);
  return JSON.parse(readFileSync(outputPath, 'utf8'));
}

async function handleSlashCommand(input, {
  mcpServers,
  allTools,
  inputQueue = null,
  statsRunner = runCodexTranscriptStats,
  displaySettings = transcriptDisplaySettings,
  carrierSessionSettings = sessionSettings,
  executeGoalOnSet = false,
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
      '/goal [text|pause|resume|clear] Show, set, pause, resume, or clear carrier goal',
      '/stats [args]         Show local Codex transcript statistics',
      '/model <name>         Set model for later turns',
      '/thinking <level>     none, low, medium, high',
      '/tool-output [state]  Toggle displayed tool call outputs (on, off, toggle)',
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
      Tools: allTools.length,
      'Tool outputs': displaySettings.toolOutputs ? 'shown' : 'hidden',
      Observers: displaySettings.observerMuted === true ? 'muted' : 'shown',
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
    ...(legacySource === 'observer' && !input?.metadata?.observer ? { observer: defaultObserverMetadata(input) } : {}),
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
  if (source === 'observer') return 'control_jsonl';
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
  if (source === 'observer') return 'agent';
  return 'operator';
}

function sourceIdForLegacyInputSource(source) {
  if (source === 'system_directive') return 'agent-cli.system_directive';
  if (source === 'observer') return 'narada.observer';
  return 'operator';
}

function deliveryModeForLegacyInputSource(source) {
  if (source === 'operator_steering' || source === 'observer') return 'admit_after_active_turn';
  return 'admit_for_current_turn';
}

function defaultObserverMetadata(input = {}) {
  return {
    role: 'observer',
    rule_id: input?.rule_id ?? 'manual-observer-interjection',
    visibility: input?.visibility ?? 'operator_visible',
    ...(input?.confidence ? { confidence: input.confidence } : {}),
  };
}

function isObserverInputEvent(input, record = null) {
  return Boolean(isProtocolObserverInputEvent(input) || input?.source === 'observer' || record?.source === 'observer');
}

function observerMetadata(input = {}) {
  return protocolObserverMetadata(input) ?? defaultObserverMetadata(input);
}

function observerVisibility(input = {}) {
  return isProtocolObserverInputEvent(input)
    ? protocolObserverVisibility(input)
    : protocolObserverVisibility(inputWithObserverMetadata(input));
}

function observerPayload(input = {}, extra = {}) {
  return protocolObserverPayload(inputWithObserverMetadata(input), extra);
}

function inputWithObserverMetadata(input = {}) {
  if (isProtocolObserverInputEvent(input)) return input;
  if (input?.source !== 'observer') return input;
  return {
    ...input,
    metadata: {
      ...(input.metadata ?? {}),
      observer: defaultObserverMetadata(input),
    },
  };
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
  const pending = [];
  const state = { running: false, deferredNotified: new Set(), heldSystemDirectives: new Set() };
  return {
    get isRunning() { return state.running; },
    get pendingCount() { return pending.length; },
    get pendingSystemDirectiveCount() { return pending.filter((event) => event.source === 'system_directive').length; },
    get pendingOperatorDirectiveCount() { return pending.filter((event) => event.source === 'operator_steering').length; },
    get pendingObserverCount() { return pending.filter((event) => isObserverInputEvent(event)).length; },
    enqueue: async (event, options = {}) => {
      const normalized = normalizeInputEvent(event);
      pending.push(normalized);
      noteSessionActivity(options.state, 'input_event_queued', normalized.created_at ?? normalized.received_at ?? new Date().toISOString());
      appendSession(SESSION_PATH, sessionEventEntry('input_event_queued', {
        event_id: normalized.event_id,
        source: normalized.source,
        transport: normalized.transport,
        source_kind: normalized.source_kind,
        authority_ref: normalized.authority_ref,
        directive_id: normalized.directive_id,
      }));
      recordObserverInputQueued(normalized);
      const queueAdmission = classifyInputRuntimeQueueAdmission(normalized, transcriptDisplaySettings, {
        activeTurn: state.running,
      });
      for (const queueEvent of queueAdmission.queue_events) {
        appendSession(SESSION_PATH, carrierSessionEventEntry(queueEvent.event_kind, queueEvent.payload));
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
      pendingObserverCount: pending.filter((event) => isObserverInputEvent(event)).length,
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
    const runtimeAdmission = classifyInputRuntimeAdmission(event);
    for (const admissionEvent of runtimeAdmission.admission_events) {
      if (admissionEvent.event_kind === 'input_admitted_to_turn') {
        appendSession(SESSION_PATH, carrierSessionEventEntry(admissionEvent.event_kind, admissionEvent.payload));
      }
    }
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
    if (state.heldSystemDirectives.has(event.event_id)) return;
    const hold = classifyInputRuntimeHold(event, {
      composerHasDraft: true,
      alreadyHeld: false,
      occurredAt: new Date().toISOString(),
    });
    if (hold.hold_action !== 'hold') return;
    state.heldSystemDirectives.add(event.event_id);
    for (const holdEvent of hold.hold_events) {
      appendSession(SESSION_PATH, carrierSessionEventEntry(holdEvent.event_kind, holdEvent.payload));
    }
  }

  function recordSystemDirectiveReleased(event) {
    if (!state.heldSystemDirectives.has(event.event_id)) return;
    const release = classifyInputRuntimeHold(event, {
      release: true,
      alreadyHeld: true,
      occurredAt: new Date().toISOString(),
    });
    state.heldSystemDirectives.delete(event.event_id);
    for (const releaseEvent of release.release_events) {
      appendSession(SESSION_PATH, carrierSessionEventEntry(releaseEvent.event_kind, releaseEvent.payload));
    }
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
  return await runConversationTurn(messages, tools, mcpServers, rl, { turn, emit, callChatApiFn, inputEventId: input?.event_id ?? null });
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
}) {
  const record = normalizeInputRecord(input);
  if (isObserverInputEvent(input, record)) {
    return submitObserverInput({ input, record, messages, tools, mcpServers, rl, turn, emit, callChatApiFn, displaySettings });
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
      response = await callChatApiFn(messagesWithCarrierGoal(messages, sessionSettings.goal), tools, { ...sessionSettings, turn, abortSignal: turn?.abortSignal, emit, mcpServers });
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
    ? classifyCarrierActionRequest(name, args, { toolAvailable: !!server, toolMetadata })
    : null;
  const category = serverMode
    ? (admissionClassification.decision === 'read_only_admitted' ? 'auto' : 'prompt')
    : classifyTool(name, args);
  const admissionRequired = serverMode && admissionClassification.decision !== 'read_only_admitted';
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

function mcpToolEffectAdmissionEvidence({ serverMode, admissionClassification, status, category }) {
  if (category === 'block') {
    return {
      admission_action: 'deny',
      admission_reason: 'unsupported_tool_effect',
    };
  }
  if (!serverMode || !admissionClassification) return {};
  if (admissionClassification.decision === 'read_only_admitted') {
    return {
      admission_action: 'admit',
      admission_reason: 'read_only_tool_effect_admitted',
      authority_ref: admissionClassification.authority_owner ?? undefined,
    };
  }
  if (admissionClassification.decision === 'routed') {
    return {
      admission_action: 'deny',
      admission_reason: 'tool_effect_admission_required',
      authority_ref: admissionClassification.authority_owner ?? undefined,
    };
  }
  if (status === 'denied') {
    return {
      admission_action: 'deny',
      admission_reason: 'unsupported_tool_effect',
      authority_ref: admissionClassification.authority_owner ?? undefined,
    };
  }
  return {};
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
  const fabricRequired = isMcpFabricRequired();
  let fabric;
  try {
    fabric = loadSiteMcpFabric(siteRoot, { required: fabricRequired });
  } catch (error) {
    throw createMcpStartupError('mcp_fabric_load_failed', `MCP fabric load failed: ${error.message}`, {
      phase: 'fabric_load',
      site_root: siteRoot,
      cause_code: error.code ?? null,
      details: error.details ?? {},
    });
  }
  if (fabricRequired && Object.keys(fabric.servers).length === 0) {
    throw createMcpStartupError('mcp_fabric_empty', `No MCP servers found in ${fabric.mcp_dir}`, {
      phase: 'fabric_load',
      site_root: siteRoot,
      mcp_dir: fabric.mcp_dir,
      files: fabric.files ?? [],
      registry_validation: fabric.registry_validation ?? null,
    });
  }

  const servers = {};
  const failures = [];
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
      const stdoutPollution = [];
      const stderrDiagnostics = [];
      let disconnectedError = null;
      const pending = new Map();
      const rejectPending = (error) => {
        for (const request of pending.values()) {
          clearTimeout(request.timeout);
          request.reject(error);
        }
        pending.clear();
      };
      const markDisconnected = (error) => {
        const normalizedError = error instanceof Error
          ? error
          : new Error(String(error ?? `MCP server ${serverName} disconnected`));
        if (!disconnectedError) disconnectedError = normalizedError;
        rejectPending(normalizedError);
      };
      proc.stdout.setEncoding('utf-8');
      proc.stderr.setEncoding('utf-8');
      proc.stderr.on('data', (d) => {
        const msg = d.toString().trim();
        if (shouldSuppressMcpStderr(msg)) return;
        if (msg) stderrDiagnostics.push(msg.slice(0, 1000));
        if (msg) process.stderr.write(`[${serverName}] ${msg}\n`);
      });

      proc.on('error', (error) => markDisconnected(error));
      proc.on('exit', (code, signal) => {
        markDisconnected(new Error(`MCP server ${serverName} exited${code === null ? '' : ` with code ${code}`}${signal ? ` signal ${signal}` : ''}`));
      });
      proc.stdin.on('error', (error) => markDisconnected(error));
      proc.stdout.on('error', (error) => markDisconnected(error));
      proc.stderr.on('error', (error) => markDisconnected(error));

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
            stdoutPollution.push(line.slice(0, 1000));
          }
        }
      });

      const startupTimeoutMs = Math.max(1, Number(serverConfig.startup_timeout_sec ?? 10) * 1000);
      const requestTimeoutMs = Math.max(1, Number(serverConfig.request_timeout_ms ?? 15000));
      const send = (req, timeoutMs = requestTimeoutMs, timeoutCode = 'mcp_request_timeout', abortSignal = null) => new Promise((resolve, reject) => {
        if (disconnectedError) {
          reject(disconnectedError);
          return;
        }
        if (abortSignal?.aborted) {
          reject(new Error('agent_cli_interrupt_requested'));
          return;
        }
        let settled = false;
        const settle = (fn, value) => {
          if (settled) return;
          settled = true;
          abortSignal?.removeEventListener?.('abort', onAbort);
          fn(value);
        };
        const resolveWrapped = (value) => settle(resolve, value);
        const rejectWrapped = (value) => settle(reject, value);
        const onAbort = () => {
          if (pending.has(req.id)) {
            clearTimeout(timeout);
            pending.delete(req.id);
          }
          rejectWrapped(new Error('agent_cli_interrupt_requested'));
        };
        abortSignal?.addEventListener('abort', onAbort, { once: true });
        const timeout = setTimeout(() => {
          if (pending.has(req.id)) {
            pending.delete(req.id);
            rejectWrapped(createMcpStartupError(timeoutCode, `MCP request timeout after ${timeoutMs}ms`, {
              phase: req.method,
              server_name: serverName,
              timeout_ms: timeoutMs,
              stdout_pollution: stdoutPollution,
              stderr: stderrDiagnostics,
            }));
          }
        }, timeoutMs);
        pending.set(req.id, { resolve: resolveWrapped, reject: rejectWrapped, timeout });
        try {
          proc.stdin.write(`${JSON.stringify(req)}\n`, (error) => {
            if (!error || !pending.has(req.id)) return;
            const request = pending.get(req.id);
            clearTimeout(request.timeout);
            pending.delete(req.id);
            markDisconnected(error);
            request.reject(error);
          });
        } catch (error) {
          if (pending.has(req.id)) {
            const request = pending.get(req.id);
            clearTimeout(request.timeout);
            pending.delete(req.id);
            request.reject(error);
          }
          markDisconnected(error);
        }
      });

      // Initialize with timeout
      let initResult, toolsResult;
      try {
        initResult = await send(
          { jsonrpc: '2.0', id: randomId(), method: 'initialize', params: { protocolVersion: '2024-11-05' } },
          startupTimeoutMs,
          'mcp_startup_timeout',
        );
        toolsResult = await send(
          { jsonrpc: '2.0', id: randomId(), method: 'tools/list', params: {} },
          startupTimeoutMs,
          'mcp_tool_hydration_timeout',
        );
      } catch (err) {
        const failure = mcpStartupDiagnostic(err, {
          code: 'mcp_server_startup_failed',
          phase: 'initialize_or_tools_list',
          server_name: serverName,
          command: serverConfig.command,
          args: serverConfig.args,
          stdout_pollution: stdoutPollution,
          stderr: stderrDiagnostics,
        });
        failures.push(failure);
        console.error(`[agent-cli] Failed to initialize MCP server ${serverName}: ${failure.message}`);
        await stopMcpStartupProcess(proc);
        continue;
      }

      if (stdoutPollution.length > 0) {
        const failure = {
          schema: 'narada.agent_cli.mcp_startup_diagnostic.v0',
          code: 'mcp_stdout_pollution',
          message: `MCP server ${serverName} emitted non-JSON stdout during startup`,
          phase: 'initialize_or_tools_list',
          server_name: serverName,
          stdout_pollution: stdoutPollution,
          stderr: stderrDiagnostics,
        };
        failures.push(failure);
        console.error(`[agent-cli] ${failure.message}`);
        await stopMcpStartupProcess(proc);
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
      const failure = mcpStartupDiagnostic(err, {
        code: 'mcp_server_spawn_failed',
        phase: 'spawn',
        server_name: serverName,
        command: serverConfig.command,
        args: serverConfig.args,
      });
      failures.push(failure);
      console.error(`[agent-cli] Failed to start MCP server ${serverName}: ${failure.message}`);
    }
  }

  if (fabricRequired && failures.length > 0) {
    throw createMcpStartupError('mcp_startup_failed', 'One or more required MCP servers failed startup', {
      phase: 'startup',
      site_root: siteRoot,
      failures,
    });
  }

  attachMcpStartupFailures(servers, failures);
  return servers;
}

function stopMcpStartupProcess(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolveStop) => {
    const timeout = setTimeout(resolveStop, 1000);
    proc.once('exit', () => {
      clearTimeout(timeout);
      resolveStop();
    });
    proc.kill();
  });
}

function isMcpFabricRequired() {
  if (process.env.NARADA_AGENT_CLI_REQUIRE_MCP_FABRIC === '0') return false;
  if (process.env.NARADA_AGENT_CLI_REQUIRE_MCP_FABRIC === '1') return true;
  return process.env.NARADA_SITE_ROOT !== undefined
    && process.env.NARADA_AGENT_ID !== undefined
    && (process.env.NARADA_AGENT_START_EVENT_ID !== undefined || process.env.NARADA_CARRIER_SESSION_ID !== undefined);
}

function createMcpStartupError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  error.diagnostic = {
    schema: 'narada.agent_cli.mcp_startup_diagnostic.v0',
    ...details,
    code,
    message,
  };
  return error;
}

function mcpStartupDiagnostic(error, fallback = {}) {
  if (error?.diagnostic) return error.diagnostic;
  const message = error instanceof Error ? error.message : String(error);
  return {
    schema: 'narada.agent_cli.mcp_startup_diagnostic.v0',
    ...fallback,
    message,
  };
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

async function sendMcpRequest(server, request, abortSignal = null) {
  if (abortSignal?.aborted) {
    throw new Error('agent_cli_interrupt_requested');
  }
  const response = await server.send(request, undefined, undefined, abortSignal);
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

function writeMcpPreflightArtifact({ artifactDir = MCP_PREFLIGHT_ARTIFACT_DIR, session, identity, siteRoot, mcpStatus, mcpServers, allTools }) {
  mkdirSync(artifactDir, { recursive: true });
  const artifactPath = join(artifactDir, `${session}.json`);
  writeFileSync(artifactPath, `${JSON.stringify({
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

function normalizeInputRecord(input) {
  if (typeof input === 'string') return { content: input, source: 'manual_operator' };
  if (input?.metadata?.observer || input?.source === 'observer') {
    return {
      content: String(input?.content ?? ''),
      source: 'observer',
      authority_ref: input?.authority_ref ?? null,
      directive_id: input?.directive_id ?? null,
    };
  }
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
  const mcpStatus = createMcpStatusSnapshot(mcpServers);
  const mcpPreflightArtifact = readMcpPreflightArtifact();
  const mcpPreflightSnapshot = createMcpPreflightArtifactSnapshot(mcpPreflightArtifact);
  const rolePrompt = loadRolePrompt(IDENTITY, SITE_ROOT);
  const state = {
    activeTurn: null,
    closed: false,
    displaySettings: { ...transcriptDisplaySettings },
    pendingRequests: new Set(),
    startedAt: new Date().toISOString(),
    sessionEventCount: 0,
    lastEventKind: null,
    lastEventAt: null,
    lastTerminalState: null,
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

  const emit = (event, payload = {}) => emitServerEvent(output, {
    event,
    agent_id: IDENTITY,
    session_id: SESSION,
    timestamp: new Date().toISOString(),
    ...payload,
  });

  noteSessionActivity(state, 'session_started', state.startedAt);

  emit('session_started', {
    transport: 'jsonl_stdio',
    site_root: SITE_ROOT,
    provider: INTELLIGENCE_PROVIDER,
    model: sessionSettings.model,
    thinking: sessionSettings.thinking,
    mcp_server_count: Object.keys(mcpServers).length,
    ...mcpStatus,
    ...mcpPreflightSnapshot,
    ...createSessionActivitySnapshot(state),
    tool_count: allTools.length,
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
  const dispatchRequestLine = (line) => {
    const runRequest = () => handleServerRequestLine(line, { state, messages, allTools, mcpServers, mcpPreflightArtifact, emit, callChatApiFn });
    const pending = isConcurrentServerRequestLine(line)
      ? runRequest()
      : (orderedServerRequests = orderedServerRequests.then(runRequest, runRequest));
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
    return classifyCarrierControlRequest(JSON.parse(line)).concurrent_allowed;
  } catch {
    return false;
  }
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
    if (controlRequest.method_kind === 'session_status') {
      noteSessionActivity(state, 'session_status_requested');
      emit('session_status', serverStatus({ requestId, state, allTools, mcpServers }));
      return;
    }
    if (controlRequest.method_kind === 'observers_status') {
      emit('observer_status', observerServerStatus({ requestId, state }));
      return;
    }
    if (controlRequest.method_kind === 'observer_set_muted') {
      const result = handleObserverCommand(controlRequest.observer_action, state.displaySettings);
      emit('observer_status', {
        ...observerServerStatus({ requestId, state }),
        terminal_state: result.status,
        message: result.message,
      });
      return;
    }
    if (controlRequest.method_kind === 'conversation_interrupt') {
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
    if (controlRequest.method_kind === 'session_close') {
      const closedAt = new Date().toISOString();
      state.closed = true;
      if (state.activeTurn) requestTurnInterrupt(state.activeTurn);
      noteSessionActivity(state, 'session_closed', closedAt, 'closed');
      emit('session_closed', {
        ...serverStatus({ requestId, state, allTools, mcpServers, mcpPreflightArtifact }),
        terminal_state: 'closed',
      });
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
      source: 'automation_jsonl',
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
  const goal = normalizeCarrierGoalState(sessionSettings.goal);
  const mcpStatus = createMcpStatusSnapshot(mcpServers);
  const mcpPreflightSnapshot = createMcpPreflightArtifactSnapshot(mcpPreflightArtifact);
  const sessionActivity = createSessionActivitySnapshot(state);
  return {
    request_id: requestId,
    transport: 'jsonl_stdio',
    provider: INTELLIGENCE_PROVIDER,
    model: sessionSettings.model,
    thinking: sessionSettings.thinking,
    stream: sessionSettings.stream,
    goal: goal.value || null,
    goal_status: goal.status,
    goal_display: carrierGoalStatusLabel(goal),
    active_turn_state: state.activeTurn ? 'running' : 'idle',
    active_turn_id: state.activeTurn?.turnId ?? null,
    mcp_server_count: Object.keys(mcpServers).length,
    ...mcpStatus,
    ...mcpPreflightSnapshot,
    ...sessionActivity,
    tool_count: allTools.length,
    mcp_tools: mcpToolCatalogEntries(mcpServers),
    observer_muted: (state?.displaySettings ?? transcriptDisplaySettings).observerMuted === true,
    observer_visibilities: OBSERVER_VISIBILITIES,
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
  if (['none', 'low', 'medium', 'high', 'xhigh'].includes(normalized)) return normalized;
  return 'medium';
}

function reasoningEffort(thinking) {
  if (thinking === 'none') return null;
  if (thinking === 'low') return 'low';
  if (thinking === 'high') return 'high';
  return 'medium';
}

function buildCodexMcpRequest(messages, tools = [], { model = MODEL, thinking = THINKING_LEVEL, siteRoot = SITE_ROOT, nativeMcpTools = CODEX_NATIVE_MCP_TOOLS, mcpServers = {} } = {}) {
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
  const developerInstructions = [system, codexToolProtocolInstructions(tools, { nativeMcpTools })].filter(Boolean).join('\n\n');

  if (codexSubscriptionThreadId) {
    return {
      tool: 'codex-reply',
      arguments: {
        threadId: codexSubscriptionThreadId,
        prompt,
        model,
        native_mcp_tools: nativeMcpTools,
        ...(nativeMcpTools ? { mcpServers } : {}),
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
      native_mcp_tools: nativeMcpTools,
      ...(nativeMcpTools ? { mcpServers } : {}),
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

function codexToolProtocolInstructions(tools = [], { nativeMcpTools = false } = {}) {
  if (!Array.isArray(tools) || tools.length === 0) return '';
  const toolLines = tools
    .map((tool) => {
      const fn = tool.function ?? {};
      const description = String(fn.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 220);
      const schema = formatCompactJsonSchema(fn.parameters ?? { type: 'object', properties: {} });
      return [
        `- ${fn.name}${description ? `: ${description}` : ''}`,
        `  input_schema: ${schema}`,
      ].join('\n');
    })
    .join('\n');
  const header = nativeMcpTools
    ? [
      'Narada MCP tools are registered with nested Codex as native MCP tools for this turn.',
      'Prefer native MCP tool calls when a listed tool is needed.',
      'If native MCP tool discovery is unavailable in the nested runtime, fall back by responding with exactly one JSON object and no prose:',
      '{"narada_tool_call":{"name":"tool_name","arguments":{}}}',
    ]
    : [
      'Narada MCP tools are available through agent-cli, not through native Codex tool discovery.',
      'When a Narada MCP tool is needed, respond with exactly one JSON object and no prose:',
      '{"narada_tool_call":{"name":"tool_name","arguments":{}}}',
    ];
  return [
    ...header,
    'Use each listed input_schema to construct arguments. Do not invent arguments outside the schema unless the schema explicitly allows them.',
    'Do not claim a listed Narada MCP tool is unavailable.',
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
  const isKimiProvider = INTELLIGENCE_PROVIDER === 'kimi-api' || INTELLIGENCE_PROVIDER === 'kimi-code-api';
  const body = {
    model,
    messages: cleanOpenAiMessages(messages),
    tools: tools.length > 0 ? tools : undefined,
    tool_choice: tools.length > 0 ? 'auto' : undefined,
    temperature: isKimiProvider ? 1 : 0.2,
  };
  const effort = reasoningEffort(thinking);
  if (effort && INTELLIGENCE_PROVIDER === 'openai-api') body.reasoning_effort = effort;
  if (INTELLIGENCE_PROVIDER === 'deepseek-api') {
    body.thinking = { type: thinking === 'none' ? 'disabled' : 'enabled' };
    if (thinking !== 'none') {
      body.reasoning_effort = thinking === 'xhigh' ? 'max' : 'high';
    }
  }
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  };
  if (INTELLIGENCE_PROVIDER === 'kimi-code-api') {
    headers['User-Agent'] = 'KimiCLI/1.0';
  }
  return {
    url: new URL('v1/chat/completions', baseUrl),
    body,
    headers,
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
        if (INTELLIGENCE_PROVIDER === 'kimi-api' || INTELLIGENCE_PROVIDER === 'kimi-code-api' || INTELLIGENCE_PROVIDER === 'deepseek-api') {
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
  if (request.arguments?.native_mcp_tools === true) {
    common.push(...codexExecMcpConfigArgs(request.arguments?.mcpServers ?? {}));
  }
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
    const nativeMcpEventState = { startedAtById: new Map() };
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

function parseCodexExecJsonLine(line) {
  try {
    return JSON.parse(stripAnsi(String(line)));
  } catch {
    return null;
  }
}

function codexExecMcpToolEventSummary(event) {
  const item = event?.item;
  if (!item || item.type !== 'mcp_tool_call') return null;
  const server = item.server ?? 'unknown-server';
  const tool = item.tool ?? 'unknown_tool';
  const name = `${server}.${tool}`;
  const args = item.arguments && typeof item.arguments === 'object' ? item.arguments : {};
  return {
    id: item.id ?? null,
    server,
    tool,
    name,
    arguments: args,
    status: item.status ?? (event.type === 'item.started' ? 'in_progress' : 'completed'),
    result: item.result ?? null,
    error: item.error ?? null,
  };
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

function formatCompactJsonSchema(schema, { limit = 1200 } = {}) {
  const normalized = schema && typeof schema === 'object' && !Array.isArray(schema)
    ? schema
    : { type: 'object', properties: {} };
  const text = stableStringify(normalized);
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 3))}...` : text;
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
    timestamp: (text) => color('38;5;240', text),
    key: (text) => color('33', text),
    code: (text) => color('90', text),
    success: (text) => color('32', text),
    prompt: (text) => color('1;32', text),
    progress: (text) => color('2;33', text),
    warn: (text) => color('33', text),
    error: (text) => color('38;5;167', text),
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
  writeTerminalRecord(`${labelStyle(label)}${terminalStyle.muted(':')} ${bodyStyle(String(text ?? ''))}${suffix}\n`, { before });
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
    after: true,
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

function copyToClipboard(text, spawnSyncFn = spawnSync, platform = process.platform) {
  try {
    let result;
    if (platform === 'win32') {
      result = spawnSyncFn('clip', [], { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
    } else if (platform === 'darwin') {
      result = spawnSyncFn('pbcopy', [], { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
    } else {
      result = spawnSyncFn('xclip', ['-selection', 'clipboard'], { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
    }
    return !result?.error && (result?.status == null || result.status === 0);
  } catch {
    return false;
  }
}

function printHostCommandResult(result = {}) {
  const commandText = String(result.command_text ?? '').trim();
  const lines = [
    commandText ? `$ ${commandText}` : null,
    `status: ${result.terminal_state ?? 'unknown'}${Number.isInteger(result.exit_code) ? ` (${result.exit_code})` : ''}`,
  ].filter(Boolean);
  const outputText = [result.stdout, result.stderr].filter((value) => String(value ?? '').trim()).join('\n').trim();
  if (outputText) lines.push(outputText);
  if (result.output_ref) lines.push(`output: ${result.output_ref.payload_ref}`);
  printMessageBlock({
    label: 'carrier host',
    text: lines.join('\n'),
    before: true,
    timestamp: true,
    labelStyle: terminalStyle.tool,
    bodyStyle: result.terminal_state === 'completed' ? (value) => value : terminalStyle.warn,
  });
}

function printInputRecord(record) {
  const label = inputRecordDisplayLabel(record);
  const labelStyle = record.source === 'system_directive'
    ? terminalStyle.systemDirective
    : isObserverInputEvent(record)
      ? terminalStyle.label
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
  if (isObserverInputEvent(record)) {
    const observerId = record?.source_id ?? 'narada.observer';
    const visibility = observerVisibility(record);
    if (visibility === 'agent_visible') return `${observerId} -> ${IDENTITY}`;
    if (visibility === 'conversation_visible') return `${observerId} -> conversation`;
    return `${observerId} -> operator`;
  }
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
  const renderedLines = [
    `${styleInputRouteLabel(promptLabel)}${terminalStyle.muted(':')} ${first}`,
    ...rest.map((line) => `  ${line}`),
  ];
  appendSuffixToLastLine(renderedLines, ` ${terminalStyle.timestamp(formatTimestamp(now))}`);
  return renderedLines.join('\n') + '\n';
}

function printMessageBlock({ label, text, before = false, after = false, timestamp = false, labelStyle = (value) => value, bodyStyle = (value) => value }) {
  const width = terminalWidth();
  const labelLine = `${labelStyle(label)}${terminalStyle.muted(':')}`;
  const bodyWidth = Math.max(32, width - 2);
  const lines = String(text ?? '').split(/\r?\n/).flatMap((line) => wrapTerminalLine(line, bodyWidth));
  const renderedLines = [
    labelLine,
    ...lines.map((line) => `  ${bodyStyle(line)}`),
  ];
  if (timestamp) appendSuffixToLastLine(renderedLines, ` ${terminalStyle.timestamp(formatTimestamp())}`);
  const rendered = renderedLines.join('\n');
  writeTerminalRecord(`${rendered}${after ? '\n\n' : '\n'}`, { before });
}

function writeTerminalRecord(text, { before = false } = {}) {
  process.stdout.write(`\r\x1b[K${before ? '\n' : ''}${text}`);
}

function appendSuffixToLastLine(lines, suffix) {
  if (!Array.isArray(lines) || lines.length === 0 || !suffix) return lines;
  lines[lines.length - 1] = `${lines[lines.length - 1]}${suffix}`;
  return lines;
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
  const text = typeof content === 'string' ? content : String(content == null ? '' : stringifySummary(content));
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const keys = Object.keys(parsed);
      // If the JSON is compact enough, show it inline so operators and the AI can actually read it.
      const compact = JSON.stringify(parsed);
      if (compact.length <= 240) return compact;

      const status = typeof parsed.status === 'string' ? `${parsed.status}` : null;
      const schema = typeof parsed.schema === 'string' ? parsed.schema : null;
      const count = typeof parsed.directive_count === 'number'
        ? `directives=${parsed.directive_count}`
        : typeof parsed.directiveCount === 'number'
          ? `directives=${parsed.directiveCount}`
          : null;
      const outputRef = typeof parsed.output_ref === 'string' ? `output_ref=${parsed.output_ref}` : null;
      const readerTool = typeof parsed.reader_tool === 'string' ? `reader_tool=${parsed.reader_tool}` : null;
      const error = typeof parsed.error === 'string' ? `error=${parsed.error}` : null;
      const shownKeys = keys.slice(0, 8);
      const keySummary = shownKeys.length
        ? `keys: ${shownKeys.join(', ')}${keys.length > shownKeys.length ? ', ...' : ''}`
        : null;
      return [
        [status, schema, count, outputRef, readerTool, error].filter(Boolean).join(' · '),
        keySummary,
      ].filter(Boolean).join('\n');
    }
    if (Array.isArray(parsed)) {
      const compact = JSON.stringify(parsed);
      return compact.length <= 240 ? compact : `array(${parsed.length})`;
    }
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

function formatProgressStatus({ spinner, phase, totalMs, phaseMs, operatorDirectiveDraft = '', operatorDirectiveDraftLength = 0, queuedOperatorDirectiveCount = 0 }) {
  const phaseText = String(phase ?? 'working');
  const phaseDuration = formatDuration(phaseMs ?? totalMs ?? 0);
  const totalDuration = formatDuration(totalMs ?? 0);
  const totalSuffix = phaseText === 'thinking' ? '' : ` · total ${totalDuration}`;
  const queuedSuffix = queuedOperatorDirectiveCount > 0 ? ` · queued operator directives ${queuedOperatorDirectiveCount}` : '';
  const draftText = sanitizeOperatorDirectiveDraftForDisplay(operatorDirectiveDraft);
  const draftLength = operatorDirectiveDraftLength || Array.from(String(operatorDirectiveDraft ?? '')).length;
  const draftSuffix = draftText
    ? ` · typing: ${draftText}`
    : (draftLength > 0 ? ` · typing operator directive (${draftLength})` : '');
  return `${spinner} ${phaseText} ${phaseDuration}${totalSuffix}${queuedSuffix} · Enter queues note · Esc to interrupt${draftSuffix}`;
}

function sanitizeOperatorDirectiveDraftForDisplay(value) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]+/g, '')
    .trimEnd();
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
    rl.setPrompt(prompt);
    rl.prompt();

    let accumulated = '';
    let lastLineTime = 0;
    let settleTimer = null;
    let completed = false;

    const cleanup = () => {
      completed = true;
      clearTimeout(settleTimer);
      rl.removeListener('line', onLine);
      rl.removeListener('close', onClose);
    };

    const commit = () => {
      if (completed) return;
      cleanup();
      resolve(accumulated.trimEnd());
    };

    const onLine = (line) => {
      const now = performance.now();
      const gap = lastLineTime ? now - lastLineTime : Infinity;
      lastLineTime = now;

      accumulated += (accumulated ? '\n' : '') + line;
      clearTimeout(settleTimer);

      if (gap < 25) {
        settleTimer = setTimeout(commit, 60);
      } else if (accumulated.includes('\n')) {
        settleTimer = setTimeout(commit, 60);
      } else {
        settleTimer = setTimeout(commit, 10);
      }
    };

    rl.on('line', onLine);
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
    } else if (argv[i] === '--mcp-preflight') {
      opts.mcpPreflight = true;
    } else if (argv[i] === '--mcp-preflight-json') {
      opts.mcpPreflightJson = true;
    } else if (argv[i] === '--session-inventory') {
      opts.sessionInventory = true;
    } else if (argv[i] === '--session-inventory-json') {
      opts.sessionInventoryJson = true;
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
  codexExecMcpToolEventSummary,
  consumeOperatorDirectiveInputText,
  createInteractiveHeaderRows,
  createMcpPreflightArtifactSnapshot,
  createSessionActivitySnapshot,
  codexExecEventText,
  discoverAndStartMcpServers,
  environmentBlockLength,
  executeMcpTool,
  classifyCarrierHostCommandInput,
  executeCarrierHostCommand,
  readCarrierHostCommandOutputRef,
  readMcpPreflightArtifact,
  handleInteractiveControlLine,
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
  rewriteSubmittedPrompt,
  recordMcpPreflightArtifactLinkage,
  renderMarkdownForTerminal,
  wrapTerminalLine,
  runConversationTurn,
  runMcpPreflight,
  runSessionInventory,
  runServerMode,
  readSessionInventory,
  serverStatus,
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
    console.log(`Usage: narada-agent-cli --identity <name> [--session <name>] [--server] [--mcp-preflight] [--session-inventory] [--session-inventory-json] [--stream|--no-stream] [--color|--no-color] [--control-jsonl <path>] [--message <text>] [--message-file <path>] [--operator-directive|--system-directive] [--enable-startup-system-directive|--startup-system-directive <text>|--no-startup-system-directive] [--interactive-after-message] [--auto-approve]`);
    console.log('Programmatic input: --message and --message-file are explicit control inputs; do not use raw stdin piping as the control API.');
    console.log(`Environment: NARADA_INTELLIGENCE_PROVIDER, ANTHROPIC_API_KEY, NARADA_AI_API_KEY, NARADA_AI_BASE_URL, NARADA_AI_MODEL, NARADA_AGENT_CLI_STREAM, NARADA_AGENT_CLI_COLOR, NARADA_AGENT_CLI_STARTUP_SYSTEM_DIRECTIVE_ENABLE, NARADA_AGENT_CLI_STARTUP_SYSTEM_DIRECTIVE, NARADA_AGENT_CLI_STARTUP_SYSTEM_DIRECTIVE_DELAY_MS, NARADA_SITE_ROOT`);
    process.exit(0);
  }

  main().catch((err) => {
    activeHeartbeat?.stop();
    activeOperationHeartbeatDirectiveEmitter?.stop?.();
    console.error(`[agent-cli] Fatal error: ${err.message}`);
    process.exit(1);
  });
}
