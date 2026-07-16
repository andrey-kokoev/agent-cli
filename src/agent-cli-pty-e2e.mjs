import assert from 'node:assert/strict';
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
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

let ptyModule = null;
try {
  ptyModule = await import('node-pty');
} catch (error) {
  if (process.env.NARADA_AGENT_CLI_PTY_E2E === 'skip') {
    test('agent-cli PTY e2e skipped by NARADA_AGENT_CLI_PTY_E2E=skip', { skip: 'PTY dependency unavailable by explicit opt-out' }, () => {});
  } else {
    test('agent-cli PTY e2e requires node-pty', () => {
      throw new Error(`node-pty unavailable; run pnpm install or set NARADA_AGENT_CLI_PTY_E2E=skip to opt out: ${error?.message ?? error}`);
    });
  }
}

const pty = ptyModule?.default ?? ptyModule;

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
      if (value) return resolve(value);
      if (Date.now() - started >= timeoutMs) return reject(new Error(`agent_cli_pty_e2e_timeout:${label}`));
      setTimeout(tick, 20);
    };
    tick();
  });
}

function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  return Promise.race([
    promise.finally(() => { if (timer) clearTimeout(timer); }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`agent_cli_pty_e2e_timeout:${label}`)), timeoutMs);
    }),
  ]);
}

