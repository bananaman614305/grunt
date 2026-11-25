// Render the authenticated aggregate response with Beeline's confirmed backlog IDs.
import { readFile, writeFile } from 'node:fs/promises';
import { planFleetBacklog, renderFleetHandoff, renderFleetReport } from '../dist/fleet-report.js';
const [day, data, items, output, recoveryFile = '-'] = process.argv.slice(2);
if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !output) throw new Error('Usage: fleet-report.mjs YYYY-MM-DD audit.json|- items.json|- report.html|--plan|--handoff [recovery.json]');
const json = async path => path === '-' ? undefined : JSON.parse(await readFile(path,'utf8'));
const audit = await json(data);
if (audit && audit.start !== Date.parse(day+'T00:00:00Z')) throw new Error('Unexpected audit window');
const backlog = await json(items) ?? {};
const recovery = await json(recoveryFile);
if (recovery && new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/New_York' }).format(recovery.since) !== day) {
  throw new Error('Unexpected local recovery window');
}
if (output === '--plan') console.log(JSON.stringify(audit ? planFleetBacklog(audit,backlog) : []));
else if (output === '--handoff') console.log(renderFleetHandoff(audit, recovery));
else await writeFile(output, renderFleetReport(day, audit, backlog, recovery));
