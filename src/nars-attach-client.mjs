import { createProjectedTerminalBridge } from './projected-terminal.mjs';

function resolveNarsAttachEndpoint(options = {}, env = process.env) {
  return String(options.attachEndpoint ?? options.attach ?? env.NARADA_EVENT_STREAM_URL ?? env.NARADA_WEBSOCKET_URL ?? '').trim() || null;
}

function createNarsEventSubscribeFrame({ id = `events-${Date.now()}`, includeReplay = true, maxReplay = 50, sinceSequence = null } = {}) {
  return {
    id,
    method: 'session.events.subscribe',
    params: {
      include_replay: includeReplay,
      max_replay: maxReplay,
      ...(sinceSequence == null ? {} : { since_sequence: sinceSequence }),
    },
  };
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

async function runNarsAttachClient({
  endpoint,
  input = process.stdin,
  output = process.stdout,
  WebSocketImpl = globalThis.WebSocket,
  maxReplay = 50,
  includeReplay = true,
  color = undefined,
} = {}) {
  if (!endpoint) throw new Error('NARS attach endpoint is required. Use --attach <ws://127.0.0.1:port/events>.');
  if (typeof WebSocketImpl !== 'function') throw new Error('WebSocket is unavailable in this Node runtime.');

  const socket = new WebSocketImpl(endpoint);
  const pendingFrames = [];
  let socketOpen = false;
  const sendFrame = (frame) => {
    if (socketOpen) socket.send(JSON.stringify(frame));
    else pendingFrames.push(frame);
  };
  const controlSink = createNarsAttachControlSink({ sendFrame, onClose: () => socket.close() });
  const projectedTerminal = createProjectedTerminalBridge({ input, output, childStdin: controlSink });

  socket.addEventListener('open', () => {
    socketOpen = true;
    sendFrame(createNarsEventSubscribeFrame({ includeReplay, maxReplay }));
    while (pendingFrames.length) socket.send(JSON.stringify(pendingFrames.shift()));
  });

  socket.addEventListener('message', (message) => {
    let parsed;
    try {
      parsed = JSON.parse(String(message.data));
    } catch {
      return;
    }
    const event = normalizeNarsAttachIncomingEvent(parsed);
    if (!event) return;
    for (const rendered of projectedTerminal.renderEvent(event)) {
      if (typeof rendered === 'string') {
        projectedTerminal.writeProjectedOutput(`${rendered}\n`, { preserveCurrentLine: rendered.startsWith('\n') });
      } else if (rendered?.raw) {
        projectedTerminal.writeProjectedOutput(rendered.raw, { preserveCurrentLine: rendered.raw.startsWith('\n'), prompt: rendered.newline !== false });
        if (rendered.newline) projectedTerminal.writeProjectedOutput('\n', { preserveCurrentLine: true });
      }
    }
  });

  return await new Promise((resolve, reject) => {
    socket.addEventListener('error', () => reject(new Error('NARS attach WebSocket error')));
    socket.addEventListener('close', () => resolve(0));
  });
}

export {
  createNarsAttachControlSink,
  createNarsEventSubscribeFrame,
  normalizeNarsAttachIncomingEvent,
  resolveNarsAttachEndpoint,
  runNarsAttachClient,
};
