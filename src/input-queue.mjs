import {
  classifyCarrierInputHold,
  normalizeInputEvent as normalizeCarrierInputEvent,
  observerMetadata as protocolObserverMetadata,
  observerPayload as protocolObserverPayload,
  observerVisibility as protocolObserverVisibility,
  isObserverInputEvent as isProtocolObserverInputEvent,
} from '@narada2/carrier-protocol';

export function shouldDeferQueuedInput(event, { rl, promptState } = {}) {
  return classifyCarrierInputHold(inputWithObserverMetadata(event), {
    composerHasDraft: Boolean(promptState?.active && readlineHasNonWhitespaceInput(rl)),
  }).should_defer;
}

export function normalizeInputEvent(input, defaults = {}, { randomIdFn = defaultRandomId } = {}) {
  const record = normalizeInputRecord(input);
  const receivedAt = defaults.received_at ?? input?.received_at ?? new Date().toISOString();
  const legacySource = record.source;
  const protocolSourceKind = input?.source_kind ?? sourceKindForLegacyInputSource(legacySource);
  const protocolMetadata = {
    ...(input?.metadata ?? {}),
    legacy_source: legacySource,
    ...(protocolSourceKind === 'system' && record.directive_id ? { directive_provenance: { kind: 'system_directive' } } : {}),
    ...(legacySource === 'operator_directive' ? { directive_provenance: { kind: 'explicit_operator_directive_surface' } } : {}),
    ...(legacySource === 'observer' && !input?.metadata?.observer ? { observer: defaultObserverMetadata(input) } : {}),
  };
  const protocolEvent = normalizeCarrierInputEvent({
    schema: 'narada.carrier.input_event.v1',
    event_id: input?.event_id ?? `input_${randomIdFn()}`,
    source_kind: protocolSourceKind,
    source_id: input?.source_id ?? sourceIdForLegacyInputSource(legacySource),
    transport: normalizeLegacyTransport(input?.transport ?? defaults.transport ?? transportForInputSource(legacySource)),
    delivery_mode: input?.delivery_mode ?? deliveryModeForLegacyInputSource(legacySource),
    hold_condition: input?.hold_condition ?? null,
    content: record.content,
    created_at: receivedAt,
    authority_ref: record.authority_ref,
    directive_id: input?.directive_id ?? record.directive_id ?? null,
    metadata: protocolMetadata,
  });
  return {
    ...protocolEvent,
    received_at: protocolEvent.created_at,
    content: record.content,
    source: legacySource,
    authority_ref: record.authority_ref,
    directive_id: protocolEvent.directive_id,
    request_id: input?.request_id ?? null,
    transport: protocolEvent.transport,
  };
}

export function normalizeInputRecord(input) {
  if (typeof input === 'string') return { content: input, source: 'manual_operator' };
  if (input?.metadata?.observer || input?.source === 'observer') {
    return {
      content: String(input?.content ?? ''),
      source: 'observer',
      authority_ref: input?.authority_ref ?? null,
      directive_id: input?.directive_id ?? null,
    };
  }
  if (input?.source_kind === 'system' && !input?.source) {
    return {
      content: String(input?.content ?? ''),
      source: 'system_directive',
      authority_ref: input?.authority_ref ?? null,
      directive_id: input?.directive_id ?? null,
    };
  }
  if (input?.delivery_mode === 'admit_after_active_turn' && !input?.source) {
    return {
      content: String(input?.content ?? ''),
      source: 'operator_steering',
      authority_ref: input?.authority_ref ?? null,
      directive_id: input?.directive_id ?? null,
    };
  }
  return {
    content: String(input?.content ?? ''),
    source: input?.source ?? 'manual_operator',
    authority_ref: input?.authority_ref ?? null,
    directive_id: input?.directive_id ?? null,
  };
}

export function isObserverInputEvent(input, record = null) {
  return Boolean(isProtocolObserverInputEvent(input) || input?.source === 'observer' || record?.source === 'observer');
}

export function observerMetadata(input = {}) {
  return protocolObserverMetadata(input) ?? defaultObserverMetadata(input);
}

export function observerVisibility(input = {}) {
  return isProtocolObserverInputEvent(input)
    ? protocolObserverVisibility(input)
    : protocolObserverVisibility(inputWithObserverMetadata(input));
}

export function observerPayload(input = {}, extra = {}) {
  return protocolObserverPayload(inputWithObserverMetadata(input), extra);
}

export function inputWithObserverMetadata(input = {}) {
  if (isProtocolObserverInputEvent(input)) return input;
  if (input?.source !== 'observer') return input;
  return {
    ...input,
    metadata: {
      ...(input.metadata ?? {}),
      observer: defaultObserverMetadata(input),
    },
  };
}

