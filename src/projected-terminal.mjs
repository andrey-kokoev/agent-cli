import readline from 'node:readline';
import { createTerminalStyle, formatTerminalMessageBlockLines } from './terminal-style.mjs';

export function colorEnabled({ output = process.stdout, env = process.env } = {}) {
  const setting = String(env.NARADA_AGENT_CLI_COLOR ?? '').trim().toLowerCase();
  if (['0', 'false', 'off', 'no', 'never'].includes(setting)) return false;
  if (['1', 'true', 'on', 'yes', 'always'].includes(setting)) return true;
  return Boolean(output.isTTY && !env.NO_COLOR);
}

function shellLikeWords(value) {
  const words = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(String(value ?? ''))) !== null) {
    words.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return words;
}

function normalizeSessionSyncDirection(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return ['upload', 'download', 'bidirectional'].includes(normalized) ? normalized : 'upload';
}

function opsSyncFrame(value = '') {
  const tokens = shellLikeWords(value);
  if (tokens[0]?.toLowerCase() !== 'sync') return null;
  const params = {
    target: null,
    direction: 'upload',
    dry_run: false,
    delete: false,
  };
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index].toLowerCase();
    const next = tokens[index + 1];
    if (token === '--target' && next) {
      params.target = next;
      index += 1;
      continue;
    }
    if (token === '--direction' && next) {
      params.direction = normalizeSessionSyncDirection(next);
      index += 1;
      continue;
    }
    if (token === '--dry-run') {
      params.dry_run = true;
      continue;
    }
    if (token === '--delete') {
      params.delete = true;
      continue;
    }
    if (token !== '--json' && !params.target) params.target = tokens[index];
  }
  params.target = String(params.target ?? '').trim() || null;
  return { id: requestIdForCommand('ops-sync'), method: 'session.sync', params };
}

