import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  createEventHub,
  startEventStreamProjection,
} from '@narada2/agent-runtime-server';
import { createNarsRuntimeContext } from '@narada2/agent-runtime-server/runtime-context';
import { createSessionCoreRuntimeService } from '@narada2/agent-runtime-server/session-core-runtime-service';

const PACKAGE_ROOT = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const CLI_BIN = join(PACKAGE_ROOT, 'bin', 'narada-agent-cli.mjs');

function waitFor(predicate, timeoutMs = 7000, label = 'condition') {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let value;
      try {
        value = predicate();
      } catch (error) {
        reject(error);
        return;
      }
      if (value) {
        resolve(value);
        return;
      }
      if (Date.now() - started >= timeoutMs) return reject(new Error(`agent_cli_e2e_timeout:${label}`));
      setTimeout(tick, 20);
    };
    tick();
  });
}

async function killCli(cli) {
  if (!cli.child.killed && cli.child.exitCode == null) cli.child.kill();
  await cli.exit;
}

function stripAnsi(value) {
  return String(value ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

function normalizedOutput(value) {
  return stripAnsi(value)
    .replace(/\r/g, '')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, '<timestamp>');
}

function assertOrdered(text, parts) {
  let index = 0;
  for (const part of parts) {
    const next = text.indexOf(part, index);
    assert.notEqual(next, -1, `expected output to contain ${JSON.stringify(part)} after index ${index}\n${text}`);
    index = next + part.length;
  }
}

function countOccurrences(text, part) {
  return text.split(part).length - 1;
}

function outputLines(text) {
  return normalizedOutput(text).split('\n').map((line) => line.trimEnd()).filter(Boolean);
}

function assertLineCount(lines, pattern, expectedCount) {
  const matches = lines.filter((line) => pattern.test(line));
  assert.equal(matches.length, expectedCount, `expected ${expectedCount} lines matching ${pattern}, got ${matches.length}\n${lines.join('\n')}`);
}

function assertEventSequence(events, expected) {
  const relevant = events
    .filter((event) => expected.some((item) => item.event === event.event))
    .map((event) => ({ event: event.event, content: event.content, status: event.status, tool: event.tool ?? event.tool_name }));
  assert.deepEqual(relevant, expected);
}

function assertNoProtocolNoise(text) {
  assert.doesNotMatch(text, /"method"\s*:/);
  assert.doesNotMatch(text, /"params"\s*:/);
  assert.doesNotMatch(text, /narada\.nars\.events\.envelope\.v1/);
  assert.doesNotMatch(text, /(?:Error:|UnhandledPromiseRejection|TypeError:|SyntaxError:)/);
}

async function startFixtureRuntime({ callChatApiFn, toolGateway }) {
  const siteRoot = join(PACKAGE_ROOT, '.tmp', 'agent-cli-e2e', `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(siteRoot, { recursive: true });
  const session = `agent-cli-e2e-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionDir = join(siteRoot, '.narada', 'crew', 'nars-sessions', session);
  mkdirSync(sessionDir, { recursive: true });

  const runtimeInput = new PassThrough();
  const runtimeOutput = new PassThrough();
  const eventHub = createEventHub();
  const events = [];
  let runtimeBuffer = '';
  const runtimeContext = createNarsRuntimeContext({
    identity: 'narada.test',
    session,
    siteRoot,
    sessionPath: join(sessionDir, 'session.jsonl'),
    eventsPath: join(sessionDir, 'events.jsonl'),
    intelligenceProvider: 'fixture-provider',
    providerSettings: { model: 'fixture-model', thinking: 'low', stream: false },
  });
  const runtime = createSessionCoreRuntimeService({
    runtimeContext,
    callChatApiFn,
    toolGateway,
    heartbeatIntervalMs: 0,
  });
  const projection = await startEventStreamProjection({
    childStdin: () => runtimeInput,
    eventHub,
    host: '127.0.0.1',
    port: 0,
    eventsPath: runtimeContext.eventsPath,
  });
  runtimeOutput.setEncoding('utf8');
  runtimeOutput.on('data', (chunk) => {
    runtimeBuffer += String(chunk);
    const lines = runtimeBuffer.split(/\r?\n/);
    runtimeBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      events.push(event);
      eventHub.publish(event);
    }
  });
  const runtimeRun = runtime.run({ input: runtimeInput, output: runtimeOutput });

  async function close() {
    runtimeInput.end();
    await runtimeRun;
    await new Promise((resolve) => projection.server.close(resolve));
    await toolGateway?.close?.();
    rmSync(siteRoot, { recursive: true, force: true });
  }

  return { events, projection, close };
}

function launchAgentCli(endpoint) {
  const child = spawn(process.execPath, [CLI_BIN, '--attach', endpoint], {
    cwd: PACKAGE_ROOT,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const exit = new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    write: (text) => child.stdin.write(text),
    closeInput: () => child.stdin.end(),
    stdout: () => stdout,
    stderr: () => stderr,
    exit,
  };
}

async function closeCli(cli) {
  if (!cli.child.killed) cli.closeInput();
  const result = await cli.exit;
  assert.equal(result.signal, null, `agent-cli exited by signal; stderr=${cli.stderr()}`);
  assert.equal(result.code, 0, `agent-cli exited nonzero; stderr=${cli.stderr()}`);
}

test('agent-cli e2e sends and renders multiple conversation turns', async () => {
  const providerCalls = [];
  const runtime = await startFixtureRuntime({
    callChatApiFn: async (messages) => {
      providerCalls.push(messages.map((message) => ({ ...message })));
      if (providerCalls.length === 1) {
        assert.deepEqual(messages, [{ role: 'user', content: 'first question' }]);
        return { choices: [{ message: { role: 'assistant', content: 'First answer from fixture.' } }] };
      }
      assert.deepEqual(messages, [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'First answer from fixture.' },
        { role: 'user', content: 'second question referencing first' },
      ]);
      return { choices: [{ message: { role: 'assistant', content: 'Second answer saw prior context.' } }] };
    },
    toolGateway: {
      toolCatalog: async () => [],
      invoke: async () => ({ status: 'refused', reason: 'no_fixture_tools' }),
      close: async () => {},
    },
  });
  const cli = launchAgentCli(runtime.projection.url);
  try {
    await waitFor(() => runtime.events.some((event) => event.event === 'session_started'), 7000, 'session_started');
    cli.write('first question\n');
    await waitFor(() => runtime.events.some((event) => event.event === 'assistant_message' && event.content === 'First answer from fixture.'), 7000, 'first_answer');
    cli.write('second question referencing first\n');
    await waitFor(() => {
      if (runtime.events.some((event) => event.event === 'assistant_message' && event.content === 'Second answer saw prior context.')) return true;
      const failed = runtime.events.find((event) => event.event === 'session_control_rejected' || event.event === 'turn_failed');
      if (failed) throw new Error(`second_turn_failed:${JSON.stringify(failed)} providerCalls=${JSON.stringify(providerCalls)}`);
      return false;
    }, 7000, 'second_answer');
    cli.write('/exit\n');
    await closeCli(cli);

    const submitted = runtime.events.filter((event) => event.event === 'user_message').map((event) => event.content);
    assert.deepEqual(submitted, ['first question', 'second question referencing first']);
    assert.equal(providerCalls.length, 2);
    const out = normalizedOutput(cli.stdout());
    const lines = outputLines(cli.stdout());
    assertOrdered(out, ['First answer from fixture.', 'Second answer saw prior context.']);
    assertLineCount(lines, /^operator:$/, 2);
    assertLineCount(lines, /^  first question <timestamp>$/, 1);
    assertLineCount(lines, /^  second question referencing first <timestamp>$/, 1);
    assertLineCount(lines, /^  First answer from fixture\. <timestamp>$/, 1);
    assertLineCount(lines, /^  Second answer saw prior context\. <timestamp>$/, 1);
    assert.equal(countOccurrences(out, 'First answer from fixture.'), 1);
    assert.equal(countOccurrences(out, 'Second answer saw prior context.'), 1);
    assertEventSequence(runtime.events, [
      { event: 'user_message', content: 'first question', status: undefined, tool: undefined },
      { event: 'assistant_message', content: 'First answer from fixture.', status: undefined, tool: undefined },
      { event: 'user_message', content: 'second question referencing first', status: undefined, tool: undefined },
      { event: 'assistant_message', content: 'Second answer saw prior context.', status: undefined, tool: undefined },
    ]);
    assertNoProtocolNoise(out);
    assert.equal(cli.stderr(), '');
    assert.equal(runtime.events.some((event) => event.event === 'session_control_rejected'), false);
  } finally {
    await killCli(cli);
    await runtime.close();
  }
});

test('agent-cli e2e executes and renders fixture tool calls', async () => {
  const providerCalls = [];
  const toolInvocations = [];
  const runtime = await startFixtureRuntime({
    callChatApiFn: async (messages) => {
      providerCalls.push(messages.map((message) => ({ ...message })));
      const hasToolResult = messages.some((message) => message.role === 'tool' && String(message.content).includes('tool result value'));
      if (!hasToolResult) {
        assert.deepEqual(messages, [{ role: 'user', content: 'use the fixture tool' }]);
        return {
          choices: [{
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'call-fixture-lookup', function: { name: 'fixture.lookup', arguments: JSON.stringify({ query: 'operator request' }) } }],
            },
          }],
        };
      }
      assert.equal(messages[0]?.role, 'user');
      assert.equal(messages[0]?.content, 'use the fixture tool');
      assert.equal(messages.some((message) => message.role === 'tool' && String(message.content).includes('tool result value')), true);
      return { choices: [{ message: { role: 'assistant', content: 'Tool result was tool result value.' } }] };
    },
    toolGateway: {
      toolCatalog: async () => [{ type: 'function', function: { name: 'fixture.lookup', parameters: { type: 'object', properties: { query: { type: 'string' } } } } }],
      invoke: async (request) => {
        toolInvocations.push(request);
        return { status: 'completed', value: 'tool result value' };
      },
      close: async () => {},
    },
  });
  const cli = launchAgentCli(runtime.projection.url);
  try {
    await waitFor(() => runtime.events.some((event) => event.event === 'session_started'), 7000, 'session_started');
    cli.write('use the fixture tool\n');
    await waitFor(() => runtime.events.some((event) => event.event === 'assistant_message' && event.content === 'Tool result was tool result value.'), 7000, 'tool_answer');
    cli.write('/exit\n');
    await closeCli(cli);

    assert.equal(providerCalls.length, 2);
    assert.equal(toolInvocations.length, 1);
    assert.equal(toolInvocations[0].toolName, 'fixture.lookup');
    assert.deepEqual(toolInvocations[0].arguments, { query: 'operator request' });
    const out = normalizedOutput(cli.stdout());
    const lines = outputLines(cli.stdout());
    assertOrdered(out, ['fixture.lookup', 'fixture.lookup ok', 'Tool result was tool result value.']);
    assertLineCount(lines, /^operator:$/, 1);
    assertLineCount(lines, /^  use the fixture tool <timestamp>$/, 1);
    assertLineCount(lines, /^narada\.test -> agent-cli: fixture\.lookup <timestamp>$/, 1);
    assertLineCount(lines, /^agent-cli -> narada\.test: fixture\.lookup ok <timestamp>$/, 1);
    assertLineCount(lines, /^  Tool result was tool result value\. <timestamp>$/, 1);
    assertEventSequence(runtime.events, [
      { event: 'user_message', content: 'use the fixture tool', status: undefined, tool: undefined },
      { event: 'carrier_tool_requested', content: undefined, status: undefined, tool: 'fixture.lookup' },
      { event: 'carrier_tool_completed', content: undefined, status: 'completed', tool: 'fixture.lookup' },
      { event: 'assistant_message', content: 'Tool result was tool result value.', status: undefined, tool: undefined },
    ]);
    assertNoProtocolNoise(out);
    assert.equal(cli.stderr(), '');
    assert.equal(runtime.events.some((event) => event.event === 'session_control_rejected'), false);
  } finally {
    await killCli(cli);
    await runtime.close();
  }
});

