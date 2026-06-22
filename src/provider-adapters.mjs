import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { codexMcpEnvVarNames } from '@narada2/mcp-fabric';
import { stripAnsi } from './terminal-rendering.mjs';

const CODEX_AUTH_FILE_NAMES = Object.freeze([
  'auth.json',
  'credentials.json',
  'credential.json',
  'token.json',
  'tokens.json',
  'session.json',
  'sessions.json',
]);
const CODEX_AUTH_HOME_ENV = 'NARADA_CODEX_AUTH_HOME';

const providerAdapterContext = {
  provider: process.env.NARADA_INTELLIGENCE_PROVIDER ?? 'codex-subscription',
  apiKey: '',
  baseUrl: 'https://api.openai.com',
  model: process.env.CODEX_MODEL ?? process.env.NARADA_CODEX_MODEL ?? 'gpt-5',
  thinking: process.env.NARADA_AI_THINKING ?? process.env.NARADA_THINKING_LEVEL ?? 'medium',
  siteRoot: process.cwd(),
  nativeMcpTools: parseBooleanEnv(process.env.NARADA_CODEX_NATIVE_MCP_TOOLS, true),
  sessionDir: process.cwd(),
  buildChildProcessEnv: fallbackChildProcessEnv,
  writeDurableTextFile: (path, text, encoding = 'utf8') => writeFileSync(path, text, encoding),
};
let codexSubscriptionThreadId = null;

function configureProviderAdapterContext(nextContext = {}) {
  Object.assign(providerAdapterContext, Object.fromEntries(Object.entries(nextContext).filter(([, value]) => value !== undefined)));
}

function parseBooleanEnv(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function fallbackChildProcessEnv(extra = {}, baseEnv = process.env) {
  return { ...baseEnv, ...extra, FORCE_COLOR: '0', NO_COLOR: '1' };
}

const REQUEST_ADAPTERS = Object.freeze({
  'openai-compatible-chat-completions': { buildRequest: buildOpenAiChatRequest, parseResponse: (response) => response },
  'anthropic-messages': { buildRequest: buildAnthropicMessagesRequest, parseResponse: parseAnthropicMessagesResponse },
  'codex-mcp-server': { buildRequest: buildCodexMcpRequest, parseResponse: parseCodexMcpResponse },
});

function reasoningEffort(thinking) {
  if (thinking === 'none') return null;
  if (thinking === 'low') return 'low';
  if (thinking === 'high') return 'high';
  return 'medium';
}

function buildCodexMcpRequest(messages, tools = [], options = {}) {
  const { model = providerAdapterContext.model, thinking = providerAdapterContext.thinking, siteRoot = providerAdapterContext.siteRoot, nativeMcpTools = providerAdapterContext.nativeMcpTools, mcpServers = {} } = options;
  const latestUserIndex = findLastMessageIndex(messages, 'user');
  const latestToolIndex = findLastMessageIndex(messages, 'tool');
  const latestUser = latestUserIndex >= 0 ? messages[latestUserIndex] : null;
  const latestTool = latestToolIndex >= 0 ? messages[latestToolIndex] : null;
  const system = messages
    .filter((message) => message.role === 'system')
    .map((message) => String(message.content ?? ''))
    .filter(Boolean)
    .join('\n\n');
  const prompt = latestTool && latestToolIndex > latestUserIndex
    ? [
      `Narada tool result (${latestTool.tool_call_id ?? 'tool'}):`,
      String(latestTool.content ?? ''),
      '',
      'Answer the original request using this tool result.',
    ].join('\n')
    : latestUser ? String(latestUser.content ?? '') : '';
  if (!prompt.trim()) throw new Error('codex_subscription_prompt_missing');
  const developerInstructions = [system, codexToolProtocolInstructions(tools, { nativeMcpTools })].filter(Boolean).join('\n\n');

  if (codexSubscriptionThreadId) {
    return {
      tool: 'codex-reply',
      arguments: {
        threadId: codexSubscriptionThreadId,
        prompt,
        model,
        native_mcp_tools: nativeMcpTools,
        ...(nativeMcpTools ? { mcpServers } : {}),
        ...(reasoningEffort(thinking) ? { 'reasoning-effort': reasoningEffort(thinking) } : {}),
      },
    };
  }

  return {
    tool: 'codex',
    arguments: {
      prompt,
      cwd: siteRoot,
      model,
      native_mcp_tools: nativeMcpTools,
      ...(nativeMcpTools ? { mcpServers } : {}),
      ...(reasoningEffort(thinking) ? { 'reasoning-effort': reasoningEffort(thinking) } : {}),
      sandbox: process.platform === 'win32' ? 'danger-full-access' : 'workspace-write',
      'approval-policy': 'never',
      ...(developerInstructions ? { 'developer-instructions': developerInstructions } : {}),
    },
  };
}

function findLastMessageIndex(messages, role) {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === role) return index;
  }
  return -1;
}

