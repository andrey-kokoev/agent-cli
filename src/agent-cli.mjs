#!/usr/bin/env node
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  isAgentCliUtilityCommandMode,
  parseArgs,
  parseBooleanEnv,
  parseColorEnv,
} from './cli-options.mjs';
import {
  resolveNarsAttachEndpoint,
  runNarsAttachClient,
} from './nars-attach-client.mjs';
import {
  filterPersistedSessionEvents,
  filterSessionInventory,
  readPersistedSession,
  readPersistedSessionEvents,
  readSessionInventory,
  runSessionEventsRead,
  runSessionInventory,
  runSessionInventoryActions,
  runSessionInventoryEvents,
  runSessionInventoryHostCommands,
  runSessionInventoryOperations,
  runSessionInventoryRecovery,
  runSessionOperationsRead,
  runSessionRead,
  runSessionRecovery,
  runSessionSync,
  sessionEventEntry,
  sessionLogEntry,
  summarizeSessionInventoryGroups,
} from './session-persistence.mjs';

const RUNTIME_OWNED_OPTIONS = Object.freeze([
  ['mcpPreflight', '--mcp-preflight'],
  ['mcpPreflightJson', '--mcp-preflight-json'],
  ['mcpPreflightRead', '--mcp-preflight-read'],
  ['mcpPreflightReadJson', '--mcp-preflight-read-json'],
  ['mcpPreflightInventory', '--mcp-preflight-inventory'],
  ['mcpPreflightInventoryJson', '--mcp-preflight-inventory-json'],
  ['mcpPreflightActions', '--mcp-preflight-actions'],
  ['mcpPreflightActionsJson', '--mcp-preflight-actions-json'],
  ['mcpPreflightRecovery', '--mcp-preflight-recovery'],
  ['mcpPreflightRecoveryJson', '--mcp-preflight-recovery-json'],
  ['mcpPreflightDiagnostics', '--mcp-preflight-diagnostics'],
  ['mcpPreflightDiagnosticsJson', '--mcp-preflight-diagnostics-json'],
  ['hostCommandOutputRead', '--host-command-output-read'],
  ['hostCommandOutputReadJson', '--host-command-output-read-json'],
  ['model', '--model'],
  ['thinking', '--thinking'],
  ['stream', '--stream/--no-stream'],
]);

function writeLine(stream, value) {
  stream.write(`${String(value)}\n`);
}

function runtimeOwnedOptionNames(options) {
  return RUNTIME_OWNED_OPTIONS
    .filter(([key]) => options[key] !== undefined && options[key] !== false)
    .map(([, flag]) => flag);
}

function siteContext(options, env, cwd) {
  const siteRoot = resolve(env.NARADA_SITE_ROOT ?? cwd);
  const naradaDir = basename(siteRoot).toLowerCase() === '.narada'
    ? siteRoot
    : join(siteRoot, '.narada');
  const identity = options.identity ?? env.NARADA_AGENT_ID ?? 'narada.architect';
  const session = options.session
    ?? env.NARADA_NARS_SESSION_ID
    ?? env.NARADA_RUNTIME_SESSION_ID
    ?? env.NARADA_CARRIER_SESSION_ID
    ?? env.NARADA_AGENT_CLI_SESSION
    ?? identity.replace(/\./g, '-');
  return { identity, session, siteRoot, naradaDir };
}

function normalizeSyncDirection(value) {
  const normalized = String(value ?? 'upload').trim().toLowerCase();
  return ['upload', 'download', 'bidirectional'].includes(normalized) ? normalized : 'upload';
}

function helpText() {
  return [
    'Usage: narada-agent-cli --attach <ws://host/events> [--identity <name>] [--session <id>]',
    '',
    'Session projections:',
    '  --session-inventory[--json]',
    '  --session-inventory-operations[--json]',
    '  --session-inventory-actions[--json]',
    '  --session-inventory-recovery[--json]',
    '  --session-inventory-events[--json]',
    '  --session-read[--json]',
    '  --session-events[--json]',
    '  --session-operations[--json]',
    '  --session-recovery[--json]',
    '  --session-sync[--json] --session-sync-target <target>',
    '',
    'Provider execution and MCP hosting belong to narada-agent-runtime-server.',
  ].join('\n');
}

