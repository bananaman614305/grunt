import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

type Result = Record<string, unknown>;
export type SignupAgent = (input: {
  service: string;
  url: string;
  goal: string;
  signal: AbortSignal;
  tools: Tool[];
  call(name: string, args: Result): Promise<Result>;
}) => Promise<void>;

// Vault, payment, upload, dialog and inbox tools stay out: they reveal secrets or local
// files to the free model, spend money, or confirm a key change no label check sees.
export const signupAgentTools = new Set(['operate_drive', 'operate_observe', 'operate_click', 'operate_type', 'operate_select', 'operate_wait', 'operate_scroll', 'operate_extract',
  'operate_solve_captcha', 'operate_navigate', 'operate_press', 'operate_login']);

const browserArguments: Record<string, readonly string[]> = {
  operate_observe: ['query', 'cursor', 'role'],
  operate_click: ['ref'],
  operate_type: ['ref', 'text'],
  operate_select: ['ref', 'values'],
  operate_wait: ['milliseconds'],
  operate_scroll: ['direction'],
  operate_extract: ['store', 'capture'],
  operate_solve_captcha: [],
  operate_navigate: ['url'],
  operate_press: ['key']
};

function signupTool(tool: Tool): Tool {
  if (tool.name === 'operate_drive') return {
    name: tool.name,
    description: 'Start with Jev’s current result. Call again with an offered answer or WAIT, or resume with known signup facts.',
    inputSchema: { type: 'object', properties: { answer: { type: 'string' }, facts: { type: 'object' } }, additionalProperties: false }
  };
  if (tool.name === 'operate_login') return {
    name: tool.name,
    description: 'Sign in with Google or GitHub OAuth by pressing the observed OAuth control ref. Wait and observe after a timeout; never repeat a dispatched OAuth click.',
    inputSchema: { type: 'object', properties: { provider: { type: 'string', enum: ['google', 'github'] }, ref: { type: 'string' } }, required: ['provider', 'ref'], additionalProperties: false }
  };
  const allowed = browserArguments[tool.name] ?? [];
  return { name: tool.name, ...(tool.description ? { description: tool.description } : {}), inputSchema: {
    type: 'object',
    properties: Object.fromEntries(Object.entries(tool.inputSchema.properties ?? {}).filter(([key]) => allowed.includes(key))),
    required: (tool.inputSchema.required ?? []).filter(key => allowed.includes(key)),
    additionalProperties: false
  } };
}

function safeBrowserText(value: string) {
  return value.replace(/https?:\/\/[^\s"']+/gi, match => {
    try { return new URL(match).origin; } catch { return '[link omitted]'; }
  }).replace(/\b(?:sk[-_]|gh[pousr]_|gsk_|nvapi-|eyJ)[\w.-]{6,}|\b[A-Za-z0-9_+/=-]{32,}\b/g, '[omitted]');
}

export const writeId = /^[a-zA-Z0-9:_-]{1,128}$/;

export function signupAgentResult(value: Result): Result {
  // write_id stays visible: the operator retries an unresolved capture with it.
  const omit = new Set(['session_id', 'operation_id', 'dom', 'delta', 'raw_attributes', 'fields', 'value', 'token',
    'approval_url', 'password', 'secret', 'credentials', 'stored_credential', 'reference', 'capture_omissions', 'trajectory']);
  const clean = (value: unknown, depth: number, key?: string): unknown => {
    if (depth > 7) return;
    // Squire's capture write_id is a nonsecret retry handle, often a UUID, which
    // the long-token redaction below would hide. Keep only its documented shape.
    if (key === 'write_id') return typeof value === 'string' && writeId.test(value) && !/^(?:sk[-_]|gh[pousr]_|gsk_|nvapi-|eyJ)/.test(value) ? value : undefined;
    if (typeof value === 'string') return safeBrowserText(value.slice(0, 1800));
    if (Array.isArray(value)) return value.slice(0, 100).map(item => clean(item, depth + 1));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).slice(0, 100)
        .filter(([key]) => !omit.has(key)).map(([key, item]) => [key, clean(item, depth + 1, key)]));
    }
    return value;
  };
  return clean(value, 0) as Result;
}

export async function signupMcp(input: Parameters<SignupAgent>[0]) {
  const authorization = randomBytes(32).toString('hex');
  const listener = createServer(async (req, res) => {
    if (req.url !== '/mcp' || req.headers.authorization !== `Bearer ${authorization}`) {
      res.writeHead(404).end(); return;
    }
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    const server = new Server({ name: 'grunt-squire', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: input.tools.map(signupTool)
    }));
    server.setRequestHandler(CallToolRequestSchema, async request => {
      try {
        const result = await input.call(request.params.name, request.params.arguments ?? {});
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch {
        return { isError: true, content: [{ type: 'text', text: 'Squire could not complete this browser step.' }] };
      }
    });
    try {
      await server.connect(transport);
      res.once('close', () => { void server.close(); });
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const address = listener.address();
  if (!address || typeof address === 'string') { listener.close(); throw new Error('Signup MCP unavailable'); }
  return {
    url: `http://127.0.0.1:${address.port}/mcp`, authorization,
    close: () => { listener.close(); listener.closeAllConnections(); }
  };
}

export function guardedSignupChoice(key: string, label: unknown) {
  if (typeof label !== 'string' || !label.trim()) return false;
  const text = label.replace(/[_|-]/g, ' ');
  const choice = `${key} ${text}`.replace(/[_-]/g, ' ');
  // Only spending money or changing an existing key is refused.
  return !/\b(?:billing|payment|credit card|upgrade|premium|subscription|paid|purchase|buy|top up|revoke|rotate|regenerate|roll|reset|delete)\b/i.test(choice);
}
