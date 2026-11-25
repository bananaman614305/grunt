import type { fleetAudit } from './fleet.js';

type Audit = Awaited<ReturnType<typeof fleetAudit>>;
const escape = (v: unknown) => String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const utc = (ms: number) => new Date(ms).toISOString().slice(0,10);

// A single backlog task can carry evidence from several affected releases.
export function planFleetBacklog(audit: Audit, backlog: Record<string,string>) {
  const handles = [...new Set(audit.findings.map(finding => finding.handle))];
  return handles.map(handle => ({
    handle,
    workId: backlog[handle] ?? null,
    title: '[' + handle + '] ' + audit.findings.find(f => f.handle === handle)!.fix,
    evidence: audit.findings.filter(f => f.handle === handle)
  }));
}

export function renderFleetReport(day: string, audit?: Audit, backlog: Record<string,string> = {}) {
  const body: string[] = [];
  if (audit) {
    const coverage = audit.coverage;
    body.push(`<section><h2>Participation</h2><p><strong>${escape(coverage?.installs ?? 0)}</strong> reporting installations · ${escape(coverage?.hours ?? 0)} installation-hours · ${escape(coverage?.partial ?? 0)} flagged partial hours</p>
    <p>Total installed fleet and outcomes of unfinished attempts are unknown. Rates use observed terminal attempts.</p></section>`);
    if (audit.findings.length) {
      body.push('<section><h2>Recommended work</h2>');
      for (const f of audit.findings) {
        const item = backlog[f.handle];
        if (!item) throw new Error('Missing backlog item for '+f.handle);
        body.push(`<article><h3>${escape(f.route)} · ${f.kind === 'failed' ? 'Failure rate increased' : 'More successful calls exceeded ten seconds'}</h3>
          <p>Release ${escape(f.release)}. ${f.affected} of ${f.denominator} observed today, compared with ${f.baselineAffected} of ${f.baselineDenominator} during the preceding week.</p>
          <p>${escape(f.fix)} ${escape(f.verification)}</p><p>Confidence · ${escape(f.confidence)}</p>
          <p>Backlog <code>${escape(item)}</code> · <code>go ${escape(f.handle)}</code></p></article>`);
      }
      body.push(`<p>Reply <code>go</code> to start <strong>${escape(audit.defaultHandle)}</strong>.</p></section>`);
    } else {
      body.push('<section><h2>Findings</h2><p>'+ (Number(coverage?.hours) ? 'No cohort met the evidence threshold for new work.' : 'No reporting hours were received for this window.') +'</p></section>');
    }
    const cohorts = audit.cohorts.filter(r => r.current === 1);
    if (cohorts.length) body.push('<section><h2>Observed routes</h2>'+cohorts.map(r =>
      `<article><h3>${escape(r.route)} · ${escape(r.release)}</h3><p>${r.starts} starts · ${r.passed} successes · ${r.failed} failures · ${r.cancelled} cancelled</p><p>${r.slow} of ${r.timed} timed successes exceeded ten seconds.</p></article>`).join('')+'</section>');
    body.push(`<footer>Source · Grunt gateway fleet aggregates. Baseline begins ${utc(audit.baselineStart)} UTC.</footer>`);
  } else {
    body.push('<section><h2>Coverage unavailable</h2><p>The audit could not read authenticated fleet aggregates for this window. Reporting installations, outcomes and regressions are unknown.</p><p>Verify the gateway release and the scheduled job’s read access before assigning a fix.</p></section>');
  }
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Grunt daily audit · ${escape(day)}</title><style>
  *{box-sizing:border-box}body{background:#171819;color:#ededeb;font:1rem/1.55 system-ui,sans-serif;margin:0}
  main{max-width:52rem;margin:auto;padding:clamp(1rem,5vw,3rem)}header{border-bottom:2px solid #d7af5f;padding-bottom:1rem}
  h1,h2,h3,p{margin:.5rem 0}h1{font-size:clamp(2rem,6vw,3.5rem)}h2{font-size:1.45rem}section{margin:1.75rem 0}
  article{background:#242526;border:1px solid #444;border-radius:3px;padding:1rem;margin:.75rem 0}
  strong,code{color:#ead29d}code{overflow-wrap:anywhere}footer{border-top:1px solid #555;padding-top:1rem;color:#ccc}
  </style><main><header><h1>Grunt daily audit</h1><p>${escape(day)} · complete UTC day</p></header>${body.join('')}</main></html>`;
}
