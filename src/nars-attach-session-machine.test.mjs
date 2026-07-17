import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ATTACH_SESSION_PHASES,
  createNarsAttachSessionMachine,
} from './nars-attach-session-machine.mjs';

function createMachine(options = {}) {
  return createNarsAttachSessionMachine({
    subscriptionId: 'test-subscription',
    ...options,
  });
}

function enterLive(machine) {
  machine.dispatch({ type: 'START' });
  machine.dispatch({ type: 'SOCKET_OPEN' });
  machine.dispatch({
    type: 'EVENT_RECEIVED',
    event: { event: 'assistant_message' },
    sequence: 1,
  });
  machine.dispatch({
    type: 'EVENT_RECEIVED',
    event: { event: 'session_events_replay_completed' },
  });
}

test('attach session machine enters live after subscription replay completes', () => {
  const machine = createMachine();

  assert.equal(machine.getState().phase, ATTACH_SESSION_PHASES.IDLE);
  assert.deepEqual(machine.dispatch({ type: 'START' }).effects, [{ type: 'connect_socket' }]);
  assert.equal(machine.getState().phase, ATTACH_SESSION_PHASES.CONNECTING);

  const opened = machine.dispatch({ type: 'SOCKET_OPEN' });
  assert.equal(machine.getState().phase, ATTACH_SESSION_PHASES.REPLAYING);
  assert.equal(opened.effects[0].type, 'send_subscribe');
  assert.equal(opened.effects[0].frame.params.include_replay, true);
  assert.equal('since_sequence' in opened.effects[0].frame.params, false);

  machine.dispatch({
    type: 'EVENT_RECEIVED',
    event: { event: 'session_events_replay_completed' },
  });
  assert.equal(machine.getState().phase, ATTACH_SESSION_PHASES.LIVE);
});

test('attach session machine reconnects with the last durable sequence', () => {
  const machine = createMachine({ maxReconnectAttempts: 2, reconnectDelayMs: 10 });
  enterLive(machine);

  const closed = machine.dispatch({ type: 'SOCKET_CLOSED' });
  assert.equal(machine.getState().phase, ATTACH_SESSION_PHASES.RECONNECT_WAIT);
  assert.deepEqual(closed.effects, [{ type: 'schedule_reconnect', delayMs: 10 }]);

  assert.deepEqual(machine.dispatch({ type: 'RECONNECT_TIMER_FIRED' }).effects, [{ type: 'connect_socket' }]);
  const reopened = machine.dispatch({ type: 'SOCKET_OPEN' });
  assert.equal(machine.getState().phase, ATTACH_SESSION_PHASES.REPLAYING);
  assert.equal(reopened.effects[0].frame.params.subscription_id, 'test-subscription');
  assert.equal(reopened.effects[0].frame.params.since_sequence, 1);
});

test('attach session machine recovers a gap once and suppresses stale frames', () => {
  const machine = createMachine();
  enterLive(machine);

  const duplicate = machine.dispatch({
    type: 'EVENT_RECEIVED',
    event: { event: 'assistant_message', content: 'duplicate' },
    sequence: 1,
  });
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.reason, 'stale_sequence');

  const gap = machine.dispatch({
    type: 'EVENT_RECEIVED',
    event: { event: 'assistant_message', content: 'future' },
    sequence: 3,
  });
  assert.equal(gap.accepted, false);
  assert.equal(gap.reason, 'sequence_gap');
  assert.equal(machine.getState().phase, ATTACH_SESSION_PHASES.RECOVERING);
  assert.equal(gap.effects[0].frame.params.since_sequence, 1);

  const repeatedGap = machine.dispatch({
    type: 'EVENT_RECEIVED',
    event: { event: 'assistant_message', content: 'future again' },
    sequence: 4,
  });
  assert.equal(repeatedGap.accepted, false);
  assert.equal(repeatedGap.reason, 'recovery_pending');
  assert.deepEqual(repeatedGap.effects, []);

  assert.equal(machine.dispatch({
    type: 'EVENT_RECEIVED',
    event: { event: 'assistant_message', content: 'missing' },
    sequence: 2,
  }).accepted, true);
  assert.equal(machine.dispatch({
    type: 'EVENT_RECEIVED',
    event: { event: 'assistant_message', content: 'recovered' },
    sequence: 3,
  }).accepted, true);
  machine.dispatch({
    type: 'EVENT_RECEIVED',
    event: { event: 'session_events_replay_completed' },
  });
  assert.equal(machine.getState().phase, ATTACH_SESSION_PHASES.LIVE);
  assert.equal(machine.getState().lastEventSequence, 3);
});

