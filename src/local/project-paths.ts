/** Shared project-relative path rules for the trusted execution host and publication. */
const folders = new Set(['.git', '.hg', '.svn', '.ssh', '.aws', '.config', '.cache', '.local', '.codex', '.trusty-squire', '.npm', '.pnpm-store', '.kube', '.azure', '.gcloud', '.docker', '.gnupg', '.squire', 'node_modules']);
const secretNames = new Set(['.npmrc', '.netrc', '.pypirc', 'auth.json', 'models.json', 'credentials', 'credentials.json', 'credentials.yml', 'credentials.yaml', 'id_rsa', 'id_ed25519']);
/** True when any segment names a credential, VCS metadata or other private file. */
export function privateProjectPath(path: string) {
  return path.split('/').some(value => {
    const part = value.toLowerCase();
    return folders.has(part) || secretNames.has(part) || part === '.env' || part === '.envrc' || part.startsWith('.env.') || part.startsWith('.grunt-workspace-') || /^credentials/.test(part) || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/.test(part) || /\.(?:pem|key|p12|pfx)$/.test(part) || /^service-account.*\.json$/.test(part);
  });
}
