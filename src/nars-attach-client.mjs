import { createProjectedTerminalBridge } from './projected-terminal.mjs';
import {
  createNarsAttachSessionMachine,
  createNarsEventSubscribeFrame,
} from './nars-attach-session-machine.mjs';

function resolveNarsAttachEndpoint(options = {}, env = process.env) {
  return String(options.attachEndpoint ?? options.attach ?? env.NARADA_EVENT_STREAM_URL ?? env.NARADA_WEBSOCKET_URL ?? '').trim() || null;
}

function normalizeNarsAttachIncomingEvent(message) {
  if (!message || typeof message !== 'object') return null;
  if (message.schema === 'narada.nars.events.envelope.v1' && message.payload && typeof message.payload === 'object') {
    return message.payload;
  }

  return message;
}

function createNarsAttachControlSink({ sendFrame, onClose = null } = {}) {
  return {
    writable: true,
    write(line) {
      const text = String(line ?? '').trim();
      if (!text) return true;
      try {
        sendFrame(JSON.parse(text));
      } catch (error) {
        sendFrame({
          id: `invalid-client-frame-${Date.now()}`,
          method: 'client.error',
          params: { code: 'invalid_client_frame', message: error instanceof Error ? error.message : String(error) },
        });
      }
      return true;
    },
    end() {
      if (onClose) onClose();
    },
  };
}

function durableEventSequence(event) {
  const sequence = Number(event?.event_sequence ?? event?.sequence);
  return Number.isInteger(sequence) && sequence > 0 ? sequence : null;
}

