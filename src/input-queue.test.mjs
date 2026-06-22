import assert from 'node:assert/strict';
import {
  createInputQueue,
  isObserverInputEvent,
  normalizeInputEvent,
  normalizeInputRecord,
  observerVisibility,
  shouldDeferQueuedInput,
} from './input-queue.mjs';

assert.deepEqual(normalizeInputRecord('typed message'), { content: 'typed message', source: 'manual_operator' });

const normalizedDirective = normalizeInputEvent(
  { content: 'run startup sequence', source: 'system_directive', authority_ref: 'dir_1', directive_id: 'dir_1' },
  { transport: 'control_jsonl', received_at: '2026-05-28T00:00:00.000Z' },
  { randomIdFn: () => 'input_queue_test' },
);
assert.equal(normalizedDirective.event_id, 'input_input_queue_test');
assert.equal(normalizedDirective.source_kind, 'system');
assert.equal(normalizedDirective.transport, 'control_jsonl');
assert.equal(normalizedDirective.delivery_mode, 'admit_for_current_turn');
assert.equal(normalizedDirective.directive_id, 'dir_1');

const observerEvent = normalizeInputEvent(
  { content: 'Ask what evidence is missing.', source: 'observer', visibility: 'operator_visible' },
  { transport: 'control_jsonl' },
  { randomIdFn: () => 'observer_test' },
);
assert.equal(isObserverInputEvent(observerEvent), true);
assert.equal(observerVisibility(observerEvent), 'operator_visible');

assert.equal(shouldDeferQueuedInput({ source: 'manual_operator' }, { promptState: { active: true } }), false);
assert.equal(shouldDeferQueuedInput({ source: 'system_directive' }, { rl: { line: 'draft' }, promptState: { active: true } }), true);

const drained = [];
const sessionEvents = [];
const queue = createInputQueue({
  drain: async (event) => {
    drained.push(event.content);
    return { terminal_state: 'completed' };
  },
  appendSessionFn: (entry) => sessionEvents.push(entry),
  sessionEventEntryFn: (event, payload) => ({ event, ...payload }),
  carrierSessionEventEntryFn: (event_kind, payload) => ({ event_kind, payload }),
  randomIdFn: () => 'queue_test',
});
await queue.enqueue({ content: 'operator', source: 'manual_operator' });
await queue.enqueue({ content: 'steer later', source: 'operator_steering' });
assert.equal(queue.pendingCount, 2);
assert.equal(queue.pendingOperatorDirectiveCount, 1);
assert.equal(queue.dropOperatorSteering(1).content, 'steer later');
await queue.drainUntilIdle();
assert.deepEqual(drained, ['operator']);
assert.equal(queue.pendingCount, 0);
assert.equal(sessionEvents.some((entry) => entry.event === 'input_event_started'), true);
