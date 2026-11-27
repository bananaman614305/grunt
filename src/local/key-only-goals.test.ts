import { afterEach, expect, it, vi } from 'vitest';
import { BrowserSquire, PROVIDERS } from './setup.js';
import { bundledRegistry } from '../registry.js';
import { planSteps } from './fixtures/key-only-goal.js';

afterEach(() => { vi.restoreAllMocks(); });

const providers = [...new Set([...Object.keys(PROVIDERS), ...bundledRegistry.adapters.map(a => a.id)])];

async function goals(provider: string, dataSharingApproved?: string[]) {
  const squire = new BrowserSquire(dataSharingApproved ? { dataSharingApproved } : {});
  const call = vi.spyOn(squire, 'call').mockImplementation(async name => name === 'operate_drive' ? { status: 'complete', session_id: `${provider}-session` } : {});
  await squire.runs.start({ service: provider, plan: 'free', project_name: 'grunt', category: 'ai', cost_cents: 0, recurrence: 'none' });
  await squire.signup(provider, `https://${provider}.test/login`, 'Sign in and capture one API key.');
  return call.mock.calls.filter(([name]) => name === 'operate_drive').map(([, args]) => String(args.goal));
}

const stripRegistryHints = (provider: string, goal: string) => {
  const hints = bundledRegistry.adapters.find(a => a.id === provider)?.hints;
  return hints ? goal.replace(` Provider hints (page, control, value, in order): ${hints}`, '') : goal;
};

it.each(providers)('asks Squire only for the %s API key, with no plan, tier or model-enable step', async provider => {
  for (const approved of [undefined, [provider]]) {
    const built = await goals(provider, approved);
    expect(built).toHaveLength(2);
    for (const goal of built) {
      expect(planSteps(stripRegistryHints(provider, goal))).toEqual([]);
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
  expect(harbor).toContain('Do not create a second key if an existing key can be captured, and never reset or rotate an existing key');
});

it('flags the old Zro and Token Harbor model-enable wording', () => {
  expect(planSteps('Enable only its daily free DeepSeek V4.1 Flash access.')).toHaveLength(1);
  expect(planSteps('Enable the free model deepseek-v4.1-flash:free; never select its paid sibling.')).toHaveLength(1);
  expect(planSteps("Use the user's existing zro account or sign up for the free plan.")).toHaveLength(1);
  expect(planSteps('Use the normal Get your free tokens link to activate its recurring weekly allowance.')).toHaveLength(1);
  expect(planSteps("Complete today's ordinary DAILY CHECK-IN to activate recurring free quota.")).toHaveLength(1);
  expect(planSteps('Use only deepseek-ai/DeepSeek-V4.1-Flash at api.runcrate.ai.')).toHaveLength(1);
  expect(planSteps('No paid plan, payment method, extra account or account switching.')).toEqual([]);
});
