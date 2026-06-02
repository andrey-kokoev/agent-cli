#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const carrierPath = join(__dirname, '..', 'src', 'agent-cli.mjs');
const requestedArgs = process.argv.slice(2);
const args = requestedArgs.includes('--server') ? requestedArgs : ['--server', ...requestedArgs];

const result = spawnSync(process.execPath, [carrierPath, ...args], {
  stdio: 'inherit',
  env: process.env,
  cwd: process.cwd(),
  windowsHide: false,
});

if (result.error) {
  console.error(`[agent-runtime-server] failed to start carrier: ${result.error.message}`);
  process.exit(1);
}

process.exit(typeof result.status === 'number' ? result.status : 1);
