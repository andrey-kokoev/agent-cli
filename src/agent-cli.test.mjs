import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const agentCliPackageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const agentCliPackageRoot = fileURLToPath(new URL('..', import.meta.url));
const agentCliGitRootPresent = existsSync(join(agentCliPackageRoot, '.git'));

for (const [exportName, exportTarget] of Object.entries(agentCliPackageJson.exports ?? {})) {
  if (typeof exportTarget !== 'string' || !exportTarget.startsWith('./')) continue;
  const exportPath = exportTarget.slice(2);
  assert.equal(existsSync(join(agentCliPackageRoot, exportPath)), true, `package export ${exportName} target must exist: ${exportPath}`);
  if (agentCliGitRootPresent && exportName !== './package.json') {
    const tracked = spawnSync('git', ['ls-files', '--error-unmatch', exportPath], {
      cwd: agentCliPackageRoot,
      encoding: 'utf8',
    });
    assert.equal(tracked.status, 0, `package export ${exportName} target must be tracked by git: ${exportPath}`);
  }
}

const rootModule = await import('./agent-cli.mjs');
assert.equal(typeof rootModule.parseArgs, 'function');
assert.equal(Object.hasOwn(agentCliPackageJson.dependencies ?? {}, '@narada2/carrier-runtime'), false);
for (const runtimeOwnedExport of [
  'REQUEST_ADAPTERS',
  'executeMcpTool',
  'assertApiKeyConfigured',
  'callChatApi',
  'messagesWithCarrierGoal',
  'recordMcpPreflightArtifactLinkage',
  'runConversationTurn',
  'runMcpPreflight',
  'runMcpPreflightDiagnostics',
  'serverStatus',
]) {
  assert.equal(Object.hasOwn(rootModule, runtimeOwnedExport), false, `agent-cli root must not export runtime-owned ${runtimeOwnedExport}`);
}

