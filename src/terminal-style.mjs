export function createTerminalStyle({ enabled = true } = {}) {
  const color = (code, text) => enabled ? `\x1b[${code}m${text}\x1b[0m` : text;
  return {
    enabled,
    header: (text) => color('36', text),
    tool: (text) => color('35', text),
    assistant: (text) => color('37', text),
    label: (text) => color('1;36', text),
    operator: (text) => color('1;32', text),
    operatorDirective: (text) => color('1;33', text),
    systemDirective: (text) => color('1;35', text),
    muted: (text) => color('2', text),
    source: (text) => color('90', text),
    timestamp: (text) => color('38;5;240', text),
    key: (text) => color('33', text),
    code: (text) => color('90', text),
    success: (text) => color('32', text),
    prompt: (text) => color('1;32', text),
    progress: (text) => color('2;33', text),
    warn: (text) => color('33', text),
    error: (text) => color('38;5;167', text),
  };
}

export function formatTerminalMessageBlockLines({
  label,
  lines,
  style = createTerminalStyle({ enabled: false }),
  labelStyle = (value) => value,
  bodyStyle = (value) => value,
  indent = '  ',
} = {}) {
  const bodyLines = Array.isArray(lines) ? lines : String(lines ?? '').split(/\r?\n/);
  return [
    `${labelStyle(String(label ?? ''))}${style.muted(':')}`,
    ...bodyLines.map((line) => `${indent}${bodyStyle(String(line ?? ''))}`),
  ];
}
