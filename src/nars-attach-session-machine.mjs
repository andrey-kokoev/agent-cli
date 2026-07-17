const ATTACH_SESSION_PHASES = Object.freeze({
  IDLE: 'idle',
  CONNECTING: 'connecting',
  REPLAYING: 'replaying',
  LIVE: 'live',
  RECOVERING: 'recovering',
  RECONNECT_WAIT: 'reconnect_wait',
  CLOSING: 'closing',
  CLOSED: 'closed',
  FAILED: 'failed',
});

function normalizeReconnectLimit(value) {
  return Math.max(0, Math.floor(Number(value) || 0));
}

function normalizeReconnectDelay(value) {
  return Math.max(0, Number(value) || 0);
}

function normalizeSequence(value) {
  const sequence = Number(value);
  return Number.isInteger(sequence) && sequence > 0 ? sequence : null;
}

function transportError(error, fallbackMessage) {
  if (error instanceof Error) {
    const normalized = new Error(fallbackMessage);
    normalized.cause = error;
    return normalized;
  }
  return new Error(error == null ? fallbackMessage : String(error));
}

function subscribeFrame(state, { forceReplay = false } = {}) {
  const subscriptionAttempt = state.subscriptionAttempt + 1;
  const shouldReplay = forceReplay || state.includeReplay;
  return {
    subscriptionAttempt,
    shouldReplay,
    frame: createNarsEventSubscribeFrame({
      id: `${state.subscriptionId}-subscribe-${subscriptionAttempt}`,
      includeReplay: shouldReplay,
      maxReplay: state.maxReplay,
      sinceSequence: state.lastEventSequence,
      subscriptionId: state.subscriptionId,
    }),
  };
}

function unchanged(state, details = {}) {
  return { state, effects: [], ...details };
}

function transportFailure(state, event, { closeSocket = true } = {}) {
  if ([
    ATTACH_SESSION_PHASES.CLOSING,
    ATTACH_SESSION_PHASES.CLOSED,
    ATTACH_SESSION_PHASES.FAILED,
    ATTACH_SESSION_PHASES.RECONNECT_WAIT,
  ].includes(state.phase)) return unchanged(state);

  const error = transportError(event.error, event.type === 'SOCKET_ERROR'
    ? 'NARS attach WebSocket error'
    : 'NARS attach WebSocket closed');
  const reconnectAttempts = state.reconnectAttempts + 1;
  const commonState = {
    ...state,
    transportReady: false,
    reconnectAttempts,
  };
  const effects = closeSocket ? [{ type: 'close_socket' }] : [];
  if (!state.reconnect || reconnectAttempts > state.maxReconnectAttempts) {
    return {
      state: { ...commonState, phase: ATTACH_SESSION_PHASES.FAILED },
      effects: [...effects, { type: 'reject', error }],
    };
  }
  return {
    state: { ...commonState, phase: ATTACH_SESSION_PHASES.RECONNECT_WAIT },
    effects: [...effects, {
      type: 'schedule_reconnect',
      delayMs: state.reconnectDelayMs * reconnectAttempts,
    }],
  };
}

function requestFrame(state, frame) {
  if (!frame || [
    ATTACH_SESSION_PHASES.CLOSING,
    ATTACH_SESSION_PHASES.CLOSED,
    ATTACH_SESSION_PHASES.FAILED,
  ].includes(state.phase)) {
    return unchanged(state, { accepted: false });
  }
  if (state.transportReady && state.phase === ATTACH_SESSION_PHASES.LIVE) {
    return { state, effects: [{ type: 'send_frame', frame }], accepted: true };
  }
  return {
    state: { ...state, pendingFrames: [...state.pendingFrames, frame] },
    effects: [],
    accepted: true,
  };
}

