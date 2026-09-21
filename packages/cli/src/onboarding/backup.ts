/**
 * The sidecar every onboarding switch writes before touching a config, so a
 * later `milo off` (or a human) can restore the exact prior bytes. The
 * envelope format is the published `usemilo` contract: a single JSON object
 * tagged `milo: "onboarding-backup"`, version 1, with the harness name, the
 * write time, and the prior config text when one existed.
 */
export const BACKUP_SUFFIX = ".milo-backup";

export type BackupEnvelope = {
  milo: "onboarding-backup";
  version: 1;
  harness: string;
  createdAt: string;
  priorConfigExisted: boolean;
  priorConfig?: string;
};

export function backupPathFor(configPath: string): string {
  return `${configPath}${BACKUP_SUFFIX}`;
}

export function makeBackup(harness: string, prior: string | undefined, now: string): string {
  const envelope: BackupEnvelope = {
    milo: "onboarding-backup",
    version: 1,
    harness,
    createdAt: now,
    priorConfigExisted: prior !== undefined,
    ...(prior !== undefined ? { priorConfig: prior } : {}),
  };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

export function parseBackup(text: string): { priorConfigExisted: boolean; priorConfig?: string } {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || (parsed as { milo?: unknown }).milo !== "onboarding-backup") {
    throw new Error("not a Milo onboarding backup");
  }
  const envelope = parsed as Record<string, unknown>;
  const priorConfigExisted = envelope.priorConfigExisted === true;
  if (priorConfigExisted && typeof envelope.priorConfig !== "string") {
    throw new Error("backup claims a prior config but stores none");
  }
  return {
    priorConfigExisted,
    ...(priorConfigExisted ? { priorConfig: envelope.priorConfig as string } : {}),
  };
}