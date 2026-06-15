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

function formatRuntimeMcpFaultSummary(event) {
  if (!event || event.event !== 'carrier_diagnostic_recorded') return null;
  if (event.diagnostic_code !== 'mcp_runtime_fault') return null;
  const serverName = event.server_name ?? 'unknown';
  const toolName = event.tool_name ?? '<missing>';
  const errorCode = event.error_code ? ` ${event.error_code}` : '';
  return `[agent-runtime-server] MCP runtime fault ${serverName}:${toolName}${errorCode}`;
}

async function main() {
  const requestedArgs = process.argv.slice(2);
  const args = requestedArgs.includes('--server') ? requestedArgs : ['--server', ...requestedArgs];
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
          startupSummaryPrinted = true;
        }
        const runtimeFaultSummary = formatRuntimeMcpFaultSummary(event);
        if (runtimeFaultSummary && !runtimeFaultSummaries.has(runtimeFaultSummary)) {
          console.error(runtimeFaultSummary);
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

export { formatStartupMcpSummary, formatRuntimeMcpFaultSummary };
