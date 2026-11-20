import { expect, it, vi } from 'vitest';
import { PUBLICATION_FLAG, registerPublicationTools } from './publication-pi.js';
import type { PublicationPiExtension } from './publication-pi.js';
it('requires the trusted flag and host channel, and never accepts policy or credentials as tool arguments', async () => {
  let enabled = false; let start: (() => void) | undefined;
  const tools: Parameters<PublicationPiExtension['registerTool']>[0][] = [];
  const pi = { registerFlag: vi.fn(), getFlag: () => enabled, registerTool: (tool: typeof tools[number]) => { tools.push(tool); }, on: (_event: string, handler: () => void) => { start = handler; } };
  const request = vi.fn(async () => ({ id: 'fixture', phase: 'queued' }));
  registerPublicationTools(pi, { channel: { request } }); start!(); expect(tools).toHaveLength(0);
  enabled = true; start!(); expect(tools.map(t => t.name)).toEqual(['grunt_release_prepare', 'grunt_release_advance', 'grunt_release_status']);
  expect(pi.registerFlag).toHaveBeenCalledWith(PUBLICATION_FLAG, expect.objectContaining({ default: false }));
  const params = tools[0]!.parameters as { properties: object }; expect(params.properties).not.toHaveProperty('policy'); expect(params.properties).not.toHaveProperty('token');
  await tools[0]!.execute('call', {}, undefined, undefined, { cwd: '/synthetic/project' }); expect(request).toHaveBeenCalledWith('prepare', {}, { cwd: '/synthetic/project' }, undefined);
  enabled = false; await expect(tools[0]!.execute('call', {}, undefined, undefined, { cwd: '/synthetic/project' })).rejects.toThrow('trusted');
});
