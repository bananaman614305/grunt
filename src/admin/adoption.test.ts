import { expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import { randomUUID } from 'node:crypto';
import { HOUR, saveHour } from '../fleet.js';
import { RegistryStore, utcDay } from '../registry-store.js';
import { bundledRegistry } from '../registry.js';
import { AdminStore } from './store.js';
import { adoption } from './adoption.js';
const day = 86400000;
const now = Date.UTC(2026,10,23,12);
const midnight = now-day/2;

it('counts reporting installations in UTC windows and requires a complete observed cohort', async () => {
  const db = createClient({url:'file::memory:'});
  try {
    await new RegistryStore(db).init();
    await new AdminStore(db).init();
    // Data left on an upgraded gateway must never count as Grunt activity.
    await db.executeMultiple("CREATE TABLE account_registrations(account,registered_at); INSERT INTO account_registrations VALUES('legacy',0)");
    const series = [{route:'kilo',release:'unknown',starts:1,passed:1,failed:0,cancelled:0,timed:0,slow:0,timeout:0,quota:0}];
    const joined = midnight-7*day;
    for (let i=0;i<168;i++) {
      for (const install of ['active','idle','partial']) await saveHour(db,install,{
        hour:joined+i*HOUR,incomplete:install==='partial' && i===1,series:install!=='idle' && (i===0 || i===24)?series:[]
      },now,true);
    }
    await saveHour(db,'older',{hour:midnight-8*day,incomplete:false,series},now,true);
    await saveHour(db,'new',{hour:midnight,incomplete:false,series},now,true);
    // Earlier observations and a replay do not move the calendar cohort or double count it.
    await saveHour(db,'active',{hour:joined-HOUR,incomplete:false,series:[]},now,true);
    await saveHour(db,'active',{hour:joined,incomplete:false,series},now,true);
    await saveHour(db,'no-consent',{hour:midnight,incomplete:false,series},now);
    for (const [period,count] of [['day',1],['week',3],['month',4],['all',4]] as const) {
      const result = await adoption(db,bundledRegistry,period,now);
      expect(result.activeInstallations).toBe(count);
      expect(result.cohort).toMatchObject({joined:2,attempted:1,succeeded:1,retained:1});
      expect(result.tokens).toBeNull();
      if (period === 'day') expect(result.cohort!.observed).toBe(3);
    }
    const expired = await adoption(db,bundledRegistry,'all',now+31*day);
    expect(expired.cohort!.observed).toBe(0);
    expect(expired.activeInstallations).toBe(0);
  } finally { db.close(); }
});

it('reconciles replayed daily reports, archived history, probe samples, measured billing and independent requests on the same route', async () => {
  const db = createClient({url:'file::memory:'});
  try {
    let clock = now-20*day;
    const registry = new RegistryStore(db,()=>clock);
    const admin = new AdminStore(db,{now:()=>now});
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
    const result = await adoption(db,bundledRegistry,'all',now);
    expect(result.collectors).toEqual([{instance:"chad",tokens:6,missing:0}]);
    expect(result.tokens).toBe(6);
    const previous = {...events[0]!,id:randomUUID(),requestId:randomUUID(),at:midnight-1};
    await admin.ingest({...batch,instanceId:'second',events:[previous]});
    expect((await adoption(db,bundledRegistry,'day',now)).tokens).toBe(6);
    const week = await adoption(db,bundledRegistry,'week',now);
    expect(week.tokens).toBe(9);
    expect(week.collectors.map(c=>c.tokens)).toEqual([6,3]);
    expect(result.routes[0]).toMatchObject({id:'kilo',attempts:6,ok:3,latency:200,uptime:0.5,probes:2,
      tokens:6,p95:1000,sessionMs:null,free:2,models:['reported']});
    expect(result.routes.find(r=>r.id==='opencode')).toMatchObject({attempts:0,free:null});
    expect(result.routes.find(r=>r.id==='zro')).toMatchObject({attempts:null});
    expect(result.history.reduce((n,b)=>n+(b.counts.kilo ?? 0),0)).toBe(6);
    expect((await adoption(db,bundledRegistry,'day',now)).routes[0]?.attempts).toBe(2);
  } finally { db.close(); }
});
