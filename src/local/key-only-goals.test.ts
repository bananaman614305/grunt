import { afterEach, expect, it, vi } from 'vitest';
import { BrowserSquire, PROVIDERS } from './setup.js';
import { bundledRegistry } from '../registry.js';

afterEach(() => { vi.restoreAllMocks(); });

// Setup asks Squire only to sign in and capture one API key. Registry
// providers are already vetted as free, so goals must not ask Squire to pick
// a plan or tier, or to enable a free model. Prohibitions ("No paid plan",
// "Never accept ... upgrade", "do not open billing or plan pages") are the
// safety clause and stay.
const planStep = /free plan|enable (only )?(its )?(daily )?free|free model|plan|tier|upgrade/i;
const prohibition = /^(no|never|do not)\b/i;
function planSteps(goal: string) {
  return goal.split(/(?<=\.)\s+/).flatMap(sentence => sentence.split(/;\s+/))
    .filter(part => planStep.test(part) && !prohibition.test(part.trim()));
}
const providers = [...new Set([...Object.keys(PROVIDERS), ...bundledRegistry.adapters.map(a => a.id)])];

async function goals(provider: string, dataSharingApproved?: string[]) {
  const squire = new BrowserSquire(dataSharingApproved ? { dataSharingApproved } : {});
  const call = vi.spyOn(squire, 'call').mockImplementation(async name => name === 'operate_drive' ? { status: 'complete', session_id: `${provider}-session` } : {});
  await squire.runs.start({ service: provider, plan: 'free', project_name: 'grunt', category: 'ai', cost_cents: 0, recurrence: 'none' });
  await squire.signup(provider, `https://${provider}.test/login`, 'Sign in and capture one API key.');
  return call.mock.calls.filter(([name]) => name === 'operate_drive').map(([, args]) => String(args.goal));
}

it.each(providers)('asks Squire only for the %s API key, with no plan, tier or model-enable step', async provider => {
  for (const approved of [undefined, [provider]]) {
    const built = await goals(provider, approved);
    expect(built).toHaveLength(2);
    for (const goal of built) {
      expect(planSteps(goal)).toEqual([]);
      expect(goal).toMatch(/No paid plan|paid plan, payment, upgrade/);
    }
  }
});

it('keeps the Zro and Token Harbor capture rules', async () => {
  const [zro] = await goals('zro');
  expect(zro).toContain('api_hosts ["zro.moonmath.ai"] and auth_shape "bearer"'); expect(zro).toContain('service zro, label grunt');
  expect(zro).toContain('Never reset or rotate an existing key');
  const [harbor] = await goals('tokenharbor');
  expect(harbor).toContain('api_hosts ["tokenharbor.ai"] and auth_shape "bearer", service tokenharbor, label grunt');
  expect(harbor).toContain('Do not create a second key if an existing vaulted key is usable, and never reset or rotate an existing key');
});

it('flags the old Zro and Token Harbor model-enable wording', () => {
  expect(planSteps('Enable only its daily free DeepSeek V4.1 Flash access.')).toHaveLength(1);
  expect(planSteps('Enable the free model deepseek-v4.1-flash:free; never select its paid sibling.')).toHaveLength(1);
  expect(planSteps("Use the user's existing zro account or sign up for the free plan.")).toHaveLength(1);
  expect(planSteps('No paid plan, payment method, extra account or account switching.')).toEqual([]);
});
