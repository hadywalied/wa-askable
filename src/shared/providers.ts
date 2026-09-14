/**
 * Provider catalogue.
 *
 * Two wire protocols exist in practice: Anthropic's `/v1/messages` and the
 * OpenAI-shaped `/chat/completions` that nearly everyone else implements. The
 * presets below are just (kind, baseUrl, model) triples — nothing here is
 * special-cased in the code, so "bring your own" is the same code path as a
 * built-in, and adding a provider is one entry in this list.
 */

export type ProviderKind = 'anthropic' | 'openai';

export interface ProviderPreset {
  id: string;
  label: string;
  kind: ProviderKind;
  /** Empty means the SDK's own default endpoint. */
  baseUrl: string;
  suggestedModel: string;
  /** Local runners generally accept any key, or none. */
  needsKey: boolean;
  /** True when the endpoint is on this machine — message text never leaves it. */
  local?: boolean;
  note?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    kind: 'anthropic',
    baseUrl: '',
    suggestedModel: 'claude-sonnet-5',
    needsKey: true,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    suggestedModel: 'gpt-5.6',
    needsKey: true,
  },
  {
    id: 'cohere',
    label: 'Cohere',
    kind: 'openai',
    baseUrl: 'https://api.cohere.ai/compatibility/v1',
    suggestedModel: 'command-a-plus-05-2026',
    needsKey: true,
    note: "Cohere's OpenAI-compatible endpoint. Its native API is a different shape and will not work.",
  },
  {
    id: 'groq',
    label: 'Groq',
    kind: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    suggestedModel: '',
    needsKey: true,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    suggestedModel: '',
    needsKey: true,
  },
  {
    id: 'ollama',
    label: 'Ollama (this machine)',
    kind: 'openai',
    baseUrl: 'http://127.0.0.1:11434/v1',
    suggestedModel: '',
    needsKey: false,
    local: true,
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (this machine)',
    kind: 'openai',
    baseUrl: 'http://127.0.0.1:1234/v1',
    suggestedModel: '',
    needsKey: false,
    local: true,
  },
  {
    id: 'custom',
    label: 'Bring your own…',
    kind: 'openai',
    baseUrl: '',
    suggestedModel: '',
    needsKey: false,
    note: 'Any endpoint speaking either wire protocol. Pick the one it implements.',
  },
];

export const presetById = (id: string): ProviderPreset | undefined =>
  PROVIDER_PRESETS.find((p) => p.id === id);

/** A base URL on the loopback interface means message text never leaves the machine. */
export function isLocalEndpoint(baseUrl: string): boolean {
  if (!baseUrl) return false;
  try {
    const h = new URL(baseUrl).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0';
  } catch {
    return false;
  }
}
