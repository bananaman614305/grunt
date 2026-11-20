import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { GithubPublicationTransport, readPublicationArtifacts } from './publication-github.js';
import type { PublicationPolicy, PublicationRecord } from './publication.js';
const head = 'a'.repeat(40), base = 'b'.repeat(40), gitTree = 'c'.repeat(40), oldPages = 'd'.repeat(40);
const policy: PublicationPolicy = { version: 1, projectRoot: '/synthetic/project', repository: 'synthetic/project', base: 'main', headPrefix: 'grunt/', requiredChecks: ['tests'], reviewPaths: ['src'], artifactDirectory: 'dist', pagesBranch: 'gh-pages', allowMerge: true, allowDeploy: true };
function fixture() {
  const value: PublicationRecord = { version: 1, id: randomUUID(), createdAt: 1, updatedAt: 1, phase: 'pull_request', verificationIds: [], request: { head, branch: 'grunt/test', title: 'A fixture', body: 'Fixture body', verificationIds: [] }, snapshot: { projectRoot: policy.projectRoot, head, treeDigest: 'e'.repeat(64), artifactDigest: 'f'.repeat(64), clean: true, branch: 'grunt/test', baseHead: base, baseIsAncestor: true, gitTree }, pullRequest: { number: 7, url: 'https://github.com/synthetic/project/pull/7' } };
  const refs = new Map([['main', base], ['gh-pages', oldPages]]), commits = new Map<string, Record<string, unknown>>([
    [head, { sha: head, tree: { sha: gitTree }, message: 'candidate' }], [base, { sha: base, tree: { sha: '0'.repeat(40) }, message: 'base' }], [oldPages, { sha: oldPages, tree: { sha: '1'.repeat(40) }, message: 'old pages' }]
  ]);
  let counter = 10, privateRepo = false, race = false, pagesRace = false, buildStatus = 'building';
  const pr = () => ({ number: 7, html_url: 'https://github.com/synthetic/project/pull/7', state: 'open', draft: false, head: { sha: head, ref: 'grunt/test', repo: { full_name: policy.repository } }, base: { ref: 'main', sha: base, repo: { full_name: policy.repository } } });
  const calls: { path: string; method: string; body?: Record<string, unknown> }[] = [];
  const exec = vi.fn(async (args: string[], input?: string) => {
    expect(args[0]).toBe('api'); expect(args[1]).toBe('--method');
    const method = args[2]!, path = args[3]!.slice(('repos/' + policy.repository).length), body = input ? JSON.parse(input) as Record<string, unknown> : undefined;
    calls.push({ path, method, ...(body ? { body } : {}) }); let result: unknown;
    if (path === '') result = { full_name: policy.repository, private: privateRepo, archived: false };
    else if (path.startsWith('/git/ref/heads/')) result = { object: { sha: refs.get(path.slice('/git/ref/heads/'.length)) } };
    else if (path.startsWith('/git/commits/') && method === 'GET') result = commits.get(path.slice('/git/commits/'.length));
    else if (path === '/git/commits' && method === 'POST') {
      const id = (++counter).toString(16).padStart(40, '0'); result = { ...body, tree: { sha: body!.tree }, sha: id }; commits.set(id, result as Record<string, unknown>);
      if (race && String(body!.message).startsWith('Grunt merge ')) refs.set('main', '9'.repeat(40));
      if (pagesRace && String(body!.message).startsWith('Grunt pages ')) refs.set('main', '9'.repeat(40));
    } else if (path.startsWith('/git/refs/heads/') && method === 'PATCH') {
      const name = path.slice('/git/refs/heads/'.length), next = commits.get(String(body!.sha));
      expect(body!.force).toBe(false);
      if (!(next?.parents as string[]).includes(refs.get(name)!)) return { code: 1, stdout: '{}' };
      refs.set(name, String(body!.sha)); result = { object: { sha: body!.sha } };
    } else if (path.startsWith('/pulls?')) result = [pr()];
    else if (path === '/pulls/7') result = pr();
    else if (path === '/pages') result = { html_url: 'https://synthetic.github.io/project/', source: { branch: 'gh-pages', path: '/' } };
    else if (path === '/git/blobs') result = { sha: (++counter).toString(16).padStart(40, '0') };
    else if (path === '/git/trees') result = { sha: (++counter).toString(16).padStart(40, '0') };
    else if (path === '/pages/builds' && method === 'POST') result = { status: 'queued' };
    else if (path === '/pages/builds?per_page=20') result = [{ commit: refs.get('gh-pages'), status: buildStatus }];
    else throw new Error('Unexpected synthetic API call: ' + path);
    return { code: 0, stdout: JSON.stringify(result) };
  });
  const pushHead = vi.fn(async () => {}), artifacts = vi.fn(async () => [{ path: 'index.html', content: Buffer.from('fixture') }]);
  const transport = new GithubPublicationTransport({ exec, pushHead, artifacts });
  return { value, transport, calls, refs, commits, pushHead, artifacts, private: () => { privateRepo = true; }, race: () => { race = true; }, pagesRace: () => { pagesRace = true; }, built: () => { buildStatus = 'built'; } };
}
it('publishes only the exact public repository pull request and keeps credential execution host supplied', async () => {
  const f = fixture(); expect(await f.transport.ensurePullRequest(f.value, policy)).toEqual({ number: 7, url: 'https://github.com/synthetic/project/pull/7' }); expect(f.pushHead).toHaveBeenCalledTimes(1);
  f.private(); await expect(f.transport.ensurePullRequest(f.value, policy)).rejects.toThrow('public repository'); expect(f.pushHead).toHaveBeenCalledTimes(1);
});
it('merges the exact tested tree with pinned parents through a non-force fast-forward ref update', async () => {
  const f = fixture(), merged = await f.transport.merge(f.value, policy);
  expect(f.refs.get('main')).toBe(merged);
  const create = f.calls.find(c => c.path === '/git/commits' && c.method === 'POST');
  expect(create?.body).toMatchObject({ tree: gitTree, parents: [base, head] });
  expect(f.calls.find(c => c.path === '/git/refs/heads/main')?.body).toEqual({ sha: merged, force: false });
  expect(await f.transport.merge(f.value, policy)).toBe(merged);
  expect(f.calls.filter(c => c.path === '/git/commits' && c.method === 'POST')).toHaveLength(1);
});
it('rejects a concurrent unrelated base advancement rather than creating an untested merge', async () => {
  const f = fixture(); f.race(); await expect(f.transport.merge(f.value, policy)).rejects.toThrow('failed'); expect(f.refs.get('main')).toBe('9'.repeat(40));
});
it('uploads only verified artifact bytes, removes stale build files and waits for the exact Pages build', async () => {
  const f = fixture(); f.value.mergeCommit = await f.transport.merge(f.value, policy);
  const first = await f.transport.deploy(f.value, policy); expect(first.url).toBeUndefined(); f.value.pagesCommit = first.commit;
  expect(f.calls.find(c => c.path === '/git/trees')?.body).toEqual({ tree: [{ path: 'index.html', mode: '100644', type: 'blob', sha: expect.any(String) }] });
  expect(f.calls.find(c => c.path === '/git/blobs')?.body).toEqual({ content: Buffer.from('fixture').toString('base64'), encoding: 'base64' });
  f.built(); expect(await f.transport.deploy(f.value, policy)).toEqual({ commit: first.commit, url: 'https://synthetic.github.io/project/' });
  expect(f.artifacts).toHaveBeenCalledTimes(1); expect(f.calls.filter(c => c.path === '/pages/builds' && c.method === 'POST')).toHaveLength(1);
});
it('does not overwrite a newer Pages deployment while waiting for its build', async () => {
  const f = fixture(); f.value.mergeCommit = await f.transport.merge(f.value, policy); const first = await f.transport.deploy(f.value, policy); f.value.pagesCommit = first.commit;
  f.refs.set('gh-pages', '8'.repeat(40)); f.commits.set('8'.repeat(40), { sha: '8'.repeat(40), tree: { sha: gitTree }, message: 'someone newer' });
  await expect(f.transport.deploy(f.value, policy)).rejects.toThrow('newer work');
});
it('rechecks the source base after uploading blobs before updating Pages', async () => {
  const f = fixture(); f.value.mergeCommit = await f.transport.merge(f.value, policy); f.pagesRace();
  await expect(f.transport.deploy(f.value, policy)).rejects.toThrow('during artifact upload'); expect(f.refs.get('gh-pages')).toBe(oldPages);
});
it.each(['.netrc', 'credentials.json', '.envrc', 'certificate.p12', 'certificate.pfx', 'service-account-prod.json', 'nested/.ssh/id_rsa', '.github/workflows/anything.yml', '.gitmodules'])('rejects %s before uploading any blob even if a trusted adapter returns it', async path => {
  const f = fixture(); f.value.mergeCommit = await f.transport.merge(f.value, policy);
  f.artifacts.mockResolvedValueOnce([{ path: 'index.html', content: Buffer.from('fixture') }, { path, content: Buffer.from('private fixture') }]);
  await expect(f.transport.deploy(f.value, policy)).rejects.toThrow('Unsafe deployment'); expect(f.calls.some(c => c.path === '/git/blobs')).toBe(false);
});
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it('reads a bounded static artifact tree without symlinks or private-looking files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grunt-pages-artifacts-')); roots.push(root); await mkdir(join(root, 'dist')); await writeFile(join(root, 'dist/index.html'), 'fixture');
  const p = { ...policy, projectRoot: root }; expect((await readPublicationArtifacts(p)).map(f => f.path)).toEqual(['index.html']);
  await writeFile(join(root, 'dist/.env'), 'private'); await expect(readPublicationArtifacts(p)).rejects.toThrow('Private-looking'); await rm(join(root, 'dist/.env'));
  await symlink(join(root, 'dist/index.html'), join(root, 'dist/outside')); await expect(readPublicationArtifacts(p)).rejects.toThrow('symlinks');
});
it.each(['.netrc', 'credentials.json', '.envrc', 'certificate.p12', 'certificate.pfx', 'service-account-prod.json'])('excludes private artifact %s from fd-relative reading', async path => {
  const root = await mkdtemp(join(tmpdir(), 'grunt-pages-private-')); roots.push(root); await mkdir(join(root, 'dist')); await writeFile(join(root, 'dist/index.html'), 'fixture'); await writeFile(join(root, 'dist', path), 'private fixture');
  await expect(readPublicationArtifacts({ ...policy, projectRoot: root })).rejects.toThrow('Private-looking');
});
