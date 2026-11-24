/** Old Pi launch flags from the removed subworker, background-job, checkpoint and release-tool features. They are accepted and ignored. */
const removedFlags = [
  ['grunt-agent-workers', 'boolean'],
  ['grunt-worker-port', 'string'],
  ['grunt-background-jobs', 'boolean'],
  ['grunt-checkpoints', 'boolean'],
  ['grunt-publication', 'boolean']
] as const;

interface PiFlagRegistry { registerFlag(name: string, options: { type: 'string' | 'boolean'; description: string }): void }

/**
 * Compatibility extension. Installed Pi launch commands still name this file and pass the removed flags; Pi rejects a
 * launch with an unknown flag, so each is registered and ignored. Grunt no longer provides tools to Pi.
 */
export default function gruntExecutionExtension(pi: PiFlagRegistry) {
  for (const [name, type] of removedFlags) pi.registerFlag(name, { type, description: 'Removed: Grunt no longer provides this Pi feature. Ignored.' });
}
