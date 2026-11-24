import { describe, expect, it } from 'vitest';
import { claudeCodeRequest } from './fixtures/claude-code-tools.js';
import { FreebuffTools } from './freebuff-tools.js';
import { SourceError } from './source.js';
import type { Tool } from './source.js';
import { ToolSchemaCompiler, compileToolSchemas } from './tool-schema.js';

const fn = (name: string, parameters: unknown): Tool => ({ type: 'function', function: { name, parameters } });
const names = (tools: Tool[]) => tools.map(tool => (tool as { function: { name: string } }).function.name);

describe('recorded Claude Code 2.1.331 tools', () => {
  it('decode to plain function tools that every non-validating adapter forwards', () => {
    for (const index of [0, 1, 2] as const) {
      const { tools } = claudeCodeRequest(index);
      expect(names(tools)).toEqual(['Agent', 'Bash', 'Edit', 'ListAgents', 'Monitor', 'Read', 'ReportFindings', 'SendMessage', 'TaskStop', 'ToolSearch', 'DeferredToolPlaceholder', 'Write']);
      // Adapters without schema validation (aperture, darus, numes, runcrate, livekit, fikra, kenari, zro,
      // tokenharbor, promotional and free-api sources) only require type "function" and a plain name.
      expect(tools.every(tool => tool.type === 'function')).toBe(true);
      expect(names(tools).every(name => /^[a-zA-Z0-9_-]{1,64}$/.test(name))).toBe(true);
      expect(new Set(names(tools)).size).toBe(tools.length);
    }
  });
  it('declare the 2020-12 dialect that the default Ajv class cannot compile', () => {
    const schemas = claudeCodeRequest(0).tools.map(tool => (tool as { function: { parameters: { $schema?: string } } }).function.parameters);
    expect(schemas.filter(schema => schema.$schema === 'https://json-schema.org/draft/2020-12/schema')).toHaveLength(schemas.length - 1);
  });
  it('compile, accept real calls and still reject calls that break the schema', () => {
    const validators = compileToolSchemas(claudeCodeRequest(0).tools, 'refused');
    expect([...validators.keys()]).toEqual(names(claudeCodeRequest(0).tools));
    expect(validators.get('Bash')!({ command: 'ls', description: 'List', timeout: 1000 })).toBe(true);
    expect(validators.get('Bash')!({ command: 'ls', extra: true })).toBe(false); // additionalProperties: false
    expect(validators.get('Bash')!({})).toBe(false); // required
    expect(validators.get('Read')!({ file_path: '/a', offset: 0, limit: 10 })).toBe(true);
    expect(validators.get('Read')!({ file_path: '/a', limit: 0 })).toBe(false); // exclusiveMinimum: 0
    expect(validators.get('Agent')!({ description: 'x', prompt: 'y', subagent_type: 'general-purpose' })).toBe(true);
    expect(validators.get('DeferredToolPlaceholder')!({})).toBe(true);
  });
  it('lets FreebuffTools enforce the real schema instead of silently accepting any arguments', () => {
    const bridge = new FreebuffTools(claudeCodeRequest(0));
    const envelope = (args: unknown) => JSON.stringify({ version: 1, type: 'calls', calls: [{ name: 'Bash', arguments: args }] });
    expect(bridge.parse(envelope({ command: 'ls' })).calls).toHaveLength(1);
    expect(() => bridge.parse(envelope({ command: 'ls', extra: true }))).toThrow();
    expect(() => bridge.parse(envelope({}))).toThrow();
  });
});

describe('ToolSchemaCompiler', () => {
  const object = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false };
  it.each([
    ['no declaration', object], ['draft-07', { $schema: 'http://json-schema.org/draft-07/schema#', ...object }],
    ['draft-07 without fragment', { $schema: 'http://json-schema.org/draft-07/schema', ...object }],
    ['2019-09', { $schema: 'https://json-schema.org/draft/2019-09/schema', ...object }], ['2020-12', { $schema: 'https://json-schema.org/draft/2020-12/schema', ...object }]
  ])('validates a %s schema', (_label, schema) => {
    const validate = new ToolSchemaCompiler().compile(schema);
    expect(validate({ a: 'x' })).toBe(true); expect(validate({ a: 1 })).toBe(false); expect(validate({})).toBe(false);
  });
  it('uses dialect specific keywords', () => {
    const validate = new ToolSchemaCompiler().compile({ $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'array', prefixItems: [{ type: 'string' }, { type: 'integer' }], items: false });
    expect(validate(['a', 1])).toBe(true); expect(validate(['a', 'b'])).toBe(false); expect(validate(['a', 1, 2])).toBe(false);
  });
  it('treats format and unknown keywords as annotations', () => {
    const validate = new ToolSchemaCompiler().compile({ type: 'object', properties: { url: { type: 'string', format: 'uri', 'x-origin': 'harness' } }, 'x-vendor': true, markdownDescription: 'x' });
    expect(validate({ url: 'https://example.test' })).toBe(true); expect(validate({ url: 3 })).toBe(false);
  });
  it('shares one compiler across tools and repeated draft schemas', () => {
    const compiler = new ToolSchemaCompiler(), schema = { $id: 'https://tools.example/one', type: 'object' };
    expect(() => { compiler.compile({ ...schema }); compiler.compile({ ...schema }); }).not.toThrow();
  });
  it.each([
    ['an unsupported draft', { $schema: 'http://json-schema.org/draft-04/schema#', type: 'object' }], ['a non-string $schema', { $schema: 4, type: 'object' }],
    ['an unknown type', { type: 'imaginary' }], ['a remote $ref', { $ref: 'https://untrusted.example/schema' }], ['a non-object schema', 'object']
  ])('refuses %s', (_label, schema) => { expect(() => new ToolSchemaCompiler().compile(schema)).toThrow(); });
});

describe('compileToolSchemas', () => {
  it('refuses as request_tool_schema so routing never counts it as provider health', () => {
    for (const tools of [[fn('bad', { type: 'imaginary' })], [{ type: 'web_search' }], [fn('ok', { type: 'object' }), fn('bad', undefined)]]) {
      try { compileToolSchemas(tools, 'Synthetic refusal'); expect.unreachable(); }
      catch (error) { expect(error).toBeInstanceOf(SourceError); expect(error).toMatchObject({ code: 'refused', message: 'Synthetic refusal', diagnostics: { failureReason: 'request_tool_schema' } }); }
    }
  });
});
