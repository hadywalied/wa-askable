import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { makeProvider, type ChatMessage, type ToolSpec } from '../src/core/provider.js';

/**
 * Round-trips both protocols against a mock endpoint.
 *
 * The translation layer is the risky part: tool results are a *user* message
 * carrying tool_result blocks in Anthropic's shape and a distinct `role: 'tool'`
 * message in OpenAI's. Getting that wrong produces a 400 from a real provider
 * and nothing from a mock, so these assert the bytes actually sent.
 */

const TOOLS: ToolSpec[] = [
  {
    name: 'search_messages',
    description: 'Search the archive.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
];

const HISTORY: ChatMessage[] = [
  { role: 'user', content: 'what did Ahmed say about the flat' },
  {
    role: 'assistant',
    content: 'looking',
    toolCalls: [{ id: 'call_1', name: 'search_messages', input: { query: 'flat' } }],
  },
  { role: 'tool', toolCallId: 'call_1', name: 'search_messages', content: '[{"id":"x"}]' },
];

async function mock(handler: (body: any) => unknown): Promise<{ url: string; server: Server; seen: any[] }> {
  const seen: any[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      seen.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(handler(body)));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, server, seen };
}

test('OpenAI shape: tool calls are parsed and results sent as role:tool', async () => {
  const { url, server, seen } = await mock(() => ({
    choices: [
      {
        message: {
          content: '',
          tool_calls: [
            { id: 'call_9', type: 'function', function: { name: 'search_messages', arguments: '{"query":"deploy"}' } },
          ],
        },
      },
    ],
  }));
  try {
    const p = makeProvider({ kind: 'openai', apiKey: 'k', baseUrl: `${url}/v1` });
    assert.ok(p);
    const reply = await p.chat({ model: 'm', system: 'sys', messages: HISTORY, tools: TOOLS, maxTokens: 100 });

    assert.deepEqual(reply.toolCalls, [{ id: 'call_9', name: 'search_messages', input: { query: 'deploy' } }]);

    const sent = seen[0];
    assert.equal(sent.messages[0].role, 'system', 'system prompt becomes a system message');
    assert.equal(sent.messages[3].role, 'tool', 'tool result uses the tool role');
    assert.equal(sent.messages[3].tool_call_id, 'call_1');
    assert.equal(sent.tools[0].type, 'function');
    assert.equal(sent.tools[0].function.name, 'search_messages');
    // Arguments must be a JSON string, not an object.
    assert.equal(typeof sent.messages[2].tool_calls[0].function.arguments, 'string');
  } finally {
    server.close();
  }
});

test('OpenAI shape: malformed tool arguments do not crash the loop', async () => {
  const { url, server } = await mock(() => ({
    choices: [
      { message: { content: '', tool_calls: [{ id: 'c', type: 'function', function: { name: 'search_messages', arguments: '{not json' } }] } },
    ],
  }));
  try {
    const p = makeProvider({ kind: 'openai', apiKey: 'k', baseUrl: `${url}/v1` });
    const reply = await p!.chat({ model: 'm', system: 's', messages: [{ role: 'user', content: 'hi' }], tools: TOOLS, maxTokens: 10 });
    assert.deepEqual(reply.toolCalls[0]!.input, {}, 'bad JSON degrades to empty input');
  } finally {
    server.close();
  }
});

test('Anthropic shape: tool results are merged into one user message', async () => {
  const { url, server, seen } = await mock(() => ({
    id: 'msg', type: 'message', role: 'assistant', model: 'm',
    content: [{ type: 'text', text: 'done' }],
    stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
  }));
  try {
    const p = makeProvider({ kind: 'anthropic', apiKey: 'k', baseUrl: url });
    assert.ok(p);
    const twoResults: ChatMessage[] = [
      ...HISTORY,
      { role: 'tool', toolCallId: 'call_2', name: 'search_messages', content: '[]' },
    ];
    const reply = await p.chat({ model: 'm', system: 'sys', messages: twoResults, tools: TOOLS, maxTokens: 100 });
    assert.equal(reply.text, 'done');

    const sent = seen[0];
    assert.equal(sent.system, 'sys', 'system is a top-level field, not a message');
    const last = sent.messages[sent.messages.length - 1];
    assert.equal(last.role, 'user', 'tool results ride in a user message');
    assert.equal(last.content.length, 2, 'consecutive tool results merge into one message');
    assert.equal(last.content[0].type, 'tool_result');
    assert.equal(last.content[0].tool_use_id, 'call_1');
    assert.equal(sent.tools[0].input_schema.type, 'object', 'schema renamed to input_schema');
  } finally {
    server.close();
  }
});

test('no provider when neither key nor base URL is set', () => {
  assert.equal(makeProvider({ kind: 'openai', apiKey: undefined, baseUrl: '' }), null);
  // A base URL alone is enough — local runners need no credential.
  assert.ok(makeProvider({ kind: 'openai', apiKey: undefined, baseUrl: 'http://127.0.0.1:11434/v1' }));
});