test('attach session machine retries transport failures and then fails terminally', () => {
  const machine = createMachine({ maxReconnectAttempts: 1 });
  enterLive(machine);
  machine.dispatch({ type: 'SOCKET_CLOSED' });
  machine.dispatch({ type: 'RECONNECT_TIMER_FIRED' });
  machine.dispatch({ type: 'SOCKET_OPEN' });

  const failed = machine.dispatch({
    type: 'SOCKET_ERROR',
    error: new Error('fixture transport failure'),
  });
  assert.equal(machine.getState().phase, ATTACH_SESSION_PHASES.FAILED);
  assert.equal(failed.effects[0].type, 'close_socket');
  assert.equal(failed.effects[1].type, 'reject');
  assert.match(failed.effects[1].error.message, /NARS attach WebSocket error/);
});

test('attach session machine sends one cancel per active turn and closes cleanly', () => {
  const machine = createMachine();
  enterLive(machine);
  const cancelFrame = { id: 'cancel-1', method: 'session.cancel', params: {} };

  const firstCancel = machine.dispatch({
    type: 'CANCEL_REQUESTED',
    turnId: 'turn-1',
    frame: cancelFrame,
  });
  assert.equal(firstCancel.cancelRequested, true);
  assert.deepEqual(firstCancel.effects, [{ type: 'send_frame', frame: cancelFrame }]);

  const duplicateCancel = machine.dispatch({
    type: 'CANCEL_REQUESTED',
    turnId: 'turn-1',
    frame: cancelFrame,
  });
  assert.equal(duplicateCancel.cancelRequested, undefined);
  assert.equal(duplicateCancel.reason, 'already_requested');

  machine.dispatch({ type: 'TURN_ACTIVITY_UPDATED', turnId: null });
  const closing = machine.dispatch({ type: 'CLOSE_REQUESTED', socketPresent: true });
  assert.equal(machine.getState().phase, ATTACH_SESSION_PHASES.CLOSING);
  assert.deepEqual(closing.effects, [{ type: 'cancel_reconnect' }, { type: 'close_socket' }]);
  const closed = machine.dispatch({ type: 'SOCKET_CLOSED' });
  assert.equal(machine.getState().phase, ATTACH_SESSION_PHASES.CLOSED);
  assert.deepEqual(closed.effects, [{ type: 'resolve', value: 0 }]);
});

test('attach session machine queues frames until a reconnecting socket is ready', () => {
  const machine = createMachine({ includeReplay: false, reconnectDelayMs: 10 });
  const frame = { id: 'queued-1', method: 'session.submit', params: { content: 'queued' } };

  machine.dispatch({ type: 'START' });
  const queued = machine.dispatch({ type: 'FRAME_REQUESTED', frame });
  assert.equal(queued.accepted, true);
  assert.deepEqual(machine.getState().pendingFrames, [frame]);

  const opened = machine.dispatch({ type: 'SOCKET_OPEN' });
  assert.equal(machine.getState().phase, ATTACH_SESSION_PHASES.LIVE);
  assert.equal(opened.effects[0].type, 'send_subscribe');
  assert.equal(opened.effects[0].frame.method, 'session.events.subscribe');
  assert.deepEqual(opened.effects[1], { type: 'flush_frames', frames: [frame] });
  assert.equal(machine.getState().pendingFrames.length, 0);
  assert.equal(machine.getState().reconnectAttempts, 0);
});

test('attach session machine holds queued frames until replay completes', () => {
  const machine = createMachine();
  const frame = { id: 'queued-replay-1', method: 'session.submit', params: { content: 'queued' } };

  machine.dispatch({ type: 'START' });
  machine.dispatch({ type: 'FRAME_REQUESTED', frame });
  const opened = machine.dispatch({ type: 'SOCKET_OPEN' });

  assert.equal(machine.getState().phase, ATTACH_SESSION_PHASES.REPLAYING);
  assert.deepEqual(opened.effects.map((effect) => effect.type), ['send_subscribe']);
  assert.deepEqual(machine.getState().pendingFrames, [frame]);

  const replayCompleted = machine.dispatch({
    type: 'EVENT_RECEIVED',
    event: { event: 'session_events_replay_completed' },
  });
  assert.equal(machine.getState().phase, ATTACH_SESSION_PHASES.LIVE);
  assert.deepEqual(replayCompleted.effects, [{ type: 'flush_frames', frames: [frame] }]);
  assert.deepEqual(machine.getState().pendingFrames, []);
});