function reduceNarsAttachSession(state, event = {}) {
  switch (event.type) {
    case 'START': {
      if (state.phase !== ATTACH_SESSION_PHASES.IDLE) return unchanged(state);
      return {
        state: { ...state, phase: ATTACH_SESSION_PHASES.CONNECTING },
        effects: [{ type: 'connect_socket' }],
      };
    }

    case 'SOCKET_OPEN': {
      if (state.phase === ATTACH_SESSION_PHASES.CLOSING) {
        return unchanged(state, { effects: [{ type: 'close_socket' }] });
      }
      if (state.phase !== ATTACH_SESSION_PHASES.CONNECTING) return unchanged(state);
      const subscription = subscribeFrame(state);
      const pendingFrames = state.pendingFrames;
      const nextState = {
        ...state,
        phase: subscription.shouldReplay ? ATTACH_SESSION_PHASES.REPLAYING : ATTACH_SESSION_PHASES.LIVE,
        transportReady: true,
        reconnectAttempts: subscription.shouldReplay ? state.reconnectAttempts : 0,
        replayRecoveryPending: false,
        subscriptionAttempt: subscription.subscriptionAttempt,
        pendingFrames: subscription.shouldReplay ? pendingFrames : [],
      };
      const effects = [{ type: 'send_subscribe', frame: subscription.frame }];
      if (!subscription.shouldReplay && pendingFrames.length > 0) {
        effects.push({ type: 'flush_frames', frames: pendingFrames });
      }
      return { state: nextState, effects };
    }

    case 'FRAME_REQUESTED':
      return requestFrame(state, event.frame);

    case 'FRAME_SEND_FAILED': {
      const failedFrames = Array.isArray(event.frames)
        ? event.frames.filter(Boolean)
        : event.frame ? [event.frame] : [];
      const failedState = failedFrames.length > 0
        ? { ...state, pendingFrames: [...failedFrames, ...state.pendingFrames] }
        : state;
      return transportFailure(failedState, {
        type: 'SOCKET_ERROR',
        error: event.error,
      });
    }

    case 'EVENT_RECEIVED': {
      const incomingEvent = event.event;
      if (!incomingEvent || !state.transportReady || [ATTACH_SESSION_PHASES.CLOSED, ATTACH_SESSION_PHASES.FAILED].includes(state.phase)) {
        return unchanged(state, { accepted: false });
      }
      const sequence = normalizeSequence(event.sequence);
      const replayCompleted = incomingEvent.event === 'session_events_replay_completed';
      if (sequence != null && state.lastEventSequence != null) {
        if (sequence <= state.lastEventSequence && !replayCompleted) {
          return unchanged(state, { accepted: false, reason: 'stale_sequence' });
        }
        if (sequence > state.lastEventSequence + 1) {
          if (state.phase === ATTACH_SESSION_PHASES.RECOVERING || state.replayRecoveryPending) {
            return unchanged(state, { accepted: false, reason: 'recovery_pending' });
          }
          const subscription = subscribeFrame(state, { forceReplay: true });
          return {
            state: {
              ...state,
              phase: ATTACH_SESSION_PHASES.RECOVERING,
              transportReady: true,
              replayRecoveryPending: true,
              subscriptionAttempt: subscription.subscriptionAttempt,
            },
            effects: [{ type: 'send_subscribe', frame: subscription.frame }],
            accepted: false,
            reason: 'sequence_gap',
          };
        }
      }

      let nextState = sequence == null || sequence <= (state.lastEventSequence ?? 0)
        ? state
        : { ...state, lastEventSequence: sequence };
      if (replayCompleted) {
        const pendingFrames = nextState.pendingFrames;
        nextState = {
          ...nextState,
          phase: ATTACH_SESSION_PHASES.LIVE,
          replayRecoveryPending: false,
          reconnectAttempts: 0,
          pendingFrames: [],
        };
        const effects = pendingFrames.length > 0
          ? [{ type: 'flush_frames', frames: pendingFrames }]
          : [];
        return { state: nextState, effects, accepted: true };
      }
      return { state: nextState, effects: [], accepted: true };
    }

    case 'SOCKET_ERROR':
      return transportFailure(state, event);

    case 'SOCKET_CLOSED':
      if (state.phase === ATTACH_SESSION_PHASES.CLOSING) {
        return {
          state: { ...state, phase: ATTACH_SESSION_PHASES.CLOSED, transportReady: false },
          effects: [{ type: 'resolve', value: 0 }],
        };
      }
      return transportFailure(state, { ...event, type: 'SOCKET_CLOSED' }, { closeSocket: false });

    case 'RECONNECT_TIMER_FIRED':
      if (state.phase !== ATTACH_SESSION_PHASES.RECONNECT_WAIT) return unchanged(state);
      return {
        state: { ...state, phase: ATTACH_SESSION_PHASES.CONNECTING },
        effects: [{ type: 'connect_socket' }],
      };

    case 'CANCEL_RECONNECT':
      return unchanged(state, { effects: [{ type: 'cancel_reconnect' }] });

    case 'CANCEL_REQUESTED': {
      if (!event.turnId || !event.frame || [
        ATTACH_SESSION_PHASES.CLOSING,
        ATTACH_SESSION_PHASES.CLOSED,
        ATTACH_SESSION_PHASES.FAILED,
      ].includes(state.phase)) return unchanged(state, { accepted: false });
      if (state.cancelRequestedTurnId === event.turnId) return unchanged(state, { accepted: false, reason: 'already_requested' });
      const result = requestFrame({ ...state, cancelRequestedTurnId: event.turnId }, event.frame);
      return { ...result, cancelRequested: true };
    }

    case 'TURN_ACTIVITY_UPDATED':
      if (event.turnId != null || state.cancelRequestedTurnId == null) return unchanged(state);
      return { state: { ...state, cancelRequestedTurnId: null }, effects: [] };

    case 'CLOSE_REQUESTED': {
      if ([ATTACH_SESSION_PHASES.CLOSING, ATTACH_SESSION_PHASES.CLOSED, ATTACH_SESSION_PHASES.FAILED].includes(state.phase)) {
        return unchanged(state);
      }
      const effects = [{ type: 'cancel_reconnect' }];
      if (event.socketPresent) {
        effects.push({ type: 'close_socket' });
        return {
          state: { ...state, phase: ATTACH_SESSION_PHASES.CLOSING, transportReady: false },
          effects,
        };
      }
      return {
        state: { ...state, phase: ATTACH_SESSION_PHASES.CLOSED, transportReady: false },
        effects: [...effects, { type: 'resolve', value: 0 }],
      };
    }

    default:
      return unchanged(state);
  }
}

