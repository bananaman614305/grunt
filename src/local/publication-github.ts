import { constants } from 'node:fs';
import { lstat, open, readdir, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { HostRefusal, publicationMarker, safeRelative } from './publication.js';
import type { PublicationPolicy, PublicationRecord, PublicationTransport } from './publication.js';
import { privateProjectPath } from './project-paths.js';

type Json = Record<string, unknown>;
const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const privateArtifact = (path: string) => privateProjectPath(path) || path.split('/').some(part => part === '.github' || part === '.gitmodules');
/** A trusted host supplies fixed-argv gh execution. No auth token, executable, URL or shell comes from a model request. */
export interface PublicationGithubExec {
  (args: string[], input?: string, signal?: AbortSignal): Promise<{ code: number; stdout: string }>;
}
export interface PublicationArtifact { path: string; content: Buffer }
export async function readPublicationArtifacts(policy: PublicationPolicy): Promise<PublicationArtifact[]> {
  if (!safeRelative(policy.artifactDirectory)) throw new Error('Unsafe artifact directory.');
  const rootStat = await lstat(policy.projectRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Unsafe project directory.');
  const root = await open(policy.projectRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const opened = await root.stat();
  if (opened.dev !== rootStat.dev || opened.ino !== rootStat.ino) { await root.close(); throw new Error('Project directory changed.'); }
  let prefix: string | undefined;
  for (const candidate of ['/proc/self/fd', '/dev/fd']) {
    try { const sample = await stat(`${candidate}/${root.fd}/.`); if (sample.dev === opened.dev && sample.ino === opened.ino) { prefix = candidate; break; } } catch { /* Try the other descriptor filesystem. */ }
  }
  if (!prefix) { await root.close(); throw new Error('Secure artifact traversal is unsupported on this platform.'); }
  const at = (handle: FileHandle, name: string) => `${prefix}/${handle.fd}/${name}`;
  const files: PublicationArtifact[] = []; let total = 0, directories = 0;
  const scan = async (dir: FileHandle, parent: string, depth: number) => {
    if (++directories > 4000 || depth > 32) throw new Error('Deployment directory budget exceeded.');
    for (const entry of (await readdir(at(dir, '.'), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = parent ? parent + '/' + entry.name : entry.name;
      if (!safeRelative(rel) || privateArtifact(rel)) throw new Error('Private-looking deployment artifact.');
      if (entry.isSymbolicLink()) throw new Error('Deployment artifact symlinks are not supported.');
      if (entry.isDirectory()) {
        const child = await open(at(dir, entry.name), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { await scan(child, rel, depth + 1); } finally { await child.close(); }
        continue;
      }
      const file = await open(at(dir, entry.name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const st = await file.stat(); if (!st.isFile() || st.size > 20 * 1024 * 1024 || process.getuid && st.uid !== process.getuid()) throw new Error('Unsafe deployment artifact.');
        const chunks: Buffer[] = [], buffer = Buffer.alloc(65536); let bytes = 0;
        for (;;) {
          const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
          if (!bytesRead) break;
          bytes += bytesRead;
          if (bytes > 20 * 1024 * 1024 || total + bytes > 100 * 1024 * 1024) throw new Error('Deployment artifact budget exceeded.');
          chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
        }
        const content = Buffer.concat(chunks); total += content.length;
        if (files.length >= 2000 || total > 100 * 1024 * 1024) throw new Error('Deployment artifact budget exceeded.');
        files.push({ path: rel, content });
      } finally { await file.close(); }
    }
  };
  const handles = [root];
  try {
    for (const part of policy.artifactDirectory.split('/')) handles.push(await open(at(handles.at(-1)!, part), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
    await scan(handles.at(-1)!, '', 0);
  } finally { await Promise.all(handles.reverse().map(handle => handle.close())); }
  if (!files.some(file => file.path === 'index.html')) throw new Error('Pages requires a verified index.html artifact.');
  return files;
}

/** Hash useful for callers whose verification plan uses this canonical artifact projection. */
export function publicationArtifactDigest(files: readonly PublicationArtifact[]) {
  return createHash('sha256').update(JSON.stringify(files.map(file => ({ path: file.path, sha256: createHash('sha256').update(file.content).digest('hex') })).sort((a, b) => a.path.localeCompare(b.path)))).digest('hex');
}

const pause = (ms: number, signal?: AbortSignal) => new Promise<void>((done, fail) => {
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); done(); }, ms);
  const abort = () => { clearTimeout(timer); fail(signal!.reason); };
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
});

export class GithubPublicationTransport implements PublicationTransport {
  constructor(private options: {
    exec: PublicationGithubExec;
    /** Push the reviewed SHA to the policy-pinned repository/branch with hooks disabled and no force. */
    pushHead(record: PublicationRecord, policy: PublicationPolicy, signal?: AbortSignal): Promise<void>;
    /** The trusted verifier must bind these bytes to its artifactDigest before any upload. */
    artifacts(record: PublicationRecord, policy: PublicationPolicy): Promise<PublicationArtifact[]>;
    /** GitHub reports a pushed head on its pull request a moment after the push; bounded re-reads absorb that lag. Tests inject a no-op sleep. */
    pullRequestSettle?: { attempts?: number; delayMs?: number; sleep?: (ms: number, signal?: AbortSignal) => Promise<void> };
  }) {}
  private async api(policy: PublicationPolicy, path: string, method = 'GET', body?: unknown, signal?: AbortSignal, missing = false): Promise<Json | Json[]> {
    if (path !== '' && !/^\/[A-Za-z0-9_./?=&%:-]+$/.test(path) || path.includes('..')) throw new Error('Invalid fixed GitHub API path.');
    const args = ['api', '--method', method, 'repos/' + policy.repository + path, ...(body === undefined ? [] : ['--input', '-'])];
    const result = await this.options.exec(args, body === undefined ? undefined : JSON.stringify(body), signal);
    if (result.code !== 0) {
      // A missing branch is not automatically created and a failed mutation is never treated as success.
      if (missing && result.code === 44) return {};
      throw new Error('GitHub publication operation failed; reconcile the retained release before retrying.');
    }
    const value: unknown = JSON.parse(result.stdout);
    if (!value || typeof value !== 'object') throw new Error('Invalid GitHub publication response.');
    return value as Json | Json[];
  }
  private async publicRepository(policy: PublicationPolicy, signal?: AbortSignal) {
    const repo = object(await this.api(policy, '', 'GET', undefined, signal));
    if (repo.full_name !== policy.repository || repo.private !== false || repo.archived !== false) throw new Error('Publication policy requires its exact active public repository.');
  }
  private async ref(policy: PublicationPolicy, name: string, signal?: AbortSignal) {
    const value = object(await this.api(policy, '/git/ref/heads/' + name, 'GET', undefined, signal)), commit = object(value.object).sha;
    if (!sha(commit)) throw new Error('The configured publication branch is unavailable.');
    return commit;
  }
  private async commit(policy: PublicationPolicy, head: string, signal?: AbortSignal) {
    const value = object(await this.api(policy, '/git/commits/' + head, 'GET', undefined, signal));
    if (value.sha !== head || !sha(object(value.tree).sha)) throw new Error('GitHub commit identity mismatch.');
    return value;
  }
  async ensurePullRequest(value: PublicationRecord, policy: PublicationPolicy, signal?: AbortSignal) {
    await this.publicRepository(policy, signal);
    if (await this.ref(policy, policy.base, signal) !== value.snapshot.baseHead) throw new Error('Publication base changed; request new verification and review.');
    await this.options.pushHead(value, policy, signal);
    const owner = policy.repository.split('/')[0]!, query = '/pulls?state=open&head=' + encodeURIComponent(owner + ':' + value.request.branch) + '&base=' + encodeURIComponent(policy.base);
    const existing = await this.api(policy, query, 'GET', undefined, signal);
    if (!Array.isArray(existing) || existing.length > 1) throw new Error('Ambiguous publication pull request.');
    let row = existing[0] ?? object(await this.api(policy, '/pulls', 'POST', { head: value.request.branch, base: policy.base, title: value.request.title, body: value.request.body, draft: false }, signal));
    // Right after a push GitHub can keep listing the pull request at its previous head for a few seconds. Re-read the same
    // pull request by number before concluding the head is wrong; a head that never converges is still refused.
    const settle = this.options.pullRequestSettle, attempts = settle?.attempts ?? 6, delayMs = settle?.delayMs ?? 1500;
    for (let attempt = 1; object(row.head).sha !== value.snapshot.head && Number.isSafeInteger(row.number) && attempt < attempts; attempt++) {
      await (settle?.sleep ?? pause)(delayMs, signal);
      row = object(await this.api(policy, '/pulls/' + Number(row.number), 'GET', undefined, signal));
    }
    const head = object(row.head), base = object(row.base);
    if (head.sha !== value.snapshot.head && head.ref === value.request.branch && sha(head.sha)) throw new HostRefusal('The pull request does not yet show the pushed head; advance the release again.');
    if (head.sha !== value.snapshot.head || head.ref !== value.request.branch || base.ref !== policy.base || object(base.repo).full_name !== policy.repository || !Number.isSafeInteger(row.number)
      || object(head.repo).full_name !== policy.repository || row.html_url !== `https://github.com/${policy.repository}/pull/${row.number}`) throw new Error('Pull request does not match the reviewed release.');
    return { number: Number(row.number), url: String(row.html_url) };
  }
  async merge(value: PublicationRecord, policy: PublicationPolicy, signal?: AbortSignal) {
    if (!policy.allowMerge || !value.pullRequest) throw new Error('A trusted merge policy and reviewed pull request are required.');
    await this.publicRepository(policy, signal);
    const base = await this.ref(policy, policy.base, signal), current = await this.commit(policy, base, signal), marker = publicationMarker(value, 'merge');
    if (current.message === marker && object(current.tree).sha === value.snapshot.gitTree) return base;
    if (base !== value.snapshot.baseHead || !value.snapshot.baseIsAncestor) throw new Error('Publication base changed; request new verification and review.');
    const pr = object(await this.api(policy, '/pulls/' + value.pullRequest.number, 'GET', undefined, signal));
    if (pr.state !== 'open' || pr.draft !== false || object(pr.head).sha !== value.snapshot.head || object(pr.base).ref !== policy.base || object(pr.base).sha !== base) throw new Error('Pull request is no longer the reviewed open release.');
    const candidate = await this.commit(policy, value.snapshot.head, signal);
    if (object(candidate.tree).sha !== value.snapshot.gitTree) throw new Error('The remote candidate tree differs from the verified tree.');
    // This commit contains exactly the tested candidate tree, not an untested automatic rebase/merge.
    // A concurrent unrelated base advancement cannot fast-forward to this two-parent commit.
    const merged = object(await this.api(policy, '/git/commits', 'POST', { message: marker, tree: value.snapshot.gitTree,
      parents: [value.snapshot.baseHead, value.snapshot.head] }, signal));
    if (!sha(merged.sha) || object(merged.tree).sha !== value.snapshot.gitTree) throw new Error('Invalid exact-tree merge commit.');
    await this.api(policy, '/git/refs/heads/' + policy.base, 'PATCH', { sha: merged.sha, force: false }, signal);
    if (await this.ref(policy, policy.base, signal) !== merged.sha) throw new Error('Merge ref confirmation failed.');
    return merged.sha;
  }
  async deploy(value: PublicationRecord, policy: PublicationPolicy, signal?: AbortSignal) {
    if (!policy.allowDeploy || !value.mergeCommit) throw new Error('An authorized merged release is required before Pages deployment.');
    await this.publicRepository(policy, signal);
    if (await this.ref(policy, policy.base, signal) !== value.mergeCommit) throw new Error('Base advanced after review; this release cannot deploy over newer work.');
    const pages = object(await this.api(policy, '/pages', 'GET', undefined, signal)), source = object(pages.source);
    if (source.branch !== policy.pagesBranch || source.path !== '/' || typeof pages.html_url !== 'string'
      || !/^https:\/\/[a-zA-Z0-9.-]+\.github\.io\/[a-zA-Z0-9._/-]*$/.test(pages.html_url)) throw new Error('Configure the policy-pinned free public GitHub Pages branch before publication.');
    let head = await this.ref(policy, policy.pagesBranch, signal), current = await this.commit(policy, head, signal);
    const marker = publicationMarker(value, 'pages');
    if (value.pagesCommit && head !== value.pagesCommit) throw new Error('Pages advanced while deployment was pending; preserve newer work.');
    if (current.message !== marker) {
      const files = await this.options.artifacts(value, policy);
      if (!files.length || files.length > 2000) throw new Error('Missing verified deployment artifact.');
      const paths = new Set<string>(); let bytes = 0;
      for (const file of files) {
        if (!safeRelative(file.path) || privateArtifact(file.path) || paths.has(file.path) || !Buffer.isBuffer(file.content)
          || file.content.length > 20 * 1024 * 1024) throw new Error('Unsafe deployment artifact path or content.');
        paths.add(file.path); bytes += file.content.length;
        if (bytes > 100 * 1024 * 1024) throw new Error('Deployment artifact budget exceeded.');
      }
      if (!paths.has('index.html')) throw new Error('Missing verified index.html.');
      const tree = [];
      for (const file of files) {
        signal?.throwIfAborted();
        const blob = object(await this.api(policy, '/git/blobs', 'POST', { content: file.content.toString('base64'), encoding: 'base64' }, signal));
        if (!sha(blob.sha)) throw new Error('Invalid deployment blob.');
        tree.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
      }
      const createdTree = object(await this.api(policy, '/git/trees', 'POST', { tree }, signal));
      if (!sha(createdTree.sha)) throw new Error('Invalid deployment tree.');
      // base_tree is omitted intentionally: removed build artifacts must also disappear from Pages.
      const created = object(await this.api(policy, '/git/commits', 'POST', { message: marker, tree: createdTree.sha, parents: [head] }, signal));
      if (!sha(created.sha)) throw new Error('Invalid Pages commit.');
      if (await this.ref(policy, policy.base, signal) !== value.mergeCommit) throw new Error('Base advanced during artifact upload; preserve newer work.');
      await this.api(policy, '/git/refs/heads/' + policy.pagesBranch, 'PATCH', { sha: created.sha, force: false }, signal);
      if (await this.ref(policy, policy.pagesBranch, signal) !== created.sha) throw new Error('Pages ref confirmation failed.');
      await this.api(policy, '/pages/builds', 'POST', {}, signal);
      head = created.sha; current = created;
    }
    if (current.message !== marker) throw new Error('Pages deployment no longer matches this release.');
    const builds = await this.api(policy, '/pages/builds?per_page=20', 'GET', undefined, signal);
    if (!Array.isArray(builds)) throw new Error('Invalid Pages build response.');
    const build = builds.find(row => row.commit === head);
    if (build?.status === 'errored') throw new Error('The exact Pages build failed; preserve its release receipt.');
    return { commit: head, ...(build?.status === 'built' ? { url: pages.html_url } : {}) };
  }
}
