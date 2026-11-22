import { readFileSync } from 'node:fs';

/** Package identity, never a model-supplied version or the status schema version. */
export function installedRuntimeVersion(): string | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    const version = value && typeof value === 'object' && 'version' in value ? value.version : undefined;
    return typeof version === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[a-zA-Z0-9][a-zA-Z0-9.-]{0,39})?$/.test(version) ? version : undefined;
  } catch { return undefined; }
}
