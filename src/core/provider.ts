import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { ProviderKind } from '../shared/providers.js';

/**
 * One interface over two wire protocols.
 *
 * Anthropic's `/v1/messages` and OpenAI's `/chat/completions` differ in more
 * than field names — tool results are a *user* message carrying tool_result
 * blocks in one, and a distinct `role: 'tool'` message in the other. The agent
 * loop in enrich.ts should not have to know that, so everything above this file
 * speaks the neutral shapes below and each adapter does its own translation.
 */

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type ChatMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface ChatReply {
  text: string;
  toolCalls: ToolCall[];
}

export interface ChatRequest {
  model: string;
  system: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  maxTokens: number;
}

export interface ChatProvider {
  readonly kind: ProviderKind;
  chat(req: ChatRequest): Promise<ChatReply>;
}

export interface ProviderConfig {
  kind: ProviderKind;
  apiKey: string | undefined;
  /** Empty means the SDK default endpoint. */
  baseUrl: string;
}

/** Returns null when nothing is configured — the app's local-only mode. */
export function makeProvider(cfg: ProviderConfig): ChatProvider | null {
  if (!cfg.apiKey && !cfg.baseUrl) return null;
  // A local endpoint usually wants no credential, but both SDKs insist on a
  // non-empty key, so send a placeholder rather than refusing to work.
  const apiKey = cfg.apiKey || 'local';
  const baseURL = cfg.baseUrl || undefined;
  return cfg.kind === 'anthropic'
    ? new AnthropicProvider(new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) }))
    : new OpenAIProvider(new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) }));
}

// --- Anthropic ---------------------------------------------------------------

class AnthropicProvider implements ChatProvider {
  readonly kind = 'anthropic' as const;
  constructor(private readonly client: Anthropic) {}

  async chat(req: ChatRequest): Promise<ChatReply> {
    const res = await this.client.messages.create({
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      ...(req.tools?.length
        ? {
            tools: req.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.parameters as Anthropic.Tool['input_schema'],
            })),
          }
        : {}),
      messages: toAnthropicMessages(req.messages),
    });

    return {
      text: res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim(),
      toolCalls: res.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
        .map((b) => ({ id: b.id, name: b.name, input: b.input as Record<string, unknown> })),
    };
  }
}

/**
 * The SDK pinned here (0.30.1, inherited from the original server) predates the
 * `ContentBlockParam` union, so it is spelled out. Worth upgrading separately —
 * not folded into this change, to keep the provider work reviewable.
 */
type AnthropicBlockParam =
  | Anthropic.TextBlockParam
  | Anthropic.ToolUseBlockParam
  | Anthropic.ToolResultBlockParam;

/**
 * Anthropic has no `tool` role: results are tool_result blocks inside a USER
 * message, and consecutive results must be merged into one. Emitting them
 * separately is rejected by the API.
 */
function toAnthropicMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      const blocks: AnthropicBlockParam[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const c of m.toolCalls ?? []) {
        blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input });
      }
      out.push({ role: 'assistant', content: blocks.length ? blocks : m.content || '(no content)' });
      continue;
    }
    const block: Anthropic.ToolResultBlockParam = {
      type: 'tool_result',
      tool_use_id: m.toolCallId,
      content: m.content,
    };
    const prev = out[out.length - 1];
    if (prev && prev.role === 'user' && Array.isArray(prev.content)) {
      prev.content.push(block);
    } else {
      out.push({ role: 'user', content: [block] });
    }
  }
  return out;
}

// --- OpenAI-shaped -----------------------------------------------------------

class OpenAIProvider implements ChatProvider {
  readonly kind = 'openai' as const;
  constructor(private readonly client: OpenAI) {}

  async chat(req: ChatRequest): Promise<ChatReply> {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: req.system },
    ];
    for (const m of req.messages) {
      if (m.role === 'user') {
        messages.push({ role: 'user', content: m.content });
      } else if (m.role === 'assistant') {
        messages.push({
          role: 'assistant',
          content: m.content || null,
          ...(m.toolCalls?.length
            ? {
                tool_calls: m.toolCalls.map((c) => ({
                  id: c.id,
                  type: 'function' as const,
                  function: { name: c.name, arguments: JSON.stringify(c.input) },
                })),
              }
            : {}),
        });
      } else {
        messages.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
      }
    }

    const res = await this.client.chat.completions.create({
      model: req.model,
      max_tokens: req.maxTokens,
      messages,
      ...(req.tools?.length
        ? {
            tools: req.tools.map((t) => ({
              type: 'function' as const,
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
          }
        : {}),
    });

    const choice = res.choices[0]?.message;
    return {
      text: (choice?.content ?? '').trim(),
      toolCalls: (choice?.tool_calls ?? []).flatMap((c) => {
        if (!('function' in c)) return [];
        let input: Record<string, unknown> = {};
        try {
          // Arguments arrive as a JSON *string*, and smaller models sometimes
          // emit malformed JSON. A bad call should degrade to an empty input,
          // not crash the whole agent loop.
          input = JSON.parse(c.function.arguments || '{}') as Record<string, unknown>;
        } catch {
          input = {};
        }
        return [{ id: c.id, name: c.function.name, input }];
      }),
    };
  }
}
