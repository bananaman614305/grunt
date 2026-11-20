import type { JobPiContext } from './jobs-pi.js';
export const PUBLICATION_FLAG = 'grunt-publication';
interface PublicationPiTool {
  name: string; label: string; description: string; promptSnippet: string; parameters: object;
  execute(id: string, input: unknown, signal?: AbortSignal, onUpdate?: unknown, context?: JobPiContext): Promise<{ content: { type: 'text'; text: string }[]; details: unknown }>;
}
export interface PublicationPiExtension {
  registerFlag(name: string, options: { type: 'boolean'; default?: boolean; description: string }): void;
  getFlag(name: string): string | boolean | undefined;
  registerTool(tool: PublicationPiTool): void;
  on(event: 'session_start', handler: (event: unknown, context: JobPiContext) => Promise<void> | void): void;
}
/** Host channel is supplied by the trusted launcher. It may be a constrained outbox broker; no GitHub credentials enter Pi. */
export interface PublicationChannel {
  request(operation: 'prepare' | 'advance' | 'status', input: unknown, context: JobPiContext, signal?: AbortSignal): Promise<unknown>;
}
const uuid = { type: 'string', pattern: '^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$' };
export function registerPublicationTools(pi: PublicationPiExtension, options: { channel?: PublicationChannel } = {}) {
  pi.registerFlag(PUBLICATION_FLAG, { type: 'boolean', default: false, description: 'Enable host-policy publication requests after independent Grunt review and authenticated required checks. GitHub credentials remain host-only.' });
  let registered = false;
  pi.on('session_start', () => {
    if (registered || pi.getFlag(PUBLICATION_FLAG) !== true || !options.channel) return;
    const registration = (operation: 'prepare' | 'advance' | 'status', description: string, parameters: object) => {
      pi.registerTool({ name: 'grunt_release_' + operation, label: 'Release ' + operation, description,
        promptSnippet: operation === 'prepare' ? 'Prepare a clean committed release with authenticated release-check IDs for a separate Grunt review' : operation === 'advance' ? 'Advance the host-authorized review, PR, exact-tree merge and verified Pages deployment without shell polling' : 'Check release status before starting another round; preserve unresolved publication evidence', parameters,
        async execute(_id, input, signal, _update, context) {
          if (pi.getFlag(PUBLICATION_FLAG) !== true || !context) throw new Error('Publication requires its trusted launch flag and current project context.');
          signal?.throwIfAborted();
          const details = await options.channel!.request(operation, input, context, signal);
          return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
        } });
    };
    registration('prepare', 'Request publication of the current clean committed candidate. The host verifies required release-check receipts, starts an independent Grunt reviewer, and enforces the configured repository/base/Pages policy. Model-written test or review claims are never sufficient.', {
      type: 'object', additionalProperties: false, required: ['head', 'branch', 'title', 'body', 'verificationIds'], properties: {
        head: { type: 'string', pattern: '^[a-f0-9]{40}$' }, branch: { type: 'string', minLength: 1, maxLength: 121 }, title: { type: 'string', minLength: 1, maxLength: 160 }, body: { type: 'string', minLength: 1, maxLength: 45000 }, verificationIds: { type: 'array', minItems: 1, maxItems: 32, uniqueItems: true, items: uuid }
      } });
    const identity = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: uuid } };
    registration('advance', 'Advance one release stage only after the host rechecks exact-head evidence and configured permissions. Continue independent useful work while a review or deployment is pending. Never submit another release to bypass a blocked gate.', identity);
    registration('status', 'Read the host publication result: review, required checks, PR, merge and exact Pages build status. This never runs game tests or provider probes.', identity);
    registered = true;
  });
}