function createNarsAttachSessionState({
  subscriptionId,
  includeReplay = true,
  maxReplay = 50,
  maxReconnectAttempts = 3,
  reconnectDelayMs = 25,
  reconnect = true,
} = {}) {
  if (!subscriptionId) throw new Error('NARS attach subscription id is required.');
  return {
    phase: ATTACH_SESSION_PHASES.IDLE,
    transportReady: false,
    reconnect: Boolean(reconnect),
    includeReplay: Boolean(includeReplay),
    maxReplay: Math.max(0, Math.floor(Number(maxReplay) || 0)),
    maxReconnectAttempts: normalizeReconnectLimit(maxReconnectAttempts),
    reconnectDelayMs: normalizeReconnectDelay(reconnectDelayMs),
    subscriptionId,
    subscriptionAttempt: 0,
    reconnectAttempts: 0,
    lastEventSequence: null,
    replayRecoveryPending: false,
    pendingFrames: [],
    cancelRequestedTurnId: null,
  };
}

function createNarsAttachSessionMachine(options = {}) {
  let state = createNarsAttachSessionState(options);
  return {
    getState() {
      return state;
    },
    dispatch(event) {
      const result = reduceNarsAttachSession(state, event);
      state = result.state;
      return result;
    },
  };
}

function createNarsEventSubscribeFrame({
  id = `events-${Date.now()}`,
  includeReplay = true,
  maxReplay = 50,
  sinceSequence = null,
  subscriptionId = null,
} = {}) {
  return {
    id,
    method: 'session.events.subscribe',
    params: {
      include_replay: includeReplay,
      max_replay: maxReplay,
      ...(subscriptionId == null ? {} : { subscription_id: subscriptionId }),
      ...(includeReplay && sinceSequence != null ? { since_sequence: sinceSequence } : {}),
    },
  };
}

export {
  ATTACH_SESSION_PHASES,
  createNarsAttachSessionMachine,
  createNarsAttachSessionState,
  createNarsEventSubscribeFrame,
  reduceNarsAttachSession,
};
