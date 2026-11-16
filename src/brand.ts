import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Grunt settings take precedence; installed Milo services remain compatible. */
export function gruntEnv(name: string, env: NodeJS.ProcessEnv = process.env) {
  return env[`GRUNT_${name}`] ?? env[`MILO_${name}`];
}

/** Keep existing keys, consent and custom state in place when upgrading. */
export function configRoot(env: NodeJS.ProcessEnv = process.env, home = homedir()) {
  const configured = gruntEnv('CONFIG_DIR', env);
  if (configured) return configured;
  const base = env.XDG_CONFIG_HOME || join(home, '.config');
  const current = join(base, 'grunt');
  const legacy = join(base, 'milo');
  return existsSync(current) || !existsSync(legacy) ? current : legacy;
}