function codexToolProtocolInstructions(tools = [], { nativeMcpTools = false } = {}) {
  if (!Array.isArray(tools) || tools.length === 0) return '';
  const toolLines = tools
    .map((tool) => {
      const fn = tool.function ?? {};
      const description = String(fn.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 220);
      const schema = formatCompactJsonSchema(fn.parameters ?? { type: 'object', properties: {} });
      return [
        `- ${fn.name}${description ? `: ${description}` : ''}`,
        `  input_schema: ${schema}`,
      ].join('\n');
    })
    .join('\n');
  const header = nativeMcpTools
    ? [
      'Narada MCP tools are registered with nested Codex as native MCP tools for this turn.',
      'Prefer native MCP tool calls when a listed tool is needed.',
      'If native MCP tool discovery is unavailable in the nested runtime, fall back by responding with exactly one JSON object and no prose:',
      '{"narada_tool_call":{"name":"tool_name","arguments":{}}}',
    ]
    : [
      'Narada MCP tools are available through agent-cli, not through native Codex tool discovery.',
      'When a Narada MCP tool is needed, respond with exactly one JSON object and no prose:',
      '{"narada_tool_call":{"name":"tool_name","arguments":{}}}',
    ];
  return [
    ...header,
    'Use each listed input_schema to construct arguments. Do not invent arguments outside the schema unless the schema explicitly allows them.',
    'Do not claim a listed Narada MCP tool is unavailable.',
    'Available Narada MCP tools:',
    toolLines,
  ].join('\n');
}

function parseCodexMcpResponse(response) {
  if (response?.threadId) codexSubscriptionThreadId = response.threadId;
  const toolCall = parseNaradaToolCall(response?.content ?? '');
  if (toolCall) {
    return {
      id: response?.threadId ?? `codex-${Date.now()}`,
      object: 'chat.completion',
      streaming_rendered: false,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: `narada_tool_${Date.now()}`,
            type: 'function',
            function: {
              name: toolCall.name,
              arguments: JSON.stringify(toolCall.arguments ?? {}),
            },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    };
  }
  return {
    id: response?.threadId ?? `codex-${Date.now()}`,
    object: 'chat.completion',
    streaming_rendered: response?.streaming_rendered === true,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: response?.content ?? '',
      },
      finish_reason: 'stop',
    }],
  };
}

function parseNaradaToolCall(content) {
  const text = stripAnsi(String(content ?? '')).trim();
  if (!text) return null;
  const candidates = [
    text,
    text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim(),
    extractJsonObject(text),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const call = parsed?.narada_tool_call;
      if (call && typeof call.name === 'string') {
        return {
          name: call.name,
          arguments: call.arguments && typeof call.arguments === 'object' && !Array.isArray(call.arguments)
            ? call.arguments
            : {},
        };
      }
    } catch {
      // Try next candidate.
    }
  }
  return null;
}

