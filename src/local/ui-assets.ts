import type { UiSnapshot } from './ui-data.js';

export const GRUNT_LOGO_SVG = `<svg class="brand-svg" viewBox="0 0 30 8" shape-rendering="crispEdges" aria-label="grunt"><g fill="#7a4f06"><rect x="2" y="1" width="4" height="1"/><rect x="1" y="2" width="1" height="5"/><rect x="4" y="4" width="2" height="1"/><rect x="5" y="5" width="1" height="2"/><rect x="2" y="7" width="3" height="1"/><rect x="7" y="1" width="4" height="1"/><rect x="7" y="2" width="1" height="6"/><rect x="11" y="2" width="1" height="2"/><rect x="8" y="4" width="3" height="1"/><rect x="9" y="5" width="1" height="1"/><rect x="10" y="6" width="1" height="1"/><rect x="11" y="7" width="1" height="1"/><rect x="13" y="1" width="1" height="6"/><rect x="17" y="1" width="1" height="6"/><rect x="14" y="7" width="3" height="1"/><rect x="19" y="1" width="1" height="7"/><rect x="23" y="1" width="1" height="7"/><rect x="20" y="2" width="1" height="1"/><rect x="21" y="3" width="1" height="1"/><rect x="22" y="4" width="1" height="1"/><rect x="25" y="1" width="5" height="1"/><rect x="27" y="2" width="1" height="6"/></g><g fill="#f2b531"><rect x="1" y="0" width="4" height="1"/><rect x="0" y="1" width="1" height="5"/><rect x="3" y="3" width="2" height="1"/><rect x="4" y="4" width="1" height="2"/><rect x="1" y="6" width="3" height="1"/><rect x="6" y="0" width="4" height="1"/><rect x="6" y="1" width="1" height="6"/><rect x="10" y="1" width="1" height="2"/><rect x="7" y="3" width="3" height="1"/><rect x="8" y="4" width="1" height="1"/><rect x="9" y="5" width="1" height="1"/><rect x="10" y="6" width="1" height="1"/><rect x="12" y="0" width="1" height="6"/><rect x="16" y="0" width="1" height="6"/><rect x="13" y="6" width="3" height="1"/><rect x="18" y="0" width="1" height="7"/><rect x="22" y="0" width="1" height="7"/><rect x="19" y="1" width="1" height="1"/><rect x="20" y="2" width="1" height="1"/><rect x="21" y="3" width="1" height="1"/><rect x="24" y="0" width="5" height="1"/><rect x="26" y="1" width="1" height="6"/></g></svg>`;

