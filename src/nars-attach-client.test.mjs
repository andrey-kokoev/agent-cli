import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  createNarsEventSubscribeFrame,
  normalizeNarsAttachIncomingEvent,
  runNarsAttachClient,
} from './nars-attach-client.mjs';

test('attach client subscribes and projects operator input as session.submit', async () => {
  const sent = [];
  class FakeWebSocket {
    constructor() {
      this.listeners = new Map();
      queueMicrotask(() => this.emit('open', {}));
    }

    addEventListener(name, listener) {
      const listeners = this.listeners.get(name) ?? [];
      listeners.push(listener);
      this.listeners.set(name, listeners);
    }

    send(value) {
      const frame = JSON.parse(String(value));
      sent.push(frame);
      if (frame.method === 'session.submit') {
        queueMicrotask(() => this.emit('message', {
          data: JSON.stringify({
            schema: 'narada.nars.events.envelope.v1',
            payload: { event: 'assistant_message', agent_id: 'narada.test', content: 'done' },
          }),
        }));
      }
    }

    close() {
      queueMicrotask(() => this.emit('close', {}));
    }

    emit(name, event) {
      for (const listener of this.listeners.get(name) ?? []) listener(event);
    }
  }

  const input = new PassThrough();
  const output = new PassThrough();
  let rendered = '';
  output.setEncoding('utf8');
  output.on('data', (chunk) => { rendered += String(chunk); });
  const running = runNarsAttachClient({
    endpoint: 'ws://runtime.test/events',
    input,
    output,
    WebSocketImpl: FakeWebSocket,
  });
  await new Promise((resolve) => setImmediate(resolve));
  input.end('hello\n');
  assert.equal(await running, 0);
  assert.equal(sent[0].method, 'session.events.subscribe');
  assert.equal(sent.some((frame) => frame.method === 'session.submit' && frame.params.content === 'hello'), true);
  assert.match(rendered, /done/);
});

test('attach event helpers preserve envelopes and replay options', () => {
  assert.deepEqual(createNarsEventSubscribeFrame({ id: 'events-1', maxReplay: 7 }), {
    id: 'events-1',
    method: 'session.events.subscribe',
    params: { include_replay: true, max_replay: 7 },
  });
  assert.deepEqual(
    normalizeNarsAttachIncomingEvent({
      schema: 'narada.nars.events.envelope.v1',
      payload: { event: 'session_health', status: 'healthy' },
    }),
    { event: 'session_health', status: 'healthy' },
  );
});