test('agent-cli e2e renders slash health and exits cleanly', async () => {
  const runtime = await startFixtureRuntime({
    callChatApiFn: async () => ({ choices: [{ message: { role: 'assistant', content: 'unused' } }] }),
    toolGateway: {
      toolCatalog: async () => [],
      invoke: async () => ({ status: 'refused', reason: 'no_fixture_tools' }),
      close: async () => {},
      operationalState: () => 'healthy',
    },
  });
  const cli = launchAgentCli(runtime.projection.url);
  try {
    await waitFor(() => runtime.events.some((event) => event.event === 'session_started'), 7000, 'session_started');
    cli.write('/health\n');
    await waitFor(() => runtime.events.some((event) => event.event === 'session_health'), 7000, 'session_health');
    await waitFor(() => normalizedOutput(cli.stdout()).includes('agent-cli: health healthy;'), 7000, 'visible_session_health');
    cli.write('/exit\n');
    await waitFor(() => normalizedOutput(cli.stdout()).includes('agent-cli: session closed'), 7000, 'visible_session_closed');
    await closeCli(cli);

    const health = runtime.events.find((event) => event.event === 'session_health');
    assert.equal(health.status, 'healthy');
    const out = normalizedOutput(cli.stdout());
    const lines = outputLines(cli.stdout());
    assertLineCount(lines, /^agent-cli: health healthy; mcp disabled; endpoint none <timestamp>$/, 1);
    assertLineCount(lines, /^agent-cli: session closed <timestamp>$/, 1);
    assertNoProtocolNoise(out);
    assert.equal(cli.stderr(), '');
    assert.equal(runtime.events.some((event) => event.event === 'session_control_rejected'), false);
    assert.equal(runtime.events.some((event) => event.event === 'session_closed'), true);
  } finally {
    await killCli(cli);
    await runtime.close();
  }
});
