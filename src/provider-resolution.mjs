import { readFileSync } from 'node:fs';

export const PROVIDER_SUPPORT_STATES = Object.freeze({
  DECLARED: 'declared',
  ADMITTED_UNSUPPORTED: 'admitted_unsupported',
  ADAPTER_IMPLEMENTED: 'adapter_implemented',
  VERIFIED_SUPPORTED: 'verified_supported',
  DEPRECATED: 'deprecated',
  REMOVED: 'removed',
});

export const DEFAULT_AGENT_CLI_PROVIDER = 'codex-subscription';

export function loadProviderMetadata(url = new URL('./intelligence-providers.json', import.meta.url)) {
  return Object.freeze(JSON.parse(readFileSync(url, 'utf-8')).providers ?? {});
}

export function resolveProviderMetadata(provider, metadata = loadProviderMetadata()) {
  return metadata[provider] ?? metadata['openai-api'];
}

export function providerEnvironment(provider, metadata = loadProviderMetadata(), env = process.env) {
  const providerDefault = resolveProviderMetadata(provider, metadata);
  const baseUrl = env.NARADA_AI_BASE_URL ?? providerDefault.base_url;
  const model = env.NARADA_AI_MODEL ?? providerDefault.default_model;
  const apiKey = env.NARADA_AI_API_KEY ?? (provider === 'anthropic-api' ? env.ANTHROPIC_API_KEY : '') ?? '';
  return { providerDefault, baseUrl, model, apiKey };
}