function isPotentialNaradaToolCallText(content) {
  const text = stripAnsi(String(content ?? '')).trimStart();
  if (!text) return false;
  if (text.startsWith('```')) return /^```(?:json)?\s*\{?/i.test(text);
  if (!text.startsWith('{')) return false;
  const compactPrefix = text.replace(/\s+/g, '').slice(0, 48);
  return '{"narada_tool_call"'.startsWith(compactPrefix)
    || compactPrefix.startsWith('{"narada_tool_call"');
}

function extractJsonObject(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : null;
}

function buildOpenAiChatRequest(messages, tools, options = {}) {
  const { baseUrl = providerAdapterContext.baseUrl, model = providerAdapterContext.model, apiKey = providerAdapterContext.apiKey, thinking = providerAdapterContext.thinking, provider = providerAdapterContext.provider } = options;
  const isKimiProvider = provider === 'kimi-api' || provider === 'kimi-code-api';
  const body = {
    model,
    messages: cleanOpenAiMessages(messages),
    tools: tools.length > 0 ? tools : undefined,
    tool_choice: tools.length > 0 ? 'auto' : undefined,
    temperature: isKimiProvider ? 1 : 0.2,
  };
  const effort = reasoningEffort(thinking);
  if (effort && provider === 'openai-api') body.reasoning_effort = effort;
  if (provider === 'deepseek-api') {
    body.thinking = { type: thinking === 'none' ? 'disabled' : 'enabled' };
    if (thinking !== 'none') {
      body.reasoning_effort = thinking === 'xhigh' ? 'max' : 'high';
    }
  }
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  };
  if (provider === 'kimi-code-api') {
    headers['User-Agent'] = 'KimiCLI/1.0';
  }
  return {
    url: new URL('v1/chat/completions', baseUrl),
    body,
    headers,
  };
}

function cleanOpenAiMessages(messages) {
  return messages.map((m) => {
    const clean = { role: m.role };
    if (m.role === 'tool') {
      clean.content = m.content ?? '';
      clean.tool_call_id = m.tool_call_id ?? '';
    } else if (m.role === 'assistant') {
      clean.content = m.content ?? null;
      if (m.tool_calls && m.tool_calls.length > 0) {
        clean.tool_calls = m.tool_calls;
        if (providerAdapterContext.provider === 'kimi-api' || providerAdapterContext.provider === 'kimi-code-api' || providerAdapterContext.provider === 'deepseek-api') {
          clean.reasoning_content = m.reasoning_content ?? '';
        }
      }
    } else {
      clean.content = m.content ?? '';
    }
    return clean;
  });
}

function buildAnthropicMessagesRequest(messages, tools, options = {}) {
  const { baseUrl = providerAdapterContext.baseUrl, model = providerAdapterContext.model, apiKey = providerAdapterContext.apiKey, thinking = providerAdapterContext.thinking } = options;
  const { system, anthropicMessages } = cleanAnthropicMessages(messages);
  const body = {
    model,
    max_tokens: 4096,
    messages: anthropicMessages,
    tools: tools.length > 0 ? tools.map(toAnthropicTool) : undefined,
    temperature: 0.2,
  };
  if (system) body.system = system;
  if (thinking === 'high') body.thinking = { type: 'enabled', budget_tokens: 4096 };
  else if (thinking === 'medium') body.thinking = { type: 'enabled', budget_tokens: 2048 };
  return {
    url: new URL('/v1/messages', baseUrl),
    body,
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': apiKey,
    },
  };
}

function cleanAnthropicMessages(messages) {
  const systemParts = [];
  const anthropicMessages = [];
  for (const message of messages) {
    if (message.role === 'system') {
      systemParts.push(String(message.content ?? ''));
    } else if (message.role === 'tool') {
      anthropicMessages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: message.tool_call_id ?? '',
          content: stringifyContent(message.content),
        }],
      });
    } else if (message.role === 'assistant') {
      const content = [];
      if (message.content) content.push({ type: 'text', text: String(message.content) });
      for (const toolCall of message.tool_calls ?? []) {
        content.push({
          type: 'tool_use',
          id: toolCall.id,
          name: toolCall.function?.name ?? '',
          input: parseJson(toolCall.function?.arguments ?? '{}'),
        });
      }
      anthropicMessages.push({ role: 'assistant', content: content.length > 0 ? content : '' });
    } else {
      anthropicMessages.push({ role: 'user', content: String(message.content ?? '') });
    }
  }
  return {
    system: systemParts.filter(Boolean).join('\n\n'),
    anthropicMessages,
  };
}

function toAnthropicTool(tool) {
  const fn = tool.function ?? {};
  return {
    name: fn.name,
    description: fn.description ?? '',
    input_schema: fn.parameters ?? { type: 'object', properties: {} },
  };
}

function parseAnthropicMessagesResponse(response) {
  const content = Array.isArray(response.content) ? response.content : [];
  const text = content.filter((item) => item?.type === 'text').map((item) => item.text ?? '').join('');
  const toolCalls = content
    .filter((item) => item?.type === 'tool_use')
    .map((item) => ({
      id: item.id,
      type: 'function',
      function: {
        name: item.name,
        arguments: JSON.stringify(item.input ?? {}),
      },
    }));
  const message = { role: 'assistant', content: text || null };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return {
    id: response.id,
    object: 'chat.completion',
    choices: [{
      index: 0,
      message,
      finish_reason: toolCalls.length > 0 ? 'tool_calls' : response.stop_reason ?? null,
    }],
    usage: response.usage,
  };
}

function buildCodexExecArgs(request, options = {}) {
  const { model = providerAdapterContext.model, thinking = providerAdapterContext.thinking, siteRoot = providerAdapterContext.siteRoot } = options;
  const effort = reasoningEffort(thinking);
  const common = [
    '--json',
    '--dangerously-bypass-approvals-and-sandbox',
    '-m',
    request.arguments?.model ?? model,
    '-c',
    'approval_policy="never"',
  ];
  if (effort) common.push('-c', `model_reasoning_effort="${effort}"`);
  if (request.arguments?.native_mcp_tools === true) {
    common.push(...codexExecMcpConfigArgs(request.arguments?.mcpServers ?? {}));
  }
  if (request.tool === 'codex-reply') {
    return ['exec', 'resume', ...common, request.arguments.threadId, '-'];
  }
  return ['exec', ...common, '-C', request.arguments?.cwd ?? siteRoot, '-'];
}

function codexExecPrompt(request) {
  const prompt = String(request.arguments?.prompt ?? '');
  const developerInstructions = request.arguments?.['developer-instructions'];
  if (!developerInstructions) return prompt;
  return [
    '<developer-instructions>',
    String(developerInstructions),
    '</developer-instructions>',
    '',
    prompt,
  ].join('\n');
}

function parseCodexExecJsonLine(line) {
  try {
    return JSON.parse(stripAnsi(String(line)));
  } catch {
    return null;
  }
}

function codexExecMcpToolEventSummary(event) {
  const item = event?.item;
  if (!item || item.type !== 'mcp_tool_call') return null;
  const server = item.server ?? 'unknown-server';
  const tool = item.tool ?? 'unknown_tool';
  const name = `${server}.${tool}`;
  const args = item.arguments && typeof item.arguments === 'object' ? item.arguments : {};
  return {
    id: item.id ?? null,
    server,
    tool,
    name,
    arguments: args,
    status: item.status ?? (event.type === 'item.started' ? 'in_progress' : 'completed'),
    result: item.result ?? null,
    error: item.error ?? null,
  };
}

function codexExecEventText(event) {
  if (event?.type !== 'item.completed') return '';
  const item = event.item;
  if (item?.type === 'agent_message' && typeof item.text === 'string') return item.text;
  return '';
}

function defaultUserCodexHome() {
  const userRoot = process.env.USERPROFILE || process.env.HOME;
  return userRoot ? join(userRoot, '.codex') : null;
}

function defaultCodexAuthHome() {
  const explicit = process.env[CODEX_AUTH_HOME_ENV];
  if (explicit) return explicit;
  const userHome = defaultUserCodexHome();
  if (userHome) return userHome;
  return process.env.CODEX_HOME || null;
}

function projectCodexAuthFiles(sourceHome, targetHome) {
  if (!sourceHome) return;
  const resolvedSource = resolve(sourceHome);
  const resolvedTarget = resolve(targetHome);
  if (resolvedSource === resolvedTarget || !existsSync(resolvedSource)) return;
  for (const fileName of CODEX_AUTH_FILE_NAMES) {
    const sourcePath = join(resolvedSource, fileName);
    if (!existsSync(sourcePath)) continue;
    try {
      if (!statSync(sourcePath).isFile()) continue;
      copyFileSync(sourcePath, join(resolvedTarget, fileName));
    } catch {
      // Optional auth projection should not block providers that use env credentials.
    }
  }
}

function writeCodexExecHome(mcpServers, sessionDir = providerAdapterContext.sessionDir, { sourceHome = defaultCodexAuthHome() } = {}) {
  const codexHome = join(sessionDir, 'codex-home');
  mkdirSync(codexHome, { recursive: true });
  projectCodexAuthFiles(sourceHome, codexHome);
  providerAdapterContext.writeDurableTextFile(join(codexHome, 'config.toml'), `${codexExecConfigToml(mcpServers)}\n`, 'utf8');
  return codexHome;
}

function codexRequestMcpServers(request, settings = {}) {
  return request.arguments?.mcpServers ?? settings.mcpServers ?? {};
}

function buildCodexSubprocessEnv(mcpServers, settings = {}) {
  const codexHome = writeCodexExecHome(mcpServers, settings.sessionDir ?? providerAdapterContext.sessionDir, {
    sourceHome: settings.codexAuthHome ?? defaultCodexAuthHome(),
  });
  const env = providerAdapterContext.buildChildProcessEnv({ CODEX_HOME: codexHome, CODEX_CONFIG_DIR: codexHome });
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_BASE_URL;
  delete env.OPENAI_MODEL;
  return env;
}

function buildCodexMcpServerArgs() {
  return ['mcp-server'];
}

function codexExecMcpConfigArgs(mcpServers) {
  const args = [];
  for (const [name, server] of Object.entries(mcpServers)) {
    const config = server.config ?? {};
    const envVars = codexMcpServerEnvVars(config);
    args.push('-c', `mcp_servers."${tomlKey(name)}".command=${tomlString(config.command ?? '')}`);
    args.push('-c', `mcp_servers."${tomlKey(name)}".args=${JSON.stringify((config.args ?? []).map((arg) => String(arg).replaceAll('\\', '/')))}`);
    args.push('-c', `mcp_servers."${tomlKey(name)}".env_vars=${JSON.stringify(envVars)}`);
    args.push('-c', `mcp_servers."${tomlKey(name)}".default_tools_approval_mode="approve"`);
  }
  return args;
}

function codexMcpServerEnvVars(config = {}) {
  return [...new Set([...(config.env_vars ?? []).map(String), ...codexMcpEnvVarNames()])];
}

function codexExecConfigToml(mcpServers) {
  const lines = [
    '# Generated by packages/agent-cli/src/provider-adapters.mjs for nested Codex subprocesses.',
    '# Mirrors the target Site MCP fabric; does not import User Site MCP servers.',
    '',
  ];
  for (const [name, server] of Object.entries(mcpServers)) {
    const config = server.config ?? {};
    lines.push(`[mcp_servers."${tomlKey(name)}"]`);
    lines.push(`command = ${tomlString(config.command ?? '')}`);
    lines.push(`args = ${JSON.stringify((config.args ?? []).map((arg) => String(arg).replaceAll('\\', '/')))}`);
    lines.push(`env_vars = ${JSON.stringify(codexMcpServerEnvVars(config))}`);
    lines.push('default_tools_approval_mode = "approve"');
    lines.push('');
  }
  return lines.join('\n');
}

function tomlString(value) {
  return JSON.stringify(String(value).replaceAll('\\', '/'));
}

function tomlKey(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function stringifyContent(value) {
  return typeof value === 'string' ? value : JSON.stringify(value ?? '');
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const record = value;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

function formatCompactJsonSchema(schema, { limit = 1200 } = {}) {
  const normalized = schema && typeof schema === 'object' && !Array.isArray(schema)
    ? schema
    : { type: 'object', properties: {} };
  const text = stableStringify(normalized);
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 3))}...` : text;
}

export {
  REQUEST_ADAPTERS,
  buildAnthropicMessagesRequest,
  buildCodexExecArgs,
  buildCodexMcpRequest,
  buildCodexMcpServerArgs,
  buildCodexSubprocessEnv,
  buildOpenAiChatRequest,
  cleanAnthropicMessages,
  cleanOpenAiMessages,
  codexExecConfigToml,
  codexExecEventText,
  codexExecMcpConfigArgs,
  codexExecMcpToolEventSummary,
  codexExecPrompt,
  codexRequestMcpServers,
  configureProviderAdapterContext,
  isPotentialNaradaToolCallText,
  parseAnthropicMessagesResponse,
  parseCodexExecJsonLine,
  parseCodexMcpResponse,
  parseNaradaToolCall,
  reasoningEffort,
};
