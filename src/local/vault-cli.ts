import { isCancel, password } from '@clack/prompts';
import { configRoot } from '../brand.js';
import { BrowserSquire } from './setup.js';
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

const HELP = `Usage: usegrunt vault <list [--json] | set <provider> [--origin <https-origin>] | export <provider> [--origin <https-origin>] | remove <provider>>

Store provider API keys locally in Grunt's private mode-0600 vault so adapters
call verified provider HTTPS origins directly without a central egress proxy.

Keys are read from stdin or a hidden prompt (never from command arguments).
Use "vault export <provider>" to explicitly opt into Trusty Squire passkey export.
Environment override: set GRUNT_VAULT_<PROVIDER>_KEY (for example ${vaultEnvKeyName('beatapi')}).`;

export interface VaultExportSquire {
  connect?(): Promise<void>;
  close?(): Promise<void>;
  credentials: {
    list(): Promise<{ service: string | null; reference: string; field_names: string[]; auth_strategy?: string | null }[]>;
  };
  materializeDirectVaultGrant(
    provider: VaultProvider,
    reference: string,
    options?: {
      directory?: string;
      origin?: string;
      onApproval?: (info: { approvalId: string; approvalUrl: string }) => Promise<void> | void;
      signal?: AbortSignal;
    }
  ): Promise<{ base_url: string; token: string }>;
}

export interface VaultCommandIO {
  directory?: string;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  readSecret?: (provider: VaultProvider) => Promise<string>;
  squire?: VaultExportSquire;
  signal?: AbortSignal;
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

  if (subcommand === 'export') {
    const provider = args[1];
    if (!provider || !isVaultProvider(provider)) {
      throw new Error(`Unknown vault provider. Supported providers: ${Object.keys(PROVIDER_DIRECT_ORIGINS).join(', ')}`);
    }
    let origin: string | undefined;
    for (let i = 2; i < args.length; i++) {
      if (args[i] === '--origin' && args[i + 1]) {
        origin = args[++i];
      } else {
        throw new Error('Usage: usegrunt vault export <provider> [--origin <https-origin>]');
      }
    }
    const pinned = validateDirectOrigin(provider, origin ?? defaultProviderOrigin(provider));
    const owned = io.squire ? undefined : new BrowserSquire(io.signal ? { signal: io.signal } : {});
    const squire = io.squire ?? owned!;
    try {
      await owned?.connect();
      const credentials = await squire.credentials.list();
      const match = credentials.find(item =>
        item.service?.trim().toLowerCase() === provider.toLowerCase()
        && item.auth_strategy !== 'username_password'
        && item.field_names.some(field => {
          const normalized = field.toLowerCase().replace(/[^a-z0-9]/g, '');
          const stripped = normalized.startsWith(provider.replace(/[^a-z0-9]/g, ''))
            ? normalized.slice(provider.replace(/[^a-z0-9]/g, '').length)
            : normalized;
          return ['apikey', 'key', 'token', 'value', 'secret', 'apitoken', 'accesstoken'].includes(stripped);
        })
      );
      if (!match) throw new Error(`No saved Trusty Squire API key credential found for ${provider}`);
      const exported = await squire.materializeDirectVaultGrant(provider, match.reference, {
        directory,
        origin: pinned,
        ...(io.signal ? { signal: io.signal } : {}),
        onApproval: info => {
          log(`${provider}: confirm Squire passkey export at ${info.approvalUrl} to store key in local Grunt vault`);
        }
      });
      log(`${provider}: exported from Trusty Squire into local Grunt vault (${exported.base_url})`);
      return;
    } finally {
      await owned?.close();
    }
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
