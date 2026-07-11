import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { parseArgs, runAgentCli } from './agent-cli.mjs';
import {
  createExplicitJsonControlFrame,
  createOperatorConversationFrame,
  createProjectedSlashCommandAction,
} from './projected-terminal.mjs';

function capture() {
  const stream = new PassThrough();
  let text = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => { text += String(chunk); });
  return { stream, text: () => text };
}

test('agent-cli package and entrypoint contain no runtime hosting dependencies', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const source = readFileSync(new URL('./agent-cli.mjs', import.meta.url), 'utf8');
  for (const dependency of [
    '@narada2/carrier-runtime',
    '@narada2/mcp-fabric',
    '@narada2/carrier-provider-contract',
    '@narada2/nars-provider-runtime',
    '@narada2/nars-capability-gateway',
  ]) {
    assert.equal(Object.hasOwn(packageJson.dependencies ?? {}, dependency), false, dependency);
    assert.equal(source.includes(dependency), false, dependency);
  }
  assert.equal(source.includes('node:child_process'), false);
});

test('agent-cli refuses provider and MCP runtime options', async () => {
  for (const argv of [
    ['--mcp-preflight'],
    ['--model', 'gpt-test'],
    ['--stream'],
    ['--message', 'legacy conversation'],
  ]) {
    const output = capture();
    const errors = capture();
    const code = await runAgentCli({ argv, output: output.stream, errorOutput: errors.stream });
    assert.equal(code, 2, argv.join(' '));
    assert.match(errors.text(), /runtime|narada-agent-runtime-server/i);
  }
});

test('agent-cli help and option parsing remain client-only', async () => {
  assert.deepEqual(parseArgs(['--attach', 'ws://127.0.0.1:9000/events']), {
    attach: true,
    attachEndpoint: 'ws://127.0.0.1:9000/events',
  });
  const output = capture();
  const code = await runAgentCli({ argv: ['--help'], output: output.stream });
  assert.equal(code, 0);
  assert.match(output.text(), /--attach/);
  assert.doesNotMatch(output.text(), /--mcp-preflight/);
});

test('terminal projection emits only narrow session-core controls', () => {
  const submit = createOperatorConversationFrame('hello');
  assert.equal(submit.method, 'session.submit');
  assert.equal(submit.params.content, 'hello');
  assert.equal(createProjectedSlashCommandAction('/status').frame.method, 'session.health');
  assert.equal(createProjectedSlashCommandAction('/interrupt').frame.method, 'session.cancel');
  assert.equal(createProjectedSlashCommandAction('/exit').frame.method, 'session.close');
  assert.match(
    createExplicitJsonControlFrame('/json {"method":"conversation.send","params":{"message":"legacy"}}').error,
    /unsupported session-core method/,
  );
});
