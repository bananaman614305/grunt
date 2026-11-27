import { createClient } from '@libsql/client';
import { expect, it } from 'vitest';
import { RegistryStore } from './registry-store.js';
import { DAY, fleetAudit, HOUR } from './fleet.js';

it('keeps a shift toward a busier high-failure installation out of the backlog', async () => {
  const end = Date.UTC(2026, 10, 24);
  const db = createClient({url:'file::memory:'});
  try {
    await new RegistryStore(db).init();
    for (const installation of ['higher','lower']) {
      const higher = installation === 'higher';
      for (let hour=0; hour<72; hour++) {
        const current = hour >= 48;
        const scale = current === higher ? 10 : 1;
        const failed = (higher ? 50 : 2)*scale;
        const passed = 100*scale - failed;
        const row = { release:'1.2.3',route:'kilo',starts:100*scale,passed,failed,timed:passed,
          slow:(higher ? 30 : 1)*scale,quota:0,timeout:failed,cancelled:0 };
        await db.execute({sql:'INSERT INTO fleet_hours(hour,installation,incomplete,series) VALUES(?,?,0,?)',
          args:[end-3*DAY+hour*HOUR,installation,JSON.stringify([row])]});
      }
    }
    const audit = await fleetAudit(db,end);
    const [prior, today] = audit.cohorts;
    expect(Number(today!.failed)/Number(today!.starts)).toBeGreaterThan(2*Number(prior!.failed)/Number(prior!.starts));
    expect(Number(today!.slow)/Number(today!.timed)).toBeGreaterThan(2*Number(prior!.slow)/Number(prior!.timed));
    expect(Number(today!.expectedFailed)).toBeCloseTo(Number(today!.failed));
    expect(Number(today!.expectedSlow)).toBeCloseTo(Number(today!.slow));
    expect(audit.findings).toEqual([]);
  } finally { db.close(); }
});
