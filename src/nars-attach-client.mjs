import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { createProjectedTerminalBridge } from './projected-terminal.mjs';
import {
  createNarsAttachSessionMachine,
  createNarsEventSubscribeFrame,
} from './nars-attach-session-machine.mjs';

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function readJson(path, code) {
  try {
    return record(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    throw new Error(code);
  }
}

function validWebSocketEndpoint(value, code) {
  const endpoint = firstString(value);
  if (!endpoint) throw new Error(code);
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error(code);
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') throw new Error(code);
  return parsed.toString();
}

function sessionRecordPath(value) {
  const path = String(value);
  return /\.jsonl?$/i.test(path) ? join(dirname(path), 'session-index-record.json') : join(path, 'session-index-record.json');
}

function resolveLaunchBinding(path) {
  const binding = readJson(path, 'launch_binding_invalid');
  if (!['narada.operator_projection_launch_binding.v1', 'narada.operator_projection_launch_binding_ref.v1'].includes(binding.schema)) {
    throw new Error('launch_binding_schema_invalid');
  }
  if (binding.schema === 'narada.operator_projection_launch_binding.v1' && binding.status !== 'ready') {
    throw new Error('launch_binding_not_ready');
  }
  if (binding.schema === 'narada.operator_projection_launch_binding_ref.v1' && binding.exact_attach_required !== true) {
    throw new Error('launch_binding_exact_attach_required');
  }

  const nested = record(binding.session_started);
  const events = record(binding.nars_events);
  let endpoint = firstString(
    binding.event_endpoint,
    binding.events_endpoint,
    binding.websocket_endpoint,
    events.endpoint,
    nested.event_endpoint,
    nested.events_endpoint,
    nested.websocket_endpoint,
  );
  const resultPath = firstString(binding.agent_start_result_file, binding.result_file);
  if (resultPath) {
    const result = readJson(resultPath, 'launch_binding_result_invalid');
    const resultEvents = record(result.nars_events);
    endpoint ??= firstString(result.event_endpoint, resultEvents.endpoint);
    if (!endpoint) {
      const launch = record(result.nars_launch);
      const candidates = [
        binding.session_path,
        binding.session_dir,
        result.session_path,
        result.session_dir,
        launch.session_path,
        launch.session_dir,
      ].filter((value) => typeof value === 'string' && value.trim());
      for (const candidate of candidates) {
        try {
          const session = readJson(sessionRecordPath(candidate), 'launch_binding_session_record_invalid');
          endpoint = firstString(session.event_endpoint, session.websocket_endpoint);
          if (endpoint) break;
        } catch {
          // The runtime may publish the result before the session index.
        }
      }
    }
  }
  return validWebSocketEndpoint(endpoint, 'nars_event_endpoint_missing_from_launch_binding');
}

function resolveNarsAttachEndpoint(options = {}, env = process.env) {
  if (options.launchBinding) return resolveLaunchBinding(options.launchBinding);
  return validWebSocketEndpoint(
    options.attachEndpoint ?? options.attach ?? env.NARADA_EVENT_STREAM_URL ?? env.NARADA_WEBSOCKET_URL,
    'NARS attach endpoint is required',
  );
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
  resolveLaunchBinding,
  resolveNarsAttachEndpoint,
  runNarsAttachClient,
};