async function runNarsAttachClient({
  endpoint,
  input = process.stdin,
  output = process.stdout,
  WebSocketImpl = globalThis.WebSocket,
  maxReplay = 50,
  includeReplay = true,
  reconnect = true,
  maxReconnectAttempts = 3,
  reconnectDelayMs = 25,
} = {}) {
  if (!endpoint) throw new Error('NARS attach endpoint is required. Use --attach <ws://127.0.0.1:port/events>.');
  if (typeof WebSocketImpl !== 'function') throw new Error('WebSocket is unavailable in this Node runtime.');

  const subscriptionId = `agent-cli-events-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const machine = createNarsAttachSessionMachine({
    subscriptionId,
    includeReplay,
    maxReplay,
    maxReconnectAttempts,
    reconnectDelayMs,
    reconnect,
  });
  let socket = null;
  let reconnectTimer = null;
  let socketGeneration = 0;
  let settled = false;
  let resolveCompletion;
  let rejectCompletion;

  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  const removeInputListeners = () => {
    if (typeof input.off !== 'function') return;
    input.off('data', onInputData);
    input.off('end', onInputEnd);
  };

  const settle = (kind, value) => {
    if (settled) return;
    settled = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    removeInputListeners();
    if (kind === 'resolve') resolveCompletion(value);
    else rejectCompletion(value);
  };

  function dispatch(event) {
    const result = machine.dispatch(event);
    applyEffects(result.effects);
    return result;
  }

  function applyEffects(effects = []) {
    for (const effect of effects) {
      if (settled && effect.type !== 'resolve' && effect.type !== 'reject') break;
      if (effect.type === 'connect_socket') {
        connectSocket();
      } else if (effect.type === 'send_subscribe') {
        sendSubscribeToCurrentSocket(effect.frame);
      } else if (effect.type === 'send_frame') {
        sendToCurrentSocket(effect.frame);
      } else if (effect.type === 'flush_frames') {
        flushFrames(effect.frames);
      } else if (effect.type === 'close_socket') {
        try {
          socket?.close?.();
        } catch {
          dispatch({ type: 'SOCKET_CLOSED' });
        }
      } else if (effect.type === 'schedule_reconnect') {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          dispatch({ type: 'RECONNECT_TIMER_FIRED' });
        }, effect.delayMs);
      } else if (effect.type === 'cancel_reconnect') {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = null;
      } else if (effect.type === 'resolve') {
        settle('resolve', effect.value);
      } else if (effect.type === 'reject') {
        settle('reject', effect.error);
      }
    }
  }

  function sendToCurrentSocket(frame) {
    if (!machine.getState().transportReady || !socket) {
      dispatch({
        type: 'FRAME_SEND_FAILED',
        frame,
        error: new Error('NARS attach WebSocket is not open'),
      });
      return;
    }
    try {
      socket.send(JSON.stringify(frame));
    } catch (error) {
      dispatch({ type: 'FRAME_SEND_FAILED', frame, error });
    }
  }

  function sendSubscribeToCurrentSocket(frame) {
    if (!machine.getState().transportReady || !socket) {
      dispatch({
        type: 'SOCKET_ERROR',
        error: new Error('NARS attach WebSocket is not open'),
      });
      return;
    }
    try {
      socket.send(JSON.stringify(frame));
    } catch (error) {
      dispatch({ type: 'SOCKET_ERROR', error });
    }
  }

  function flushFrames(frames = []) {
    for (let index = 0; index < frames.length; index += 1) {
      if (settled || !machine.getState().transportReady || !socket) return;
      try {
        socket.send(JSON.stringify(frames[index]));
      } catch (error) {
        dispatch({ type: 'FRAME_SEND_FAILED', frames: frames.slice(index), error });
        return;
      }
    }
  }

  const projectedTerminal = createProjectedTerminalBridge({
    input,
    output,
    childStdin: createNarsAttachControlSink({
      sendFrame: (frame) => sendFrame(frame),
      onClose: () => {
        sendCancelForActiveTurn();
        requestClose();
      },
    }),
  });

  function sendFrame(frame) {
    if (settled) return false;
    return dispatch({ type: 'FRAME_REQUESTED', frame }).accepted === true;
  }

  function sendCancelForActiveTurn() {
    const activeTurnId = projectedTerminal.operatorState.activeTurnId;
    if (!activeTurnId) return false;
    const result = dispatch({
      type: 'CANCEL_REQUESTED',
      turnId: activeTurnId,
      frame: {
        id: `operator-cancel-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        method: 'session.cancel',
        params: {},
      },
    });
    return result.cancelRequested === true;
  }

  function connectSocket() {
    if (settled) return;
    const generation = ++socketGeneration;
    let currentSocket;
    try {
      currentSocket = new WebSocketImpl(endpoint);
      socket = currentSocket;
    } catch (error) {
      dispatch({ type: 'SOCKET_ERROR', error });
      return;
    }
    const isCurrentSocket = () => !settled && generation === socketGeneration && currentSocket === socket;
    currentSocket.addEventListener('open', () => {
      if (!isCurrentSocket()) return;
      dispatch({ type: 'SOCKET_OPEN' });
    });
    currentSocket.addEventListener('message', (message) => {
      if (!isCurrentSocket()) return;
      let parsed;
      try {
        parsed = JSON.parse(String(message.data));
      } catch {
        return;
      }
      const event = normalizeNarsAttachIncomingEvent(parsed);
      if (!event) return;
      const sequence = durableEventSequence(event);
      const result = dispatch({ type: 'EVENT_RECEIVED', event, sequence });
      if (!result.accepted) return;
      for (const rendered of projectedTerminal.renderEvent(event)) {
        if (typeof rendered === 'string') {
          projectedTerminal.writeProjectedOutput(`${rendered}\n`, { preserveCurrentLine: rendered.startsWith('\n') });
        } else if (rendered?.raw) {
          projectedTerminal.writeProjectedOutput(rendered.raw, { preserveCurrentLine: rendered.raw.startsWith('\n'), prompt: rendered.newline !== false });
          if (rendered.newline) projectedTerminal.writeProjectedOutput('\n', { preserveCurrentLine: true });
        }
      }
      dispatch({
        type: 'TURN_ACTIVITY_UPDATED',
        turnId: projectedTerminal.operatorState.activeTurnId ?? null,
      });
    });
    currentSocket.addEventListener('error', (error) => {
      if (!isCurrentSocket()) return;
      dispatch({ type: 'SOCKET_ERROR', error });
    });
    currentSocket.addEventListener('close', () => {
      if (!isCurrentSocket()) return;
      socket = null;
      dispatch({ type: 'SOCKET_CLOSED' });
    });
  }

  function requestClose() {
    if (settled) return;
    dispatch({
      type: 'CLOSE_REQUESTED',
      socketPresent: Boolean(socket),
    });
  }

  function onInputData(chunk) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
    for (const character of text) {
      if (character === '\x03') sendCancelForActiveTurn();
    }
  }

  function onInputEnd() {
    sendCancelForActiveTurn();
  }

  input.on?.('data', onInputData);
  input.on?.('end', onInputEnd);
  dispatch({ type: 'START' });

  return await completion;
}

export {
  createNarsAttachControlSink,
  createNarsEventSubscribeFrame,
  durableEventSequence,
  normalizeNarsAttachIncomingEvent,
  resolveNarsAttachEndpoint,
  runNarsAttachClient,
};