export const UI_CSS = `:root {
  --bg: #0d121c;
  --panel: #141b28;
  --raised: #1a2332;
  --fg: #ede6d8;
  --secondary: #a3adbd;
  --divider: #303b4d;
  --accent: #f2b531;
  --accent-fg: #1a1406;
  --success: #80d6ad;
  --warning: #f2c66d;
  --failure: #f29e9e;
  --activity: #8ac9e8;
  --success-tint: rgba(128, 214, 173, 0.12);
  --warning-tint: rgba(242, 198, 109, 0.13);
  --failure-tint: rgba(242, 158, 158, 0.13);
  --activity-tint: rgba(138, 201, 232, 0.13);
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  --radius: 4px;
  --nav-w: 224px;
  --touch: 44px;
}
* { box-sizing: border-box; }
html, body {
  margin: 0;
  padding: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: var(--sans);
  font-size: 14px;
  line-height: 1.45;
  -webkit-font-smoothing: antialiased;
}
button {
  font-family: var(--sans);
  font-size: inherit;
  color: inherit;
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
  text-align: left;
}
a.ctrl-btn { text-decoration: none; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition: none !important; animation: none !important; scroll-behavior: auto !important; }
}
.mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.app { display: flex; min-height: 100vh; }
.sidebar {
  width: var(--nav-w);
  flex-shrink: 0;
  background: var(--panel);
  border-right: 1px solid var(--divider);
  display: flex;
  flex-direction: column;
  position: sticky;
  top: 0;
  height: 100vh;
}
.brand-head {
  padding: 16px 16px 14px;
  border-bottom: 1px solid var(--divider);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.brand-lockup { display: flex; align-items: center; gap: 10px; }
.brand-svg { width: 68px; height: 18px; display: block; image-rendering: pixelated; }
.brand-ver {
  font-size: 11px;
  color: var(--secondary);
  padding: 2px 6px;
  border: 1px solid var(--divider);
  border-radius: 3px;
  background: var(--bg);
}
.nav-list { padding: 10px 8px; display: flex; flex-direction: column; gap: 2px; flex: 1; overflow-y: auto; }
.nav-item {
  min-height: var(--touch);
  padding: 0 12px;
  border-radius: var(--radius);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 14px;
  font-weight: 500;
  color: var(--secondary);
  border-left: 3px solid transparent;
  transition: background-color 0.12s ease, color 0.12s ease;
}
.nav-item:hover { background: var(--raised); color: var(--fg); }
.nav-item.active { background: var(--raised); color: var(--fg); border-left-color: var(--accent); font-weight: 600; }
.nav-count { font-size: 12px; color: var(--secondary); padding: 1px 6px; border-radius: 3px; background: var(--bg); }
.nav-item.active .nav-count { background: var(--accent); color: var(--accent-fg); font-weight: 700; }
.sidebar-foot {
  padding: 12px 14px;
  border-top: 1px solid var(--divider);
  font-size: 12px;
  color: var(--secondary);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.sidebar-foot strong { color: var(--fg); font-weight: 600; }
.main-col { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.utility-bar {
  background: var(--bg);
  border-bottom: 1px solid var(--divider);
  padding: 10px 20px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  position: sticky;
  top: 0;
  z-index: 20;
}
.util-left, .util-right { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ctrl-btn {
  min-height: var(--touch);
  padding: 0 12px;
  border-radius: var(--radius);
  border: 1px solid var(--divider);
  background: var(--panel);
  color: var(--fg);
  font-size: 13px;
  font-weight: 500;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  transition: background-color 0.12s ease, border-color 0.12s ease;
}
.ctrl-btn:hover { background: var(--raised); border-color: var(--secondary); }
.instance-pill {
  min-height: var(--touch);
  padding: 0 12px;
  border-radius: var(--radius);
  border: 1px solid var(--divider);
  background: var(--panel);
  color: var(--fg);
  font-size: 13px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.freshness { min-height: var(--touch); padding: 0 8px; display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: var(--secondary); }
.dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; display: inline-block; }
.dot.success { background: var(--success); }
.dot.activity { background: var(--activity); }
.dot.warning { background: var(--warning); }
.dot.failure { background: var(--failure); }
.dot.neutral { background: var(--secondary); }
.seg { display: inline-flex; background: var(--panel); border: 1px solid var(--divider); border-radius: var(--radius); }
.seg-btn {
  min-height: calc(var(--touch) - 2px);
  min-width: var(--touch);
  padding: 0 10px;
  font-size: 13px;
  font-weight: 500;
  color: var(--secondary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-right: 1px solid var(--divider);
  transition: background-color 0.12s ease, color 0.12s ease;
}
.seg-btn:last-child { border-right: none; }
.seg-btn:hover { background: var(--raised); color: var(--fg); }
.seg-btn.active { background: var(--raised); color: var(--accent); font-weight: 700; }
.workspace { display: flex; flex: 1; min-height: 0; }
.content { flex: 1; min-width: 0; padding: 18px 20px 44px; }
.alert-band {
  padding: 12px 16px;
  border-radius: var(--radius);
  border: 1px solid var(--divider);
  border-left-width: 4px;
  margin-bottom: 18px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.alert-band.failure { background: var(--failure-tint); border-left-color: var(--failure); }
.alert-band.warning { background: var(--warning-tint); border-left-color: var(--warning); }
.alert-band.activity { background: var(--activity-tint); border-left-color: var(--activity); }
.alert-title { font-weight: 700; font-size: 14px; color: var(--fg); margin-bottom: 2px; }
.alert-sub { font-size: 13px; color: var(--secondary); }
.cmd-pill {
  padding: 6px 10px;
  border-radius: var(--radius);
  background: var(--bg);
  border: 1px solid var(--divider);
  color: var(--accent);
  font-size: 12px;
  display: inline-block;
}
.summary-strip {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  border-top: 1px solid var(--divider);
  border-bottom: 1px solid var(--divider);
  margin-bottom: 22px;
}
.summary-cell { padding: 14px 16px 14px 0; border-right: 1px solid var(--divider); }
.summary-cell:not(:first-child) { padding-left: 16px; }
.summary-cell:last-child { border-right: none; padding-right: 0; }
.summary-k { font-size: 12px; font-weight: 600; color: var(--secondary); display: flex; justify-content: space-between; align-items: center; gap: 6px; margin-bottom: 6px; }
.summary-v { font-size: 21px; font-weight: 700; color: var(--fg); line-height: 1.2; display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.summary-sub { font-size: 12px; color: var(--secondary); }
.stack-bar { height: 6px; border-radius: 2px; background: var(--raised); overflow: hidden; margin: 7px 0 6px; }
.bar-svg { display: block; width: 100%; height: 100%; }
.fill-in { fill: var(--activity); }
.fill-out { fill: var(--success); }
.fill-rsn { fill: var(--accent); }
.fill-ok { fill: var(--success); }
.fill-low { fill: var(--warning); }
.fill-empty { fill: var(--failure); }
.fill-est-bg { fill: rgba(242, 198, 109, 0.35); }
.fill-est-stripe { fill: var(--warning); }
.seg-in { background: var(--activity); }
.seg-out { background: var(--success); }
.seg-rsn { background: var(--accent); }
.text-warn { color: var(--warning); }
.text-fail { color: var(--failure); }
.text-ok { color: var(--success); }
.text-fg { color: var(--fg); }
.text-sec { color: var(--secondary); }
.fw-600 { font-weight: 600; }
.fw-700 { font-weight: 700; }
.w-full { width: 100%; }
.section { padding-bottom: 22px; margin-bottom: 22px; border-bottom: 1px solid var(--divider); }
.section:last-child { border-bottom: none; margin-bottom: 0; }
.sec-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 12px; }
.sec-title { font-size: 15px; font-weight: 700; color: var(--fg); margin: 0; }
.sec-sub { font-size: 13px; color: var(--secondary); }
.chart-panel { background: var(--panel); border: 1px solid var(--divider); border-radius: var(--radius); padding: 14px 16px; }
.chart-bars { display: flex; align-items: flex-end; gap: 4px; height: 108px; padding-top: 6px; border-bottom: 1px solid var(--divider); }
.bar-btn { flex: 1; height: 100%; min-width: 10px; display: flex; flex-direction: column; justify-content: flex-end; padding: 0 2px; border-radius: 2px; transition: background-color 0.1s ease; }
.bar-btn:hover, .bar-btn.selected { background: var(--raised); }
.bar-col-stack { width: 100%; display: flex; flex-direction: column-reverse; border-radius: 2px 2px 0 0; overflow: hidden; }
.chart-axis { display: flex; justify-content: space-between; font-size: 11px; color: var(--secondary); margin-top: 6px; }
.chart-foot { margin-top: 10px; display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 10px; font-size: 12px; color: var(--secondary); }
.legend { display: flex; flex-wrap: wrap; gap: 14px; }
.leg-item { display: inline-flex; align-items: center; gap: 6px; }
.swatch { width: 9px; height: 9px; border-radius: 2px; display: inline-block; }
.filter-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
.filter-group { display: flex; flex-wrap: wrap; gap: 6px; }
.filter-btn {
  min-height: var(--touch);
  padding: 0 12px;
  border-radius: var(--radius);
  border: 1px solid var(--divider);
  background: var(--panel);
  color: var(--secondary);
  font-size: 13px;
  font-weight: 500;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  transition: background-color 0.12s ease, color 0.12s ease, border-color 0.12s ease;
}
.filter-btn:hover { background: var(--raised); color: var(--fg); }
.filter-btn.active { background: var(--raised); color: var(--fg); border-color: var(--accent); font-weight: 600; }
.table-scroll { overflow-x: auto; border-top: 1px solid var(--divider); border-bottom: 1px solid var(--divider); }
table { width: 100%; border-collapse: collapse; min-width: 680px; }
th { text-align: left; font-size: 12px; font-weight: 600; color: var(--secondary); padding: 10px; border-bottom: 1px solid var(--divider); background: var(--panel); white-space: nowrap; }
td { padding: 10px; border-bottom: 1px solid var(--divider); vertical-align: middle; }
tbody tr { min-height: 54px; cursor: pointer; transition: background-color 0.1s ease; }
tbody tr:last-child td { border-bottom: none; }
tbody tr:hover { background: var(--raised); }
tbody tr.selected { background: var(--raised); box-shadow: inset 3px 0 0 var(--accent); }
.name-main { font-weight: 600; color: var(--fg); display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.sub-line { font-size: 12px; color: var(--secondary); margin-top: 2px; }
.cap-tag { font-size: 11px; padding: 1px 5px; border-radius: 3px; border: 1px solid var(--divider); background: var(--bg); color: var(--secondary); font-weight: 500; }
.state-pill { display: inline-flex; align-items: center; gap: 6px; padding: 3px 8px; border-radius: 3px; font-size: 12px; font-weight: 600; white-space: nowrap; }
.state-pill.success { background: var(--success-tint); color: var(--success); }
.state-pill.activity { background: var(--activity-tint); color: var(--activity); }
.state-pill.warning { background: var(--warning-tint); color: var(--warning); }
.state-pill.failure { background: var(--failure-tint); color: var(--failure); }
.state-pill.neutral { background: var(--panel); color: var(--secondary); border: 1px solid var(--divider); }
.quota-col { min-width: 185px; }
.quota-row { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; font-size: 12px; }
.tier-lbl { font-size: 11px; font-weight: 600; white-space: nowrap; }
.tier-lbl.verified { color: var(--success); }
.tier-lbl.estimate { color: var(--warning); }
.tier-lbl.unknown { color: var(--secondary); }
.meter-track { height: 6px; border-radius: 2px; background: var(--bg); border: 1px solid var(--divider); overflow: hidden; margin-top: 5px; }
.meter-bar { height: 100%; }
.meter-bar.verified-ok { background: var(--success); }
.meter-bar.verified-low { background: var(--warning); }
.meter-bar.verified-empty { background: var(--failure); }
.meter-bar.estimate-striped {
  background: repeating-linear-gradient(-45deg, var(--warning), var(--warning) 5px, rgba(242, 198, 109, 0.35) 5px, rgba(242, 198, 109, 0.35) 10px);
}
.detail-panel {
  width: 360px;
  flex-shrink: 0;
  background: var(--panel);
  border-left: 1px solid var(--divider);
  padding: 16px 18px 28px;
  overflow-y: auto;
  position: sticky;
  top: 65px;
  max-height: calc(100vh - 65px);
}
.detail-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; padding-bottom: 12px; border-bottom: 1px solid var(--divider); margin-bottom: 12px; }
.detail-title { font-size: 16px; font-weight: 700; color: var(--fg); }
.close-btn {
  min-width: var(--touch);
  min-height: var(--touch);
  border-radius: var(--radius);
  border: 1px solid var(--divider);
  background: var(--bg);
  color: var(--fg);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  font-weight: 600;
  flex-shrink: 0;
}
.close-btn:hover { background: var(--raised); border-color: var(--accent); }
.detail-sec { padding: 11px 0; border-bottom: 1px solid var(--divider); }
.detail-sec:last-child { border-bottom: none; }
.detail-k { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--secondary); margin-bottom: 8px; }
.kv { display: flex; justify-content: space-between; gap: 10px; font-size: 13px; margin-bottom: 6px; }
.kv:last-child { margin-bottom: 0; }
.kv span:first-child { color: var(--secondary); }
.kv span:last-child { color: var(--fg); text-align: right; }
.note-box { background: var(--bg); border: 1px solid var(--divider); border-radius: var(--radius); padding: 10px 12px; font-size: 13px; color: var(--fg); margin-top: 8px; }
.timeline-step { padding: 8px 0 8px 14px; border-left: 2px solid var(--divider); margin-left: 4px; position: relative; }
.timeline-step::before { content: ""; position: absolute; left: -5px; top: 13px; width: 8px; height: 8px; border-radius: 50%; background: var(--secondary); }
.timeline-step.ok::before { background: var(--success); }
.timeline-step.warn::before { background: var(--warning); }
.timeline-step.err::before { background: var(--failure); }
.state-box { background: var(--panel); border: 1px solid var(--divider); border-radius: var(--radius); padding: 24px 20px; margin-bottom: 18px; }
.state-box h2 { margin: 0 0 6px; font-size: 16px; color: var(--fg); }
.state-box p { margin: 0 0 12px; color: var(--secondary); max-width: 620px; }
.empty-cell { text-align: center; padding: 24px 12px; color: var(--secondary); }
.readout-text { font-size: 13px; color: var(--fg); }
.hidden { display: none !important; }
@media (max-width: 1080px) {
  .summary-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .summary-cell:nth-child(2) { border-right: none; padding-right: 0; }
  .summary-cell:nth-child(3) { padding-left: 0; border-top: 1px solid var(--divider); }
  .summary-cell:nth-child(4) { border-top: 1px solid var(--divider); }
  .detail-panel { width: 320px; }
}
@media (max-width: 860px) {
  .app { flex-direction: column; }
  .sidebar { width: 100%; height: auto; position: static; border-right: none; border-bottom: 1px solid var(--divider); }
  .nav-list { flex-direction: row; overflow-x: auto; padding: 6px 12px; gap: 4px; scrollbar-width: none; }
  .nav-list::-webkit-scrollbar { display: none; }
  .nav-item { border-left: none; border-bottom: 3px solid transparent; white-space: nowrap; flex-shrink: 0; }
  .nav-item.active { border-left-color: transparent; border-bottom-color: var(--accent); }
  .sidebar-foot { display: none; }
  .utility-bar { padding: 10px 12px; position: static; }
  .content { padding: 14px 12px 36px; }
  .detail-panel { display: none; }
  .detail-panel.open-mobile { display: block; position: fixed; inset: 0; width: 100%; max-width: none; max-height: none; top: 0; z-index: 50; border-left: none; padding: 16px 16px 32px; }
}
@media (max-width: 560px) {
  .summary-strip { grid-template-columns: 1fr; }
  .summary-cell, .summary-cell:not(:first-child) { border-right: none; padding: 12px 0; border-top: 1px solid var(--divider); }
  .summary-cell:first-child { border-top: none; }
}
`;

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function renderUiHtml(options: { daemonPort: number; bindHost: string; uiPort: number; version?: string | undefined }): string {
  const ver = escapeHtml(options.version ?? 'local');
  const bindLabel = escapeHtml(`UI ${options.bindHost}:${options.uiPort}`);
  const daemonLabel = escapeHtml(`Daemon 127.0.0.1:${options.daemonPort}`);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>grunt · Local Status &amp; Usage Console</title>
<link rel="stylesheet" href="/app.css">
</head>
<body data-daemon-port="${options.daemonPort}" data-bind-host="${escapeHtml(options.bindHost)}" data-ui-port="${options.uiPort}">
<div class="app">
  <aside class="sidebar" aria-label="Console navigation">
    <div class="brand-head">
      <div class="brand-lockup">
        ${GRUNT_LOGO_SVG}
        <span class="brand-ver mono" id="brandVer">${ver}</span>
      </div>
    </div>
    <nav class="nav-list" id="navList"></nav>
    <div class="sidebar-foot">
      <strong>Local read-only console</strong>
      <span class="mono">${bindLabel}</span>
      <span>No prompts, replies, or API keys stored or served.</span>
    </div>
  </aside>
  <div class="main-col">
    <header class="utility-bar">
      <div class="util-left">
        <div class="instance-pill">
          <span class="dot neutral" id="instDot"></span>
          <span class="mono" id="instLabel">${daemonLabel}</span>
        </div>
        <div class="freshness" id="freshnessBox">
          <span class="dot activity" id="freshDot"></span>
          <span id="freshText">Connecting to local daemon…</span>
        </div>
      </div>
      <div class="util-right">
        <div class="seg" id="windowSeg" role="group" aria-label="Usage time window"></div>
        <button class="ctrl-btn" id="liveToggleBtn" type="button">Pause SSE</button>
        <button class="ctrl-btn" id="refreshBtn" type="button">Refresh</button>
        <a class="ctrl-btn" id="exportLink" href="/api/export?window=24h" download="grunt-status.json">Export JSON</a>
      </div>
    </header>
    <div class="workspace">
      <main class="content" id="mainContent">
        <div class="alert-band hidden" id="alertBand" role="status">
          <div>
            <div class="alert-title" id="alertTitle"></div>
            <div class="alert-sub" id="alertSub"></div>
          </div>
          <div class="cmd-pill mono" id="alertCmd"></div>
        </div>
        <div class="state-box" id="specialStateBox">
          <h2>Loading local Grunt snapshot…</h2>
          <p>Requesting status, observation, and diagnostics from 127.0.0.1:${options.daemonPort}. No totals or charts appear before observed data arrives.</p>
        </div>
        <div id="dataContainer" class="hidden">
          <section class="summary-strip" id="summaryStrip" aria-label="Pool summary">
            <div class="summary-cell">
              <div class="summary-k"><span>Pool state</span><span class="mono" id="sumActive"></span></div>
              <div class="summary-v"><span class="dot neutral" id="sumDot"></span><span id="sumState"></span></div>
              <div class="summary-sub" id="sumStateSub"></div>
            </div>
            <div class="summary-cell">
              <div class="summary-k"><span>Tokens spent</span><span class="mono" id="sumWin"></span></div>
              <div class="summary-v mono" id="sumTok"></div>
              <div class="stack-bar" id="sumTokBar"></div>
              <div class="summary-sub mono" id="sumTokSplit"></div>
            </div>
            <div class="summary-cell">
              <div class="summary-k"><span>Earliest comeback</span><span class="mono" id="sumLimited"></span></div>
              <div class="summary-v mono" id="sumNext"></div>
              <div class="summary-sub" id="sumNextSub"></div>
            </div>
            <div class="summary-cell">
              <div class="summary-k"><span>Requests &amp; latency</span><span class="mono" id="sumFailover"></span></div>
              <div class="summary-v mono" id="sumReq"></div>
              <div class="summary-sub" id="sumReqSub"></div>
            </div>
          </section>
          <section class="section" id="chartSection">
            <div class="sec-head">
              <div>
                <h2 class="sec-title">Tokens spent over time</h2>
                <div class="sec-sub">Hourly diagnostic buckets from local Grunt history</div>
              </div>
              <div class="mono readout-text" id="chartReadout"></div>
            </div>
            <div class="chart-panel" id="chartPanel">
              <div class="chart-bars" id="chartBars"></div>
              <div class="chart-axis mono" id="chartAxis"></div>
              <div class="chart-foot">
                <div class="legend">
                  <span class="leg-item"><span class="swatch seg-in"></span>Input</span>
                  <span class="leg-item"><span class="swatch seg-out"></span>Output</span>
                  <span class="leg-item"><span class="swatch seg-rsn"></span>Reasoning</span>
                </div>
                <span id="unknownTokNote"></span>
              </div>
            </div>
          </section>
          <section class="section" id="providersSection">
            <div class="sec-head">
              <div>
                <h2 class="sec-title">Routes &amp; remaining usage</h2>
                <div class="sec-sub">Provider-reported balances are distinguished from local policy estimates and unreported quotas</div>
              </div>
            </div>
            <div class="filter-row">
              <div class="filter-group" id="filterGroup"></div>
              <span class="sec-sub" id="routeCountLbl"></span>
            </div>
            <div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Route</th>
                    <th>State &amp; cause</th>
                    <th>Remaining usage</th>
                    <th>Tokens spent</th>
                    <th>Comes back</th>
                    <th>Latency</th>
                  </tr>
                </thead>
                <tbody id="routesTbody"></tbody>
              </table>
            </div>
          </section>
          <section class="section" id="requestsSection">
            <div class="sec-head">
              <div>
                <h2 class="sec-title">Live &amp; recent requests</h2>
                <div class="sec-sub">Select any request to inspect its attempt and failover timeline</div>
              </div>
              <span class="sec-sub" id="inFlightCountLbl"></span>
            </div>
            <div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Request</th>
                    <th>State</th>
                    <th>Route trail</th>
                    <th>Tokens</th>
                    <th>Duration</th>
                  </tr>
                </thead>
                <tbody id="requestsTbody"></tbody>
              </table>
            </div>
          </section>
          <section class="section hidden" id="scheduleSection">
            <div class="sec-head">
              <div>
                <h2 class="sec-title">When usage comes back</h2>
                <div class="sec-sub">Chronological countdowns for automatic refills alongside routes requiring manual action</div>
              </div>
            </div>
            <div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Route</th>
                    <th>Status</th>
                    <th>Reset cadence</th>
                    <th>Countdown</th>
                    <th>Reset time (UTC)</th>
                  </tr>
                </thead>
                <tbody id="autoScheduleTbody"></tbody>
              </table>
            </div>
            <div class="sec-head">
              <div>
                <h2 class="sec-title">Manual action required</h2>
                <div class="sec-sub">These routes will not recover automatically on a timer</div>
              </div>
            </div>
            <div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Route</th>
                    <th>Cause</th>
                    <th>Next command</th>
                  </tr>
                </thead>
                <tbody id="manualScheduleTbody"></tbody>
              </table>
            </div>
          </section>
        </div>
      </main>
      <aside class="detail-panel hidden" id="detailPanel" role="region" aria-label="Selection inspector"></aside>
    </div>
  </div>
</div>
<script src="/app.js" defer></script>
</body>
</html>`;
}

export function renderUnauthorizedHtml(bindHost: string, uiPort: number): string {
  const addr = escapeHtml(`${bindHost}:${uiPort}`);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>grunt · Unauthorized Session</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>
<main class="content">
  <div class="state-box">
    <h2>Unauthorized remote UI session</h2>
    <p>This Grunt console on <span class="mono">${addr}</span> requires a valid per-session access token. Open the tokenized URL or scan the QR code printed by <span class="mono">usegrunt ui --bind</span>.</p>
  </div>
</main>
</body>
</html>`;
}

