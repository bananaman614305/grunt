import { afterEach, expect, it } from 'vitest';
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join, parse } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { WorkerScopes } from './worker-scopes.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function project() {
  const root = await mkdtemp(join(tmpdir(), 'grunt-scope-')); directories.push(root);
  return root;
}
async function registered(scopes: WorkerScopes, root: string) {
  const challenge = await scopes.challenge(root);
  await writeFile(join(root, challenge.fileName), challenge.nonce, { mode: 0o600, flag: 'wx' });
  return { challenge, lease: await scopes.register(challenge.challengeId) };
}

it('requires a caller-created private project proof before authorizing any project read', async () => {
  const scopes = new WorkerScopes(), root = await project(), challenge = await scopes.challenge(root);
  await expect(scopes.register(challenge.challengeId)).rejects.toMatchObject({ code: 'permission_denied' });
  expect(await scopes.resolve(challenge.nonce)).toBeUndefined();
  expect((await lstat(root)).isDirectory()).toBe(true);
});
it('issues an opaque revocable lease and removes only the validated proof', async () => {
  const scopes = new WorkerScopes(), root = await project(), { challenge, lease } = await registered(scopes, root);
  expect(lease.token).toMatch(/^[a-f0-9]{64}$/);
  expect(await scopes.resolve(lease.token)).toEqual({ projectRoot: root, projectIdentity: expect.stringMatching(/^[a-f0-9]{64}$/) });
  await expect(readFile(join(root, challenge.fileName))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(scopes.revoke(lease.token)).toBe(true);
  expect(await scopes.resolve(lease.token)).toBeUndefined();
});
it('cannot reuse proof or resolve arbitrary malformed capabilities', async () => {
  const scopes = new WorkerScopes(), { challenge } = await registered(scopes, await project());
  await expect(scopes.register(challenge.challengeId)).rejects.toMatchObject({ code: 'expired_scope' });
  for (const token of [undefined, {}, '../secret', 'x'.repeat(64), '0'.repeat(64)]) expect(await scopes.resolve(token)).toBeUndefined();
});
it('rejects a wrong proof without deleting caller data or echoing it', async () => {
  const scopes = new WorkerScopes(), root = await project(), challenge = await scopes.challenge(root), privateText = 'private-unrelated-value'.padEnd(64, 'x');
  await writeFile(join(root, challenge.fileName), privateText, { mode: 0o600 });
  const error = await scopes.register(challenge.challengeId).catch(error => error);
  expect(error).toMatchObject({ code: 'permission_denied' });
  expect(error.message).not.toContain(privateText);
  expect(await readFile(join(root, challenge.fileName), 'utf8')).toBe(privateText);
});
it('rejects symlink proof files', async () => {
  const scopes = new WorkerScopes(), root = await project(), challenge = await scopes.challenge(root), target = join(root, 'target');
  await writeFile(target, challenge.nonce, { mode: 0o600 });
  await symlink(target, join(root, challenge.fileName));
  await expect(scopes.register(challenge.challengeId)).rejects.toMatchObject({ code: 'permission_denied' });
  expect(await readFile(target, 'utf8')).toBe(challenge.nonce);
});
it.skipIf(process.platform === 'win32')('rejects nonprivate proof modes', async () => {
  const scopes = new WorkerScopes(), root = await project(), challenge = await scopes.challenge(root), file = join(root, challenge.fileName);
  await writeFile(file, challenge.nonce, { mode: 0o600 }); await chmod(file, 0o644);
  await expect(scopes.register(challenge.challengeId)).rejects.toMatchObject({ code: 'permission_denied' });
});
it('expires both pending proofs and issued leases', async () => {
  let now = 1000; const scopes = new WorkerScopes({ now: () => now, challengeMs: 50, leaseMs: 100 }), root = await project();
  const first = await scopes.challenge(root); now += 51;
  await expect(scopes.register(first.challengeId)).rejects.toMatchObject({ code: 'expired_scope' });
  const { lease } = await registered(scopes, root); now += 101;
  expect(await scopes.resolve(lease.token)).toBeUndefined();
});
it('rejects a project replaced after its proof was requested or issued', async () => {
  const scopes = new WorkerScopes(), root = await project(), original = join(root, 'project'), moved = join(root, 'moved');
  await mkdir(original); const challenge = await scopes.challenge(original);
  await rename(original, moved); await mkdir(original);
  await writeFile(join(original, challenge.fileName), challenge.nonce, { mode: 0o600 });
  await expect(scopes.register(challenge.challengeId)).rejects.toMatchObject({ code: 'permission_denied' });
  const { lease } = await registered(scopes, original); await rename(original, join(root, 'second')); await mkdir(original);
  expect(await scopes.resolve(lease.token)).toBeUndefined();
});
it('rejects broad roots and credential directories, including resolved aliases', async () => {
  const scopes = new WorkerScopes(), root = await project(), secret = join(root, '.ssh'); await mkdir(secret);
  for (const value of [homedir(), parse(root).root, 'relative', secret, `${root}\nprivate`]) {
    await expect(scopes.challenge(value)).rejects.toMatchObject({ code: 'invalid_workspace' });
  }
  const alias = join(root, 'alias'); await symlink(secret, alias);
  await expect(scopes.challenge(alias)).rejects.toMatchObject({ code: 'invalid_workspace' });
});
it('bounds registrations and releases expired entries', async () => {
  let now = 1000; const scopes = new WorkerScopes({ now: () => now, maximum: 1, challengeMs: 20 });
  const root = await project(); await scopes.challenge(root);
  await expect(scopes.challenge(root)).rejects.toMatchObject({ code: 'busy' });
  now += 21; await expect(scopes.challenge(root)).resolves.toHaveProperty('challengeId');
  scopes.close(); await expect(scopes.challenge(root)).resolves.toHaveProperty('challengeId');
});

it('keeps the directory identity stable across leases and distinguishes a replacement at the same path', async () => {
  const scopes = new WorkerScopes(), root = await project(), original = join(root, 'project');
  await mkdir(original);
  const first = await registered(scopes, original), second = await registered(scopes, original);
  const before = await scopes.resolve(first.lease.token);
  expect(await scopes.resolve(second.lease.token)).toEqual(before);
  await rename(original, join(root, 'previous')); await mkdir(original);
  const replacement = await registered(scopes, original), after = await scopes.resolve(replacement.lease.token);
  expect(after?.projectRoot).toBe(before?.projectRoot);
  expect(after?.projectIdentity).not.toBe(before?.projectIdentity);
  expect(await scopes.resolve(first.lease.token)).toBeUndefined();
});
