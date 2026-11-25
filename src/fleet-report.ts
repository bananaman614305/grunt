import type { fleetAudit } from './fleet.js';
import type { RecoveryAudit } from './recovery-audit.js';

type Audit = Awaited<ReturnType<typeof fleetAudit>>;
const escape = (v: unknown) => String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const utc = (ms: number) => new Date(ms).toISOString().slice(0,10);
const seconds = (ms: number | null) => ms === null ? 'unknown' : (ms / 1000).toFixed(2) + ' s';
const windowFormatter = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York',
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
const recoveryHeadline = (a: RecoveryAudit) => `${seconds(a.failedMs)} in failed attempts before successful answers`;
const recoveryCoverage = (a: RecoveryAudit) => `${a.recovered} recovered of ${a.passed} observed successful provider requests. Classified traces (${a.classified}), still open at day end (${a.unfinished}), cancelled (${a.cancelled}), marked incomplete (${a.truncated}). Local diagnostics from one installation, ${windowFormatter.format(a.since)} to ${windowFormatter.format(a.until)}. ${a.countsMatch ? 'Request and attempt finish counts match local metrics.' : 'Event coverage is partial or unverified.'}`;
const traceSummary = (row: RecoveryAudit['slowest'][number]) => `${seconds(row.failedMs)} before recovery in ${seconds(row.elapsedMs)} elapsed. ${row.attempts.map(a => `${a.source} ${a.outcome}${a.failure ? ' (' + a.failure + ')' : ''} ${seconds(a.durationMs)}`).join(' → ')}.`;
function failureTiming(attempt: RecoveryAudit['slowest'][number]['attempts'][number]) {
  if (attempt.outcome !== 'failed') return '';
  const replay = attempt.replayBlockedMs !== null ? 'Replay blocked at ' + seconds(attempt.replayBlockedMs)
    : attempt.replaySafeMs !== null ? 'Known safe to replay at ' + seconds(attempt.replaySafeMs) : 'Replay safety unknown';
  return ` Failure observed by ${seconds(attempt.failureObservedMs)}. ${replay}.`;
}
function beatSummary(beat: RecoveryAudit['beatapi']) {
  const { comparison } = beat;
  const rates = comparison
    ? `Matched ordinary denial rates per denied account-hour. Before ${comparison.before.checksPerDeniedAccountHour.toFixed(2)} (${comparison.before.denied}/${comparison.before.deniedAccountHours} hours). After ${comparison.after.checksPerDeniedAccountHour.toFixed(2)} (${comparison.after.denied}/${comparison.after.deniedAccountHours} hours).`
    : 'Matched denied account-hours are unknown.';
  return `BeatAPI observed account checks (${beat.checks}), ordinary HTTP 403 denials (${beat.ordinaryDenied}), HTTP 403 denials from other paths (${beat.otherDenied}), validated availability observations (${beat.verifiedAvailable}). ${rates} Restored-access rediscovery delay ${seconds(beat.rediscoveryMs)}.`;
}

export function renderFleetHandoff(audit?: Audit, recovery?: RecoveryAudit) {
  const lines = recovery ? [recoveryHeadline(recovery), recoveryCoverage(recovery),
    ...recovery.slowest.map(trace => '- ' + traceSummary(trace)), beatSummary(recovery.beatapi)] : ['Failed-attempt time before successful answers is unavailable for this run.'];
  if (!audit) lines.push('Fleet aggregates unavailable.');
  else if (!audit.defaultHandle) lines.push('No fleet cohort met the threshold for new work.');
  else lines.push(...audit.findings.map(f => `- ${f.route} (${f.affected}/${f.denominator}). ${f.fix}`), `Reply go to start ${audit.defaultHandle}.`);
  return lines.join('\n');
}

function renderRecoveryEvidence(a: RecoveryAudit) {
  return `<section><h2>${escape(recoveryHeadline(a))}</h2><p>${escape(recoveryCoverage(a))}</p>
    <p>Observed runtimes · ${escape(a.versions.join(', ') || 'unknown')}. Overlapping failed attempts count once within a request. Time after accepted output is excluded. Older runtimes may omit incomplete-output markers.</p>
    ${a.slowest.length ? '<h3>Slowest recovered requests by failed-attempt time</h3>' : ''}
    ${a.slowest.map(row => `<article><h3>${escape(traceSummary(row))}</h3>
      <p><code>${escape(row.requestId)}</code> · ${escape(row.runtimeVersion ?? 'unknown runtime')}</p>
      <p>First usable output ${seconds(row.firstUsableMs)}. Successful attempt accepted at ${seconds(row.acceptedMs)} from request start.</p>
      <ul>${row.attempts.map(attempt => `<li><strong>${escape(attempt.source)}</strong> observed eligible at ${seconds(attempt.firstEligibleMs)}, dispatched at ${seconds(attempt.startedMs)}, finished at ${seconds(attempt.endedMs)}.${failureTiming(attempt)}</li>`).join('')}</ul></article>`).join('')}
    <h3>BeatAPI account checks</h3><p>${escape(beatSummary(a.beatapi))}</p></section>`;
}

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

export function renderFleetReport(day: string, audit?: Audit, backlog: Record<string,string> = {}, recovery?: RecoveryAudit) {
  const body: string[] = [recovery ? renderRecoveryEvidence(recovery) : '<section><h2>Failed-attempt time before successful answers</h2><p>Local request traces are unavailable for this run.</p></section>'];
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
          <p>Release ${escape(f.release)}. ${f.affected} of ${f.denominator} observed today, compared with ${f.baselineAffected} of ${f.baselineDenominator} during the preceding week. Using today’s installation shares for both windows, the rate moved from ${(100*f.standardizedBaselineRate).toFixed(1)}% to ${(100*f.rate).toFixed(1)}%.</p>
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
  </style><main><header><h1>Grunt daily audit</h1><p>${escape(day)} · fleet window in UTC</p></header>${body.join('')}</main></html>`;
}
