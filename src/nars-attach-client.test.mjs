import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  createNarsEventSubscribeFrame,
  normalizeNarsAttachIncomingEvent,
  runNarsAttachClient,
} from './nars-attach-client.mjs';

function waitFor(predicate, timeoutMs = 1000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started >= timeoutMs) return reject(new Error('attach_client_test_timeout'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

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
    includeReplay: false,
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

test('attach client ignores malformed inbound frames and keeps rendering subsequent events', async () => {
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
      if (frame.method === 'session.events.subscribe') {
        queueMicrotask(() => {
          this.emit('message', { data: '{not-json' });
          this.emit('message', {
            data: JSON.stringify({
              schema: 'narada.nars.events.envelope.v1',
              payload: { event: 'assistant_message', agent_id: 'narada.test', content: 'still connected' },
            }),
          });
        });
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
  input.end('\n');
  assert.equal(await running, 0);
  assert.equal(sent[0].method, 'session.events.subscribe');
  assert.match(rendered, /still connected/);
});

test('attach client rejects a WebSocket transport error', async () => {
  class ErrorWebSocket {
    constructor() {
      this.listeners = new Map();
      queueMicrotask(() => this.emit('open', {}));
      queueMicrotask(() => this.emit('error', new Error('fixture socket failed')));
    }

    addEventListener(name, listener) {
      const listeners = this.listeners.get(name) ?? [];
      listeners.push(listener);
      this.listeners.set(name, listeners);
    }

    send() {}

    emit(name, event) {
      for (const listener of this.listeners.get(name) ?? []) listener(event);
    }
  }

  const input = new PassThrough();
  const output = new PassThrough();
  await assert.rejects(
    runNarsAttachClient({
      endpoint: 'ws://runtime.test/events',
      input,
      output,
      WebSocketImpl: ErrorWebSocket,
      reconnect: false,
    }),
    /NARS attach WebSocket error/,
  );
  input.destroy();
});

test('attach client reports an unexpected server close when reconnect is disabled', async () => {
  class ClosingWebSocket {
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
      if (frame.method === 'session.events.subscribe') queueMicrotask(() => this.emit('close', {}));
    }

    emit(name, event) {
      for (const listener of this.listeners.get(name) ?? []) listener(event);
    }
  }

  const input = new PassThrough();
  const output = new PassThrough();
  await assert.rejects(runNarsAttachClient({
    endpoint: 'ws://runtime.test/events',
    input,
    output,
    WebSocketImpl: ClosingWebSocket,
    reconnect: false,
  }), /NARS attach WebSocket closed/);
  input.destroy();
});

test('attach client deduplicates durable frames and replays a detected sequence gap', async () => {
  const sent = [];
  class SequencedWebSocket {
    constructor() {
      this.listeners = new Map();
      this.subscribeCount = 0;
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
      if (frame.method !== 'session.events.subscribe') return;
      this.subscribeCount += 1;
      if (this.subscribeCount === 1) {
        queueMicrotask(() => {
          this.emitEvent(1, 'first durable event');
          this.emitEvent(1, 'duplicate durable event');
          this.emitEvent(3, 'future event before recovery');
        });
      } else {
        queueMicrotask(() => {
          this.emitEvent(2, 'missing durable event');
          this.emitEvent(3, 'recovered durable event');
          this.emit('message', { data: JSON.stringify({ event: 'session_events_replay_completed' }) });
        });
      }
    }

    emitEvent(sequence, content) {
      this.emit('message', {
        data: JSON.stringify({
          event: 'assistant_message',
          event_sequence: sequence,
          agent_id: 'narada.test',
          content,
        }),
      });
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
    WebSocketImpl: SequencedWebSocket,
    reconnect: false,
  });

  await waitFor(() => rendered.includes('recovered durable event'));
  input.end('\n');
  assert.equal(await running, 0);
  const subscriptions = sent.filter((frame) => frame.method === 'session.events.subscribe');
  assert.equal(subscriptions.length, 2);
  assert.equal(subscriptions[1].params.since_sequence, 1);
  assert.equal(subscriptions[0].params.subscription_id, subscriptions[1].params.subscription_id);
  assert.match(rendered, /first durable event/);
  assert.match(rendered, /missing durable event/);
  assert.match(rendered, /recovered durable event/);
  assert.doesNotMatch(rendered, /duplicate durable event/);
  assert.doesNotMatch(rendered, /future event before recovery/);
});
