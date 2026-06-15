#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const carrierPath = join(__dirname, '..', 'src', 'agent-cli.mjs');

const isEntrypoint = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

function formatStartupMcpSummary(event) {
  if (!event || event.event !== 'session_started') return null;
  if (event.mcp_operational_state === 'healthy') return null;
  const parts = [`MCP state=${event.mcp_operational_state}`];
  if (event.mcp_startup_failure_count > 0 && event.mcp_startup_failure_summary) {
    parts.push(`startup=${event.mcp_startup_failure_summary}`);
  }
  if (event.mcp_runtime_fault_count > 0 && event.mcp_runtime_fault_summary) {
    parts.push(`runtime=${event.mcp_runtime_fault_summary}`);
  }
  return `[agent-runtime-server] ${parts.join(' | ')}`;
}

function formatStartupMcpEvent(event) {
  if (!event || event.event !== 'session_started') return null;
  if (event.mcp_operational_state === 'healthy') return null;
  return {
    schema: 'narada.agent_runtime_server.wrapper_event.v1',
    event: 'mcp_startup_status',
    timestamp: event.timestamp ?? new Date().toISOString(),
    agent_id: event.agent_id ?? null,
    session_id: event.session_id ?? null,
    mcp_operational_state: event.mcp_operational_state ?? null,
    mcp_startup_failure_count: event.mcp_startup_failure_count ?? 0,
    mcp_startup_failure_summary: event.mcp_startup_failure_summary ?? '0',
    mcp_runtime_fault_count: event.mcp_runtime_fault_count ?? 0,
    mcp_runtime_fault_summary: event.mcp_runtime_fault_summary ?? '0',
  };
}

function formatRuntimeMcpFaultSummary(event) {
  if (!event || event.event !== 'carrier_diagnostic_recorded') return null;
  if (event.diagnostic_code !== 'mcp_runtime_fault') return null;
  const serverName = event.server_name ?? 'unknown';
  const toolName = event.tool_name ?? '<missing>';
  const errorCode = event.error_code ? ` ${event.error_code}` : '';
  return `[agent-runtime-server] MCP runtime fault ${serverName}:${toolName}${errorCode}`;
}

function formatRuntimeMcpFaultEvent(event) {
  if (!event || event.event !== 'carrier_diagnostic_recorded') return null;
  if (event.diagnostic_code !== 'mcp_runtime_fault') return null;
  return {
    schema: 'narada.agent_runtime_server.wrapper_event.v1',
    event: 'mcp_runtime_fault',
    timestamp: event.timestamp ?? new Date().toISOString(),
    agent_id: event.agent_id ?? null,
    session_id: event.session_id ?? null,
    diagnostic_code: event.diagnostic_code,
    server_name: event.server_name ?? 'unknown',
    tool_name: event.tool_name ?? '<missing>',
    error_code: event.error_code ?? null,
  };
}

async function main() {
  const requestedArgs = process.argv.slice(2);
  const wrapperEventsJsonl = requestedArgs.includes('--wrapper-events-jsonl');
  const forwardedArgs = requestedArgs.filter((arg) => arg !== '--wrapper-events-jsonl');
  const args = forwardedArgs.includes('--server') ? forwardedArgs : ['--server', ...forwardedArgs];
  const child = spawn(process.execPath, [carrierPath, ...args], {
    stdio: ['inherit', 'pipe', 'pipe'],
    env: process.env,
    cwd: process.cwd(),
    windowsHide: false,
  });

  let startupSummaryPrinted = false;
  const runtimeFaultSummaries = new Set();
  let stdoutBuffer = '';

  child.stdout.on('data', (chunk) => {
    const text = String(chunk);
    process.stdout.write(text);
    stdoutBuffer += text;
    while (true) {
      const newlineIndex = stdoutBuffer.indexOf('\n');
      if (newlineIndex === -1) break;
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (!line || startupSummaryPrinted) continue;
      try {
        const event = JSON.parse(line);
        const summary = formatStartupMcpSummary(event);
        if (summary) {
          console.error(summary);
          if (wrapperEventsJsonl) {
            const wrapperEvent = formatStartupMcpEvent(event);
            if (wrapperEvent) console.error(JSON.stringify(wrapperEvent));
          }
          startupSummaryPrinted = true;
        }
        const runtimeFaultSummary = formatRuntimeMcpFaultSummary(event);
        if (runtimeFaultSummary && !runtimeFaultSummaries.has(runtimeFaultSummary)) {
          console.error(runtimeFaultSummary);
          if (wrapperEventsJsonl) {
            const wrapperEvent = formatRuntimeMcpFaultEvent(event);
            if (wrapperEvent) console.error(JSON.stringify(wrapperEvent));
          }
          runtimeFaultSummaries.add(runtimeFaultSummary);
        }
      } catch {}
    }
  });

  child.stderr.on('data', (chunk) => {
    process.stderr.write(String(chunk));
  });

  child.on('error', (error) => {
    console.error(`[agent-runtime-server] failed to start carrier: ${error.message}`);
    process.exit(1);
  });

  const exitCode = await new Promise((resolve) => {
    child.on('close', (code) => resolve(typeof code === 'number' ? code : 1));
  });
  process.exit(exitCode);
}

if (isEntrypoint) {
  main().catch((error) => {
    console.error(`[agent-runtime-server] failed to start carrier: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

export { formatStartupMcpEvent, formatStartupMcpSummary, formatRuntimeMcpFaultEvent, formatRuntimeMcpFaultSummary };
