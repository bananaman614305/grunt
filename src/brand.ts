import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Pre-rename environment variable names that retain MILO_* fallback compatibility. */
export const LEGACY_MILO_ENV: ReadonlySet<string> = new Set([
  'PORT',
  'CONFIG_DIR',
  'SOURCES',
  'DAEMON',
  'DB',
  'PUBLIC_URL',
  'FREELLMAPI_URL',
  'FREELLMAPI_KEY',
  'OPENCODE_MODEL',
  'OPENCODE_URL',
  'CODEX_MODEL',
  'DOTS_URL',
  'DOTS_TIMEOUT_MS',
  'APP_TIMEOUT_MS',
  'APP_POOL',
  'ROUTER_ENTRY',
  'ROUTER_RUNTIME',
  'SQUIRE_HOME',
  'SQUIRE_XDG_CONFIG_HOME',
  'SETUP_NO_HUMAN',
]);

/** Grunt settings take precedence; only pre-rename settings fall back to MILO_*. */
export function gruntEnv(name: string, env: NodeJS.ProcessEnv = process.env) {
  return env[`GRUNT_${name}`] ?? (LEGACY_MILO_ENV.has(name) ? env[`MILO_${name}`] : undefined);
}

/** Keep existing keys, consent and custom state in place when upgrading. */
export function configRoot(env: NodeJS.ProcessEnv = process.env, home = homedir()) {
  const configured = gruntEnv('CONFIG_DIR', env);
  if (configured) return configured;
  const base = process.platform === 'win32' ? env.LOCALAPPDATA || join(home, 'AppData', 'Local') : env.XDG_CONFIG_HOME || join(home, '.config');
  const current = join(base, 'grunt');
  const legacy = join(base, 'milo');
  return existsSync(current) || !existsSync(legacy) ? current : legacy;
}
