/** Dependencies used only by the hosted gateway (src/dots-events.ts), never by the local daemon runtime. */
export const HOSTED_ONLY_DEPENDENCIES: ReadonlySet<string> = new Set([
  'standardwebhooks',
  'ipaddr.js',
]);

export function localRuntimeDependencies(dependencies: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(dependencies).filter(([name]) => !HOSTED_ONLY_DEPENDENCIES.has(name))
  );
}