function requestIdForCommand(command) {
  return `operator-command-${command}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function commandFrame(command, value = '') {
  return {
    id: requestIdForCommand(command.replace(/^\//, '').replace(/[^a-z0-9]+/g, '-')),
    method: 'agent-cli.command',
    params: { command, value },
  };
}

export function createProjectedSlashCommandAction(line) {
  const trimmed = String(line ?? '').trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (lower === 'exit' || lower === '/exit' || lower === '/quit') {
    return { kind: 'frame', frame: { id: requestIdForCommand('exit'), method: 'session.close', params: {} } };
  }
  if (!trimmed.startsWith('/')) return null;
  const [rawCommand, ...rest] = trimmed.split(/\s+/);
  const command = rawCommand.toLowerCase();
  const value = rest.join(' ').trim();
  if (command === '/help') return { kind: 'local_help' };
  if (command === '/clear') return { kind: 'clear' };
  if (command === '/status') return { kind: 'frame', frame: { id: requestIdForCommand('status'), method: 'session.status', params: {} } };
  if (command === '/recovery') return { kind: 'frame', frame: { id: requestIdForCommand('recovery'), method: 'session.recovery', params: {} } };
  if (command === '/ops') return { kind: 'frame', frame: opsSyncFrame(value) ?? { id: requestIdForCommand('ops'), method: 'session.operations', params: {} } };
  if (command === '/observers') return { kind: 'frame', frame: { id: requestIdForCommand('observers'), method: 'observers.status', params: {} } };
  if (command === '/observer' && value === 'mute') return { kind: 'frame', frame: { id: requestIdForCommand('observer-mute'), method: 'observer.mute', params: {} } };
  if (command === '/observer' && value === 'unmute') return { kind: 'frame', frame: { id: requestIdForCommand('observer-unmute'), method: 'observer.unmute', params: {} } };
  const carrierCommands = new Set(['/goal', '/stats', '/model', '/thinking', '/tool-output', '/tool-outputs', '/tools', '/tool', '/queue']);
  if (carrierCommands.has(command)) {
    return { kind: 'frame', frame: commandFrame(command, value) };
  }
  if (command === '/observer') return { kind: 'message', message: 'Usage: /observer mute|unmute' };
  return { kind: 'message', message: `Unknown command: ${command}. Type /help.` };
}

function projectedHelpText() {
  return [
    'Commands',
    '',
    '/help                 Show commands',
    '/status               Show session state',
    '/recovery             Show recovery workflow',
    '/goal [text|pause|resume|clear] Show, set, pause, resume, or clear carrier goal',
    '/stats [args]         Show local Codex transcript statistics',
    '/model <name>         Set model for later turns',
    '/thinking <level>     none, low, medium, high',
    '/tool-output [state]  Toggle displayed tool call outputs (on, off, toggle)',
    '/ops                  Show operation workflow summary',
    '/tools [filter]       Show discovered MCP tools and input schemas',
    '/observers            Show observer posture',
    '/observer mute        Mute visible observer interjections',
    '/observer unmute      Unmute visible observer interjections',
    '/queue                Show queued carrier input',
    '/queue clear          Clear queued operator steering',
    '/queue drop <index>   Drop one queued operator steering item',
    '/clear                Clear terminal display',
    '/exit                 Save and quit',
    '/json <frame>         Send explicit JSONL control frame',
  ].join('\n');
}

export function createOperatorStyle({ enabled = colorEnabled() } = {}) {
  const style = createTerminalStyle({ enabled });
  return {
    ...style,
    agent: style.label,
    ok: style.success,
  };
}

export function createOperatorPrompt(style = createOperatorStyle({ enabled: false })) {
  return `${style.operator('operator')} ${style.muted('>')} `;
}

function clearPreviousTerminalRows(rows) {
  if (rows <= 1) return '\x1b[1A\r\x1b[K';
  let sequence = `\x1b[${rows}A`;
  for (let index = 0; index < rows; index++) {
    sequence += '\r\x1b[2K';
    if (index < rows - 1) sequence += '\x1b[1B';
  }
  return `${sequence}\x1b[${rows - 1}A\r`;
}

export function rewriteSubmittedOperatorPromptForTest({
  line,
  agentId = 'agent',
  columns = 80,
  style = createOperatorStyle({ enabled: false }),
  now = new Date(),
} = {}) {
  const text = String(line ?? '');
  if (text.includes('\n') || text.includes('\r')) return null;
  const rawPromptRows = Math.max(1, Math.ceil(stripAnsi(`${createOperatorPrompt(style)}${text}`).length / Math.max(1, columns)));
  const promptLabel = `operator -> ${agentId}`;
  const prefix = `${promptLabel}: `;
  const firstLineWidth = Math.max(16, columns - stripAnsi(prefix).length);
  const lines = wrapTerminalLine(text, firstLineWidth);
  const [first = '', ...rest] = lines;
  const renderedLines = [
    `${style.operator('operator')} ${style.muted('->')} ${style.agent(agentId)}${style.muted(':')} ${first}`,
    ...rest.map((wrapped) => `  ${wrapped}`),
  ];
  appendSuffixToLastLine(renderedLines, ` ${style.timestamp(formatTimestamp(now))}`);
  return `${clearPreviousTerminalRows(rawPromptRows)}\n${renderedLines.join('\n')}\n`;
}

export function createProjectedOutputWriter({ rl = null, interactive = false, output = process.stdout } = {}) {
  return (text, { preserveCurrentLine = false, prompt = true } = {}) => {
    if (interactive && !preserveCurrentLine) {
      readline.clearLine(output, 0);
      readline.cursorTo(output, 0);
    }
    output.write(text);
    if (interactive && prompt) rl?.prompt(true);
  };
}

export function createOperatorConversationFrame(line) {
  const rawMessage = String(line ?? '');
  if (!rawMessage.trim()) return null;
  const requestId = `operator-conversation-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    id: requestId,
    method: 'conversation.send',
    params: {
      request_id: requestId,
      message: rawMessage,
      source: 'programmatic_operator',
      source_id: 'agent-runtime-server.operator_terminal',
    },
  };
}

export function createExplicitJsonControlFrame(line) {
  const text = String(line ?? '');
  const match = text.match(/^\s*\/json(?:\s+(.+))?$/s);
  if (!match) return null;
  const payload = match[1]?.trim();
  if (!payload) return { error: 'usage: /json <control-frame-json>' };
  try {
    const frame = JSON.parse(payload);
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
      return { error: '/json payload must be a JSON object control frame' };
    }
    return { frame };
  } catch (error) {
    return { error: `/json invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function withStreamBoundary(state, rendered) {
  if (state?.streamOpen && !state.streamAtLineStart) {
    state.streamOpen = false;
    state.streamAtLineStart = true;
    state.openStreamTurnKey = null;
    if (Array.isArray(rendered) && rendered.length > 0 && typeof rendered[0] === 'string') {
      return [`\n${rendered[0]}`, ...rendered.slice(1)];
    }
    return [{ raw: '\n', newline: false }, ...(Array.isArray(rendered) ? rendered : [])];
  }
  if (state) {
    state.streamOpen = false;
    state.openStreamTurnKey = null;
  }
  return rendered;
}

function stripAnsi(text) {
  return String(text ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function terminalColumns(state = {}) {
  const value = Number(state.terminalColumns ?? process.stdout.columns ?? 88);
  if (!Number.isFinite(value)) return 88;
  return Math.max(50, Math.min(120, Math.floor(value)));
}

function wrapTerminalLine(line, width) {
  const text = String(line ?? '');
  if (text.trim() === '') return [''];
  if (stripAnsi(text).length <= width) return [text];
  const words = text.split(/(\s+)/);
  const lines = [];
  let current = '';
  for (const word of words) {
    if (!word) continue;
    if (stripAnsi(current + word).length > width && current.trim()) {
      lines.push(current.trimEnd());
      current = word.trimStart();
    } else {
      current += word;
    }
  }
  if (current.trim()) lines.push(current.trimEnd());
  return lines.length ? lines : [text];
}

function wrapIndentedLines(text, { indent = '  ', columns = 88 } = {}) {
  const width = Math.max(10, columns - stripAnsi(indent).length);
  return String(text ?? '').split(/\r?\n/).flatMap((line) => (
    wrapTerminalLine(line, width).map((wrapped) => `${indent}${wrapped}`)
  ));
}

function styleInlineCode(text, style) {
  return String(text ?? '').replace(/`([^`\r\n]+)`/g, (_match, code) => style.code(code));
}

function formatTimestamp(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}Z${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

function timestampSuffix(state, style) {
  if (state.timestamps === false) return '';
  const now = typeof state.now === 'function' ? state.now() : state.now;
  return ` ${style.timestamp(formatTimestamp(now ?? new Date()))}`;
}

function assistantEmissionHeader(state, style, fallbackLabel = 'assistant') {
  return `${style.agent(fallbackLabel)}${style.muted(':')}`;
}

function projectedAgentId(state) {
  return state?.agentId ?? process.env.NARADA_AGENT_ID ?? 'agent';
}

function consumeLocalThinkingForEvent(state, event) {
  if (!state.localThinkingRendered) return false;
  const expectedAgentId = state.localThinkingAgentId ?? projectedAgentId(state);
  if ((event.agent_id ?? expectedAgentId) !== expectedAgentId) return false;
  state.localThinkingRendered = false;
  state.localThinkingAgentId = null;
  return true;
}

function clearLocalThinking(state) {
  if (!state.localThinkingRendered) return;
  state.localThinkingRendered = false;
  state.localThinkingAgentId = null;
}

function appendSuffixToLastLine(lines, suffix) {
  if (!Array.isArray(lines) || lines.length === 0 || !suffix) return lines;
  lines[lines.length - 1] = `${lines[lines.length - 1]}${suffix}`;
  return lines;
}

function transformOutsideInlineCode(text, transform) {
  return String(text ?? '').split(/(`[^`]*`)/g)
    .map((part) => part.startsWith('`') && part.endsWith('`') ? part : transform(part))
    .join('');
}

function normalizeDisplayTerms(line) {
  return transformOutsideInlineCode(String(line ?? ''), (chunk) => chunk
    .replace(/\bauthority_locus\b/g, 'authority locus')
    .replace(/\bauthority_posture\b/g, 'authority posture')
    .replace(/\bfacade_only\b/g, '`facade_only`')
    .replace(/\bnarada_proper\b/g, '`narada_proper`'));
}

function visibleLength(value) {
  return stripAnsi(value).length;
}

function padVisible(value, width) {
  const text = String(value ?? '');
  return `${text}${' '.repeat(Math.max(0, width - visibleLength(text)))}`;
}

function renderMarkdownForProjectedTerminal(text, style) {
  const lines = String(text ?? '').split(/\r?\n/);
  let inFence = false;
  let inTable = false;
  let tableHeader = null;
  let tableRows = [];
  const outLines = [];
  const flushTable = () => {
    if (!tableHeader) return;
    const colCount = tableHeader.length;
    const widths = tableHeader.map((header, index) => Math.max(
      visibleLength(styleInlineCode(header, style)),
      ...tableRows.map((row) => visibleLength(styleInlineCode(row[index] ?? '', style))),
    ));
    const renderRow = (row) => row
      .map((cell, index) => padVisible(styleInlineCode(cell ?? '', style), widths[index]))
      .join('  ');
    outLines.push(style.label(renderRow(tableHeader)));
    for (const row of tableRows) {
      const paddedRow = [];
      for (let index = 0; index < colCount; index++) {
        paddedRow.push(padVisible(styleInlineCode(row[index] ?? '', style), widths[index]));
      }
      outLines.push(paddedRow.join('  '));
    }
    tableHeader = null;
    tableRows = [];
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (inTable) {
        flushTable();
        inTable = false;
      }
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      outLines.push(style.code(`  ${line.replace(/^\s{0,4}/, '')}`));
      continue;
    }
    const tableMatch = line.match(/^\|(.*)\|$/);
    if (tableMatch) {
      inTable = true;
      const cells = tableMatch[1].split('|').map((cell) => cell.trim());
      if (cells.every((cell) => /^:?-+:?$/.test(cell))) continue;
      if (tableHeader === null) tableHeader = cells;
      else tableRows.push(cells);
      continue;
    }
    if (inTable) {
      flushTable();
      inTable = false;
    }
    if (/^#{1,6}\s+/.test(line)) {
      outLines.push(style.label(line.replace(/^#{1,6}\s+/, '')));
      continue;
    }
    const normalizedLine = normalizeDisplayTerms(line);
    const bulletLine = /^\s*[-*]\s+/.test(normalizedLine)
      ? normalizedLine.replace(/^(\s*)[-*]\s+/, '$1• ')
      : normalizedLine;
    outLines.push(styleInlineCode(bulletLine, style));
  }
  if (inTable) flushTable();
  return outLines.join('\n');
}

function agentLabel(event, style) {
  return style.agent(event.agent_id ?? 'agent');
}

function toolDisplayName(event) {
  const tool = event.tool ?? event.tool_name ?? event.name ?? '<unknown>';
  const server = event.server_name ?? event.tool_server ?? null;
  return server && !String(tool).startsWith(`${server}.`) ? `${server}.${tool}` : String(tool);
}

function summarizeToolCall(event) {
  if (event.argument_summary) return `(${event.argument_summary})`;
  if (event.arguments && typeof event.arguments === 'object') {
    try {
      const text = JSON.stringify(event.arguments);
      return `(${text.length > 200 ? `${text.slice(0, 197)}...` : text})`;
    } catch {
      return '(arguments)';
    }
  }
  return '';
}

function summarizeToolResult(event) {
  const status = String(event.status ?? '').toLowerCase();
  const normal = !status || ['success', 'complete', 'completed', 'ok'].includes(status);
  const head = normal ? 'ok' : status || 'result';
  const details = [
    event.output_ref ? `output_ref=${event.output_ref}` : null,
    event.reason ? `reason=${event.reason}` : null,
    event.authority_owner ? `authority_owner=${event.authority_owner}` : null,
    event.request_id ? `request_id=${event.request_id}` : null,
    event.error ? `error=${formatEventValue(event.error)}` : null,
    event.recovery ? `recovery=${formatEventValue(event.recovery)}` : null,
  ].filter(Boolean);
  return `${head}${details.length ? ` · ${details.join(' · ')}` : ''}`;
}

function formatEventValue(value, { limit = 500 } = {}) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (value instanceof Error) return value.message || value.name || String(value);
  if (typeof value === 'object') {
    const message = typeof value.message === 'string' ? value.message : null;
    const code = typeof value.code === 'string' || typeof value.code === 'number' ? String(value.code) : null;
    const error = typeof value.error === 'string' ? value.error : null;
    const summary = [code, message ?? error].filter(Boolean).join(': ');
    if (summary) return summary;
    try {
      const compact = JSON.stringify(value);
      return compact.length > limit ? `${compact.slice(0, Math.max(0, limit - 3))}...` : compact;
    } catch {
      return Object.prototype.toString.call(value);
    }
  }
  return String(value);
}

function routeLine({ label, body, labelStyle = (value) => value, bodyStyle = (value) => value, state, style }) {
  return `${labelStyle(label)}${style.muted(':')} ${bodyStyle(String(body ?? ''))}${timestampSuffix(state, style)}`;
}

function isHostCommandEvent(event) {
  return String(event?.event ?? event?.event_kind ?? '').startsWith('carrier_host_command_')
    || event?.event === 'host_command_result';
}

function hostCommandPayload(event) {
  return event?.payload && typeof event.payload === 'object' ? event.payload : event;
}

function formatHostCommandBlock(event, state, style) {
  const payload = hostCommandPayload(event);
  const eventKind = String(event?.event ?? event?.event_kind ?? 'host_command_result');
  const commandText = String(payload.command_text ?? payload.command_summary ?? '').trim();
  const terminalState = payload.terminal_state
    ?? (eventKind.endsWith('_completed') ? 'completed' : eventKind.endsWith('_failed') ? 'failed' : eventKind.endsWith('_rejected') ? 'rejected' : 'unknown');
  const lines = [
    commandText ? `$ ${commandText}` : null,
    `status: ${terminalState}${Number.isInteger(payload.exit_code) ? ` (${payload.exit_code})` : ''}`,
    payload.admission_reason ? `admission: ${payload.admission_reason}` : null,
    payload.stdout ? String(payload.stdout).trimEnd() : null,
    payload.stderr ? String(payload.stderr).trimEnd() : null,
    payload.error ? `error: ${payload.error}` : null,
    payload.output_ref ? `output: ${payload.output_ref.payload_ref ?? payload.output_ref}` : null,
  ].filter((line) => String(line ?? '').trim());
  const bodyStyle = terminalState === 'completed' ? (value) => value : style.warn;
  const wrapped = wrapIndentedLines(lines.join('\n'), { indent: '', columns: terminalColumns(state) - 2 });
  const block = formatTerminalMessageBlockLines({
    label: 'carrier host',
    lines: wrapped,
    style,
    labelStyle: style.tool,
    bodyStyle,
  });
  appendSuffixToLastLine(block, timestampSuffix(state, style));
  return block;
}

function startupRows(event) {
  const rows = [
    ['Identity', event.agent_id ?? '<unknown>'],
    ['Session', event.session_id ?? '<unknown>'],
    ['Provider', event.provider ?? '<unknown>'],
    ['Model', event.model ?? '<unknown>'],
    ['Thinking', event.thinking ?? '<unknown>'],
    ['Stream', event.stream === false ? 'off' : 'on'],
    ['Goal', event.goal_display ?? event.goal ?? 'not set'],
    ['MCP servers', event.mcp_server_count ?? 0],
    ['MCP state', event.mcp_operational_state ?? 'unknown'],
  ];
  if ((event.mcp_startup_failure_count ?? 0) > 0) rows.push(['MCP startup failures', event.mcp_startup_failure_summary ?? event.mcp_startup_failure_count]);
  if ((event.mcp_runtime_fault_count ?? 0) > 0) rows.push(['MCP runtime faults', event.mcp_runtime_fault_summary ?? event.mcp_runtime_fault_count]);
  for (const server of event.mcp_servers ?? []) {
    if (!server?.name) continue;
    rows.push([`  ${server.name}`, `${server.tool_count ?? 0} tools`]);
  }
  rows.push(
    ['Tools', event.tool_count ?? 0],
    ['Tool outputs', event.tool_outputs ?? 'shown'],
    ['Approvals', event.approvals ?? 'disabled'],
    ['Help', event.help ?? '/help'],
  );
  return rows;
}

function formatStartupTable(event, style) {
  const rows = startupRows(event);
  const width = rows.reduce((max, [label]) => Math.max(max, String(label).length), 0);
  return [
    `${style.label('agent-cli')}:`,
    ...rows.map(([label, value]) => `  ${style.label(String(label).padEnd(width))} ${value ?? ''}`),
    '',
  ];
}

export function renderOperatorEvent(event, state = {}) {
  if (!event || typeof event !== 'object') return [];
  const style = state.style ?? createOperatorStyle({ enabled: false });
  if (!state.streamedTurns) state.streamedTurns = new Set();
  if (!state.streamedContentByTurn) state.streamedContentByTurn = new Map();
  if (isHostCommandEvent(event)) {
    const eventKind = String(event.event ?? event.event_kind ?? '');
    if (eventKind === 'carrier_host_command_requested' || eventKind === 'carrier_host_command_admitted' || eventKind === 'carrier_host_command_started') return [];
    return withStreamBoundary(state, formatHostCommandBlock(event, state, style));
  }
  switch (event.event) {
    case 'session_started':
      state.agentId = event.agent_id ?? state.agentId;
      state.toolOutputs = event.tool_outputs ?? state.toolOutputs ?? 'shown';
      return formatStartupTable(event, style);
    case 'session_status':
      return withStreamBoundary(state, [routeLine({
        label: 'agent-cli',
        body: `status ${event.operational_posture_display ?? event.operational_posture ?? 'unknown'}; requests ${event.request_outcome_summary ?? '0'}`,
        labelStyle: style.label,
        state,
        style,
      })]);
    case 'session_recovery':
      return withStreamBoundary(state, [routeLine({
        label: 'agent-cli',
        body: `recovery ${event.operational_posture_display ?? event.operational_posture ?? 'unknown'}; action ${event.recommended_action_display ?? event.recommended_action ?? 'none'}`,
        labelStyle: style.label,
        state,
        style,
      })]);
    case 'session_operations':
      return withStreamBoundary(state, [routeLine({
        label: 'agent-cli',
        body: `operations ${event.operation?.operation_event_summary ?? event.event_summary?.event_summary ?? event.operational_posture_display ?? 'available'}`,
        labelStyle: style.label,
        state,
        style,
      })]);
    case 'session_sync':
      return withStreamBoundary(state, [routeLine({
        label: 'agent-cli',
        body: `session sync ${event.success === true ? 'succeeded' : event.success === false ? 'failed' : event.mode ?? 'requested'}; ${event.direction ?? 'upload'}${event.target ? ` ${event.target}` : ''}`,
        labelStyle: style.label,
        bodyStyle: event.success === false ? style.warn : (value) => value,
        state,
        style,
      })]);
    case 'observer_status':
      return withStreamBoundary(state, [routeLine({
        label: 'agent-cli',
        body: event.message ?? `observers ${event.observer_muted === true ? 'muted' : 'shown'}`,
        labelStyle: style.label,
        state,
        style,
      })]);
    case 'carrier_command_result': {
      if (event.fields?.tool_outputs) state.toolOutputs = event.fields.tool_outputs;
      const message = String(event.message ?? '').trim();
      if (!message.includes('\n')) {
        return withStreamBoundary(state, [routeLine({
          label: 'agent-cli',
          body: message || `${event.command ?? 'command'} ${event.terminal_state ?? 'completed'}`,
          labelStyle: style.label,
          bodyStyle: event.terminal_state === 'invalid' || event.terminal_state === 'unsupported' ? style.warn : (value) => value,
          state,
          style,
        })]);
      }
      const block = formatTerminalMessageBlockLines({
        label: 'agent-cli',
        lines: wrapIndentedLines(message, { indent: '', columns: terminalColumns(state) - 2 }),
        style,
        labelStyle: style.label,
        bodyStyle: event.terminal_state === 'invalid' || event.terminal_state === 'unsupported' ? style.warn : (value) => value,
      });
      appendSuffixToLastLine(block, timestampSuffix(state, style));
      return withStreamBoundary(state, block);
    }
    case 'directive_received':
      if (!event.turn_id) return [];
      return withStreamBoundary(state, [routeLine({
        label: `operator directive -> ${event.agent_id ?? 'agent'}`,
        body: 'accepted directive',
        labelStyle: style.operatorDirective,
        state,
        style,
      })]);
    case 'directive_complete':
      if (!event.turn_id) return [];
      return withStreamBoundary(state, [routeLine({
        label: 'agent-cli',
        body: `directive ${event.terminal_state ?? 'complete'}`,
        labelStyle: style.label,
        bodyStyle: event.terminal_state === 'failed' ? style.error : style.muted,
        state,
        style,
      })]);
    case 'turn_started':
      if (consumeLocalThinkingForEvent(state, event)) {
        return withStreamBoundary(state, []);
      }
      return withStreamBoundary(state, [`${assistantEmissionHeader(state, style, event.agent_id ?? 'agent')} thinking...`]);
    case 'assistant_message_stream': {
      clearLocalThinking(state);
      const content = String(event.content ?? '');
      if (!content) return [];
      const turnKey = event.turn_id ?? '__default_stream_turn';
      if (event.turn_id) state.streamedTurns.add(event.turn_id);
      state.streamedContentByTurn.set(turnKey, `${state.streamedContentByTurn.get(turnKey) ?? ''}${content}`);
      const prefix = state.streamOpen && state.openStreamTurnKey === turnKey
        ? ''
        : `${assistantEmissionHeader(state, style, event.agent_id ?? 'assistant')}\n  `;
      const bodyWidth = terminalColumns(state) - 2;
      const shouldHardWrap = stripAnsi(content).length > bodyWidth;
      const renderedContent = shouldHardWrap
        ? wrapIndentedLines(content, { indent: '  ', columns: terminalColumns(state) }).join('\n').replace(/^  /, '')
        : content.replace(/\r?\n/g, '\n  ');
      const raw = `${prefix}${styleInlineCode(renderedContent, style)}`;
      state.streamOpen = true;
      state.openStreamTurnKey = turnKey;
      state.streamAtLineStart = raw.endsWith('\n');
      return [{ raw, newline: false }];
    }
    case 'assistant_message': {
      clearLocalThinking(state);
      const turnKey = event.turn_id ?? '__default_stream_turn';
      const finalContent = String(event.content ?? '');
      const streamedContent = state.streamedContentByTurn.get(turnKey) ?? '';
      const content = (streamedContent && finalContent.startsWith(streamedContent)
        ? finalContent.slice(streamedContent.length).trimStart()
        : finalContent).trimEnd();
      if (!content) return [];
      const renderedContent = renderMarkdownForProjectedTerminal(content, style);
      const lines = wrapIndentedLines(renderedContent, { indent: '', columns: terminalColumns(state) - 2 });
      if (streamedContent) return withStreamBoundary(state, lines.map((line) => `  ${line}`));
      const block = formatTerminalMessageBlockLines({
        label: event.agent_id ?? 'assistant',
        lines,
        style,
        labelStyle: style.agent,
        bodyStyle: (value) => value,
      });
      appendSuffixToLastLine(block, timestampSuffix(state, style));
      return withStreamBoundary(state, block);
    }
    case 'tool_call': {
      clearLocalThinking(state);
      if (state.toolOutputs === 'hidden') return withStreamBoundary(state, []);
      const tool = toolDisplayName(event);
      const label = `${event.agent_id ?? 'agent'} -> agent-cli`;
      return withStreamBoundary(state, [routeLine({
        label,
        body: `${tool}${summarizeToolCall(event)}`,
        labelStyle: (value) => `${agentLabel(event, style)} ${style.muted('->')} ${style.tool('agent-cli')}`,
        bodyStyle: style.muted,
        state,
        style,
      })]);
    }
    case 'tool_result': {
      clearLocalThinking(state);
      if (state.toolOutputs === 'hidden') return withStreamBoundary(state, []);
      const status = String(event.status ?? '').toLowerCase();
      const normal = !status || ['success', 'complete', 'completed', 'ok'].includes(status);
      const levelStyle = normal ? style.muted : status === 'error' ? style.error : style.warn;
      return withStreamBoundary(state, [routeLine({
        label: `agent-cli -> ${event.agent_id ?? 'agent'}`,
        body: `${toolDisplayName(event)} ${summarizeToolResult(event)}`,
        labelStyle: (value) => `${style.tool('agent-cli')} ${style.muted('->')} ${agentLabel(event, style)}`,
        bodyStyle: levelStyle,
        state,
        style,
      })]);
    }
    case 'turn_complete':
      return withStreamBoundary(state, [routeLine({ label: 'agent-cli', body: 'turn complete', labelStyle: style.label, bodyStyle: style.ok, state, style })]);
    case 'turn_failed':
      return withStreamBoundary(state, [routeLine({ label: 'agent-cli', body: `turn failed: ${event.message ?? event.error ?? event.code ?? 'unknown error'}`, labelStyle: style.label, bodyStyle: style.error, state, style })]);
    case 'error':
      return withStreamBoundary(state, [routeLine({ label: 'error', body: `${event.code ?? 'error'}${event.message ? `: ${event.message}` : ''}`, labelStyle: style.error, bodyStyle: style.error, state, style })]);
    case 'session_closed':
      return withStreamBoundary(state, [routeLine({ label: 'agent-cli', body: 'session closed', labelStyle: style.label, state, style })]);
    default:
      return withStreamBoundary(state, []);
  }
}

export function createProjectedTerminalBridge({
  input = process.stdin,
  output = process.stdout,
  childStdin,
  style = createOperatorStyle({ enabled: colorEnabled({ output }) }),
} = {}) {
  const interactive = Boolean(input.isTTY && output.isTTY);
  const rl = readline.createInterface({
    input,
    output: interactive ? output : undefined,
    terminal: interactive,
    prompt: interactive ? createOperatorPrompt(style) : undefined,
  });
  const writeProjectedOutput = createProjectedOutputWriter({ rl, interactive, output });
  const operatorState = { streamedTurns: new Set(), style };

  if (interactive) rl.prompt();
  rl.on('line', (line) => {
    const explicitJsonControl = createExplicitJsonControlFrame(line);
    if (explicitJsonControl) {
      if (explicitJsonControl.error) {
        writeProjectedOutput(`agent-cli: ${explicitJsonControl.error}\n`);
      } else {
        if (interactive) {
          const rewritten = rewriteSubmittedOperatorPromptForTest({
            line,
            agentId: projectedAgentId(operatorState),
            columns: output.columns || 80,
            style,
          });
          if (rewritten) output.write(rewritten);
        }
        childStdin?.write(`${JSON.stringify(explicitJsonControl.frame)}\n`);
      }
      if (interactive && explicitJsonControl.error) rl.prompt(true);
      return;
    }
    const slashCommand = createProjectedSlashCommandAction(line);
    if (slashCommand) {
      if (interactive) {
        const rewritten = rewriteSubmittedOperatorPromptForTest({
          line,
          agentId: projectedAgentId(operatorState),
          columns: output.columns || 80,
          style,
        });
        if (rewritten) output.write(rewritten);
      }
      if (slashCommand.kind === 'frame') {
        childStdin?.write(`${JSON.stringify(slashCommand.frame)}\n`);
      } else if (slashCommand.kind === 'local_help') {
        const rendered = formatTerminalMessageBlockLines({
          label: 'agent-cli',
          lines: wrapIndentedLines(projectedHelpText(), { indent: '', columns: terminalColumns(operatorState) - 2 }),
          style,
          labelStyle: style.label,
        }).join('\n');
        writeProjectedOutput(`${rendered}\n`, { preserveCurrentLine: true });
      } else if (slashCommand.kind === 'clear') {
        output.write('\x1b[2J\x1b[3J\x1b[H');
      } else if (slashCommand.kind === 'message') {
        writeProjectedOutput(`${style.label('agent-cli')}${style.muted(':')} ${slashCommand.message}\n`, { preserveCurrentLine: true });
      }
      return;
    }
    const frame = createOperatorConversationFrame(line);
    if (frame && interactive) {
      const rewritten = rewriteSubmittedOperatorPromptForTest({
        line,
        agentId: projectedAgentId(operatorState),
        columns: output.columns || 80,
        style,
      });
      if (rewritten) output.write(rewritten);
      const agentId = projectedAgentId(operatorState);
      output.write(`${assistantEmissionHeader(operatorState, style, agentId)} thinking...\n`);
      operatorState.localThinkingRendered = true;
      operatorState.localThinkingAgentId = agentId;
    }
    if (frame) childStdin?.write(`${JSON.stringify(frame)}\n`);
  });
  rl.on('close', () => {
    childStdin?.end();
  });

  return {
    interactive,
    rl,
    operatorState,
    writeProjectedOutput,
    renderEvent: (event) => renderOperatorEvent(event, operatorState),
  };
}
