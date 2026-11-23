/** Shared project-relative path rules for checkpoints and the trusted execution host. */
const folders = new Set(['.git', '.hg', '.svn', '.ssh', '.aws', '.config', '.cache', '.local', '.codex', '.trusty-squire', '.npm', '.pnpm-store', '.kube', '.azure', '.gcloud', '.docker', '.gnupg', '.squire', 'node_modules']);
const secretNames = new Set(['.npmrc', '.netrc', '.pypirc', 'auth.json', 'models.json', 'credentials', 'credentials.json', 'credentials.yml', 'credentials.yaml', 'id_rsa', 'id_ed25519']);
/** True when any segment names a credential, VCS metadata or other private file. */
export function privateProjectPath(path: string) {
  return path.split('/').some(value => {
    const part = value.toLowerCase();
    return folders.has(part) || secretNames.has(part) || part === '.env' || part === '.envrc' || part.startsWith('.env.') || part.startsWith('.grunt-workspace-') || /^credentials/.test(part) || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/.test(part) || /\.(?:pem|key|p12|pfx)$/.test(part) || /^service-account.*\.json$/.test(part);
  });
}
/** Normalizes a portable relative project path or throws when it is unsafe or private. */
export function projectRelativePath(value: unknown, allowRoot = false): string {
  if (allowRoot && (value === undefined || value === '' || value === '.')) return '';
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\\:\x00-\x1f\x7f]/.test(value) || value.startsWith('/')) throw new Error('invalid_path');
  const parts = value.replace(/\/$/, '').split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) || privateProjectPath(parts.join('/'))) throw new Error('invalid_path');
  return parts.join('/');
}
