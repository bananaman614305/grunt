import { afterEach, expect, it, vi } from 'vitest';
import { BrowserSquire } from './setup.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const zroInput = { service: 'zro', plan: 'free', project_name: 'grunt', category: 'ai', cost_cents: 0, recurrence: 'none', idempotency_key: 'milo-free-zro' };
const question = 'Choose one current target key, or DONE, BLOCKED, NONE_OF_THESE, or WAIT.';
// Squire 1.1.62's handoff for Zro's create-key dialog (trace row 588), trimmed.
const unsure = (url: string, field: string, slug: string) => ({
  status: 'low_confidence', session_id: 'tab', question, confidence: 0.32,
  reason: `model confidence is below the drive threshold on ${url}`,
  options: { kcancel_fm_1_b: 'Cancel', [slug]: field.split('|')[0], kspend_limit: 'Spend limit', DONE: 'The goal is complete', WAIT: 'Wait for the page to change' },
  observation: { url, safe_table: [['@e:f0d51', 'b', 'Cancel|fm=1'], ['@e:f0d45', 't', field], ['@e:f0d47', 't', 'Spend limit|it=number|ph=25.00|fm=1']] }
});
function drives(squire: BrowserSquire, answer: (args: Record<string, unknown>) => Record<string, unknown>) {
  const calls: Record<string, unknown>[] = [];
  vi.spyOn(squire, 'call').mockImplementation(async (name, args) => {
    if (name !== 'operate_drive') return {};
    calls.push(structuredClone(args));
    return answer(args);
  });
  return calls;
}

it('resumes an unsure Zro Alias field with the key_name Grunt supplied, stamped to the minute', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-23T14:54:22Z'));
  const squire = new BrowserSquire();
  const calls = drives(squire, args => args.answer === 'kalias_ph_agent_prod_fm_1_t'
    ? { status: 'complete', session_id: 'tab' } : unsure('https://zro.moonmath.ai/api-keys', 'Alias|ph=agent-prod|fm=1', 'kalias_ph_agent_prod_fm_1_t'));
  await expect(squire.runs.start(zroInput)).resolves.toMatchObject({ run: { state: 'completed' } });
  expect(calls).toHaveLength(2);
  expect(calls[0]!.facts).toEqual({ key_name: 'grunt-20261123-1454', plan: 'free', project_name: 'grunt' });
  expect(calls[1]).toMatchObject({ session_id: 'tab', answer: 'kalias_ph_agent_prod_fm_1_t',
    facts: { key_name: 'grunt-20261123-1454', Alias: 'grunt-20261123-1454', plan: 'free', project_name: 'grunt' } });
  await squire.close();
});

it('names an optional label field by its own label', async () => {
  const squire = new BrowserSquire();
  const calls = drives(squire, args => args.answer === 'klabel'
    ? { status: 'complete', session_id: 'tab' } : unsure('https://kenari.test/keys', 'Label (opsional)|ph=grunt|fm=1', 'klabel'));
  await squire.signup('kenari', 'https://kenari.test/overview', 'Create one key.', { key_name: 'grunt', model: 'free-model' });
  expect(calls[1]).toMatchObject({ answer: 'klabel', facts: { 'Label (opsional)': 'grunt', key_name: 'grunt', model: 'free-model' } });
  await squire.close();
});

it.each([
  ['the provider has no key_name of its own', 'https://fikra.test/keys', 'Alias|fm=1', undefined],
  ['the field is a person\'s name on a sign-up page', 'https://fikra.test/sign-up', 'Name|fm=1', { key_name: 'grunt' }],
  ['the field is not a name field', 'https://fikra.test/keys', 'Email|fm=1', { key_name: 'grunt' }],
])('drops with Squire\'s own question, score and reason when %s', async (_case, url, field, facts) => {
  const squire = new BrowserSquire();
  const calls = drives(squire, () => unsure(url, field, 'kfield'));
  await expect(squire.signup('fikra', url, 'Create one key.', facts)).rejects.toThrow('confidence 0.32');
  expect(calls).toHaveLength(1);
  expect(squire.signupFailure('fikra')).toBe(`browser could not continue; Squire asked: ${question}; confidence 0.32; Squire's reason: model confidence is below the drive threshold on [link omitted]`);
  await squire.close();
});

