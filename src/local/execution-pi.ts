import { join } from 'node:path';
import { jobsStateDirectory } from './jobs.js';
import { runtimeWorkTiming } from './work-timing-store.js';
import { registerJobTools } from './jobs-pi.js';
import type { JobPiContext, JobPiExtension } from './jobs-pi.js';
import { registerCheckpointTools } from './execution-checkpoint-pi.js';
import { registerPublicationTools } from './publication-pi.js';
import { loadExecutionHostChannels } from './efficiency-host.js';

type PiExecutionExtension = Omit<JobPiExtension, 'registerFlag' | 'on'> & {
  registerFlag(name: string, options: { type: 'string' | 'boolean'; default?: boolean; description: string }): void;
  on: JobPiExtension['on'] & ((event: 'before_agent_start', handler: (event: { systemPrompt: string }, context: JobPiContext) => { systemPrompt: string } | undefined | Promise<{ systemPrompt: string } | undefined>) => void);
};

/** Subworkers were removed. Old launch commands may still pass these flags; they are accepted and ignored. */
const removedFlags = [
  ['grunt-agent-workers', 'boolean', 'Removed: Grunt no longer provides subworkers. Ignored.'],
  ['grunt-worker-port', 'string', 'Removed: Grunt no longer provides subworkers. Ignored.']
] as const;

/** Pi extension for the opt-in local execution tools: background jobs, checkpoints and host publication requests. */
export default function gruntExecutionExtension(pi: PiExecutionExtension) {
  for (const [name, type, description] of removedFlags) pi.registerFlag(name, { type, description });
  const measurements = runtimeWorkTiming(join(jobsStateDirectory(), 'efficiency'));
  const channelFile = process.env.GRUNT_EXECUTION_CHANNEL_FILE;
  let channels: ReturnType<typeof loadExecutionHostChannels> | undefined;
  const hostChannels = () => {
    if (!channelFile) throw new Error('The trusted launcher must configure an execution-host channel manifest.');
    return channels ??= loadExecutionHostChannels(channelFile).catch((error: unknown) => { channels = undefined; throw error; });
  };
  registerJobTools(pi, { timing: measurements.timing, closeTiming: () => measurements.close(), ...(channelFile ? { verificationBroker: {
    start: async (...args) => (await hostChannels()).verificationBroker.start(...args),
    status: async (...args) => (await hostChannels()).verificationBroker.status(...args),
    result: async (...args) => (await hostChannels()).verificationBroker.result(...args)
  } } : {}) });
  registerCheckpointTools(pi, { timing: measurements.timing });
  registerPublicationTools(pi, channelFile ? { channel: {
    request: async (...args) => (await hostChannels()).publicationChannel.request(...args)
  } } : {});
}