export function createInputQueue({
  drain,
  shouldDefer = () => false,
  onDeferred = null,
  appendSessionFn = () => {},
  sessionEventEntryFn = (event, payload) => ({ event, ...payload }),
  carrierSessionEventEntryFn = (event_kind, payload) => ({ event_kind, payload }),
  noteSessionActivityFn = () => {},
  recordObserverInputQueuedFn = () => {},
  classifyInputRuntimeQueueAdmissionFn = () => ({ queue_events: [] }),
  classifyInputRuntimeAdmissionFn = () => ({ admission_events: [] }),
  classifyInputRuntimeHoldFn = (event, state) => classifyCarrierInputHold(inputWithObserverMetadata(event), state),
  directiveReceiptEvidenceFn = () => ({}),
  directiveAcceptedEvidenceFn = () => ({}),
  identity = null,
  session = null,
  transcriptDisplaySettings = {},
  randomIdFn = defaultRandomId,
} = {}) {
  const pending = [];
  const state = { running: false, deferredNotified: new Set(), heldSystemDirectives: new Set() };
  return {
    get isRunning() { return state.running; },
    get pendingCount() { return pending.length; },
    get pendingSystemDirectiveCount() { return pending.filter((event) => event.source === 'system_directive').length; },
    get pendingOperatorDirectiveCount() { return pending.filter((event) => event.source === 'operator_steering').length; },
    get pendingObserverCount() { return pending.filter((event) => isObserverInputEvent(event)).length; },
    enqueue: async (event, options = {}) => {
      const normalized = normalizeInputEvent(event, {}, { randomIdFn });
      pending.push(normalized);
      noteSessionActivityFn(options.state, 'input_event_queued', normalized.created_at ?? normalized.received_at ?? new Date().toISOString());
      appendSessionFn(sessionEventEntryFn('input_event_queued', {
        event_id: normalized.event_id,
        source: normalized.source,
        transport: normalized.transport,
        source_kind: normalized.source_kind,
        authority_ref: normalized.authority_ref,
        directive_id: normalized.directive_id,
      }));
      recordObserverInputQueuedFn(normalized);
      const queueAdmission = classifyInputRuntimeQueueAdmissionFn(normalized, transcriptDisplaySettings, {
        activeTurn: state.running,
      });
      for (const queueEvent of queueAdmission.queue_events ?? []) {
        appendSessionFn(carrierSessionEventEntryFn(queueEvent.event_kind, queueEvent.payload));
      }
      if (options.drain) await drainUntilIdle();
      return normalized;
    },
    drainOnce,
    drainUntilIdle,
    state: queueSnapshot,
    items: queueItems,
    clearOperatorSteering,
    dropOperatorSteering,
    finalizeSession,
  };

  function queueSnapshot() {
    return {
      running: state.running,
      pendingCount: pending.length,
      pendingSystemDirectiveCount: pending.filter((event) => event.source === 'system_directive').length,
      pendingOperatorDirectiveCount: pending.filter((event) => event.source === 'operator_steering').length,
      pendingObserverCount: pending.filter((event) => isObserverInputEvent(event)).length,
    };
  }

  function queueItems() {
    return pending.map((event, index) => ({
      index: index + 1,
      event_id: event.event_id,
      source: event.source,
      source_kind: event.source_kind,
      source_id: event.source_id,
      transport: event.transport,
      delivery_mode: event.delivery_mode,
      hold_condition: event.hold_condition ?? null,
      created_at: event.created_at,
      received_at: event.received_at,
      content: event.content,
    }));
  }

  function clearOperatorSteering() {
    const dropped = [];
    for (let index = pending.length - 1; index >= 0; index--) {
      if (pending[index].source !== 'operator_steering') continue;
      const [event] = pending.splice(index, 1);
      dropped.unshift(event);
    }
    for (const event of dropped) recordDroppedByOperator(event, 'queue_clear');
    return dropped;
  }

  function dropOperatorSteering(index) {
    const operatorSteering = pending
      .map((event, pendingIndex) => ({ event, pendingIndex }))
      .filter(({ event }) => event.source === 'operator_steering');
    const target = operatorSteering[index - 1];
    if (!target) return null;
    const [event] = pending.splice(target.pendingIndex, 1);
    recordDroppedByOperator(event, 'queue_drop');
    return event;
  }

  function recordDroppedByOperator(event, dropReason) {
    appendSessionFn(carrierSessionEventEntryFn('input_dropped_by_operator', {
      input_event_id: event.event_id,
      drop_reason: dropReason,
    }));
  }

  function finalizeSession() {
    const abandoned = pending.splice(0, pending.length);
    for (const event of abandoned) {
      appendSessionFn(carrierSessionEventEntryFn('input_abandoned_on_session_end', {
        input_event_id: event.event_id,
      }));
      state.deferredNotified.delete(event.event_id);
      state.heldSystemDirectives.delete(event.event_id);
    }
    return abandoned;
  }

  async function drainOnce() {
    if (state.running || pending.length === 0) return null;
    if (shouldDefer(pending[0])) {
      const event = pending[0];
      if (event && !state.deferredNotified.has(event.event_id)) {
        state.deferredNotified.add(event.event_id);
        recordSystemDirectiveHeld(event);
        onDeferred?.(event, queueSnapshot());
      }
      return null;
    }
    const event = pending.shift();
    state.deferredNotified.delete(event.event_id);
    recordSystemDirectiveReleased(event);
    state.running = true;
    appendSessionFn(sessionEventEntryFn('input_event_started', {
      event_id: event.event_id,
      source: event.source,
      transport: event.transport,
      authority_ref: event.authority_ref,
      directive_id: event.directive_id,
    }));
    const runtimeAdmission = classifyInputRuntimeAdmissionFn(event);
    for (const admissionEvent of runtimeAdmission.admission_events ?? []) {
      if (admissionEvent.event_kind === 'input_admitted_to_turn') {
        appendSessionFn(carrierSessionEventEntryFn(admissionEvent.event_kind, admissionEvent.payload));
      }
    }
    if (event.source === 'system_directive' && event.directive_id) {
      appendSessionFn(sessionEventEntryFn('directive_receipt_recorded', directiveReceiptEvidenceFn(event, {
        agentId: identity,
        carrierSessionId: session,
      })));
      appendSessionFn(sessionEventEntryFn('directive_carrier_accepted_recorded', directiveAcceptedEvidenceFn(event, {
        agentId: identity,
        carrierSessionId: session,
      })));
    }
    try {
      const result = await drain(event);
      appendSessionFn(sessionEventEntryFn('input_event_completed', {
        event_id: event.event_id,
        terminal_state: result?.terminal_state ?? 'completed',
      }));
      appendSessionFn(carrierSessionEventEntryFn('input_completed', {
        input_event_id: event.event_id,
        terminal_state: result?.terminal_state ?? 'completed',
      }));
      return result;
    } finally {
      state.running = false;
    }
  }

  function recordSystemDirectiveHeld(event) {
    if (state.heldSystemDirectives.has(event.event_id)) return;
    const hold = classifyInputRuntimeHoldFn(event, {
      composerHasDraft: true,
      alreadyHeld: false,
      occurredAt: new Date().toISOString(),
    });
    if (hold.hold_action !== 'hold') return;
    state.heldSystemDirectives.add(event.event_id);
    for (const holdEvent of hold.hold_events ?? []) {
      appendSessionFn(carrierSessionEventEntryFn(holdEvent.event_kind, holdEvent.payload));
    }
  }

  function recordSystemDirectiveReleased(event) {
    if (!state.heldSystemDirectives.has(event.event_id)) return;
    const release = classifyInputRuntimeHoldFn(event, {
      release: true,
      alreadyHeld: true,
      occurredAt: new Date().toISOString(),
    });
    state.heldSystemDirectives.delete(event.event_id);
    for (const releaseEvent of release.release_events ?? []) {
      appendSessionFn(carrierSessionEventEntryFn(releaseEvent.event_kind, releaseEvent.payload));
    }
  }

  async function drainUntilIdle() {
    let last = null;
    while (!state.running && pending.length > 0 && !shouldDefer(pending[0])) {
      last = await drainOnce();
    }
    if (!state.running && pending.length > 0 && shouldDefer(pending[0])) await drainOnce();
    return last;
  }
}

