#!/usr/bin/env node

import { main } from '../src/agent-cli.mjs';

await main().catch((error) => {
  console.error(`[narada-agent-cli] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
