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
    callChatApiFn: async () => ({
      choices: [{ message: { role: 'assistant', content: 'session-core response' } }],
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
  const attached = runNarsAttachClient({
    endpoint: projection.url,
    input: attachInput,
    output: attachOutput,
  });

  try {
    await waitFor(() => events.some((event) => event.event === 'session_started'));
    attachInput.write('hello from agent-cli\n');
    await waitFor(() => events.some((event) => event.event === 'assistant_message'));
    attachInput.write('/health\n');
    await waitFor(() => events.some((event) => event.event === 'session_health'));
    assert.match(rendered, /session-core response/);
    assert.equal(events.some((event) => event.event === 'session_control_rejected'), false);
  } finally {
    attachInput.end();
    await attached;
    runtimeInput.end();
    await runtimeRun;
    await new Promise((resolve) => projection.server.close(resolve));
    rmSync(siteRoot, { recursive: true, force: true });
  }
});