export function readlineHasPartialInput(rl) {
  return Boolean(rl && typeof rl.line === 'string' && rl.line.length > 0);
}

export function readlineHasNonWhitespaceInput(rl) {
  return Boolean(rl && typeof rl.line === 'string' && rl.line.trim().length > 0);
}

function transportForInputSource(source) {
  if (source === 'automation_jsonl') return 'control_jsonl';
  if (source === 'observer') return 'control_jsonl';
  if (source === 'programmatic_operator' || source === 'operator_directive' || source === 'system_directive') return 'carrier_server_api';
  return 'interactive_terminal';
}

function normalizeLegacyTransport(transport) {
  if (transport === 'terminal') return 'interactive_terminal';
  if (transport === 'programmatic') return 'carrier_server_api';
  if (transport === 'jsonl_stdio') return 'control_jsonl';
  return transport;
}

function sourceKindForLegacyInputSource(source) {
  if (source === 'system_directive') return 'system';
  if (source === 'observer') return 'agent';
  return 'operator';
}

function sourceIdForLegacyInputSource(source) {
  if (source === 'system_directive') return 'agent-cli.system_directive';
  if (source === 'observer') return 'narada.observer';
  return 'operator';
}

function deliveryModeForLegacyInputSource(source) {
  if (source === 'operator_steering' || source === 'observer') return 'admit_after_active_turn';
  return 'admit_for_current_turn';
}

function defaultObserverMetadata(input = {}) {
  return {
    role: 'observer',
    rule_id: input?.rule_id ?? 'manual-observer-interjection',
    visibility: input?.visibility ?? 'operator_visible',
    ...(input?.confidence ? { confidence: input.confidence } : {}),
  };
}

function defaultRandomId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
