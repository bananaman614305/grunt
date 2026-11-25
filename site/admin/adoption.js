'use strict';
const api = document.querySelector('[name="grunt-admin-api"]').content;
const statusBox = document.querySelector('#status');
const report = document.querySelector('#report');
const controls = document.querySelector('#controls');
const fmt = value => value == null ? 'Unreported' : value.toLocaleString('en-US');
const date = value => new Date(value).toISOString().slice(0, 10);
const escapeText = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);
const palette = ['#5ad1e6','#a78bfa','#f4b41a','#ed9465','#6cc591','#ebe0c9','#dc7bb1'];
function bars(rows, denominator) {
  return rows.map(([label, n]) => `<div class="bar"><span>${escapeText(label)}</span><b data-bar="${100*n/(denominator || 1)}"></b><strong>${fmt(n)}</strong></div>`).join('');
}
function dimensions(accounts, key) {
  const tally = new Map();
  for (const row of accounts) tally.set(row[key], (tally.get(row[key]) || 0)+1);
  return bars([...tally].sort((a,b) => b[1]-a[1]), accounts.length) || '<small>No active accounts</small>';
}
function table(columns, rows) {
  return '<table><thead><tr>'+columns.map(x => '<th scope="col">'+escapeText(x)+'</th>').join('')+'</tr></thead><tbody>'+
    rows.map(row => '<tr>'+row.map(x => '<td>'+escapeText(x)+'</td>').join('')+'</tr>').join('')+'</tbody></table>';
}
function historyChart(history, routes) {
  const ids = routes.filter(r => r.attempts > 0).map(r => r.id).sort();
  const color = id => palette[ids.indexOf(id)%palette.length];
  const buckets = history.map(({bucket,counts}) => ({bucket,counts,total:Object.values(counts).reduce((n,x)=>n+x,0)}));
  const max = Math.max(1,...buckets.map(row => row.total));
  return buckets.map(({bucket,counts,total}) => `<div class="bucket"><small>${escapeText(bucket)}</small><div class="track">${Object.entries(counts).filter(([,n]) => n>0).map(([id,n]) =>
    `<i title="${escapeText(id)} · ${fmt(n)}" data-color="${color(id)}" data-width="${100*n/max}"></i>`).join('')}</div><b>${fmt(total)}</b></div>`).join('')+
    '<div class="legend">'+ids.map(id => `<span><i data-color="${color(id)}"></i>${escapeText(id)}</span>`).join('')+'</div>'+
    '<details><summary>Exact counts by period and route</summary><div class="scroll">'+table(['UTC period','Route','Attempts'],
      buckets.flatMap(b => Object.entries(b.counts).map(([id,n]) => [b.bucket,id,fmt(n)])))+'</div></details>';
}
function render(data) {
  const {accounts, routes, cohort, history} = data;
  const attempts = routes.reduce((n,r) => n+(r.attempts ?? 0),0);
  const columns = ['Route','Attempts','Served / rate','Tokens²','Avg session','P95 latency²','Probe uptime²','Free served²','Expiry','Models served²','Registry models','Reported latency¹'];
  const rows = routes.map(r => [r.id, fmt(r.attempts),
    r.ok == null ? 'Unreported' : fmt(r.ok)+(r.attempts ? ' / '+Math.round(100*r.ok/r.attempts)+'%' : ''),
    fmt(r.tokens),r.sessionMs == null ? 'Unreported' : fmt(r.sessionMs/1000)+' s',
    r.p95 == null ? 'Unreported' : fmt(Math.round(r.p95))+' ms',
    r.uptime == null ? 'Unreported' : (r.uptime*100).toFixed(1)+'% ('+fmt(r.probes)+')',
    fmt(r.free),r.expiry ?? 'Unreported',r.models.join(', ') || 'Unreported',r.configured.join(', ') || 'Unreported',
    r.latency == null ? 'Unreported' : fmt(r.latency)+' ms']);
  const mobile = rows.map(row => {
    const stats = [3,5,6].map(i => `<div><small>${escapeText(columns[i])}</small>${escapeText(row[i])}</div>`).join('');
    const detail = [1,4,7,8,9,10,11].map(i => `<div><dt>${escapeText(columns[i])}</dt><dd>${escapeText(row[i])}</dd></div>`).join('');
    return `<article><div class="routehead"><strong>${escapeText(row[0])}</strong><span>${escapeText(row[2])} served</span></div>
      <div class="stats">${stats}</div><details><summary>Route details</summary><dl>${detail}</dl></details></article>`;
  }).join('');
  return `<h1>User adoption</h1><p>${data.start ? date(data.start) : 'All recorded history'} – ${date(data.now)} UTC · Hosted gateway accounts with a recorded run attempt. One account per gateway key.</p>
    <div class="cards"><div>Active users<b>${fmt(accounts.length)}</b></div><div>Global metered tokens<b>${fmt(data.tokens)}</b></div></div>
    <small>${fmt(accounts.reduce((n,a) => n+a.missing,0))} attempts lack complete token measurements.</small>
    <details><summary>Tokens by user · ${fmt(accounts.length)} active accounts</summary><div class="scroll">${table(['Account','Metered tokens','Unmetered attempts'],accounts.map(a => ['Account '+a.account.slice(0,16),fmt(a.tokens),fmt(a.missing)]))}</div></details>
    <h3>First use to retention</h3>${bars([['First gateway use',cohort.joined],['Attempted a route',cohort.attempted],['First success',cohort.succeeded],['Returned later',cohort.retained]],cohort.joined)}
    <small>Hosted accounts begin at their first message. Each cohort has seven full days to attempt a run, succeed, and succeed again on a later UTC day. Historical calls before account metering lack attribution.</small>
    <div class="pair"><div><h3>Country</h3>${dimensions(accounts,'country')}</div><div><h3>Device type</h3>${dimensions(accounts,'device')}</div></div>
    <h3>Usage by route</h3>${bars(routes.filter(r => r.attempts>0).map(r => [r.id,r.attempts]),attempts)}
    <small>Anonymous router reports · ${fmt(attempts)} reported attempts, including retries. Cancellations are excluded.</small>
    <h2 id="registry">Registry</h2><p>${fmt(routes.reduce((n,r)=>n+(r.ok ?? 0),0))} successfully served · Registry published ${date(data.published)} UTC</p>
    <h3>Attempts by route over time</h3><div class="history">${history.length ? historyChart(history,routes) : '<small>No reports for this period.</small>'}</div>
    <h3>Routes by attempts</h3><div class="wide" tabindex="0">${table(columns,rows)}</div><div class="mobile">${mobile}</div>
    <p>¹ Mean of reporting routers’ daily smoothed success latencies. ² Tokens, successful reply latency, probe pass rate, free replies and served models cover retained enrolled-collector observations. Session duration is unreported because the collector observes individual attempts only. Free usage counts observed replies with confirmed zero billing. All time includes available history.</p>`;
}
let version = 0;
async function load() {
  const current = ++version;
  report.setAttribute('aria-busy','true');
  try {
    const period = document.querySelector('[name=period]:checked').value;
    const response = await fetch(api+'/api/adoption?period='+period,{credentials:'include',cache:'no-store'});
    if (current !== version) return;
    if (response.status === 401 || response.status === 403) {
      controls.hidden = true;
      report.replaceChildren();
      const login = document.createElement('a');
      login.href = api+'/auth/google?view=adoption';
      login.textContent = 'Sign in with an owner Google account';
      statusBox.replaceChildren(login);
      return;
    }
    if (!response.ok) throw new Error();
    const data = await response.json();
    if (current !== version) return;
    report.innerHTML = render(data);
    for (const bar of report.querySelectorAll('[data-bar]')) bar.style.setProperty('--w',bar.dataset.bar+'%');
    for (const segment of report.querySelectorAll('[data-color]')) {
      segment.style.backgroundColor = segment.dataset.color;
      if (segment.dataset.width) segment.style.width = segment.dataset.width+'%';
    }
    controls.hidden = false;
    statusBox.replaceChildren();
  } catch {
    if (current !== version) return;
    report.replaceChildren();
    const retry = document.createElement('button');
    retry.textContent = 'Retry';
    retry.onclick = load;
    statusBox.replaceChildren('Measurements are unavailable. ',retry);
  } finally { if (current === version) report.removeAttribute('aria-busy'); }
}
controls.addEventListener('change',load);
load();
