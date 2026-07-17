import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import xtermHeadless from '@xterm/headless';
import {
  createEventHub,
  startEventStreamProjection,
} from '@narada2/agent-runtime-server';
import { createNarsRuntimeContext } from '@narada2/agent-runtime-server/runtime-context';
import { createSessionCoreRuntimeService } from '@narada2/agent-runtime-server/session-core-runtime-service';

const PACKAGE_ROOT = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const CLI_BIN = join(PACKAGE_ROOT, 'bin', 'narada-agent-cli.mjs');
const { Terminal } = xtermHeadless;
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

async function waitFor(predicate, timeoutMs = 7000, label = 'condition') {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      let value;
      try {
        value = await predicate();
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

function normalizedText(value) {
  return String(value ?? '')
    .replace(/\r/g, '')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, '<timestamp>');
}

function assertNoProtocolNoise(text) {
  assert.doesNotMatch(text, /"method"\s*:/);
  assert.doesNotMatch(text, /"params"\s*:/);
  assert.doesNotMatch(text, /narada\.nars\.events\.envelope\.v1/);
  assert.doesNotMatch(text, /(?:UnhandledPromiseRejection|TypeError:|SyntaxError:)/);
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
  let frameBuffer = '';
  const originalWrite = runtimeInput.write.bind(runtimeInput);
  runtimeInput.write = (chunk, ...args) => {
    frameBuffer += String(chunk ?? '');
    const lines = frameBuffer.split(/\r?\n/);
    frameBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        frames.push(JSON.parse(line));
      } catch {
        frames.push({ parse_error: true, raw: line });
      }
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
    if (frameBuffer.trim()) frames.push({ parse_error: true, raw: frameBuffer });
    assert.equal(
      frames.some((frame) => frame.parse_error),
      false,
      'fixture observed malformed protocol frame: ' + JSON.stringify(frames.find((frame) => frame.parse_error)),
    );
    await new Promise((resolve) => projection.server.close(resolve));
    await toolGateway?.close?.();
    rmSync(siteRoot, { recursive: true, force: true });
  }

  return { events, frames, projection, runtimeInput, close };
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
  let screenRows = rows;
  const screenTerminal = new Terminal({
    allowProposedApi: true,
    cols: columns,
    logLevel: 'off',
    rows,
    convertEol: true,
    scrollback: 1000,
  });
  const terminal = pty.spawn(process.execPath, [CLI_BIN, '--attach', endpoint], {
    cwd: PACKAGE_ROOT,
    cols: columns,
    rows,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  terminal.onData((data) => {
    output += data;
    try {
      screenTerminal.write(data);
    } catch {}
  });
  const readScreen = () => {
    try {
      const buffer = screenTerminal.buffer.active;
      const viewportY = buffer.viewportY ?? buffer.baseY ?? 0;
      return normalizedText(Array.from({ length: screenRows }, (_, row) => (
        buffer.getLine(viewportY + row)?.translateToString(true).replace(/\s+$/u, '') ?? ''
      )).join('\n'));
    } catch {
      return '';
    }
  };
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
    resize: (nextColumns, nextRows) => {
      terminal.resize(nextColumns, nextRows);
      screenRows = nextRows;
      screenTerminal.resize(nextColumns, nextRows);
    },
    raw: () => output,
    screenText: readScreen,
    waitForScreen: async (pattern, label) => {
      try {
        return await waitFor(() => {
          const screen = readScreen();
          return typeof pattern === 'string' ? screen.includes(pattern) : pattern.test(screen);
        }, 7000, label);
      } catch (error) {
        throw new Error(String(error?.message ?? error) + '\nscreen=' + JSON.stringify(readScreen()));
      }
    },
    dispose: () => screenTerminal.dispose(),
    kill: async () => {
      try { terminal.kill(); } catch {}
      screenTerminal.dispose();
      try {
        await withTimeout(exit, 1000, 'pty_kill');
      } catch {}
    },
    exit,
  };
}

async function closePty(cli) {
  if (!cli) return;
  cli.write('/exit\r');
  await cli.waitForScreen('agent-cli: session closed', 'session_closed_screen');
  const result = await withTimeout(cli.exit, 3000, 'pty_exit_after_session_closed');
  assert.equal(result.exitCode, 0, `agent-cli PTY exited nonzero; screen=${cli.screenText()}`);
  assertNoProtocolNoise(cli.raw());
  cli.dispose();
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

async function createCancellableRuntime() {
  return startFixtureRuntime({
    callChatApiFn: async (_messages, _tools, settings) => new Promise((_resolve, reject) => {
      const abort = () => reject(new Error('fixture provider aborted'));
      if (settings?.abortSignal?.aborted) {
        abort();
        return;
      }
      settings?.abortSignal?.addEventListener('abort', abort, { once: true });
    }),
    toolGateway: {
      toolCatalog: async () => [],
      invoke: async () => ({ status: 'refused', reason: 'no_fixture_tools' }),
      close: async () => {},
    },
  });
}

async function createToolRuntime() {
  const providerCalls = [];
  const toolInvocations = [];
  const runtime = await startFixtureRuntime({
    callChatApiFn: async (messages) => {
      providerCalls.push(messages.map((message) => ({ ...message })));
      const hasToolResult = messages.some((message) => (
        message.role === 'tool' && String(message.content).includes('tool result value')
      ));
      if (!hasToolResult) {
        assert.deepEqual(messages, [{ role: 'user', content: 'use the fixture tool' }]);
        return {
          choices: [{
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call-fixture-lookup',
                function: {
                  name: 'fixture.lookup',
                  arguments: JSON.stringify({ query: 'operator request' }),
                },
              }],
            },
          }],
        };
      }
      return { choices: [{ message: { role: 'assistant', content: 'Tool result was tool result value.' } }] };
    },
    toolGateway: {
      toolCatalog: async () => [{
        type: 'function',
        function: {
          name: 'fixture.lookup',
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
        },
      }],
      invoke: async (request) => {
        toolInvocations.push(request);
        return { status: 'completed', value: 'tool result value' };
      },
      close: async () => {},
    },
  });
  return { ...runtime, providerCalls, toolInvocations };
}