it('answers a name field once, then reports Squire\'s stop', async () => {
  const squire = new BrowserSquire();
  const calls = drives(squire, () => unsure('https://zro.moonmath.ai/api-keys', 'Alias|fm=1', 'kalias'));
  await expect(squire.runs.start(zroInput)).resolves.toMatchObject({ run: { state: 'dropped' }, diagnostic: { question, confidence: 0.32 } });
  expect(calls.map(call => call.answer)).toEqual([undefined, 'kalias']);
  await squire.close();
});

it.each(['budget', 'evaluate_timeout'].flatMap(status => ['provisioning', 'signup'].map(path => ({ status, path }))))('retains recovered field facts across $status in $path and clears them after completion', async ({ status, path }) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-23T14:54:22Z'));
  const squire = new BrowserSquire();
  const provisioning = path === 'provisioning';
  const service = provisioning ? 'zro' : 'kenari';
  const field = provisioning ? 'Alias' : 'Label (opsional)';
  const expectedName = provisioning ? 'grunt-20261123-1454' : 'grunt';
  const supplied = { key_name: 'grunt', model: 'free-model' };
  let turn = 0;
  const calls = drives(squire, args => {
    const step = turn++ % 3;
    if (step === 0) return unsure(`https://${service}.test/keys`, `${field}|fm=1`, 'kname');
    if (step === 1) return { status, session_id: 'tab' };
    return (args.facts as Record<string, string>)[field] === expectedName
      ? { status: 'complete', session_id: 'tab' }
      : unsure(`https://${service}.test/keys`, `${field}|fm=1`, 'kname');
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    if (provisioning) {
      await expect(squire.runs.start(zroInput)).resolves.toMatchObject({ run: { state: 'running' } });
      await expect(squire.runs.get('zro')).resolves.toMatchObject({ state: 'completed' });
    } else {
      await squire.signup(service, `https://${service}.test/keys`, 'Create one key.', supplied);
    }
  }
  expect(calls).toHaveLength(6);
  for (const start of [0, 3]) {
    expect(calls[start]!.facts).not.toHaveProperty(field);
    expect(calls[start + 1]).toMatchObject({ answer: 'kname', facts: { [field]: expectedName, key_name: expectedName } });
    expect(calls[start + 2]).toMatchObject({ session_id: 'tab', facts: { [field]: expectedName, key_name: expectedName, plan: 'free', project_name: 'grunt' } });
  }
  expect(supplied).toEqual({ key_name: 'grunt', model: 'free-model' });
  await squire.close();
});

const factQuestion = (field: string) => ({
  ...unsure('https://zro.test/keys', `${field}|fm=1`, 'unused'),
  options: { key_name: 'Use the supplied key_name', plan: 'Use the plan', project_name: 'Use the project name', none: 'None of these' }
});

it.each(['Alias', 'Label', 'Name'])('resumes an offered key_name fact for %s once, using this provider\'s fact', async field => {
  const squire = new BrowserSquire();
  const calls = drives(squire, args => args.answer === 'key_name' ? { status: 'complete', session_id: 'tab' } : factQuestion(field));
  await squire.signup('kenari', 'https://kenari.test/keys', 'Create one key.', { key_name: 'Grunt Free' });
  expect(calls).toHaveLength(2);
  expect(calls[1]).toMatchObject({ answer: 'key_name', facts: { key_name: 'Grunt Free' }, session_id: 'tab' });
  await squire.close();
});

it('does not answer an offered key_name without this provider supplying that fact', async () => {
  const squire = new BrowserSquire();
  const calls = drives(squire, () => factQuestion('Alias'));
  await expect(squire.signup('fikra', 'https://fikra.test/keys', 'Create one key.')).rejects.toThrow('confidence 0.32');
  expect(calls).toHaveLength(1);
  expect(calls[0]).not.toHaveProperty('answer');
  await squire.close();
});

it('answers a repeated key_name fact question only once across a polling yield', async () => {
  const squire = new BrowserSquire();
  let turn = 0;
  const calls = drives(squire, () => ++turn === 2 ? { status: 'budget', session_id: 'tab' } : factQuestion('Alias'));
  await expect(squire.runs.start(zroInput)).resolves.toMatchObject({ run: { state: 'running' } });
  await expect(squire.runs.get('zro')).resolves.toMatchObject({ state: 'dropped' });
  expect(calls.map(call => call.answer)).toEqual([undefined, 'key_name', undefined]);
  await squire.close();
});
