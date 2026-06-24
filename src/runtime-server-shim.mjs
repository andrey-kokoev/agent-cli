import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

export function runtimeServerShimUnavailableMessage(error) {
  const cause = error instanceof Error ? error.message : String(error);
  return [
    'agent-runtime-server moved to Narada proper.',
    'Install or launch @narada2/agent-runtime-server and use the canonical bin `narada-agent-runtime-server`.',
    `resolution_error=${cause}`,
  ].join('\n');
}

export function resolveNaradaAgentRuntimeServerBin({ requireFn = require, fallbackRoots = requireFn === require } = {}) {
  let packageJsonPath;
  try {
    packageJsonPath = requireFn.resolve('@narada2/agent-runtime-server/package.json');
  } catch (error) {
    if (!fallbackRoots) throw error;
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      process.env.NARADA_PROPER_ROOT ? join(process.env.NARADA_PROPER_ROOT, 'packages', 'agent-runtime-server', 'package.json') : null,
      join(moduleDir, '..', '..', 'narada', 'packages', 'agent-runtime-server', 'package.json'),
    ].filter(Boolean);
    packageJsonPath = candidates.find((candidate) => existsSync(candidate));
    if (!packageJsonPath) throw error;
  }
  return join(dirname(packageJsonPath), 'bin', 'narada-agent-runtime-server.mjs');
}

export async function runCompatibilityShim({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  env = process.env,
  stderr = process.stderr,
  stdio = 'inherit',
  requireFn = require,
  spawnFn = spawn,
} = {}) {
  let runtimeServerBin;
  try {
    runtimeServerBin = resolveNaradaAgentRuntimeServerBin({ requireFn });
  } catch (error) {
    stderr.write(`${runtimeServerShimUnavailableMessage(error)}\n`);
    return 1;
  }

  const child = spawnFn(process.execPath, [runtimeServerBin, ...argv], {
    cwd,
    env,
    stdio,
    windowsHide: false,
  });

  child.on('error', (error) => {
    stderr.write(`[agent-runtime-server] failed to start Narada runtime server: ${error.message}\n`);
  });

  return await new Promise((resolve) => {
    child.on('close', (code) => resolve(typeof code === 'number' ? code : 1));
  });
}

export async function main(options = {}) {
  const exitCode = await runCompatibilityShim(options);
  if (options.exit === false) return exitCode;
  process.exit(exitCode);
}
