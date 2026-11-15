import { constants } from 'node:fs';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { confirm, isCancel } from '@clack/prompts';
import { withTerminal } from './terminal.js';

export interface DataSharingPolicy {
  provider: string;
  name: string;
  version: string;
  disclosure: string;
  url: string;
}

// Keep these provider-specific. An unknown policy must not inherit consent to
// another provider merely because both offer free inference.
export const DATA_SHARING_POLICIES: readonly DataSharingPolicy[] = [{
  provider: 'freebuff', name: 'Freebuff', version: '2026-11-15',
  disclosure: 'Prompt, code, and project data may be retained and reviewed for safety, analyzed for advertising and ad-model training. For features marked for AI training, data may also be shared or sold for training and research.',
  url: 'https://freebuff.com/privacy-policy'
}, {
  provider: 'opencode', name: 'OpenCode free model pool', version: '2026-11-15',
  disclosure: 'DeepSeek and GLM free routes have zero-retention and no-training policies. The pool also includes Big Pickle, whose collected data may be used for model improvement.',
  url: 'https://opencode.ai/docs/console/models/#privacy'
}, {
  provider: 'kilo', name: 'Kilo Particle-1 Free', version: '2026-11-15-particle',
  disclosure: 'Particle-1 prompts and outputs pass through Kilo and Particle AI. The live catalog permits training on prompts; retention and staff-review guarantees are not established. Do not submit personal or confidential data.',
  url: 'https://kilo.ai/docs/getting-started/using-kilo-for-free'
}, {
  provider: 'tokenharbor', name: 'Token Harbor', version: '2026-11-15',
  disclosure: 'Prompts and responses may be retained, read by staff, and used by upstream providers for training.',
  url: 'https://team.tokenharbor.ai/faq'
}, {
  provider: 'runcrate', name: 'Runcrate', version: '2026-11-15',
  disclosure: 'Free inference is served by third-party model providers under their own terms. Runcrate does not save API prompts or responses by default and does not train on saved prompts; upstream retention and training guarantees are not established.',
  url: 'https://www.runcrate.ai/inference/free'
}, {
  provider: 'apinex', name: 'APInex', version: '2026-11-15',
  disclosure: 'Account and usage metadata are collected. Prompt retention duration and upstream no-training guarantees are not established for the free route.',
  url: 'https://apinex.bond/legal/privacy'
}, {
  provider: 'mistral-vibe', name: 'Mistral Vibe Free (GLM 5.3 Flash)', version: '2026-11-15',
  disclosure: 'The native coding agent sends task and project context to Mistral-hosted GLM. Free-plan prompt and code data may be used to improve services; no zero-retention guarantee is established for this route.',
  url: 'https://legal.mistral.ai/terms/privacy-policy'
}, {
  provider: 'pollinations', name: 'Pollinations community GLM 5.3 Flash', version: '2026-11-15',
  disclosure: 'Prompts and project context pass through Pollinations, the OSAII community operator, and Poe/Together upstream processing. Retention, staff review, and training guarantees are not established for these intermediaries.',
  url: 'https://pollinations.ai/privacy'
}, {
  provider: 'beatapi', name: 'BeatAPI free model pool', version: '2026-11-15',
  disclosure: 'Prompts and project context may be retained for operations and processed by upstream providers. BeatAPI states that private content is not used for training without separate notice and consent where required; upstream retention and training guarantees are not established.',
  url: 'https://beatapi.io/privacy-policy'

}];

const fileName = 'data-sharing-consent.json';
type Approval = { policy: string; approvedAt: string };
type Receipt = { version: 1; approved: Record<string, Approval> };
const emptyReceipt = (): Receipt => ({ version: 1, approved: {} });
const fingerprint = (policy: DataSharingPolicy) => createHash('sha256').update(JSON.stringify(policy)).digest('hex');

export function dataSharingPolicies(providers: readonly string[]): DataSharingPolicy[] {
  const selected = new Set(providers);
  return DATA_SHARING_POLICIES.filter(policy => selected.has(policy.provider));
}
export const requiresDataSharing = (provider: string) => DATA_SHARING_POLICIES.some(policy => policy.provider === provider);

async function receipt(directory: string): Promise<Receipt> {
  try {
    const file = await open(join(directory, fileName), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()) return emptyReceipt();
      const value = JSON.parse(await file.readFile('utf8')) as Partial<Receipt>;
      if (value.version !== 1 || !value.approved || typeof value.approved !== 'object' || Array.isArray(value.approved)) return emptyReceipt();
      const approved = Object.fromEntries(Object.entries(value.approved).filter(([, item]) => item
        && typeof item.policy === 'string' && typeof item.approvedAt === 'string' && Number.isFinite(Date.parse(item.approvedAt))));
      return { version: 1, approved };
    } finally { await file.close(); }
  } catch { return emptyReceipt(); }
}

// Background setup only reads this receipt; it never opens an approval prompt.
export async function readDataSharingConsent(directory: string, providers: readonly string[]): Promise<string[]> {
  const saved = await receipt(directory);
  return dataSharingPolicies(providers).filter(policy => saved.approved[policy.provider]?.policy === fingerprint(policy)).map(policy => policy.provider);
}

// Also used when an operator has already obtained explicit approval outside the
// CLI. This records the same current provider policies as the grouped prompt.
export async function recordDataSharingConsent(directory: string, providers: readonly string[]): Promise<void> {
  const policies = dataSharingPolicies(providers);
  if (!policies.length) return;
  const saved = await receipt(directory);
  const approvedAt = new Date().toISOString();
  for (const policy of policies) saved.approved[policy.provider] = { policy: fingerprint(policy), approvedAt };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `${fileName}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(saved), { mode: 0o600, flag: 'wx' });
    await rename(temporary, join(directory, fileName));
  } finally { await rm(temporary, { force: true }); }
}

export interface DataSharingApprovalOptions {
  directory: string;
  providers: readonly string[];
  interactive?: boolean;
  prompt?: (policies: readonly DataSharingPolicy[]) => Promise<boolean | symbol>;
}

export async function approveDataSharing(options: DataSharingApprovalOptions): Promise<{ approved: string[]; skipped: string[] }> {
  const policies = dataSharingPolicies(options.providers);
  const approved = await readDataSharingConsent(options.directory, options.providers);
  const pending = policies.filter(policy => !approved.includes(policy.provider));
  if (!pending.length) return { approved, skipped: [] };
  const interactive = options.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY && process.env.MILO_SETUP_NO_HUMAN !== '1');
  const prompt = options.prompt ?? (async (list: readonly DataSharingPolicy[]) => withTerminal(async () => confirm({
    message: `Allow data sharing for all these free services?\n${list.map(policy => `${policy.name}: ${policy.disclosure} ${policy.url}`).join('\n')}\nDeclining skips these services; other free services continue.`,
    initialValue: false
  })));
  if (!interactive) return { approved, skipped: pending.map(policy => policy.provider) };
  const answer = await prompt(pending);
  if (isCancel(answer) || answer !== true) return { approved, skipped: pending.map(policy => policy.provider) };
  const newlyApproved = pending.map(policy => policy.provider);
  await recordDataSharingConsent(options.directory, newlyApproved);
  return { approved: [...approved, ...newlyApproved], skipped: [] };
}