export async function runAgentCli({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
  input = process.stdin,
  output = process.stdout,
  errorOutput = process.stderr,
  WebSocketImpl = globalThis.WebSocket,
} = {}) {
  const options = parseArgs(argv);
  if (options.help) {
    writeLine(output, helpText());
    return 0;
  }

  const removedConversationArgs = options.removedConversationArgs ?? [];
  if (removedConversationArgs.length > 0) {
    writeLine(errorOutput, `agent-cli no longer owns conversation runtime flags: ${removedConversationArgs.join(', ')}. Submit through narada-agent-runtime-server.`);
    return 2;
  }

  const runtimeOwned = runtimeOwnedOptionNames(options);
  if (runtimeOwned.length > 0) {
    writeLine(errorOutput, `agent-cli cannot execute runtime-owned option(s): ${runtimeOwned.join(', ')}. Use narada-agent-runtime-server health/control surfaces.`);
    return 2;
  }

  const context = siteContext(options, env, cwd);
  if (options.attach) {
    return await runNarsAttachClient({
      endpoint: resolveNarsAttachEndpoint(options, env),
      input,
      output,
      WebSocketImpl,
      maxReplay: 50,
      color: options.color,
    });
  }

  const inventoryOptions = {
    siteRoot: context.siteRoot,
    naradaDir: context.naradaDir,
    filterKey: options.sessionInventoryFilter ?? null,
    filterValue: options.sessionInventoryMatch ?? null,
  };
  if (options.sessionInventory || options.sessionInventoryJson) {
    return await runSessionInventory({ ...inventoryOptions, jsonOutput: options.sessionInventoryJson === true });
  }
  if (options.sessionInventoryOperations || options.sessionInventoryOperationsJson) {
    return await runSessionInventoryOperations({ ...inventoryOptions, jsonOutput: options.sessionInventoryOperationsJson === true });
  }
  if (options.sessionInventoryHostCommands || options.sessionInventoryHostCommandsJson) {
    return await runSessionInventoryHostCommands({ ...inventoryOptions, jsonOutput: options.sessionInventoryHostCommandsJson === true });
  }
  if (options.sessionInventoryActions || options.sessionInventoryActionsJson) {
    return await runSessionInventoryActions({ ...inventoryOptions, jsonOutput: options.sessionInventoryActionsJson === true });
  }
  if (options.sessionInventoryRecovery || options.sessionInventoryRecoveryJson) {
    return await runSessionInventoryRecovery({ ...inventoryOptions, jsonOutput: options.sessionInventoryRecoveryJson === true });
  }
  if (options.sessionInventoryEvents || options.sessionInventoryEventsJson) {
    return await runSessionInventoryEvents({
      ...inventoryOptions,
      jsonOutput: options.sessionInventoryEventsJson === true,
      eventFilter: options.sessionInventoryEventsFilter ?? 'all',
      recentCount: Number.isFinite(options.sessionInventoryEventsCount) ? Math.max(1, options.sessionInventoryEventsCount) : 20,
    });
  }

  const sessionOptions = {
    session: context.session,
    siteRoot: context.siteRoot,
    naradaDir: context.naradaDir,
  };
  if (options.sessionOperations || options.sessionOperationsJson) {
    return await runSessionOperationsRead({ ...sessionOptions, jsonOutput: options.sessionOperationsJson === true });
  }
  if (options.sessionRecovery || options.sessionRecoveryJson) {
    return await runSessionRecovery({ ...sessionOptions, jsonOutput: options.sessionRecoveryJson === true });
  }
  if (options.sessionRead || options.sessionReadJson) {
    return await runSessionRead({ ...sessionOptions, jsonOutput: options.sessionReadJson === true });
  }
  if (options.sessionEvents || options.sessionEventsJson) {
    return await runSessionEventsRead({
      ...sessionOptions,
      jsonOutput: options.sessionEventsJson === true,
      eventFilter: options.sessionEventsFilter ?? 'all',
      recentCount: Number.isFinite(options.sessionEventsCount) ? Math.max(1, options.sessionEventsCount) : 20,
    });
  }
  if (options.sessionSync || options.sessionSyncJson) {
    return await runSessionSync({
      ...sessionOptions,
      target: String(options.sessionSyncTarget ?? '').trim() || null,
      direction: normalizeSyncDirection(options.sessionSyncDirection),
      jsonOutput: options.sessionSyncJson === true,
      dryRun: options.sessionSyncDryRun === true,
      deleteMissing: options.sessionSyncDelete === true,
    });
  }

  writeLine(errorOutput, 'agent-cli is a NARS client projection. Pass --attach or an explicit session projection command.');
  return 2;
}

export async function main() {
  process.exitCode = await runAgentCli();
}

export {
  filterPersistedSessionEvents,
  filterSessionInventory,
  isAgentCliUtilityCommandMode,
  parseArgs,
  parseBooleanEnv,
  parseColorEnv,
  readPersistedSession,
  readPersistedSessionEvents,
  readSessionInventory,
  runSessionEventsRead,
  runSessionInventory,
  runSessionInventoryActions,
  runSessionInventoryEvents,
  runSessionInventoryHostCommands,
  runSessionInventoryOperations,
  runSessionInventoryRecovery,
  runSessionOperationsRead,
  runSessionRead,
  runSessionRecovery,
  runSessionSync,
  sessionEventEntry,
  sessionLogEntry,
  summarizeSessionInventoryGroups,
};

const isEntrypoint = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isEntrypoint) {
  await main().catch((error) => {
    writeLine(process.stderr, `[agent-cli] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
