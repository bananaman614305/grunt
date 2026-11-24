import { Ajv } from 'ajv';
import { Ajv2019 } from 'ajv/dist/2019.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { AnySchema, Options, ValidateFunction } from 'ajv';
import { requestRefusal } from './source.js';
import type { Tool } from './source.js';

// Harness tools declare their JSON Schema dialect. Claude Code 2.1.x emits
// `"$schema": "https://json-schema.org/draft/2020-12/schema"` on every tool; the
// default Ajv class only knows draft-07 and throws on that identifier. Compile each
// schema with the Ajv class that implements its declared dialect.
// Draft-07 (or no declaration) keeps the default class. Other drafts stay unsupported.
const DRAFT_07 = /^http:\/\/json-schema\.org\/draft-07\/schema#?$/;
const DRAFT_2019 = /^https:\/\/json-schema\.org\/draft\/2019-09\/schema#?$/;
const DRAFT_2020 = /^https:\/\/json-schema\.org\/draft\/2020-12\/schema#?$/;

const options: Options = {
  strict: true, strictTypes: false, strictTuples: false,
  // JSON Schema treats `format` and unknown keywords as annotations. Without ajv-formats a
  // strict compile throws on `"format": "uri"` and on harmless extensions, which refused whole
  // requests although the provider would receive and obey them. Structure is still enforced.
  strictSchema: false, validateFormats: false,
  // Ajv retains schema objects in its cache. Keep that cache request-local.
  addUsedSchema: false
};

export class ToolSchemaCompiler {
  private instances = new Map<string, InstanceType<typeof Ajv>>();
  private instance(dialect: string) {
    let ajv = this.instances.get(dialect);
    if (!ajv) {
      ajv = dialect === '2020' ? new Ajv2020(options) : dialect === '2019' ? new Ajv2019(options) : new Ajv(options);
      this.instances.set(dialect, ajv);
    }
    return ajv;
  }
  // Throws when the schema is malformed or declares a dialect Grunt cannot validate.
  compile(schema: unknown): ValidateFunction {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('Tool schema must be an object');
    const declared = (schema as { $schema?: unknown }).$schema;
    if (declared !== undefined && typeof declared !== 'string') throw new Error('Invalid $schema');
    const dialect = declared === undefined || DRAFT_07.test(declared) ? '07' : DRAFT_2019.test(declared) ? '2019' : DRAFT_2020.test(declared) ? '2020' : undefined;
    if (!dialect) throw new Error('Unsupported JSON Schema dialect');
    return this.instance(dialect).compile(schema as AnySchema);
  }
}

// One validator per function tool, keyed by name. A tool whose schema cannot be compiled is
// refused locally as `request_tool_schema` (a request problem, never provider health).
export function compileToolSchemas(tools: readonly Tool[], message: string): Map<string, ValidateFunction> {
  const compiler = new ToolSchemaCompiler(), validators = new Map<string, ValidateFunction>();
  try {
    for (const tool of tools) {
      const fn = (tool as { function?: { name?: unknown; parameters?: unknown } }).function;
      if (tool.type !== 'function' || !fn || typeof fn.name !== 'string') throw new Error('Unsupported tool');
      validators.set(fn.name, compiler.compile(fn.parameters));
    }
  } catch { throw requestRefusal(message, 'request_tool_schema'); }
  return validators;
}