export const UI_CLIENT_JS = `(function () {
  'use strict';

  const WINDOWS = ['1h', '24h', '7d', '30d'];
  const state = {
    nav: 'overview',
    win: '24h',
    filter: 'all',
    live: true,
    loading: true,
    unauthorized: false,
    snapshot: null,
    lastGood: null,
    lastError: null,
    selectedBarIdx: null,
    selection: null,
    panelOpen: false,
    mobileDialogOpen: false,
    source: null
  };

  const SVG_NS = 'http://www.w3.org/2000/svg';
  let stripeSeq = 0;

  function el(tag, attrs, text) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') node.className = v;
        else node.setAttribute(k, v);
      }
    }
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function svgEl(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    }
    return node;
  }

  function buildHorizontalBarSvg(segments, striped) {
    const svg = svgEl('svg', { class: 'bar-svg', viewBox: '0 0 100 6', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    let patId = null;
    if (striped) {
      patId = 'est-pat-' + (++stripeSeq);
      const defs = svgEl('defs');
      const pat = svgEl('pattern', { id: patId, width: 8, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(-45)' });
      pat.appendChild(svgEl('rect', { width: 8, height: 6, class: 'fill-est-bg' }));
      pat.appendChild(svgEl('rect', { width: 4, height: 6, class: 'fill-est-stripe' }));
      defs.appendChild(pat);
      svg.appendChild(defs);
    }
    let x = 0;
    for (const seg of segments) {
      const w = Math.max(0, Math.min(100 - x, seg.pct));
      if (w <= 0) continue;
      const rect = svgEl('rect', { x: x.toFixed(2), y: 0, width: w.toFixed(2), height: 6 });
      if (striped && seg.striped) rect.setAttribute('fill', 'url(#' + patId + ')');
      else rect.setAttribute('class', seg.cls);
      svg.appendChild(rect);
      x += w;
    }
    return svg;
  }

  function buildVerticalStackSvg(totalPct, inRatio, outRatio, rsnRatio) {
    const svg = svgEl('svg', { class: 'bar-svg', viewBox: '0 0 20 100', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    const hTot = Math.max(6, Math.min(100, totalPct));
    const hIn = hTot * inRatio;
    const hOut = hTot * outRatio;
    const hRsn = hTot * rsnRatio;
    let y = 100;
    if (hIn > 0) {
      y -= hIn;
      svg.appendChild(svgEl('rect', { x: 2, y: y.toFixed(2), width: 16, height: hIn.toFixed(2), class: 'fill-in' }));
    }
    if (hOut > 0) {
      y -= hOut;
      svg.appendChild(svgEl('rect', { x: 2, y: y.toFixed(2), width: 16, height: hOut.toFixed(2), class: 'fill-out' }));
    }
    if (hRsn > 0) {
      y -= hRsn;
      svg.appendChild(svgEl('rect', { x: 2, y: y.toFixed(2), width: 16, height: hRsn.toFixed(2), class: 'fill-rsn' }));
    }
    return svg;
  }

  function fmtNum(n) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
    if (n >= 1000000) return (n / 1000000).toFixed(n >= 10000000 ? 1 : 2) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'K';
    return String(Math.round(n));
  }

  function fmtAgeSec(ms) {
    const sec = Math.max(0, Math.floor(ms / 1000));
    if (sec < 60) return sec + 's';
    const m = Math.floor(sec / 60), s = sec % 60;
    if (m < 60) return m + 'm ' + String(s).padStart(2, '0') + 's';
    const h = Math.floor(m / 60), rm = m % 60;
    return h + 'h ' + String(rm).padStart(2, '0') + 'm';
  }

  function fmtCountdown(epochMs, nowMs) {
    if (!epochMs) return '—';
    const rem = Math.max(0, Math.ceil((epochMs - nowMs) / 1000));
    if (rem <= 0) return 'Due now';
    const d = Math.floor(rem / 86400);
    const h = Math.floor((rem % 86400) / 3600);
    const m = Math.floor((rem % 3600) / 60);
    const s = rem % 60;
    const p = x => String(x).padStart(2, '0');
    if (d > 0) return d + 'd ' + h + 'h ' + p(m) + 'm';
    if (h > 0) return h + 'h ' + p(m) + 'm ' + p(s) + 's';
    if (m > 0) return m + 'm ' + p(s) + 's';
    return s + 's';
  }

  function fmtUtc(epochMs) {
    if (!epochMs) return '—';
    return new Date(epochMs).toISOString().slice(11, 16) + ' UTC';
  }

  function poolMeta(poolState) {
    switch (poolState) {
      case 'working': return { tone: 'activity', label: 'Working' };
      case 'idle': return { tone: 'success', label: 'Idle' };
      case 'switching': return { tone: 'warning', label: 'Switching' };
      case 'transient_error': return { tone: 'warning', label: 'Transient error' };
      case 'provider_exhausted': return { tone: 'warning', label: 'Provider exhausted' };
      case 'globally_exhausted': return { tone: 'failure', label: 'Globally exhausted' };
      default: return { tone: 'neutral', label: String(poolState || 'Unknown') };
    }
  }

  function routeMeta(route) {
    switch (route.state) {
      case 'answering': return { tone: 'activity', label: 'Answering' };
      case 'ready': return { tone: 'success', label: 'Ready' };
      case 'available': return { tone: 'success', label: 'Available' };
      case 'connecting': return { tone: 'activity', label: 'Connecting' };
      case 'verifying': return { tone: 'activity', label: 'Verifying' };
      case 'limited': return { tone: 'warning', label: 'Limited' };
      case 'approval': return { tone: 'warning', label: 'Approval needed' };
      case 'error': return { tone: 'failure', label: route.errorCode === 'logged_out' ? 'Auth expired' : 'Error' };
      case 'unavailable': return { tone: 'neutral', label: route.errorCode === 'logged_out' ? 'Auth expired' : 'Unavailable' };
      case 'disabled': return { tone: 'neutral', label: 'Disabled' };
      default: return { tone: 'neutral', label: 'Unknown' };
    }
  }

  function bindRowActivation(tr, fn) {
    tr.setAttribute('tabindex', '0');
    tr.addEventListener('click', fn);
    tr.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); fn(); }
    });
  }

  function activeSnapshot() {
    if (state.snapshot && state.snapshot.daemonReachable) return state.snapshot;
    return state.lastGood;
  }

  function isStale() {
    return Boolean(state.lastGood && state.snapshot && !state.snapshot.daemonReachable);
  }

  function renderNav(snap) {
    const nav = document.getElementById('navList');
    nav.textContent = '';
    const activeRoutes = snap ? snap.routes.filter(r => r.state !== 'disabled').length : 0;
    const schedCount = snap ? snap.routes.filter(r => r.retryAt || r.actionCommand).length : 0;
    const items = [
      { id: 'overview', label: 'Overview', count: null },
      { id: 'providers', label: 'Routes & Quota', count: snap ? activeRoutes : null },
      { id: 'requests', label: 'Requests', count: snap ? snap.activeRequests : null },
      { id: 'schedule', label: 'Reset Schedule', count: snap ? schedCount : null }
    ];
    for (const item of items) {
      const btn = el('button', { class: 'nav-item' + (state.nav === item.id ? ' active' : ''), type: 'button' });
      btn.appendChild(el('span', null, item.label));
      if (item.count !== null) btn.appendChild(el('span', { class: 'nav-count mono' }, item.count));
      btn.addEventListener('click', () => { state.nav = item.id; render(); });
      nav.appendChild(btn);
    }
  }

  function renderUtilityBar() {
    const snap = activeSnapshot();
    const now = Date.now();
    const instDot = document.getElementById('instDot');
    const freshDot = document.getElementById('freshDot');
    const freshText = document.getElementById('freshText');
    const brandVer = document.getElementById('brandVer');
    if (snap && snap.daemonVersion) brandVer.textContent = 'v' + snap.daemonVersion;

    if (state.unauthorized) {
      instDot.className = 'dot failure';
      freshDot.className = 'dot failure';
      freshText.textContent = 'Unauthorized session';
    } else if (state.loading && !snap) {
      instDot.className = 'dot activity';
      freshDot.className = 'dot activity';
      freshText.textContent = 'Connecting to local daemon…';
    } else if (isStale()) {
      instDot.className = 'dot failure';
      freshDot.className = 'dot failure';
      freshText.textContent = 'Stale · last observed ' + fmtAgeSec(now - snap.observedAt) + ' ago (refresh failed)';
    } else if (!snap) {
      instDot.className = 'dot failure';
      freshDot.className = 'dot failure';
      freshText.textContent = 'Daemon offline';
    } else if (!state.live) {
      instDot.className = 'dot success';
      freshDot.className = 'dot warning';
      freshText.textContent = 'Paused · observed ' + fmtAgeSec(now - snap.observedAt) + ' ago';
    } else {
      instDot.className = 'dot success';
      freshDot.className = 'dot success';
      freshText.textContent = 'Live SSE · observed ' + fmtAgeSec(now - snap.observedAt) + ' ago';
    }

    const seg = document.getElementById('windowSeg');
    seg.textContent = '';
    for (const w of WINDOWS) {
      const btn = el('button', { class: 'seg-btn' + (state.win === w ? ' active' : ''), type: 'button' }, w.toUpperCase());
      btn.addEventListener('click', () => {
        if (state.win === w) return;
        state.win = w;
        state.selectedBarIdx = null;
        document.getElementById('exportLink').setAttribute('href', '/api/export?window=' + encodeURIComponent(w));
        reconnectStream();
        void fetchOnce();
      });
      seg.appendChild(btn);
    }
    document.getElementById('liveToggleBtn').textContent = state.live ? 'Pause SSE' : 'Resume SSE';
  }

  function renderAlert(snap) {
    const band = document.getElementById('alertBand');
    const title = document.getElementById('alertTitle');
    const sub = document.getElementById('alertSub');
    const cmd = document.getElementById('alertCmd');
    if (!snap) { band.className = 'alert-band hidden'; return; }

    if (isStale()) {
      band.className = 'alert-band failure';
      title.textContent = 'Refresh failed — local Grunt daemon is unreachable on 127.0.0.1:' + snap.daemonPort;
      sub.textContent = 'Prior observed snapshot from ' + fmtAgeSec(Date.now() - snap.observedAt) + ' ago remains visible below.';
      cmd.textContent = 'usegrunt setup';
      return;
    }
    if (snap.poolState === 'globally_exhausted') {
      band.className = 'alert-band failure';
      title.textContent = 'Pool globally exhausted';
      sub.textContent = snap.poolReason + (snap.earliestResetAt ? ' · earliest comeback in ' + fmtCountdown(snap.earliestResetAt, Date.now()) : '');
      cmd.textContent = 'usegrunt setup';
      return;
    }
    if (snap.poolState === 'provider_exhausted' || snap.poolState === 'transient_error') {
      band.className = 'alert-band warning';
      title.textContent = poolMeta(snap.poolState).label;
      sub.textContent = snap.poolReason;
      cmd.textContent = snap.earliestResetAt ? 'Next comeback: ' + fmtCountdown(snap.earliestResetAt, Date.now()) : 'usegrunt status';
      return;
    }
    if (snap.poolState === 'switching') {
      band.className = 'alert-band activity';
      title.textContent = 'Switching routes';
      sub.textContent = snap.poolReason;
      cmd.textContent = 'Failover active';
      return;
    }
    band.className = 'alert-band hidden';
  }

  function renderSpecialBox(snap) {
    const box = document.getElementById('specialStateBox');
    const dataCont = document.getElementById('dataContainer');
    const detail = document.getElementById('detailPanel');

    if (state.unauthorized) {
      box.classList.remove('hidden'); dataCont.classList.add('hidden'); detail.classList.add('hidden');
      box.textContent = '';
      box.appendChild(el('h2', null, 'Unauthorized remote UI session'));
      box.appendChild(el('p', null, 'Re-open the tokenized URL or scan the QR code printed by usegrunt ui --bind.'));
      return true;
    }
    if (state.loading && !snap) {
      box.classList.remove('hidden'); dataCont.classList.add('hidden'); detail.classList.add('hidden');
      box.textContent = '';
      box.appendChild(el('h2', null, 'Loading local Grunt snapshot…'));
      box.appendChild(el('p', null, 'Waiting for the first observed status from the local daemon. No placeholder numbers or charts are shown without data.'));
      return true;
    }
    if (!snap) {
      box.classList.remove('hidden'); dataCont.classList.add('hidden'); detail.classList.add('hidden');
      box.textContent = '';
      box.appendChild(el('h2', null, 'Local Grunt daemon is offline'));
      box.appendChild(el('p', null, state.lastError || 'Could not reach the local Grunt daemon. Start the daemon or run setup; this page will reconnect automatically.'));
      box.appendChild(el('div', { class: 'cmd-pill mono' }, 'usegrunt setup'));
      return true;
    }
    if (!snap.routes.length) {
      box.classList.remove('hidden'); dataCont.classList.add('hidden'); detail.classList.add('hidden');
      box.textContent = '';
      box.appendChild(el('h2', null, 'No routes configured yet'));
      box.appendChild(el('p', null, 'The local Grunt daemon is running, but no providers are configured. Run setup to connect free routes.'));
      box.appendChild(el('div', { class: 'cmd-pill mono' }, 'usegrunt setup'));
      return true;
    }
    box.classList.add('hidden');
    dataCont.classList.remove('hidden');
    return false;
  }

  function renderSummary(snap) {
    const now = Date.now();
    const pm = isStale() ? { tone: 'failure', label: 'Daemon offline' } : poolMeta(snap.poolState);
    document.getElementById('sumDot').className = 'dot ' + pm.tone;
    document.getElementById('sumState').textContent = pm.label;
    document.getElementById('sumStateSub').textContent = isStale()
      ? 'Cached from ' + fmtAgeSec(now - snap.observedAt) + ' ago · ' + snap.routableCount + ' routable then'
      : snap.poolReason;
    document.getElementById('sumActive').textContent = snap.activeRequests + ' active';

    const t = snap.totals;
    const tokTotal = t.input + t.output + t.reasoning;
    document.getElementById('sumWin').textContent = snap.window.toUpperCase();
    document.getElementById('sumTok').textContent = snap.metricsAvailable ? fmtNum(tokTotal) : 'Unreported';
    const bar = document.getElementById('sumTokBar');
    bar.textContent = '';
    if (snap.metricsAvailable && tokTotal > 0) {
      bar.appendChild(buildHorizontalBarSvg([
        { pct: (t.input / tokTotal) * 100, cls: 'fill-in' },
        { pct: (t.output / tokTotal) * 100, cls: 'fill-out' },
        { pct: (t.reasoning / tokTotal) * 100, cls: 'fill-rsn' }
      ], false));
    }
    document.getElementById('sumTokSplit').textContent = snap.metricsAvailable
      ? 'In ' + fmtNum(t.input) + ' · Out ' + fmtNum(t.output) + ' · Rsn ' + fmtNum(t.reasoning)
      : 'Diagnostics metrics unavailable';

    document.getElementById('sumLimited').textContent = snap.limitedCount + ' waiting';
    if (snap.earliestResetAt) {
      document.getElementById('sumNext').textContent = fmtCountdown(snap.earliestResetAt, now);
      document.getElementById('sumNextSub').textContent = (snap.earliestResetRoute || 'Route') + ' · ' + fmtUtc(snap.earliestResetAt);
    } else {
      document.getElementById('sumNext').textContent = 'None waiting';
      document.getElementById('sumNextSub').textContent = 'No routes waiting on quota cooldown';
    }

    document.getElementById('sumReq').textContent = snap.metricsAvailable ? fmtNum(t.requests) + ' req' : '—';
    document.getElementById('sumFailover').textContent = snap.metricsAvailable ? fmtNum(t.failovers) + ' failovers' : '';
    const passPct = t.requests > 0 ? ((t.requestsPassed / t.requests) * 100).toFixed(1) + '% passed' : 'No requests in window';
    const med = t.medianLatencyMs !== null ? ' · p50 ' + (t.medianLatencyMs < 1000 ? Math.round(t.medianLatencyMs) + 'ms' : (t.medianLatencyMs / 1000).toFixed(2) + 's') : '';
    document.getElementById('sumReqSub').textContent = snap.metricsAvailable ? passPct + med : 'Diagnostics unavailable';

    const unk = Math.max(t.unknownInput, t.unknownOutput);
    document.getElementById('unknownTokNote').textContent = !snap.metricsAvailable
      ? 'Diagnostics history unavailable'
      : unk > 0 ? unk + ' attempts omitted provider token counts (not estimated)' : 'All attempts reported token counts';
  }

  function renderChart(snap) {
    const barsHost = document.getElementById('chartBars');
    const axisHost = document.getElementById('chartAxis');
    const readout = document.getElementById('chartReadout');
    barsHost.textContent = '';
    axisHost.textContent = '';
    if (!snap.history.length) {
      readout.textContent = 'No hourly token history in window';
      barsHost.appendChild(el('div', { class: 'empty-cell w-full' }, 'No recorded token usage in the selected window yet.'));
      return;
    }
    const maxV = Math.max(...snap.history.map(b => b.input + b.output + b.reasoning), 1);
    const selIdx = state.selectedBarIdx !== null && state.selectedBarIdx < snap.history.length ? state.selectedBarIdx : snap.history.length - 1;
    snap.history.forEach((b, idx) => {
      const tot = b.input + b.output + b.reasoning;
      const isSel = idx === selIdx;
      const btn = el('button', {
        class: 'bar-btn' + (isSel ? ' selected' : ''),
        type: 'button',
        'aria-pressed': isSel ? 'true' : 'false',
        'aria-label': new Date(b.hour).toISOString().slice(0, 16) + ' UTC, ' + fmtNum(tot) + ' tokens'
      });
      if (tot > 0) {
        btn.appendChild(buildVerticalStackSvg((tot / maxV) * 100, b.input / tot, b.output / tot, b.reasoning / tot));
      }
      btn.addEventListener('click', () => { state.selectedBarIdx = idx; renderChart(snap); });
      barsHost.appendChild(btn);
    });
    axisHost.appendChild(el('span', null, new Date(snap.history[0].hour).toISOString().slice(5, 16) + ' UTC'));
    axisHost.appendChild(el('span', null, new Date(snap.history[snap.history.length - 1].hour).toISOString().slice(5, 16) + ' UTC'));
    const cur = snap.history[selIdx];
    const curTot = cur.input + cur.output + cur.reasoning;
    readout.textContent = new Date(cur.hour).toISOString().slice(5, 16) + ' UTC · ' + fmtNum(curTot) + ' tok (in ' + fmtNum(cur.input) + ' · out ' + fmtNum(cur.output) + ' · rsn ' + fmtNum(cur.reasoning) + ')';
  }

  function renderQuotaCell(r, now) {
    const td = el('td', { class: 'quota-col' });
    const row = el('div', { class: 'quota-row' });
    const q = r.remaining;
    if (q.tier === 'verified') {
      const unit = q.unit === 'tokens' ? 'tok' : q.unit || '';
      const hasLimit = typeof q.limit === 'number' && q.limit > 0;
      const pct = hasLimit ? Math.max(0, Math.min(100, Math.round((q.remaining / q.limit) * 100))) : null;
      row.appendChild(el('span', { class: 'mono' }, hasLimit ? fmtNum(q.remaining) + ' / ' + fmtNum(q.limit) + ' ' + unit : fmtNum(q.remaining) + ' ' + unit));
      row.appendChild(el('span', { class: 'tier-lbl verified' }, 'Reported'));
      td.appendChild(row);
      if (pct !== null) {
        const track = el('div', { class: 'meter-track' });
        const cls = pct === 0 ? 'fill-empty' : pct < 20 ? 'fill-low' : 'fill-ok';
        track.appendChild(buildHorizontalBarSvg([{ pct: pct === 0 ? 100 : pct, cls }], false));
        td.appendChild(track);
      }
      const age = q.observedAt ? 'observed ' + fmtAgeSec(now - q.observedAt) + ' ago' : 'provider metadata';
      td.appendChild(el('div', { class: 'sub-line' }, (pct !== null ? pct + '% remaining · ' : '') + age));
    } else if (q.tier === 'estimate') {
      const unit = q.unit === 'tokens' ? 'tok' : 'req';
      const pct = q.limit > 0 ? Math.max(0, Math.min(100, Math.round((q.remaining / q.limit) * 100))) : 0;
      row.appendChild(el('span', { class: 'mono' }, '~' + fmtNum(q.remaining) + ' / ' + fmtNum(q.limit) + ' ' + unit));
      row.appendChild(el('span', { class: 'tier-lbl estimate' }, 'Estimated'));
      td.appendChild(row);
      const track = el('div', { class: 'meter-track' });
      track.appendChild(buildHorizontalBarSvg([{ pct: pct === 0 ? 100 : pct, cls: 'fill-empty', striped: pct > 0 }], pct > 0));
      td.appendChild(track);
      td.appendChild(el('div', { class: 'sub-line' }, 'Local Grunt spend vs published cap'));
    } else {
      row.appendChild(el('span', { class: 'text-sec' }, 'Not reported'));
      row.appendChild(el('span', { class: 'tier-lbl unknown' }, 'Unknown'));
      td.appendChild(row);
      const localTot = r.tokens.input + r.tokens.output;
      td.appendChild(el('div', { class: 'sub-line' }, localTot > 0 ? fmtNum(localTot) + ' tok measured locally' : 'No remaining balance published'));
    }
    return td;
  }

  function renderProviders(snap) {
    const now = Date.now();
    const fg = document.getElementById('filterGroup');
    fg.textContent = '';
    const counts = {
      all: snap.routes.filter(r => r.state !== 'disabled').length,
      routable: snap.routes.filter(r => r.routable).length,
      limited: snap.routes.filter(r => r.state === 'limited' || r.retryAt).length,
      issues: snap.routes.filter(r => r.state === 'error' || r.state === 'unavailable' || r.state === 'approval').length,
      disabled: snap.routes.filter(r => r.state === 'disabled').length
    };
    const defs = [['all', 'Active pool'], ['routable', 'Routable'], ['limited', 'Limited'], ['issues', 'Issues'], ['disabled', 'Disabled']];
    for (const [k, label] of defs) {
      const btn = el('button', { class: 'filter-btn' + (state.filter === k ? ' active' : ''), type: 'button' }, label + ' (' + counts[k] + ')');
      btn.addEventListener('click', () => { state.filter = k; render(); });
      fg.appendChild(btn);
    }
    const rows = snap.routes.filter(r => {
      if (state.filter === 'all') return r.state !== 'disabled';
      if (state.filter === 'routable') return r.routable;
      if (state.filter === 'limited') return r.state === 'limited' || Boolean(r.retryAt);
      if (state.filter === 'issues') return r.state === 'error' || r.state === 'unavailable' || r.state === 'approval';
      if (state.filter === 'disabled') return r.state === 'disabled';
      return true;
    });
    document.getElementById('routeCountLbl').textContent = rows.length + ' shown · select any row for details';
    const tbody = document.getElementById('routesTbody');
    tbody.textContent = '';
    if (!rows.length) {
      const tr = el('tr');
      tr.appendChild(el('td', { colspan: '6', class: 'empty-cell' }, 'No routes match this filter.'));
      tbody.appendChild(tr);
      return;
    }
    for (const r of rows) {
      const sel = state.panelOpen && state.selection && state.selection.kind === 'route' && state.selection.id === r.id;
      const tr = el('tr', { class: sel ? 'selected' : '' });
      bindRowActivation(tr, () => { state.selection = { kind: 'route', id: r.id }; state.panelOpen = true; state.mobileDialogOpen = true; render(); });

      const td1 = el('td');
      const nm = el('div', { class: 'name-main' }, r.name);
      if (r.supportsFunctionTools) nm.appendChild(el('span', { class: 'cap-tag' }, 'Tools'));
      td1.appendChild(nm);
      td1.appendChild(el('div', { class: 'sub-line mono' }, r.model || 'Model not observed'));
      tr.appendChild(td1);

      const td2 = el('td');
      const rm = routeMeta(r);
      const pill = el('span', { class: 'state-pill ' + rm.tone });
      pill.appendChild(el('span', { class: 'dot ' + rm.tone }));
      pill.appendChild(el('span', null, rm.label + (r.active ? ' (' + r.active + ')' : '')));
      td2.appendChild(pill);
      td2.appendChild(el('div', { class: 'sub-line' }, r.detail));
      tr.appendChild(td2);

      tr.appendChild(renderQuotaCell(r, now));

      const td4 = el('td', { class: 'mono' });
      const tot = r.tokens.input + r.tokens.output + r.tokens.reasoning;
      td4.appendChild(el('div', null, fmtNum(tot)));
      td4.appendChild(el('div', { class: 'sub-line mono' }, tot > 0 ? fmtNum(r.tokens.input) + 'i · ' + fmtNum(r.tokens.output) + 'o' + (r.tokens.reasoning ? ' · ' + fmtNum(r.tokens.reasoning) + 'r' : '') : 'No spend in window'));
      tr.appendChild(td4);

      const td5 = el('td');
      if (r.retryAt && r.retryAt > now) {
        td5.appendChild(el('div', { class: 'mono text-warn fw-700' }, fmtCountdown(r.retryAt, now)));
        td5.appendChild(el('div', { class: 'sub-line mono' }, fmtUtc(r.retryAt)));
      } else if (r.actionCommand) {
        td5.appendChild(el('div', { class: 'text-fail fw-600' }, 'Manual action'));
        td5.appendChild(el('div', { class: 'sub-line mono' }, r.actionCommand));
      } else if (r.routable) {
        td5.appendChild(el('div', { class: 'text-ok fw-600' }, 'Ready now'));
        if (r.comesBackAt && r.comesBackAt > now) td5.appendChild(el('div', { class: 'sub-line mono' }, 'Refills ' + fmtCountdown(r.comesBackAt, now)));
      } else {
        td5.appendChild(el('div', { class: 'sub-line' }, r.resetCadence));
      }
      tr.appendChild(td5);

      const td6 = el('td', { class: 'mono' });
      td6.appendChild(el('div', null, r.lastReplyMs !== null ? (r.lastReplyMs < 1000 ? Math.round(r.lastReplyMs) + 'ms' : (r.lastReplyMs / 1000).toFixed(2) + 's') : '—'));
      td6.appendChild(el('div', { class: 'sub-line' }, r.checkedAgoSeconds !== null ? (r.probeFresh ? 'Fresh ' : 'Idle ') + r.checkedAgoSeconds + 's' : 'Unprobed'));
      tr.appendChild(td6);

      tbody.appendChild(tr);
    }
  }

  function renderRequests(snap) {
    const now = Date.now();
    const list = [...snap.inFlight, ...snap.completed];
    document.getElementById('inFlightCountLbl').textContent = snap.inFlight.length + ' in flight · ' + snap.completed.length + ' recent';
    const tbody = document.getElementById('requestsTbody');
    tbody.textContent = '';
    if (!list.length) {
      const tr = el('tr');
      tr.appendChild(el('td', { colspan: '5', class: 'empty-cell' }, 'No in-flight or recent requests observed yet.'));
      tbody.appendChild(tr);
      return;
    }
    for (const req of list) {
      const sel = state.panelOpen && state.selection && state.selection.kind === 'request' && state.selection.id === req.id;
      const tr = el('tr', { class: sel ? 'selected' : '' });
      bindRowActivation(tr, () => { state.selection = { kind: 'request', id: req.id }; state.panelOpen = true; state.mobileDialogOpen = true; render(); });

      const td1 = el('td');
      const top = el('div', { class: 'name-main' });
      top.appendChild(el('span', { class: 'mono' }, req.id.slice(0, 12)));
      if (req.caller) top.appendChild(el('span', { class: 'cap-tag mono' }, req.caller));
      td1.appendChild(top);
      td1.appendChild(el('div', { class: 'sub-line mono' }, (req.endpoint || 'request') + (req.promptBytes !== null ? ' · ' + Math.round(req.promptBytes / 1024) + ' KB prompt' : '')));
      tr.appendChild(td1);

      const td2 = el('td');
      const tone = req.live ? 'activity' : req.outcome === 'passed' ? 'success' : req.outcome === 'cancelled' ? 'neutral' : 'failure';
      const pill = el('span', { class: 'state-pill ' + tone });
      pill.appendChild(el('span', { class: 'dot ' + tone }));
      pill.appendChild(el('span', null, req.live ? (req.state || 'active') : (req.outcome || 'completed')));
      td2.appendChild(pill);
      tr.appendChild(td2);

      const td3 = el('td');
      const trail = req.attempts.length ? req.attempts.map(a => a.provider || '?').join(' -> ') : (req.selectedRoute || '—');
      td3.appendChild(el('div', { class: 'mono' }, trail));
      td3.appendChild(el('div', { class: 'sub-line' }, req.errorText || (req.attempts.length > 1 ? 'Failover (' + req.attempts.length + ' attempts)' : 'Single attempt')));
      tr.appendChild(td3);

      const td4 = el('td', { class: 'mono' });
      if (req.tokens.input !== null || req.tokens.output !== null) {
        const ti = req.tokens.input || 0, to = req.tokens.output || 0, trsn = req.tokens.reasoning || 0;
        td4.appendChild(el('div', null, fmtNum(ti + to + trsn)));
        td4.appendChild(el('div', { class: 'sub-line mono' }, fmtNum(ti) + 'i · ' + fmtNum(to) + 'o' + (trsn ? ' · ' + fmtNum(trsn) + 'r' : '')));
      } else {
        td4.appendChild(el('div', { class: 'sub-line' }, req.live ? 'In progress' : 'Unreported'));
      }
      tr.appendChild(td4);

      const td5 = el('td', { class: 'mono' });
      const dur = req.durationMs !== null ? (req.durationMs < 1000 ? Math.round(req.durationMs) + 'ms' : (req.durationMs / 1000).toFixed(2) + 's') : '—';
      td5.appendChild(el('div', null, dur));
      if (req.startedAt) td5.appendChild(el('div', { class: 'sub-line' }, fmtAgeSec(now - req.startedAt) + ' ago'));
      tr.appendChild(td5);

      tbody.appendChild(tr);
    }
  }

  function renderSchedule(snap) {
    const now = Date.now();
    const autoTb = document.getElementById('autoScheduleTbody');
    const manTb = document.getElementById('manualScheduleTbody');
    autoTb.textContent = '';
    manTb.textContent = '';

    const autoItems = snap.routes
      .filter(r => (r.retryAt && r.retryAt > now) || (r.comesBackAt && r.comesBackAt > now && r.state !== 'disabled' && !r.actionCommand))
      .sort((a, b) => (a.retryAt || a.comesBackAt) - (b.retryAt || b.comesBackAt));

    if (!autoItems.length) {
      const tr = el('tr');
      tr.appendChild(el('td', { colspan: '5', class: 'empty-cell' }, 'No upcoming automatic quota resets known.'));
      autoTb.appendChild(tr);
    } else {
      for (const r of autoItems) {
        const tr = el('tr');
        bindRowActivation(tr, () => { state.selection = { kind: 'route', id: r.id }; state.panelOpen = true; state.mobileDialogOpen = true; render(); });
        tr.appendChild(el('td', { class: 'fw-600' }, r.name));
        const cooling = Boolean(r.retryAt && r.retryAt > now);
        const tdS = el('td');
        const pill = el('span', { class: 'state-pill ' + (cooling ? 'warning' : 'success') });
        pill.appendChild(el('span', { class: 'dot ' + (cooling ? 'warning' : 'success') }));
        pill.appendChild(el('span', null, cooling ? 'Cooling down' : 'Scheduled refill'));
        tdS.appendChild(pill);
        tr.appendChild(tdS);
        tr.appendChild(el('td', null, r.resetCadence));
        const target = cooling ? r.retryAt : r.comesBackAt;
        tr.appendChild(el('td', { class: 'mono fw-700 ' + (cooling ? 'text-warn' : 'text-fg') }, fmtCountdown(target, now)));
        tr.appendChild(el('td', { class: 'mono' }, fmtUtc(target)));
        autoTb.appendChild(tr);
      }
    }

    const manItems = snap.routes.filter(r => r.actionCommand || r.state === 'disabled' || r.retired);
    if (!manItems.length) {
      const tr = el('tr');
      tr.appendChild(el('td', { colspan: '3', class: 'empty-cell' }, 'No routes require manual action.'));
      manTb.appendChild(tr);
    } else {
      for (const r of manItems) {
        const tr = el('tr');
        bindRowActivation(tr, () => { state.selection = { kind: 'route', id: r.id }; state.panelOpen = true; state.mobileDialogOpen = true; render(); });
        tr.appendChild(el('td', { class: 'fw-600' }, r.name));
        tr.appendChild(el('td', { class: 'text-sec' }, r.detail));
        const tdC = el('td');
        tdC.appendChild(r.actionCommand ? el('span', { class: 'cmd-pill mono' }, r.actionCommand) : el('span', { class: 'sub-line' }, 'Disabled / retired'));
        tr.appendChild(tdC);
        manTb.appendChild(tr);
      }
    }
  }

  function kvRow(k, v, monoVal) {
    const row = el('div', { class: 'kv' });
    row.appendChild(el('span', null, k));
    row.appendChild(el('span', monoVal ? { class: 'mono' } : null, v));
    return row;
  }

  function renderDetail(snap) {
    const panel = document.getElementById('detailPanel');
    const now = Date.now();
    if (!state.panelOpen || !state.selection) {
      panel.classList.add('hidden');
      panel.classList.remove('open-mobile');
      return;
    }
    panel.classList.remove('hidden');
    panel.classList.toggle('open-mobile', state.mobileDialogOpen);
    if (state.mobileDialogOpen) { panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); }
    else { panel.setAttribute('role', 'region'); panel.removeAttribute('aria-modal'); }
    panel.textContent = '';

    const closeBtn = el('button', { class: 'close-btn', type: 'button', 'aria-label': 'Close inspector panel' }, '×');
    closeBtn.addEventListener('click', () => { state.panelOpen = false; state.mobileDialogOpen = false; render(); });

    if (state.selection.kind === 'request') {
      const req = [...snap.inFlight, ...snap.completed].find(x => x.id === state.selection.id);
      if (!req) { state.panelOpen = false; panel.classList.add('hidden'); return; }
      const head = el('div', { class: 'detail-head' });
      const left = el('div');
      left.appendChild(el('div', { class: 'detail-title mono' }, req.id.slice(0, 16)));
      left.appendChild(el('div', { class: 'sub-line mono' }, (req.caller || 'client') + ' · ' + (req.endpoint || 'request')));
      head.appendChild(left);
      head.appendChild(closeBtn);
      panel.appendChild(head);

      const s1 = el('div', { class: 'detail-sec' });
      s1.appendChild(el('div', { class: 'detail-k' }, 'Request metadata'));
      s1.appendChild(kvRow('State', req.live ? (req.state || 'active') : (req.outcome || 'completed'), false));
      if (req.promptBytes !== null) s1.appendChild(kvRow('Prompt size', Math.round(req.promptBytes / 1024) + ' KB', true));
      if (req.responseBytes !== null) s1.appendChild(kvRow('Response size', (req.responseBytes / 1024).toFixed(1) + ' KB', true));
      if (req.durationMs !== null) s1.appendChild(kvRow('Duration', (req.durationMs / 1000).toFixed(2) + 's', true));
      panel.appendChild(s1);

      const s2 = el('div', { class: 'detail-sec' });
      s2.appendChild(el('div', { class: 'detail-k' }, 'Attempt & failover timeline'));
      if (!req.attempts.length) {
        s2.appendChild(el('div', { class: 'sub-line' }, 'No provider attempts recorded.'));
      }
      for (const a of req.attempts) {
        const tone = a.outcome === 'passed' ? 'ok' : a.errorCode === 'quota' ? 'warn' : a.outcome === 'failed' ? 'err' : '';
        const step = el('div', { class: 'timeline-step ' + tone });
        step.appendChild(el('div', { class: 'fw-600' }, (a.provider || 'unknown') + ' · ' + (a.outcome || 'active')));
        step.appendChild(el('div', { class: 'sub-line mono' }, (a.model || 'model unreported') + (a.account ? ' (' + a.account + ')' : '')));
        if (a.errorText) step.appendChild(el('div', { class: 'sub-line' }, a.errorText));
        s2.appendChild(step);
      }
      panel.appendChild(s2);
      return;
    }

    const r = snap.routes.find(x => x.id === state.selection.id);
    if (!r) { state.panelOpen = false; panel.classList.add('hidden'); return; }
    const rm = routeMeta(r);
    const head = el('div', { class: 'detail-head' });
    const left = el('div');
    left.appendChild(el('div', { class: 'detail-title' }, r.name));
    left.appendChild(el('div', { class: 'sub-line mono' }, r.id + (r.model ? ' · ' + r.model : '')));
    head.appendChild(left);
    head.appendChild(closeBtn);
    panel.appendChild(head);

    const s1 = el('div', { class: 'detail-sec' });
    s1.appendChild(el('div', { class: 'detail-k' }, 'Observed health'));
    s1.appendChild(kvRow('State', rm.label, false));
    s1.appendChild(kvRow('Routable', r.routable ? 'Yes' : 'No', false));
    s1.appendChild(kvRow('Probe freshness', r.checkedAgoSeconds !== null ? (r.probeFresh ? 'Fresh (' : 'Idle (') + r.checkedAgoSeconds + 's)' : 'Unprobed', true));
    if (r.errorCode) s1.appendChild(kvRow('Error code', r.errorCode, true));
    if (r.maintenance) s1.appendChild(kvRow('Maintenance', (r.maintenance.outcome || 'scheduled') + (r.maintenance.code ? ' (' + r.maintenance.code + ')' : ''), false));
    panel.appendChild(s1);

    const s2 = el('div', { class: 'detail-sec' });
    s2.appendChild(el('div', { class: 'detail-k' }, 'Remaining usage provenance'));
    const srcLbl = r.remaining.tier === 'verified' ? 'Provider-reported (live)' : r.remaining.tier === 'estimate' ? 'Policy estimate (local spend)' : 'Not reported by provider';
    s2.appendChild(kvRow('Confidence', srcLbl, false));
    s2.appendChild(kvRow('Reset cadence', r.resetCadence, false));
    if (r.retryAt || r.comesBackAt) {
      const target = r.retryAt || r.comesBackAt;
      s2.appendChild(kvRow('Next reset', fmtCountdown(target, now) + ' (' + fmtUtc(target) + ')', true));
    }
    s2.appendChild(el('div', { class: 'note-box' }, r.remaining.note));
    panel.appendChild(s2);

    const s3 = el('div', { class: 'detail-sec' });
    s3.appendChild(el('div', { class: 'detail-k' }, 'Measured spend (' + snap.window.toUpperCase() + ')'));
    s3.appendChild(kvRow('Input tokens', fmtNum(r.tokens.input), true));
    s3.appendChild(kvRow('Output tokens', fmtNum(r.tokens.output), true));
    s3.appendChild(kvRow('Reasoning tokens', fmtNum(r.tokens.reasoning), true));
    s3.appendChild(kvRow('Attempts', fmtNum(r.tokens.attempts) + (r.tokens.unknownInput ? ' (' + r.tokens.unknownInput + ' unmeasured)' : ''), true));
    panel.appendChild(s3);

    if (r.actionCommand) {
      const s4 = el('div', { class: 'detail-sec' });
      s4.appendChild(el('div', { class: 'detail-k' }, 'Recovery command'));
      s4.appendChild(el('div', { class: 'cmd-pill mono' }, r.actionCommand));
      panel.appendChild(s4);
    }
  }

  function applyVisibility() {
    document.getElementById('summaryStrip').classList.toggle('hidden', state.nav !== 'overview');
    document.getElementById('chartSection').classList.toggle('hidden', state.nav !== 'overview');
    document.getElementById('providersSection').classList.toggle('hidden', state.nav !== 'overview' && state.nav !== 'providers');
    document.getElementById('requestsSection').classList.toggle('hidden', state.nav !== 'overview' && state.nav !== 'requests');
    document.getElementById('scheduleSection').classList.toggle('hidden', state.nav !== 'schedule');
  }

  function render() {
    const snap = activeSnapshot();
    renderNav(snap);
    renderUtilityBar();
    renderAlert(snap);
    const blocked = renderSpecialBox(snap);
    applyVisibility();
    if (!blocked && snap) {
      renderSummary(snap);
      renderChart(snap);
      renderProviders(snap);
      renderRequests(snap);
      renderSchedule(snap);
      renderDetail(snap);
    }
  }

  function acceptSnapshot(data) {
    state.loading = false;
    state.unauthorized = false;
    state.snapshot = data;
    if (data && data.daemonReachable) {
      state.lastGood = data;
      state.lastError = null;
    } else if (data) {
      state.lastError = data.daemonError || 'Daemon offline';
    }
    render();
  }

  async function fetchOnce() {
    try {
      const res = await fetch('/api/snapshot?window=' + encodeURIComponent(state.win), { headers: { Accept: 'application/json' } });
      if (res.status === 401) { state.unauthorized = true; state.loading = false; render(); return; }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      acceptSnapshot(await res.json());
    } catch (err) {
      state.loading = false;
      state.lastError = err instanceof Error ? err.message : 'Unable to reach UI server';
      if (state.snapshot) state.snapshot = Object.assign({}, state.snapshot, { daemonReachable: false });
      render();
    }
  }

  function closeStream() {
    if (state.source) { state.source.close(); state.source = null; }
  }

  function reconnectStream() {
    closeStream();
    if (!state.live || typeof EventSource === 'undefined') return;
    const es = new EventSource('/api/stream?window=' + encodeURIComponent(state.win));
    es.addEventListener('snapshot', ev => {
      try { acceptSnapshot(JSON.parse(ev.data)); } catch { /* ignore malformed event */ }
    });
    es.addEventListener('error', () => { void fetchOnce(); });
    state.source = es;
  }

  document.getElementById('liveToggleBtn').addEventListener('click', () => {
    state.live = !state.live;
    if (state.live) { reconnectStream(); void fetchOnce(); }
    else closeStream();
    render();
  });

  document.getElementById('refreshBtn').addEventListener('click', () => { void fetchOnce(); });

  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape' && state.mobileDialogOpen) {
      state.mobileDialogOpen = false;
      render();
    }
  });

  setInterval(() => { render(); }, 1000);
  void fetchOnce();
  reconnectStream();
})();
`;

