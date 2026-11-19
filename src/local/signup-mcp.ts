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

export const signupAgentTools = new Set(['operate_drive', 'operate_observe', 'operate_click', 'operate_type', 'operate_select', 'operate_wait', 'operate_scroll', 'operate_extract', 'operate_share']);

const browserArguments: Record<string, readonly string[]> = {
  operate_observe: ['query', 'cursor', 'role'],
  operate_click: ['ref'],
  operate_type: ['ref', 'text'],
  operate_select: ['ref', 'values'],
  operate_wait: ['milliseconds'],
  operate_scroll: ['direction'],
  operate_extract: ['store', 'capture'],
  operate_share: []
};

function signupTool(tool: Tool): Tool {
  if (tool.name === 'operate_drive') return {
    name: tool.name,
    description: 'Start with Jev’s current result. Call again with an offered answer or WAIT, or resume with known signup facts.',
    inputSchema: { type: 'object', properties: { answer: { type: 'string' }, facts: { type: 'object' } }, additionalProperties: false }
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

export function signupAgentResult(value: Result): Result {
  // write_id stays visible: the operator retries an unresolved capture with it.
  const omit = new Set(['session_id', 'operation_id', 'dom', 'delta', 'raw_attributes', 'fields', 'value', 'token',
    'approval_url', 'password', 'secret', 'credentials', 'stored_credential', 'reference', 'capture_omissions', 'trajectory']);
  const clean = (value: unknown, depth: number): unknown => {
    if (depth > 7) return;
    if (typeof value === 'string') return safeBrowserText(value.slice(0, 1800));
    if (Array.isArray(value)) return value.slice(0, 100).map(item => clean(item, depth + 1));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).slice(0, 100)
        .filter(([key]) => !omit.has(key)).map(([key, item]) => [key, clean(item, depth + 1)]));
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
  if (/\b(?:billing|payment|credit card|upgrade|premium|subscription|paid|purchase|buy|top up|switch (?:an? )?account|another account|password|passcode|secret|sms|phone|captcha|passkey|revoke|rotate|reset|delete|done|blocked)\b/i.test(choice)) return false;
  if (/\b(?:reject|decline) (?:all|optional)(?: cookies)?\b/i.test(text)) return true;
  const requiredTerms = /\b(?:accept|agree)\b/i.test(text)
    && /\b(?:terms of service|terms and conditions|terms of use)\b/i.test(text)
    && !/\b(?:optional|marketing|newsletter|training|retention|sharing|consent|authorize|permission)\b/i.test(choice);
  return requiredTerms || !/\b(?:consent|accept|agree|authorize|permission)\b/i.test(choice);
}