function stripAnsi(value) {
  return String(value ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

function normalizedScreen(value) {
  return stripAnsi(value)
    .replace(/\r/g, '')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, '<timestamp>');
}

function assertNoProtocolNoise(text) {
  assert.doesNotMatch(text, /"method"\s*:/);
  assert.doesNotMatch(text, /"params"\s*:/);
  assert.doesNotMatch(text, /narada\.nars\.events\.envelope\.v1/);
  assert.doesNotMatch(text, /(?:UnhandledPromiseRejection|TypeError:|SyntaxError:)/);
}

function parseJsonLinesFromChunk(chunk) {
  return String(chunk ?? '').split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
}

async function startFixtureRuntime({ callChatApiFn, toolGateway }) {
  const siteRoot = join(PACKAGE_ROOT, '.tmp', 'agent-cli-pty-e2e', `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(siteRoot, { recursive: true });
  const session = `agent-cli-pty-e2e-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionDir = join(siteRoot, '.narada', 'crew', 'nars-sessions', session);
  mkdirSync(sessionDir, { recursive: true });

  const runtimeInput = new PassThrough();
  const runtimeOutput = new PassThrough();
  const frames = [];
  const originalWrite = runtimeInput.write.bind(runtimeInput);
  runtimeInput.write = (chunk, ...args) => {
    try {
      frames.push(...parseJsonLinesFromChunk(chunk));
    } catch {
      frames.push({ parse_error: true, raw: String(chunk ?? '') });
    }
    return originalWrite(chunk, ...args);
  };

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

  return { events, frames, projection, close };
}

function keySequence(name) {
  const keys = {
    enter: '\r',
    home: '\x1b[H',
    end: '\x1b[F',
    left: '\x1b[D',
    right: '\x1b[C',
    ctrlLeft: '\x1b[1;5D',
    ctrlRight: '\x1b[1;5C',
  };
  if (!Object.hasOwn(keys, name)) throw new Error(`unknown_pty_key:${name}`);
  return keys[name];
}

function spawnAgentCliPty(endpoint, { columns = 100, rows = 30 } = {}) {
  let output = '';
  const terminal = pty.spawn(process.execPath, [CLI_BIN, '--attach', endpoint], {
    cwd: PACKAGE_ROOT,
    cols: columns,
    rows,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  terminal.onData((data) => { output += data; });
  const exit = new Promise((resolve) => {
    terminal.onExit((event) => resolve(event));
  });
  return {
    write: (text) => terminal.write(text),
    paste: (text) => {
      terminal.write(PASTE_START);
      terminal.write(String(text ?? ''));
      terminal.write(PASTE_END);
    },
    key: (name) => terminal.write(keySequence(name)),
    raw: () => output,
    screenText: () => normalizedScreen(output),
    waitForScreen: async (pattern, label) => {
      try {
        return await waitFor(() => {
          const screen = normalizedScreen(output);
          return typeof pattern === 'string' ? screen.includes(pattern) : pattern.test(screen);
        }, 7000, label);
      } catch (error) {
        throw new Error(`${error?.message ?? error}\nscreen=${JSON.stringify(normalizedScreen(output))}`);
      }
    },
    kill: () => {
      try { terminal.kill(); } catch {}
    },
    exit,
  };
}

async function closePty(cli) {
  cli.write('/exit\r');
  await cli.waitForScreen('agent-cli: session closed', 'session_closed_screen');
  const result = await withTimeout(cli.exit, 3000, 'pty_exit_after_session_closed');
  assert.equal(result.exitCode, 0, `agent-cli PTY exited nonzero; screen=${cli.screenText()}`);
}

async function createSimpleRuntime({ holdFirstTurn = false } = {}) {
  const providerCalls = [];
  let releaseFirstTurn = null;
  const firstTurnGate = holdFirstTurn ? new Promise((resolve) => { releaseFirstTurn = resolve; }) : null;
  const runtime = await startFixtureRuntime({
    callChatApiFn: async (messages) => {
      providerCalls.push(messages.map((message) => ({ ...message })));
      if (firstTurnGate && providerCalls.length === 1) await firstTurnGate;
      return { choices: [{ message: { role: 'assistant', content: `fixture saw ${messages.at(-1)?.content}` } }] };
    },
    toolGateway: {
      toolCatalog: async () => [],
      invoke: async () => ({ status: 'refused', reason: 'no_fixture_tools' }),
      close: async () => {},
    },
  });
  return { ...runtime, providerCalls, releaseFirstTurn };
}

function submittedFrames(runtime) {
  return runtime.frames.filter((frame) => frame.method === 'session.submit');
}

function userMessages(runtime) {
  return runtime.events.filter((event) => event.event === 'user_message').map((event) => event.content);
}

if (pty) {
  test('agent-cli PTY keeps single-line paste editable until enter', async () => {
    const runtime = await createSimpleRuntime();
    const cli = spawnAgentCliPty(runtime.projection.url);
    try {
      await waitFor(() => runtime.events.some((event) => event.event === 'session_started'), 7000, 'session_started');
      cli.paste('"x"');
      cli.write(' plus y');
      await cli.waitForScreen('operator > "x" plus y', 'single_line_draft');
      assert.equal(submittedFrames(runtime).length, 0);
      cli.key('enter');
      await waitFor(() => userMessages(runtime).includes('"x" plus y'), 7000, 'submitted_single_line_paste');
      await cli.waitForScreen('fixture saw "x" plus y', 'single_line_assistant');

      assert.deepEqual(userMessages(runtime), ['"x" plus y']);
      assert.equal(submittedFrames(runtime).length, 1);
      assert.equal(submittedFrames(runtime)[0].params.content, '"x" plus y');
      assertNoProtocolNoise(cli.screenText());
    } finally {
      await closePty(cli).catch(() => cli.kill());
      await runtime.close();
    }
  });

  test('agent-cli PTY keeps multiline paste as one draft and one turn', async () => {
    const runtime = await createSimpleRuntime();
    const cli = spawnAgentCliPty(runtime.projection.url);
    const pasted = 'line 1\nline 2\nline 3';
    try {
      await waitFor(() => runtime.events.some((event) => event.event === 'session_started'), 7000, 'session_started');
      cli.paste(pasted);
      await cli.waitForScreen(/operator > line 1[\s\S]*line 2[\s\S]*line 3/, 'multiline_draft');
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.equal(submittedFrames(runtime).length, 0);
      cli.key('enter');
      await waitFor(() => userMessages(runtime).includes(pasted), 7000, 'submitted_multiline_paste');
      await cli.waitForScreen('fixture saw line 1', 'multiline_assistant');

      assert.deepEqual(userMessages(runtime), [pasted]);
      assert.equal(submittedFrames(runtime).length, 1);
      assert.equal(submittedFrames(runtime)[0].params.content, pasted);
      assert.equal(cli.screenText().includes('line 3or > line 1'), false);
      assertNoProtocolNoise(cli.screenText());
    } finally {
      await closePty(cli).catch(() => cli.kill());
      await runtime.close();
    }
  });

  test('agent-cli PTY keeps slash-looking multiline paste as prose', async () => {
    const runtime = await createSimpleRuntime();
    const cli = spawnAgentCliPty(runtime.projection.url);
    const pasted = '/health\nthis is copied prose, not a command sequence';
    try {
      await waitFor(() => runtime.events.some((event) => event.event === 'session_started'), 7000, 'session_started');
      cli.paste(pasted);
      await cli.waitForScreen(/operator > \/health[\s\S]*this is copied prose, not a command sequence/, 'slash_paste_draft');
      assert.equal(runtime.frames.some((frame) => frame.method === 'session.health'), false);
      cli.key('enter');
      await waitFor(() => userMessages(runtime).includes(pasted), 7000, 'submitted_slash_paste');

      assert.equal(runtime.frames.some((frame) => frame.method === 'session.health'), false);
      assert.equal(submittedFrames(runtime).length, 1);
      assert.equal(submittedFrames(runtime)[0].params.content, pasted);
    } finally {
      await closePty(cli).catch(() => cli.kill());
      await runtime.close();
    }
  });

  test('agent-cli PTY navigation keys edit draft without leaking escapes', async () => {
    const runtime = await createSimpleRuntime();
    const cli = spawnAgentCliPty(runtime.projection.url);
    try {
      await waitFor(() => runtime.events.some((event) => event.event === 'session_started'), 7000, 'session_started');
      cli.write('abc');
      cli.key('home');
      cli.write('X');
      cli.key('end');
      cli.write('Y');
      cli.key('left');
      cli.write('Z');
      await cli.waitForScreen('operator > XabcZY', 'navigation_draft');
      for (const fragment of ['[H', '[F', '[D', '[1~', '[4~']) {
        assert.equal(cli.screenText().includes(fragment), false, `screen leaked ${fragment}: ${cli.screenText()}`);
      }
      cli.key('enter');
      await waitFor(() => userMessages(runtime).includes('XabcZY'), 7000, 'submitted_navigation_edit');
      assert.equal(submittedFrames(runtime).length, 1);
      assert.equal(submittedFrames(runtime)[0].params.content, 'XabcZY');
    } finally {
      await closePty(cli).catch(() => cli.kill());
      await runtime.close();
    }
  });

  test('agent-cli PTY ctrl-arrow is deterministic and does not leak escapes', async () => {
    const runtime = await createSimpleRuntime();
    const cli = spawnAgentCliPty(runtime.projection.url);
    try {
      await waitFor(() => runtime.events.some((event) => event.event === 'session_started'), 7000, 'session_started');
      cli.write('alpha beta');
      cli.key('ctrlLeft');
      cli.write('X');
      cli.key('ctrlRight');
      cli.write('Y');
      await cli.waitForScreen('operator > alpha betXaY', 'ctrl_arrow_draft');
      for (const fragment of ['[1;5D', '[1;5C']) {
        assert.equal(cli.screenText().includes(fragment), false, `screen leaked ${fragment}: ${cli.screenText()}`);
      }
      cli.key('enter');
      await waitFor(() => userMessages(runtime).includes('alpha betXaY'), 7000, 'submitted_ctrl_arrow_edit');
      assert.equal(submittedFrames(runtime)[0].params.content, 'alpha betXaY');
    } finally {
      await closePty(cli).catch(() => cli.kill());
      await runtime.close();
    }
  });

  test('agent-cli PTY sends active-turn input as steering before turn completion', async () => {
    const runtime = await createSimpleRuntime({ holdFirstTurn: true });
    const cli = spawnAgentCliPty(runtime.projection.url);
    try {
      await waitFor(() => runtime.events.some((event) => event.event === 'session_started'), 7000, 'session_started');
      cli.write('start slow turn');
      cli.key('enter');
      const turnStarted = await waitFor(
        () => runtime.events.find((event) => event.event === 'turn_started'),
        7000,
        'turn_started',
      );
      cli.write('steer this turn');
      cli.key('enter');
      await waitFor(() => submittedFrames(runtime).length >= 2, 7000, 'steering_frame');
      assert.equal(runtime.events.some((event) => event.event === 'turn_complete'), false);

      const steering = submittedFrames(runtime)[1];
      assert.equal(steering.params.content, 'steer this turn');
      assert.equal(steering.params.source, 'operator_steering');
      assert.equal(steering.params.delivery_mode, 'admit_after_active_turn');
      assert.equal(steering.params.active_turn_id, turnStarted.turn_id);

      runtime.releaseFirstTurn();
      await waitFor(() => runtime.events.some((event) => event.event === 'turn_complete'), 7000, 'turn_complete');
    } finally {
      await closePty(cli).catch(() => cli.kill());
      await runtime.close();
    }
  });
}
