#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { main } from '../src/runtime-server-shim.mjs';

const isEntrypoint = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isEntrypoint) {
  main().catch((error) => {
    console.error(`[agent-runtime-server] compatibility shim failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

export { main, resolveNaradaAgentRuntimeServerBin, runCompatibilityShim, runtimeServerShimUnavailableMessage } from '../src/runtime-server-shim.mjs';