function submittedFrames(runtime) {
  return runtime.frames.filter((frame) => frame.method === 'session.submit');
}

function userMessages(runtime) {
  return runtime.events.filter((event) => event.event === 'user_message').map((event) => event.content);
}

if (pty) {
  test('agent-cli PTY replays durable events through the spawned CLI process', async () => {
    const runtime = await createSimpleRuntime();
    let cli = null;
    try {
      await waitFor(() => runtime.events.some((event) => event.event === 'session_started'), 7000, 'session_started');
      runtime.runtimeInput.write(`${JSON.stringify({
        id: 'pty-replay-submit',
        method: 'session.submit',
        params: { content: 'pre-attach process replay' },
      })}\n`);
      await waitFor(() => runtime.events.some((event) => (
        event.event === 'assistant_message' && event.content === 'fixture saw pre-attach process replay'
      )), 7000, 'pre_attach_assistant');

      cli = spawnAgentCliPty(runtime.projection.url);
      await cli.waitForScreen('fixture saw pre-attach process replay', 'process_replay_screen');
      assert.equal(runtime.frames.some((frame) => (
        frame.method === 'session.submit' && frame.params.content === 'pre-attach process replay'
      )), true);
      assertNoProtocolNoise(cli.screenText());
    } finally {
      if (cli) await closePty(cli).catch(() => cli.kill());
      await runtime.close();
    }
  });

  test('agent-cli PTY cancels an active turn with Ctrl-C', async () => {
    const runtime = await createCancellableRuntime();
    let cli = null;
    try {
      cli = spawnAgentCliPty(runtime.projection.url);
      await waitFor(() => runtime.events.some((event) => event.event === 'session_started'), 7000, 'session_started');
      cli.write('start ctrl-c turn');
      cli.key('enter');
      await waitFor(() => runtime.events.some((event) => event.event === 'turn_started'), 7000, 'turn_started');
      cli.write('\x03');
      const cancelled = await waitFor(
        () => runtime.events.find((event) => event.event === 'session_cancel' && event.cancelled === true),
        7000,
        'ctrl_c_session_cancel',
      );
      const interrupted = await waitFor(
        () => runtime.events.find((event) => (
          event.event === 'turn_interrupted' && (event.terminal_state ?? event.terminal_status) === 'interrupted'
        )),
        7000,
        'ctrl_c_turn_interrupted',
      );
      await waitFor(() => runtime.events.some((event) => (
        event.event === 'carrier_turn_failed' && event.error === 'fixture provider aborted'
      )), 7000, 'ctrl_c_provider_aborted');
      assert.equal(cancelled.cancelled, true);
      assert.equal(interrupted.terminal_state ?? interrupted.terminal_status, 'interrupted');
      const cancelFrames = runtime.frames.filter((frame) => frame.method === 'session.cancel');
      assert.equal(cancelFrames.length, 1);
      assert.deepEqual(cancelFrames[0].params, {});
      assertNoProtocolNoise(cli.screenText());
    } finally {
      if (cli) await closePty(cli).catch(() => cli.kill());
      await runtime.close();
    }
  });

  test('agent-cli PTY keeps single-line paste editable until enter', async () => {
    const runtime = await createSimpleRuntime();
    let cli = null;
    try {
      cli = spawnAgentCliPty(runtime.projection.url);
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
      if (cli) await closePty(cli).catch(() => cli.kill());
      await runtime.close();
    }
  });

  test('agent-cli PTY executes and renders fixture tool calls', async () => {
    const runtime = await createToolRuntime();
    let cli = null;
    try {
      cli = spawnAgentCliPty(runtime.projection.url);
      await waitFor(() => runtime.events.some((event) => event.event === 'session_started'), 7000, 'session_started');
      cli.write('use the fixture tool');
      cli.key('enter');
      await waitFor(() => runtime.events.find((event) => event.event === 'carrier_tool_requested'), 7000, 'tool_requested');
      await waitFor(() => runtime.events.find((event) => (
        event.event === 'carrier_tool_completed' && event.status === 'completed'
      )), 7000, 'tool_completed');
      await waitFor(() => runtime.events.find((event) => (
        event.event === 'assistant_message' && event.content === 'Tool result was tool result value.'
      )), 7000, 'tool_answer');
      await cli.waitForScreen('fixture.lookup', 'tool_name_screen');
      await cli.waitForScreen('fixture.lookup ok', 'tool_completed_screen');
      await cli.waitForScreen('Tool result was tool result value.', 'tool_answer_screen');

      assert.equal(runtime.providerCalls.length, 2);
      assert.equal(runtime.toolInvocations.length, 1);
      assert.equal(runtime.toolInvocations[0].toolName, 'fixture.lookup');
      assert.deepEqual(runtime.toolInvocations[0].arguments, { query: 'operator request' });
      assert.deepEqual(submittedFrames(runtime).map((frame) => frame.params.content), ['use the fixture tool']);
      assertNoProtocolNoise(cli.screenText());
    } finally {
      if (cli) await closePty(cli).catch(() => cli.kill());
      await runtime.close();
    }
  });

  test('agent-cli PTY keeps multiline paste as one draft and one turn', async () => {
    const runtime = await createSimpleRuntime();
    let cli = null;
    const pasted = 'line 1\nline 2\nline 3';
    try {
      cli = spawnAgentCliPty(runtime.projection.url);
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
      if (cli) await closePty(cli).catch(() => cli.kill());
      await runtime.close();
    }
  });

  test('agent-cli PTY keeps slash-looking multiline paste as prose', async () => {
    const runtime = await createSimpleRuntime();
    let cli = null;
    const pasted = '/health\nthis is copied prose, not a command sequence';
    try {
      cli = spawnAgentCliPty(runtime.projection.url);
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
      if (cli) await closePty(cli).catch(() => cli.kill());
      await runtime.close();
    }
  });

  test('agent-cli PTY navigation keys edit draft without leaking escapes', async () => {
    const runtime = await createSimpleRuntime();
    let cli = null;
    try {
      cli = spawnAgentCliPty(runtime.projection.url);
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
      if (cli) await closePty(cli).catch(() => cli.kill());
      await runtime.close();
    }
  });

  test('agent-cli PTY ctrl-arrow is deterministic and does not leak escapes', async () => {
    const runtime = await createSimpleRuntime();
    let cli = null;
    try {
      cli = spawnAgentCliPty(runtime.projection.url);
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
      if (cli) await closePty(cli).catch(() => cli.kill());
      await runtime.close();
    }
  });

  test('agent-cli PTY resizes and preserves Unicode through wrapped input', async () => {
    const runtime = await createSimpleRuntime();
    let cli = null;
    const pasted = `wide 你好 café —🙂 ${'wrapped '.repeat(6)}`;
    try {
      cli = spawnAgentCliPty(runtime.projection.url, { columns: 72, rows: 20 });
      await waitFor(() => runtime.events.some((event) => event.event === 'session_started'), 7000, 'session_started');
      cli.resize(32, 12);
      cli.paste(pasted);
      await cli.waitForScreen(/operator > wide 你好/, 'unicode_wrapped_draft');
      assert.equal(submittedFrames(runtime).length, 0);
      cli.key('enter');
      await waitFor(() => userMessages(runtime).includes(pasted), 7000, 'submitted_unicode_wrapped_input');
      await cli.waitForScreen('fixture saw wide 你好', 'unicode_wrapped_assistant');

      assert.equal(submittedFrames(runtime).length, 1);
      assert.equal(submittedFrames(runtime)[0].params.content, pasted);
      assert.equal(cli.screenText().split('\n').length, 12);
      assertNoProtocolNoise(cli.screenText());
    } finally {
      if (cli) await closePty(cli).catch(() => cli.kill());
      await runtime.close();
    }
  });

  test('agent-cli PTY sends active-turn input as steering before turn completion', async () => {
    const runtime = await createSimpleRuntime({ holdFirstTurn: true });
    let cli = null;
    try {
      cli = spawnAgentCliPty(runtime.projection.url);
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
      const steeringQueued = await waitFor(() => runtime.events.find((event) => (
        event.event === 'input_event_queued' && event.request_id === steering.id
      )), 7000, 'steering_admitted');
      assert.equal(steering.params.content, 'steer this turn');
      assert.equal(steering.params.source, 'operator_steering');
      assert.equal(steering.params.delivery_mode, 'admit_after_active_turn');
      assert.equal(steering.params.active_turn_id, turnStarted.turn_id);
      assert.equal(steeringQueued.request_id, steering.id);
      assert.equal(steeringQueued.admission_state, 'queued');

      runtime.releaseFirstTurn();
      await waitFor(() => runtime.events.some((event) => event.event === 'turn_complete'), 7000, 'turn_complete');
      await cli.waitForScreen('fixture saw start slow turn', 'active_turn_assistant');
      assert.equal(runtime.events.some((event) => (
        event.event === 'assistant_message' && event.content === 'fixture saw start slow turn'
      )), true);
    } finally {
      runtime.releaseFirstTurn?.();
      if (cli) await closePty(cli).catch(() => cli.kill());
      await runtime.close();
    }
  });
}
