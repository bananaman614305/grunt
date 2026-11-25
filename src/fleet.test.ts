import { adminRoutes } from './admin/routes.js';
import { AdminStore } from './admin/store.js';
import { createClient } from '@libsql/client';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { DiagnosticsStore, withDiagnosticContext } from './local/diagnostics.js';
import { SourceStatus } from './local/source-status.js';
import { SourceError } from './local/source.js';
import { RouteFeedback } from './local/route-feedback.js';
import { uploadFleet } from './local/fleet-upload.js';
import { RegistryStore } from './registry-store.js';
import { registryRoutes } from './registry-routes.js';
import { DAY, fleetAudit, HOUR } from './fleet.js';
import { planFleetBacklog, renderFleetReport } from './fleet-report.js';

it('audits a complete UTC day through route observations, signed intake and replay', async () => {
  const end = Date.UTC(2026, 10, 24);
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'grunt-fleet-'));
  const client = createClient({url:'file:'+join(dir,'gateway.db')});
  const store = new RegistryStore(client, () => end);
  await store.init();
  const api = registryRoutes({ store, now: () => end, fleetSecret: 'test-only-secret-for-offline-fleet-diagnostics' });
  const url = 'https://registry.test/v1/registry';
  let uploads = 0, replay: Request | undefined;
  const fetcher: typeof fetch = async (input,init) => {
    const req = new Request(input,init);
    if (req.url.endsWith('/fleet')) {
      expect(await req.clone().text()).not.toMatch(/PRIVATE|requestId|attemptId|cwd/);
      replay = req.clone(); uploads++;
    }
    return api.request(req);
  };
  let monotonic = 0;
  const perf = vi.spyOn(performance,'now').mockImplementation(() => monotonic);
  try {
    for (const installation of ['first','second']) {
      const directory = join(dir,installation);
      let now = end - 3*DAY;
      const journal = await DiagnosticsStore.open({directory,now:()=>now,runtimeVersion:'1.2.3'});
      try {
        const observer = new SourceStatus(['kilo'],()=>now);
        observer.setDiagnostics(journal);
        const feedback = new RouteFeedback({ directory, urls:[url], listed:()=>['kilo'], retired:()=>false, now:()=>end,
          fleet: token => uploadFleet(journal,directory,[url],token,end,fetcher), fetcher });
        for (let day=3;day>=1;day--) {
          for (let attempt=0;attempt<24;attempt++) {
            now = end-day*DAY + attempt*HOUR + 30000;
            const failing = day===1 && attempt%4===0;
            const slow = day===1 && attempt%4===1;
            await withDiagnosticContext({ requestId:randomUUID(),kind:'user' },async () => {
              const completion = observer.complete({ id:'kilo', available:async()=>true, close:async()=>{},
                complete:async () => {
                  monotonic += slow ? 11000 : 100;
                  if (failing) throw new SourceError('timeout','PRIVATE upstream response');
                  return { text:'PRIVATE response',model:'kilo' };
                } }, {model:'grunt',cwd:'PRIVATE',messages:[],tools:[],stream:false},new AbortController().signal);
              if (failing) await expect(completion).rejects.toThrow(); else await completion;
            });
          }
        }
        journal.record({ version:1, id:randomUUID(),requestId:randomUUID(),at:now,source:'kilo',kind:'user',type:'attempt.start' });
        now=end;
        await feedback.exchange();
      } finally { await journal.close(); }
    }
    expect(uploads).toBe(144);
    expect((await api.request(replay!.clone())).status).toBe(204);
    const rejected = replay!.clone();
    rejected.headers.set('Authorization','Bearer '+ 'a'.repeat(97));
    expect((await api.request(rejected)).status).toBe(401);
    const ownerRead = 'test-only-read-token-for-offline-fleet-audit';
    const admin = adminRoutes(new AdminStore(client), { now:()=>end, env:{
      GRUNT_ADMIN_READ_TOKEN:ownerRead, GRUNT_ADMIN_OWNERS:'owner@example.test',
      GRUNT_ADMIN_GOOGLE_CLIENT_ID:'offline.apps.googleusercontent.com', GRUNT_ADMIN_GOOGLE_CLIENT_SECRET:'offline',
      GRUNT_ADMIN_SESSION_SECRET:'test-only-session-secret-for-offline-fleet-audit'
    } });
    const reportUrl = '/admin/api/fleet-audit?day=2026-11-23';
    expect((await admin.request(reportUrl)).status).toBe(401);
    const authenticated = await admin.request(reportUrl,{headers:{Authorization:'Bearer '+ownerRead}});
    expect(authenticated.status).toBe(200);
    expect(await authenticated.json()).toEqual(await fleetAudit(client,end));
    const report = await fleetAudit(client,end);
    expect(report.coverage).toMatchObject({installs:2,hours:48});
    expect(report.cohorts.find(r=>r.current===1)).toMatchObject({starts:50,passed:36,failed:12});
    expect(report.findings.map(f=>f.handle)).toEqual(['fleet-kilo-failed','fleet-kilo-slow']);
    expect(report.findings[0]).toMatchObject({affected:12,denominator:48,baselineAffected:0,baselineDenominator:96});
    const backlog = Object.fromEntries(report.findings.map(f=>[f.handle,'fixture-'+f.handle]));
    const firstPlan = planFleetBacklog(report,{});
    expect(firstPlan.filter(item=>!item.workId)).toHaveLength(2);
    expect(planFleetBacklog(await fleetAudit(client,end),backlog).filter(item=>!item.workId)).toEqual([]);
    const html = renderFleetReport('2026-11-23',report,backlog);
    expect(html).toContain('go fleet-kilo-slow');
    expect(renderFleetReport('2026-11-23',await fleetAudit(client,end),backlog)).toBe(html);
    expect(()=>renderFleetReport('2026-11-23',report)).toThrow(/Missing backlog item/);
    expect((await fleetAudit(client,end+DAY)).findings).toEqual([]);
  } finally { perf.mockRestore(); client.close(); await rm(dir,{recursive:true,force:true}); }
},30000);