function fmtStaticNum(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(n >= 10000000 ? 1 : 2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}K`;
  return String(Math.round(n));
}

/** Render a standalone, script-free offline HTML snapshot for headless export. */
export function renderStaticSnapshotHtml(snapshot: UiSnapshot): string {
  const ts = new Date(snapshot.observedAt).toISOString();
  const rows = snapshot.routes.map(r => {
    const tot = r.tokens.input + r.tokens.output + r.tokens.reasoning;
    const rem = r.remaining.tier === 'verified'
      ? `${fmtStaticNum(r.remaining.remaining ?? 0)}${r.remaining.limit ? ` / ${fmtStaticNum(r.remaining.limit)}` : ''} ${r.remaining.unit ?? ''} (Reported)`
      : r.remaining.tier === 'estimate'
        ? `~${fmtStaticNum(r.remaining.remaining ?? 0)} / ${fmtStaticNum(r.remaining.limit ?? 0)} ${r.remaining.unit ?? ''} (Estimated)`
        : 'Not reported';
    const reset = r.retryAt ? new Date(r.retryAt).toISOString() : r.actionCommand ?? (r.routable ? 'Ready now' : r.resetCadence);
    return `<tr>
      <td><div class="name-main">${escapeHtml(r.name)}</div><div class="sub-line mono">${escapeHtml(r.model ?? 'Model not observed')}</div></td>
      <td><span class="state-pill neutral">${escapeHtml(r.state)}</span><div class="sub-line">${escapeHtml(r.detail)}</div></td>
      <td class="mono">${escapeHtml(rem)}</td>
      <td class="mono">${escapeHtml(fmtStaticNum(tot))}<div class="sub-line mono">${escapeHtml(`${fmtStaticNum(r.tokens.input)}i · ${fmtStaticNum(r.tokens.output)}o · ${fmtStaticNum(r.tokens.reasoning)}r`)}</div></td>
      <td class="mono">${escapeHtml(reset)}</td>
    </tr>`;
  }).join('\n');

  const totalTok = snapshot.totals.input + snapshot.totals.output + snapshot.totals.reasoning;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>grunt · Status Snapshot (${escapeHtml(ts)})</title>
<style>${UI_CSS}</style>
</head>
<body>
<main class="content">
  <div class="brand-head">
    <div class="brand-lockup">${GRUNT_LOGO_SVG}<span class="brand-ver mono">snapshot</span></div>
    <div class="sub-line mono">Observed ${escapeHtml(ts)} · Daemon 127.0.0.1:${snapshot.daemonPort} · Window ${escapeHtml(snapshot.window.toUpperCase())}</div>
  </div>
  <section class="summary-strip">
    <div class="summary-cell"><div class="summary-k"><span>Pool state</span></div><div class="summary-v">${escapeHtml(snapshot.daemonReachable ? snapshot.poolState : 'daemon offline')}</div><div class="summary-sub">${escapeHtml(snapshot.poolReason)}</div></div>
    <div class="summary-cell"><div class="summary-k"><span>Tokens spent</span></div><div class="summary-v mono">${escapeHtml(fmtStaticNum(totalTok))}</div><div class="summary-sub mono">${escapeHtml(`In ${fmtStaticNum(snapshot.totals.input)} · Out ${fmtStaticNum(snapshot.totals.output)} · Rsn ${fmtStaticNum(snapshot.totals.reasoning)}`)}</div></div>
    <div class="summary-cell"><div class="summary-k"><span>Routable / Limited</span></div><div class="summary-v mono">${snapshot.routableCount} / ${snapshot.limitedCount}</div><div class="summary-sub">${snapshot.earliestResetAt ? `Earliest comeback: ${escapeHtml(new Date(snapshot.earliestResetAt).toISOString())}` : 'No active quota cooldown'}</div></div>
    <div class="summary-cell"><div class="summary-k"><span>Requests</span></div><div class="summary-v mono">${escapeHtml(fmtStaticNum(snapshot.totals.requests))}</div><div class="summary-sub">${escapeHtml(`${snapshot.totals.requestsPassed} passed · ${snapshot.totals.failovers} failovers`)}</div></div>
  </section>
  <section class="section">
    <div class="sec-head"><h2 class="sec-title">Routes &amp; remaining usage</h2></div>
    <div class="table-scroll">
      <table>
        <thead><tr><th>Route</th><th>State &amp; cause</th><th>Remaining usage</th><th>Tokens spent</th><th>Comes back</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" class="empty-cell">No routes observed in snapshot.</td></tr>'}</tbody>
      </table>
    </div>
  </section>
</main>
</body>
</html>`;
}
