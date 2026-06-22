import { spawnSync as defaultSpawnSync } from 'node:child_process';
import { formatTerminalMessageBlockLines } from './terminal-style.mjs';

function parseBooleanEnv(value, defaultValue) {
  if (value === undefined || value === null || String(value).trim() === '') return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function stripAnsi(text) {
  return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

function parseColorEnv(value, defaultValue) {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  return parseBooleanEnv(value, defaultValue);
}

function createTerminalRendering({
  identity = 'narada.architect',
  terminalStyle,
  isObserverInputEvent = () => false,
  observerVisibility = () => 'operator_visible',
  stringifySummary = (value) => JSON.stringify(value),
} = {}) {
  if (!terminalStyle) throw new TypeError('createTerminalRendering requires terminalStyle');
  const IDENTITY = identity;


function printHeader(text, { before = false, after = false, level = 'info' } = {}) {
  const styled = level === 'warn'
    ? terminalStyle.warn(`[agent-cli] ${text}`)
    : terminalStyle.header(`[agent-cli] ${text}`);
  console.log(`${before ? '\n' : ''}${styled}${after ? '\n' : ''}`);
}

function clearTerminalDisplay() {
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
}

function printHeaderRow(key, value, { before = false, after = false } = {}) {
  console.log(formatHeaderRow(key, value, { before, after }));
}

function printHeaderRows(rows, { before = false, after = false } = {}) {
  printMessageBlock({
    label: 'agent-cli',
    text: formatHeaderRows(rows),
    before,
    after,
    labelStyle: terminalStyle.tool,
    bodyStyle: (value) => value,
  });
}

function formatHeaderRows(rows) {
  const width = rows.reduce((max, [key]) => Math.max(max, stripAnsi(String(key)).length), 0);
  return rows.map(([key, value]) => formatHeaderRow(key, value, { width, includePrefix: false })).join('\n');
}

function formatHeaderRow(key, value, { before = false, after = false, width = 12, includePrefix = true } = {}) {
  const prefix = includePrefix ? `${terminalStyle.source('[agent-cli]')} ` : '';
  const keyText = terminalStyle.key(String(key).padEnd(width));
  const valueText = String(value) === 'on'
    ? terminalStyle.success(String(value))
    : terminalStyle.header(String(value));
  return `${before ? '\n' : ''}${prefix}${keyText} ${valueText}${after ? '\n' : ''}`;
}

function printToolRequestLine(text, { before = false } = {}) {
  printInlineEvent(toolDirectionLabel('invoke'), text, {
    before,
    timestamp: true,
    bodyStyle: terminalStyle.muted,
  });
}

function printToolResultLine(text, { before = false, level = 'info' } = {}) {
  const label = toolDirectionLabel('result');
  const bodyStyle = level === 'error' ? terminalStyle.error : level === 'warn' ? terminalStyle.warn : terminalStyle.muted;
  if (!String(text ?? '').includes('\n')) {
    printInlineEvent(label, text, { before, timestamp: true, labelStyle: level === 'error' ? terminalStyle.error : level === 'warn' ? terminalStyle.warn : (value) => value, bodyStyle });
    return;
  }
  printMessageBlock({ label, text, before, timestamp: true, labelStyle: level === 'error' ? terminalStyle.error : level === 'warn' ? terminalStyle.warn : (value) => value, bodyStyle });
}

function toolDirectionLabel(direction) {
  const arrow = terminalStyle.muted('->');
  if (direction === 'result') return `${terminalStyle.tool('agent-cli')} ${arrow} ${terminalStyle.label(IDENTITY)}`;
  return `${terminalStyle.label(IDENTITY)} ${arrow} ${terminalStyle.tool('agent-cli')}`;
}

function styleInputRouteLabel(label) {
  const manual = `operator -> ${IDENTITY}`;
  const directive = `operator directive -> ${IDENTITY}`;
  const arrow = terminalStyle.muted('->');
  if (label === manual) return `${terminalStyle.operator('operator')} ${arrow} ${terminalStyle.label(IDENTITY)}`;
  if (label === directive) return `${terminalStyle.operatorDirective('operator directive')} ${arrow} ${terminalStyle.label(IDENTITY)}`;
  return terminalStyle.prompt(label);
}

function printInlineEvent(label, text, { before = false, timestamp = false, labelStyle = (value) => value, bodyStyle = (value) => value } = {}) {
  const suffix = timestamp ? ` ${terminalStyle.timestamp(formatTimestamp())}` : '';
  writeTerminalRecord(`${labelStyle(label)}${terminalStyle.muted(':')} ${bodyStyle(String(text ?? ''))}${suffix}\n`, { before });
}

function printAgentMessage(text) {
  const normalized = String(text ?? '').trim();
  if (!stripAnsi(normalized).trim()) return false;
  const renderedText = renderMarkdownForTerminal(normalized);
  if (!stripAnsi(renderedText).trim()) return false;
  printMessageBlock({
    label: IDENTITY,
    text: renderedText,
    before: true,
    after: true,
    timestamp: true,
    labelStyle: terminalStyle.label,
    bodyStyle: (value) => value,
  });
  return true;
}

function printCliMessage(text) {
  const normalized = String(text ?? '').trim();
  if (!normalized) return;
  printMessageBlock({
    label: 'agent-cli',
    text: renderMarkdownForTerminal(normalized),
    before: true,
    after: true,
    labelStyle: terminalStyle.tool,
    bodyStyle: (value) => value,
  });
}

function copyToClipboard(text, spawnSyncFn = defaultSpawnSync, platform = process.platform) {
  try {
    let result;
    if (platform === 'win32') {
      result = spawnSyncFn('clip', [], { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
    } else if (platform === 'darwin') {
      result = spawnSyncFn('pbcopy', [], { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
    } else {
      result = spawnSyncFn('xclip', ['-selection', 'clipboard'], { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
    }
    return !result?.error && (result?.status == null || result.status === 0);
  } catch {
    return false;
  }
}

function printHostCommandResult(result = {}) {
  const commandText = String(result.command_text ?? '').trim();
  const lines = [
    commandText ? `$ ${commandText}` : null,
    `status: ${result.terminal_state ?? 'unknown'}${Number.isInteger(result.exit_code) ? ` (${result.exit_code})` : ''}`,
  ].filter(Boolean);
  const outputText = [result.stdout, result.stderr].filter((value) => String(value ?? '').trim()).join('\n').trim();
  if (outputText) lines.push(outputText);
  if (result.output_ref) lines.push(`output: ${result.output_ref.payload_ref}`);
  printMessageBlock({
    label: 'carrier host',
    text: lines.join('\n'),
    before: true,
    timestamp: true,
    labelStyle: terminalStyle.tool,
    bodyStyle: result.terminal_state === 'completed' ? (value) => value : terminalStyle.warn,
  });
}

function printInputRecord(record) {
  const label = inputRecordDisplayLabel(record);
  const labelStyle = record.source === 'system_directive'
    ? terminalStyle.systemDirective
    : isObserverInputEvent(record)
      ? terminalStyle.label
    : styleInputRouteLabel;
  printMessageBlock({
    label,
    text: String(record.content ?? '').trim(),
    before: true,
    timestamp: true,
    labelStyle,
    bodyStyle: (value) => value,
  });
}

function inputRecordDisplayLabel(record) {
  if (record?.source === 'system_directive') return 'system directive';
  if (record?.source === 'operator_directive') return `operator directive -> ${IDENTITY}`;
  if (record?.source === 'operator_steering') return `operator steering -> ${IDENTITY}`;
  if (isObserverInputEvent(record)) {
    const observerId = record?.source_id ?? 'narada.observer';
    const visibility = observerVisibility(record);
    if (visibility === 'agent_visible') return `${observerId} -> ${IDENTITY}`;
    if (visibility === 'conversation_visible') return `${observerId} -> conversation`;
    return `${observerId} -> operator`;
  }
  return `operator -> ${IDENTITY}`;
}

function printOperatorMessage(text) {
  const normalized = String(text ?? '').trim();
  if (!normalized) return;
  printMessageBlock({
    label: 'operator',
    text: normalized,
    before: true,
    timestamp: true,
    labelStyle: terminalStyle.prompt,
    bodyStyle: (value) => value,
  });
}

function rewriteSubmittedPrompt(promptLabel, input) {
  if (!process.stdout.isTTY) return;
  const rewritten = rewriteSubmittedPromptForTest(promptLabel, input, process.stdout.columns || 80);
  if (rewritten) process.stdout.write(rewritten);
}

function rewriteSubmittedPromptForTest(promptLabel, input, columns = 80, now = new Date()) {
  const text = String(input ?? '');
  if (text.includes('\n') || text.includes('\r')) return null;
  const rawPromptRows = Math.max(1, Math.ceil(stripAnsi(`${promptLabel}> ${text}`).length / Math.max(1, columns)));
  return `${clearPreviousTerminalRows(rawPromptRows)}\n${formatSubmittedPrompt(promptLabel, text, columns, now)}`;
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

function formatSubmittedPrompt(promptLabel, text, columns = 80, now = new Date()) {
  const prefix = `${promptLabel}: `;
  const firstLineWidth = Math.max(16, columns - stripAnsi(prefix).length);
  const lines = wrapTerminalLine(String(text ?? ''), firstLineWidth);
  const [first = '', ...rest] = lines;
  const renderedLines = [
    `${styleInputRouteLabel(promptLabel)}${terminalStyle.muted(':')} ${first}`,
    ...rest.map((line) => `  ${line}`),
  ];
  appendSuffixToLastLine(renderedLines, ` ${terminalStyle.timestamp(formatTimestamp(now))}`);
  return renderedLines.join('\n') + '\n';
}

function printMessageBlock({ label, text, before = false, after = false, timestamp = false, labelStyle = (value) => value, bodyStyle = (value) => value }) {
  const width = terminalWidth();
  const bodyWidth = Math.max(32, width - 2);
  const lines = String(text ?? '').split(/\r?\n/).flatMap((line) => wrapTerminalLine(line, bodyWidth));
  const renderedLines = formatTerminalMessageBlockLines({
    label,
    lines,
    style: terminalStyle,
    labelStyle,
    bodyStyle,
  });
  if (timestamp) appendSuffixToLastLine(renderedLines, ` ${terminalStyle.timestamp(formatTimestamp())}`);
  const rendered = renderedLines.join('\n');
  writeTerminalRecord(`${rendered}${after ? '\n\n' : '\n'}`, { before });
}

function writeTerminalRecord(text, { before = false } = {}) {
  process.stdout.write(`\r\x1b[K${before ? '\n' : ''}${text}`);
}

function appendSuffixToLastLine(lines, suffix) {
  if (!Array.isArray(lines) || lines.length === 0 || !suffix) return lines;
  lines[lines.length - 1] = `${lines[lines.length - 1]}${suffix}`;
  return lines;
}

function formatTimestamp(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

function renderMarkdownForTerminal(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  let inFence = false;
  let inTable = false;
  let tableRows = [];
  let tableHeader = null;
  const outLines = [];
  for (const line of lines) {
    const fenceMatch = line.match(/^(\s*)```/);
    if (fenceMatch) {
      if (inTable) flushTable();
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      outLines.push(terminalStyle.code(`  ${line.replace(/^\s{0,4}/, '')}`));
      continue;
    }
    const tableMatch = line.match(/^\|(.*)\|$/);
    if (tableMatch) {
      inTable = true;
      const cells = tableMatch[1].split('|').map((cell) => cell.trim());
      const isSeparator = cells.every((cell) => /^:?-+:?$/.test(cell));
      if (isSeparator) continue;
      if (tableHeader === null) {
        tableHeader = cells;
      } else {
        tableRows.push(cells);
      }
      continue;
    }
    if (inTable) {
      flushTable();
      inTable = false;
    }
    if (/^#{1,6}\s+/.test(line)) {
      outLines.push(terminalStyle.label(line.replace(/^#{1,6}\s+/, '')));
      continue;
    }
    const normalizedLine = normalizeDisplayTerms(line);
    const bulletLine = /^\s*[-*]\s+/.test(normalizedLine)
      ? normalizedLine.replace(/^(\s*)[-*]\s+/, '$1• ')
      : normalizedLine;
    outLines.push(styleInlineCode(bulletLine));
  }
  if (inTable) flushTable();
  return outLines.filter((line) => line !== null).join('\n');

  function flushTable() {
    if (!tableHeader) return;
    const colCount = tableHeader.length;
    const visible = (s) => stripAnsi(s).length;
    const padded = (s, width) => {
      const padWidth = Math.max(0, width - visible(s));
      return `${s}${' '.repeat(padWidth)}`;
    };
    const widths = tableHeader.map((h, i) => Math.max(
      visible(styleInlineCode(h)),
      ...tableRows.map((row) => visible(styleInlineCode(row[i] ?? ''))),
    ));
    const renderRow = (row) => row.map((cell, i) => padded(styleInlineCode(cell ?? ''), widths[i])).join('  ');
    outLines.push(terminalStyle.label(renderRow(tableHeader)));
    for (const row of tableRows) {
      const paddedRow = [];
      for (let i = 0; i < colCount; i++) {
        paddedRow.push(padded(styleInlineCode(row[i] ?? ''), widths[i]));
      }
      outLines.push(paddedRow.join('  '));
    }
    tableHeader = null;
    tableRows = [];
  }
}

function styleInlineCode(line) {
  return String(line ?? '').replace(/`([^`]+)`/g, (_match, code) => terminalStyle.code(code));
}

function normalizeDisplayTerms(line) {
  return transformOutsideInlineCode(String(line ?? ''), (chunk) => chunk
    .replace(/\bauthority_locus\b/g, 'authority locus')
    .replace(/\bauthority_posture\b/g, 'authority posture')
    .replace(/\bfacade_only\b/g, '`facade_only`')
    .replace(/\bnarada_proper\b/g, '`narada_proper`'));
}

function transformOutsideInlineCode(text, transform) {
  return String(text ?? '').split(/(`[^`]*`)/g)
    .map((part) => part.startsWith('`') && part.endsWith('`') ? part : transform(part))
    .join('');
}

function terminalWidth() {
  return Math.max(50, Math.min(120, process.stdout.columns || 88));
}

function wrapTerminalLine(line, width) {
  if (line.trim() === '') return [''];
  const visible = stripAnsi(line);
  if (visible.length <= width) return [line];
  const words = line.split(/(\s+)/);
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
  return lines.length ? lines : [line];
}

function formatToolResultContent(content) {
  const text = typeof content === 'string' ? content : String(content == null ? '' : stringifySummary(content));
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const keys = Object.keys(parsed);
      // If the JSON is compact enough, show it inline so operators and the AI can actually read it.
      const compact = JSON.stringify(parsed);
      if (compact.length <= 240) return compact;

      const status = typeof parsed.status === 'string' ? `${parsed.status}` : null;
      const schema = typeof parsed.schema === 'string' ? parsed.schema : null;
      const count = typeof parsed.directive_count === 'number'
        ? `directives=${parsed.directive_count}`
        : typeof parsed.directiveCount === 'number'
          ? `directives=${parsed.directiveCount}`
          : null;
      const outputRef = typeof parsed.output_ref === 'string' ? `output_ref=${parsed.output_ref}` : null;
      const readerTool = typeof parsed.reader_tool === 'string' ? `reader_tool=${parsed.reader_tool}` : null;
      const error = typeof parsed.error === 'string' ? `error=${parsed.error}` : null;
      const shownKeys = keys.slice(0, 8);
      const keySummary = shownKeys.length
        ? `keys: ${shownKeys.join(', ')}${keys.length > shownKeys.length ? ', ...' : ''}`
        : null;
      return [
        [status, schema, count, outputRef, readerTool, error].filter(Boolean).join(' · '),
        keySummary,
      ].filter(Boolean).join('\n');
    }
    if (Array.isArray(parsed)) {
      const compact = JSON.stringify(parsed);
      return compact.length <= 240 ? compact : `array(${parsed.length})`;
    }
  } catch {
    // Fall through to text summary.
  }
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

function formatKeyValueRows(record) {
  const entries = Object.entries(record);
  const width = entries.reduce((max, [key]) => Math.max(max, key.length), 0);
  return entries.map(([key, value]) => `${key.padEnd(width)}  ${value}`).join('\n');
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function formatProgressStatus({ spinner, phase, totalMs, phaseMs, operatorDirectiveDraft = '', operatorDirectiveDraftLength = 0, queuedOperatorDirectiveCount = 0 }) {
  const phaseText = String(phase ?? 'working');
  const phaseDuration = formatDuration(phaseMs ?? totalMs ?? 0);
  const totalDuration = formatDuration(totalMs ?? 0);
  const totalSuffix = phaseText === 'thinking' ? '' : ` · total ${totalDuration}`;
  const queuedSuffix = queuedOperatorDirectiveCount > 0 ? ` · queued operator directives ${queuedOperatorDirectiveCount}` : '';
  const draftText = sanitizeOperatorDirectiveDraftForDisplay(operatorDirectiveDraft);
  const draftLength = operatorDirectiveDraftLength || Array.from(String(operatorDirectiveDraft ?? '')).length;
  const draftSuffix = draftText
    ? ` · typing: ${draftText}`
    : (draftLength > 0 ? ` · typing operator directive (${draftLength})` : '');
  return `${spinner} ${phaseText} ${phaseDuration}${totalSuffix}${queuedSuffix} · Enter queues note · Esc to interrupt${draftSuffix}`;
}

function sanitizeOperatorDirectiveDraftForDisplay(value) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]+/g, '')
    .trimEnd();
}

  return {
    terminalStyle,
    printHeader,
    clearTerminalDisplay,
    printHeaderRow,
    printHeaderRows,
    formatHeaderRows,
    formatHeaderRow,
    printToolRequestLine,
    printToolResultLine,
    toolDirectionLabel,
    styleInputRouteLabel,
    printInlineEvent,
    printAgentMessage,
    printCliMessage,
    copyToClipboard,
    printHostCommandResult,
    printInputRecord,
    inputRecordDisplayLabel,
    printOperatorMessage,
    rewriteSubmittedPrompt,
    rewriteSubmittedPromptForTest,
    clearPreviousTerminalRows,
    formatSubmittedPrompt,
    printMessageBlock,
    writeTerminalRecord,
    appendSuffixToLastLine,
    formatTimestamp,
    renderMarkdownForTerminal,
    styleInlineCode,
    normalizeDisplayTerms,
    transformOutsideInlineCode,
    terminalWidth,
    wrapTerminalLine,
    formatToolResultContent,
    formatKeyValueRows,
    formatDuration,
    formatProgressStatus,
    sanitizeOperatorDirectiveDraftForDisplay,
  };
}

export {
  createTerminalRendering,
  parseColorEnv,
  stripAnsi,
};
