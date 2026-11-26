import { isCancel, password } from '@clack/prompts';
import { configRoot } from '../brand.js';
import {
  PROVIDER_DIRECT_ORIGINS,
  defaultProviderOrigin,
  deleteVaultEntry,
  isVaultProvider,
  listVaultEntries,
  validateDirectOrigin,
  vaultEnvKeyName,
  writeVaultEntry
} from './vault.js';
import type { VaultProvider } from './vault.js';

const HELP = `Usage: usegrunt vault <list [--json] | set <provider> [--origin <https-origin>] | remove <provider>>

Store provider API keys locally in Grunt's private mode-0600 vault so adapters
call verified provider HTTPS origins directly without a central egress proxy.

Keys are read from stdin or a hidden prompt (never from command arguments).
Environment override: set GRUNT_VAULT_<PROVIDER>_KEY (for example ${vaultEnvKeyName('beatapi')}).`;

export interface VaultCommandIO {
  directory?: string;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  readSecret?: (provider: VaultProvider) => Promise<string>;
}

async function readStdinSecret(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk as Buffer);
    if (Buffer.concat(chunks).byteLength > 32768) throw new Error('API key input is too large');
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function promptSecret(provider: VaultProvider): Promise<string> {
  if (!process.stdin.isTTY) return readStdinSecret();
  const entered = await password({ message: `Enter ${provider} API key (stored privately in Grunt local vault):` });
  if (isCancel(entered) || typeof entered !== 'string') throw new Error('Vault update cancelled');
  return entered.trim();
}

export async function vaultCommand(args: string[], io: VaultCommandIO = {}): Promise<void> {
  const log = io.log ?? console.log;
  const env = io.env ?? process.env;
  const directory = io.directory ?? configRoot(env);
  const subcommand = args[0];

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    log(HELP);
    return;
  }

  if (subcommand === 'list') {
    const json = args.includes('--json');
    const unexpected = args.slice(1).filter(arg => arg !== '--json');
    if (unexpected.length) throw new Error('Usage: usegrunt vault list [--json]');
    const entries = await listVaultEntries(directory, env);
    if (json) {
      log(JSON.stringify({ providers: entries }, null, 2));
      return;
    }
    if (!entries.length) {
      log('Local Grunt vault has no stored provider keys.');
      return;
    }
    for (const entry of entries) {
      log(`${entry.provider}\t${entry.origin}\t${entry.source}${entry.updated_at ? `\t${entry.updated_at}` : ''}`);
    }
    return;
  }

  if (subcommand === 'set') {
    const provider = args[1];
    if (!provider || !isVaultProvider(provider)) {
      throw new Error(`Unknown vault provider. Supported providers: ${Object.keys(PROVIDER_DIRECT_ORIGINS).join(', ')}`);
    }
    let origin: string | undefined;
    for (let i = 2; i < args.length; i++) {
      if (args[i] === '--origin' && args[i + 1]) {
        origin = args[++i];
      } else {
        throw new Error('Usage: usegrunt vault set <provider> [--origin <https-origin>] (pass key via stdin or hidden prompt, never in argv)');
      }
    }
    const pinned = validateDirectOrigin(provider, origin ?? defaultProviderOrigin(provider));
    const secret = (await (io.readSecret ? io.readSecret(provider) : promptSecret(provider))).trim();
    if (!secret) throw new Error(`No API key provided for ${provider}`);
    const saved = await writeVaultEntry(provider, { api_key: secret, origin: pinned, source: 'import' }, directory);
    log(`${saved.provider}: stored privately in local Grunt vault (${saved.origin})`);
    return;
  }

  if (subcommand === 'remove') {
    const provider = args[1];
    if (!provider || args.length !== 2 || !isVaultProvider(provider)) {
      throw new Error('Usage: usegrunt vault remove <provider>');
    }
    const removed = await deleteVaultEntry(provider, directory);
    log(removed ? `${provider}: removed from local Grunt vault` : `${provider}: no key stored in local Grunt vault`);
    return;
  }

  throw new Error('Unknown vault subcommand. Run usegrunt vault --help.');
}
