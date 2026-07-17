import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  createEventHub,
  startEventStreamProjection,
} from '@narada2/agent-runtime-server';
import { createNarsRuntimeContext } from '@narada2/agent-runtime-server/runtime-context';
import { createSessionCoreRuntimeService } from '@narada2/agent-runtime-server/session-core-runtime-service';
import { runNarsAttachClient } from './nars-attach-client.mjs';

function waitFor(predicate, timeoutMs = 5000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const value = predicate();
      if (value) return resolve(value);
      if (Date.now() - started >= timeoutMs) return reject(new Error('attach_runtime_timeout'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

test('agent-cli attaches to the session-core runtime without constructing provider or MCP hosts', async () => {
  const siteRoot = mkdtempSync(join(tmpdir(), 'agent-cli-session-core-attach-'));
  const session = 'agent-cli-attach-runtime';
  const sessionDir = join(siteRoot, '.narada', 'crew', 'nars-sessions', session);
  mkdirSync(sessionDir, { recursive: true });
  const runtimeInput = new PassThrough();
  const runtimeOutput = new PassThrough();
  const eventHub = createEventHub();
  const events = [];
  let outputBuffer = '';
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
    callChatApiFn: async (messages) => ({
      choices: [{
        message: {
          role: 'assistant',
          content: messages.at(-1)?.content === 'pre-attach replay request'
            ? 'pre-attach replay response'
            : 'session-core response',
        },
      }],
    }),
    toolGateway: {
      toolCatalog: async () => [],
      invoke: async () => ({ status: 'refused', reason: 'no_fixture_tools' }),
      close: async () => {},
    },
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
    outputBuffer += String(chunk);
    const lines = outputBuffer.split(/\r?\n/);
    outputBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      events.push(event);
      eventHub.publish(event);
    }
  });
  const runtimeRun = runtime.run({ input: runtimeInput, output: runtimeOutput });

  const attachInput = new PassThrough();
  const attachOutput = new PassThrough();
  let rendered = '';
  attachOutput.setEncoding('utf8');
  attachOutput.on('data', (chunk) => { rendered += String(chunk); });
  let attached = null;

  try {
    await waitFor(() => events.some((event) => event.event === 'session_started'));
    runtimeInput.write(`${JSON.stringify({ id: 'replay-1', method: 'session.submit', params: { content: 'pre-attach replay request' } })}\n`);
    await waitFor(() => events.some((event) => event.event === 'assistant_message' && event.content === 'pre-attach replay response'));
    attached = runNarsAttachClient({
      endpoint: projection.url,
      input: attachInput,
      output: attachOutput,
    });
    await waitFor(() => rendered.includes('pre-attach replay response'));
    attachInput.write('hello from agent-cli\n');
    await waitFor(() => events.some((event) => event.event === 'assistant_message' && event.content === 'session-core response'));
    attachInput.write('/health\n');
    await waitFor(() => events.some((event) => event.event === 'session_health'));
    await waitFor(() => rendered.includes('session-core response'));
    assert.match(rendered, /session-core response/);
    assert.match(rendered, /pre-attach replay response/);
    assert.ok(rendered.indexOf('pre-attach replay response') < rendered.indexOf('session-core response'));
    const durableSequences = events
      .map((event) => Number(event.event_sequence ?? event.sequence))
      .filter(Number.isFinite);
    assert.ok(durableSequences.length >= 2);
    assert.deepEqual(durableSequences, [...durableSequences].sort((left, right) => left - right));
    assert.equal(events.some((event) => event.event === 'session_control_rejected'), false);
  } finally {
    attachInput.end();
    if (attached) await attached;
    runtimeInput.end();
    await runtimeRun;
    await new Promise((resolve) => projection.server.close(resolve));
    rmSync(siteRoot, { recursive: true, force: true });
  }
});

test('agent-cli reconnects and resubscribes after an event-stream disconnect', async () => {
  const siteRoot = mkdtempSync(join(tmpdir(), 'agent-cli-reconnect-attach-'));
  const session = 'agent-cli-reconnect-runtime';
  const sessionDir = join(siteRoot, '.narada', 'crew', 'nars-sessions', session);
  mkdirSync(sessionDir, { recursive: true });
  const runtimeInput = new PassThrough();
  const runtimeOutput = new PassThrough();
  const eventHub = createEventHub();
  const events = [];
  let outputBuffer = '';
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
    callChatApiFn: async (messages) => ({
      choices: [{ message: { role: 'assistant', content: `reconnect response to ${messages.at(-1)?.content}` } }],
    }),
    toolGateway: {
      toolCatalog: async () => [],
      invoke: async () => ({ status: 'refused', reason: 'no_fixture_tools' }),
      close: async () => {},
    },
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
    outputBuffer += String(chunk);
    const lines = outputBuffer.split(/\r?\n/);
    outputBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      events.push(event);
      eventHub.publish(event);
    }
  });
  const runtimeRun = runtime.run({ input: runtimeInput, output: runtimeOutput });

  const attachInput = new PassThrough();
  const attachOutput = new PassThrough();
  let rendered = '';
  attachOutput.setEncoding('utf8');
  attachOutput.on('data', (chunk) => { rendered += String(chunk); });
  let attached = null;

  try {
    await waitFor(() => events.some((event) => event.event === 'session_started'));
    runtimeInput.write(`${JSON.stringify({
      id: 'reconnect-pre-attach',
      method: 'session.submit',
      params: { content: 'before reconnect' },
    })}\n`);
    await waitFor(() => events.some((event) => (
      event.event === 'assistant_message' && event.content === 'reconnect response to before reconnect'
    )));
    attached = runNarsAttachClient({
      endpoint: projection.url,
      input: attachInput,
      output: attachOutput,
    });
    await waitFor(() => rendered.includes('reconnect response to before reconnect'));
    await waitFor(() => projection.subscribeRequests.length >= 1);

    projection.closeConnections();
    await waitFor(() => projection.subscribeRequests.length >= 2);
    const firstSubscription = projection.subscribeRequests[0];
    const secondSubscription = projection.subscribeRequests[1];
    assert.equal(secondSubscription.params.include_replay, true);
    assert.equal(secondSubscription.params.subscription_id, firstSubscription.params.subscription_id);
    assert.ok(Number.isInteger(secondSubscription.params.since_sequence));

    attachInput.write('after reconnect\n');
    await waitFor(() => events.some((event) => (
      event.event === 'assistant_message' && event.content === 'reconnect response to after reconnect'
    )));
    await waitFor(() => rendered.includes('reconnect response to after reconnect'));
    assert.match(rendered, /reconnect response to after reconnect/);
    assert.equal(events.some((event) => event.event === 'session_control_rejected'), false);
  } finally {
    attachInput.end();
    if (attached) await attached;
    runtimeInput.end();
    await runtimeRun;
    await new Promise((resolve) => projection.server.close(resolve));
    rmSync(siteRoot, { recursive: true, force: true });
  }
});
