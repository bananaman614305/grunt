import { constants } from 'node:fs';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { gruntEnv } from '../brand.js';

export interface DataSharingPolicy {
  provider: string;
  name: string;
  version: string;
  disclosure: string;
  url: string;
  approval?: 'explicit' | 'material';
}

export const NUMES_DEEPSEEK_FLASH_CONSENT = 'numes-deepseek-flash';
export const NUMES_AMAZEE_MODELS_CONSENT = 'numes-amazee-models';

// Keep these provider-specific. An unknown policy must not inherit consent to
// another provider merely because both offer free inference.
export const DATA_SHARING_POLICIES: readonly DataSharingPolicy[] = [{
  provider: 'millionseek', name: '100milionseek DeepSeek V4.1 Flash', version: '2026-11-20',
  disclosure: 'The relay says prompts and replies are not stored, logged, trained on or sold. An unnamed model provider receives prompts without email or account ID; that provider’s retention and training practices remain unverified. Account and quota metadata are retained separately.',
  url: 'https://100milionseek.top/privacy'
}, {
  provider: 'freebuff', name: 'Freebuff', version: '2026-11-15',
  disclosure: 'Prompt, code, and project data may be retained and reviewed for safety, analyzed for advertising and ad-model training. For features marked for AI training, data may also be shared or sold for training and research.',
  url: 'https://freebuff.com/privacy-policy'
}, {
  provider: 'opencode', name: 'OpenCode free model pool', version: '2026-11-15',
  disclosure: 'DeepSeek and GLM free routes have zero-retention and no-training policies. The pool also includes Big Pickle, whose collected data may be used for model improvement.',
  url: 'https://opencode.ai/docs/console/models/#privacy'
}, {
  provider: 'kilo', name: 'Kilo free models', version: '2026-11-21-free-models',
  disclosure: 'Prompts, code and tool results pass through Kilo Gateway and the upstream hosting whichever listed free model answers: Particle AI by default, or another free model such as Reflection Beam, NVIDIA Nemotron or Baidu ERNIE when Particle is rate-limited. Free models may train on prompts; retention, staff-review and training practices vary by upstream and are not established. Do not submit personal or confidential data.',
  url: 'https://kilo.ai/docs/getting-started/using-kilo-for-free',
  approval: 'explicit'
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
}, {
  provider: 'perch', name: 'Perch Starter DeepSeek', version: '2026-11-15',
  disclosure: 'Prompts, code and tool context are processed by Perch and its inference providers. The optional Starter Data Program must remain off. Setup turns off the account settings Use memory and Learn new memories without deleting saved notes; both must remain off for routing. Operational processing for service delivery, security, debugging and metering remains; retention and review limits and zero-retention coverage have not been independently verified.',
  url: 'https://www.perchai.app/privacy#starter-data-program'
}, {
  provider: 'nous', name: 'Nous Portal Free Qwen4 Max', version: '2026-11-10',
  disclosure: 'Prompts, outputs and tool context may be retained, shared with model providers and other partners, and used for training, product improvement and support. Nous offers optional Privacy Mode for some payloads. Upstream retention and training limits are unverified.',
  url: 'https://portal.nousresearch.com/privacy',
  approval: 'explicit'
}, {
  provider: 'kenari', name: 'Kenari ERNIE 5.5 Flash Free', version: '2026-11-18',
  disclosure: 'Kenari records model and usage metadata and says it does not store prompt or response content. It forwards request and tool context to the upstream model provider. Upstream retention, review and training policies are unverified.',
  url: 'https://kenari.id/privacy',
  approval: 'explicit'
}, {
  provider: 'numes', name: 'Numes GLM 5.3 Flash Free', version: '2026-11-18',
  disclosure: 'Numes records request, usage and routing metadata and says it does not store prompts or responses. The selected inference provider receives messages, media and tool context. Its retention, review and training policies vary by endpoint.',
  url: 'https://numes.ai/docs/privacy/data-retention',
  approval: 'explicit'
}, {
  provider: NUMES_DEEPSEEK_FLASH_CONSENT, name: 'Numes DeepSeek V4.1 Flash Free', version: '2026-11-19',
  disclosure: 'Numes records request, usage and routing metadata and says it does not store prompts or responses. The Amazee.ai inference endpoint receives messages and tool context. Its retention, review and training policies are unverified.',
  url: 'https://numes.ai/docs/privacy/data-retention',
  approval: 'explicit'
}, {
  provider: NUMES_AMAZEE_MODELS_CONSENT, name: 'Numes Kimi K3.1 Pro and GLM 5.3 Free', version: '2026-11-25',
  disclosure: 'Numes records request, usage and routing metadata and says it does not store prompts or responses. The Amazee.ai inference endpoint, the same one used by the Flash routes, receives messages and tool context. Its retention, review and training policies are unverified.',
  url: 'https://numes.ai/docs/privacy/data-retention',
  approval: 'explicit'
}, {
  provider: 'aperture-ai', name: 'Aperture Free ERNIE 5.5 Flash', version: '2026-11-20',
  disclosure: 'Prompts, code and tool context pass through Aperture, OpenRouter and the selected inference provider. Account and operational usage metadata may be retained. Upstream retention, staff review and training guarantees are not established for this route. Grunt uses only the exact zero-priced free alias on a verified Free account and never substitutes a paid model.',
  url: 'https://www.aperture-ai.run/privacy.html', approval: 'explicit'
}, {
  provider: 'darus', name: 'Darus Gateway daily free DeepSeek V4.1 Flash', version: '2026-11-20',
  disclosure: 'Prompts, code, tool definitions and tool results pass through Darus Gateway and its inference providers. Retention, staff review, training and deletion guarantees have not been established. Grunt uses only the exact -FREE route with Protect Balance enabled and stops when daily free tokens run out.',
  url: 'https://gateway.darusalfatah.id/dokumentasi', approval: 'explicit'
}, {
  provider: 'fikra', name: 'Fikra temporary free DeepSeek V4.1 Flash Economy', version: '2026-11-20',
  disclosure: 'Prompts, code and tool context go through Fikra and upstream inference providers. Fikra caches responses briefly and retains operational metadata. Upstream retention, training and review policies vary. This temporary free offer ends at the earlier live gate deadline or shared budget limit.',
  url: 'https://fikraapi.co.ke/privacy', approval: 'explicit'
}, {
  provider: 'openference', name: 'Openference temporary free DeepSeek V4.1 Flash', version: '2026-11-20-on-demand',
  disclosure: 'Prompts, code and tool context pass through Openference and its inference providers. Upstream training is permitted without an opt-out. Retention and review guarantees are unverified. This offer ends December 31, 2026 UTC. Grunt uses the exact zero-priced on-demand free alias, independently of subscription allowances, and stops when the offer ends.',
  url: 'https://openference.com/terms-of-service', approval: 'explicit'
}, {
  provider: 'crowllm', name: 'CrowLLM GLM 5.3 Flash Free', version: '2026-11-20',
  disclosure: 'Prompts, code, tool definitions and tool results pass through CrowLLM and its inference upstream. Retention, staff review, training and deletion guarantees have not been verified. Grunt uses only the exact model with a zero price in the live catalog.',
  url: 'https://crowllm.com/docs',
  approval: 'explicit'
}, {
  provider: 'goedel', name: 'Gödel Machines DeepSeek V4.1 Flash Free', version: '2026-11-19',
  disclosure: 'The free tier stores prompts and responses in India, permits staff review and training, and retains content until deletion is requested. It forbids sending secrets, confidential business information, or other people’s personal data. Grunt requires the client to confirm the entire request is safe to share.',
  url: 'https://inference.goedelmachines.com/legal#free-tier',
  approval: 'explicit'
}, {
  provider: 'antseed-vikey', name: 'Antseed Vikey DeepSeek V4.1 Flash', version: '2026-11-18',
  disclosure: 'Prompts, code, and tool context go to the pinned Vikey seller and its inference upstream. Vikey may forward data to other providers. The final model host and its retention and training practices are unverified.',
  url: 'https://vikey.ai/en/terms/',
  approval: 'explicit'
}, {
  provider: 'reflection-beam', name: 'Reflection Beam through Kilo Gateway', version: '2026-11-18',
  disclosure: 'Prompts, code, and tool results pass through Kilo Gateway and the upstream hosting Reflection Beam. Their retention, review, and training practices for this route have not been verified.',
  url: 'https://kilo.ai/docs/getting-started/using-kilo-for-free',
  approval: 'explicit'
}, {
  provider: 'freepi', name: 'Free-Pi DeepSeek V4.1 Flash', version: '2026-11-20-trace-sale-v4',
  disclosure: 'Free-Pi collects coding-session traces, including prompts, code, tool definitions, tool results and outputs, and may sell or commercially license them to third parties. Redaction is not guaranteed: project identity or personal/confidential information may remain identifiable. There is no ordinary opt-out. Send only a request you have reviewed in full as safe for public sharing. Grunt requires every spendable wallet to be zero and stops when the current exact free model offer or daily allowance is unavailable.',
  url: 'https://freepi.ai/privacy',
  approval: 'material'
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
export const requiresExplicitDataSharing = (provider: string) => DATA_SHARING_POLICIES.some(policy => policy.provider === provider && policy.approval !== undefined);

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

// Routing requires a receipt matching the current policy fingerprint.
export async function readDataSharingConsent(directory: string, providers: readonly string[]): Promise<string[]> {
  const saved = await receipt(directory);
  return dataSharingPolicies(providers).filter(policy => saved.approved[policy.provider]?.policy === fingerprint(policy)).map(policy => policy.provider);
}

async function writeReceipt(directory: string, saved: Receipt) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `${fileName}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(saved), { mode: 0o600, flag: 'wx' });
    await rename(temporary, join(directory, fileName));
  } finally { await rm(temporary, { force: true }); }
}

export async function recordDataSharingConsent(directory: string, providers: readonly string[]): Promise<void> {
  const policies = dataSharingPolicies(providers);
  if (!policies.length) return;
  const saved = await receipt(directory);
  const approvedAt = new Date().toISOString();
  for (const policy of policies) saved.approved[policy.provider] = { policy: fingerprint(policy), approvedAt };
  await writeReceipt(directory, saved);
}

async function revokeDataSharingConsent(directory: string, providers: readonly string[]): Promise<void> {
  const saved = await receipt(directory);
  const present = providers.filter(provider => Object.hasOwn(saved.approved, provider));
  if (!present.length) return;
  for (const provider of present) delete saved.approved[provider];
  await writeReceipt(directory, saved);
}

// The daemon renews saved approvals the way setup does, without prompting: an
// approval recorded for an earlier version of a provider's policy is recorded
// again for the current one. The setup opt-out still keeps explicit and
// material policies off. This renewal only covers existing approvals;
// acquisition uses approveDataSharing for new providers.
export async function refreshDataSharingConsent(directory: string, env?: NodeJS.ProcessEnv): Promise<string[]> {
  const saved = await receipt(directory), optOut = gruntEnv('SETUP_NO_DATA_SHARING', env) === '1';
  const stale = DATA_SHARING_POLICIES.filter(policy => Object.hasOwn(saved.approved, policy.provider)
    && saved.approved[policy.provider]!.policy !== fingerprint(policy) && !(optOut && policy.approval !== undefined)).map(policy => policy.provider);
  await recordDataSharingConsent(directory, stale);
  return stale;
}

export const DATA_SHARING_OPT_OUT = 'GRUNT_SETUP_NO_DATA_SHARING=1';

export interface DataSharingApprovalOptions {
  directory: string;
  providers: readonly string[];
  env?: NodeJS.ProcessEnv;
  notice?: (line: string) => void;
}

// Setup records current policies automatically unless the existing opt-out applies.
export async function approveDataSharing(options: DataSharingApprovalOptions): Promise<{ approved: string[]; skipped: string[] }> {
  const providers = options.providers.includes('numes') ? [...options.providers, NUMES_DEEPSEEK_FLASH_CONSENT, NUMES_AMAZEE_MODELS_CONSENT] : options.providers;
  const policies = dataSharingPolicies(providers);
  const saved = new Set(await readDataSharingConsent(options.directory, providers));
  const optOut = gruntEnv('SETUP_NO_DATA_SHARING', options.env) === '1';
  const skipped = optOut ? policies.filter(policy => policy.approval !== undefined).map(policy => policy.provider) : [];
  if (skipped.length) await revokeDataSharingConsent(options.directory, skipped);
  const approved = policies.map(policy => policy.provider).filter(provider => !skipped.includes(provider));
  const added = approved.filter(provider => !saved.has(provider));
  await recordDataSharingConsent(options.directory, added);
  const explicit = policies.filter(policy => policy.approval !== undefined && added.includes(policy.provider));
  if (explicit.length) {
    (options.notice ?? console.log)(`Data sharing on: ${explicit.map(policy => policy.provider).join(', ')}. Off: ${DATA_SHARING_OPT_OUT}`);
  }
  return { approved, skipped };
}
