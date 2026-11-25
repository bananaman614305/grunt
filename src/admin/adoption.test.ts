import { expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { AgentStore } from '../store.js';
import { RegistryStore, utcDay } from '../registry-store.js';
import { bundledRegistry } from '../registry.js';
import { AdminStore } from './store.js';
import { adoption } from './adoption.js';
const day = 86400000;
const now = Date.UTC(2026,10,23,12);
const midnight = now-day/2;

it('reconciles windowed active accounts, metered tokens and latest distinct dimensions', async () => {
  const store = await AgentStore.open(':memory:');
  try {
    await new RegistryStore(store.db).init();
    await new AdminStore(store.db).init();
    const call = async (ts: number, account: string, tokens: number | null, device='Unknown') =>
      store.record({ model:'model', kind:'chat', tokens_in:99,tokens_out:99,latency_ms:10,outcome:'ok',cost:0,ts },
        {account,tokens,device,country:'Unknown'});
    await call(midnight-30*day,'old',1);
    await call(midnight-29*day,'month',2);
    await call(midnight-6*day,'week',3);
    await call(midnight-1,'a',4);
    await call(midnight,'a',5,'Desktop');
    await call(now,'a',6,'Mobile');
    await call(now,'b',null);
    await call(now+1,'future',100);
    for (const [period,count,tokens] of [['day',2,11],['week',3,18],['month',4,20],['all',5,21]] as const) {
      const result = await adoption(store.db,bundledRegistry,period,now);
      expect(result.accounts.length).toBe(count);
      expect(result.tokens).toBe(tokens);
      expect(result.accounts.find(a => a.account==='b')).toMatchObject({tokens:null,missing:1,country:'Unknown'});
      expect(result.accounts.find(a => a.account==='a')).toMatchObject({tokens:period==='day'?11:15,device:'Mobile'});
    }
    const joined = midnight-7*day;
    await store.db.execute({sql:'UPDATE account_metering SET started_at=?',args:[joined]});
    for (const [account,ts] of [['mature',joined],['immature',now-7*day+1],['reversed',joined]] as const) {
      await store.db.execute({sql:"INSERT INTO messages VALUES (?,?, 'user','',?)",args:[randomUUID(),account,ts]});
    }
    await call(joined-1,'reversed',0);
    await call(joined,'mature',0);
    await call(joined+day,'mature',0);
    expect((await adoption(store.db,bundledRegistry,'day',now)).cohort)
      .toMatchObject({joined:2,attempted:1,succeeded:1,retained:1});
  } finally { store.close(); }
});

it('reconciles replayed daily reports, archived history, probe samples, measured billing and independent requests on the same route', async () => {
  const store = await AgentStore.open(':memory:');
  try {
    let clock = now-20*day;
    const registry = new RegistryStore(store.db,()=>clock);
    const admin = new AdminStore(store.db,{now:()=>now});
    await registry.init(); await admin.init();
    const send = (id: string,ok: number,failed: number) => registry.recordFeedback({version:1,day:utcDay(clock),
      install:'a'.repeat(32),client:'test',routes:[{id,ok,failed,auth:0,quota:0,latency_ms:200,signup_failed:0,signup_ok:0,retired:false}]});
    await send('kilo',1,3);
    clock=now;
    await send('kilo',2,0); await send('kilo',2,0);
    await send('kilo',1,0); // A delayed cumulative report cannot erase a later success.
    await send('opencode',0,0);
    const events = ['user','maintenance','maintenance'].map((kind,i) => ({version:1,id:randomUUID(),requestId:randomUUID(),
      at:now,type:'attempt.finish',source:'kilo',model:'reported',durationMs:1000,inputTokens:1,outputTokens:2,kind,free:true,outcome:i===2?'failed':'passed'}));
    events.push({...events[0]!,id:randomUUID(),requestId:randomUUID(),at:now-20*60000});
    const batch = {version:1,instanceId:'chad',observedAt:now,snapshot:null,events};
    await admin.ingest(batch); await admin.ingest(batch);
    const result = await adoption(store.db,bundledRegistry,'all',now);
    expect(result.routes[0]).toMatchObject({id:'kilo',attempts:6,ok:3,latency:200,uptime:0.5,probes:2,
      tokens:6,p95:1000,sessionMs:null,free:2,models:['reported']});
    expect(result.routes.find(r=>r.id==='opencode')).toMatchObject({attempts:0,free:null});
    expect(result.routes.find(r=>r.id==='zro')).toMatchObject({attempts:null});
    expect(result.history.reduce((n,b)=>n+(b.counts.kilo ?? 0),0)).toBe(6);
    expect((await adoption(store.db,bundledRegistry,'day',now)).routes[0]?.attempts).toBe(2);
  } finally { store.close(); }
});

it('preserves legacy attribution across rowid gaps, vacuum and restart', async () => {
  const directory = await mkdtemp(join(tmpdir(),'grunt-attribution-'));
  const url = 'file:'+join(directory,'test.db');
  try {
    const legacy = createClient({url});
    try {
      await legacy.executeMultiple(`
        CREATE TABLE calls(model TEXT,kind TEXT,tokens_in INTEGER,tokens_out INTEGER,latency_ms INTEGER,outcome TEXT,cost REAL,ts INTEGER);
        INSERT INTO calls VALUES ('m','chat',0,0,10,'ok',0,1),('m','chat',0,0,10,'error',0,2),('m','chat',0,0,10,'ok',0,3);
        DELETE FROM calls WHERE rowid=2;
        CREATE TABLE account_attempts(call_id INTEGER PRIMARY KEY,account TEXT,measured_tokens INTEGER,device TEXT,country TEXT);
        INSERT INTO account_attempts VALUES(3,'legacy',17,'Desktop','CA');
      `);
    } finally { legacy.close(); }
    const migrated = await AgentStore.open(url);
    try { await migrated.db.execute('VACUUM'); } finally { migrated.close(); }
    const reopened = await AgentStore.open(url);
    try {
      await reopened.record({model:'m',kind:'chat',tokens_in:1,tokens_out:1,latency_ms:1,outcome:'ok',cost:0,ts:4},
        {account:'new',tokens:2,device:'Mobile',country:'GB'});
      await new RegistryStore(reopened.db).init();
      await new AdminStore(reopened.db).init();
      const report = await adoption(reopened.db,bundledRegistry,'all',now);
      expect(report.accounts).toEqual([
        {account:'legacy',tokens:17,missing:0,device:'Desktop',country:'Unknown'},
        {account:'new',tokens:2,missing:0,device:'Mobile',country:'GB'}
      ]);
      expect(report.tokens).toBe(19);
    } finally { reopened.close(); }
  } finally { await rm(directory,{recursive:true,force:true}); }
});
