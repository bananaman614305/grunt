import { homedir } from 'node:os';
import { join } from 'node:path';

export function gruntEnv(name: string, env: NodeJS.ProcessEnv = process.env) {
  return env[`GRUNT_${name}`];
}

export function configRoot(env: NodeJS.ProcessEnv = process.env, home = homedir()) {
  return gruntEnv('CONFIG_DIR', env) || join(env.XDG_CONFIG_HOME || join(home, '.config'), 'grunt');
}
