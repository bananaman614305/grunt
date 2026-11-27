import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { sanitizeSafeDiagnosticMetadata } from '../local/diagnostics.js';

const source = readFileSync(new URL('../../site/admin/admin.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../../site/admin/index.html', import.meta.url), 'utf8');
function helpers(expression: string): unknown {
  const module = new URL('../../site/admin/admin.js', import.meta.url).href;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
    `const ui = await import(${JSON.stringify(module)}); console.log(JSON.stringify(${expression}));`], { encoding: 'utf8' }));
}

it('keeps unknown token usage distinct from a reported zero', () => {
  expect(helpers('[ui.formatCount(undefined),ui.formatCount(null),ui.formatCount(0),ui.formatCount(12000)]'))
    .toEqual(['Not reported', 'Not reported', '0', '12,000']);
  expect(helpers('ui.usageCoverage({knownInputEvents:0,unknownInputEvents:4,knownOutputEvents:2,unknownOutputEvents:2})'))
    .toBe('Input reported for 0 attempt events; 4 unknown. Output reported for 2 attempt events; 2 unknown.');
  expect(helpers('ui.usageCoverage({})')).toBe('Token-reporting coverage has not been reported.');
});

it('distinguishes earlier errors from active cooldowns in the source overview', () => {
  expect(helpers(`ui.homeSources({}, {instances: [{instanceId: 'chad', receivedAt: 1000,
    activity: {phase: 'working', issues: [
      {source: 'kilo', state: 'available', error: 'upstream'},
      {source: 'zro', state: 'limited', error: 'quota'},
      {source: 'perch', state: 'error', error: 'refused'},
      {source: 'runcrate', error: 'timeout'}
    ], active: [{source: 'opencode'}]}
  }]}, {sources: [{source: 'kilo', lastReplyAt: 1000}]}, 1000)
    .map(({id, state, error}) => [id, state, error])`)).toEqual([
    ['opencode', 'answering', null],
    ['zro', 'limited', 'quota'],
    ['perch', 'error', 'refused'],
    ['runcrate', 'error', 'timeout'],
    ['kilo', 'retryable', 'upstream']
  ]);
});

it('keeps a source disabled after an earlier reply', () => {
  expect(helpers(`['disabled', 'available'].map(state => ui.homeSources(
    {instances: [{id: 'chad', connected: true}],
      providers: [{id: 'kilo', instanceId: 'chad', state, lastObservedAt: 1000}]},
    {instances: [{instanceId: 'chad', receivedAt: 1000,
      activity: {phase: 'working', lastReply: {source: 'kilo', at: 500}}
    }]}, null, 1000)[0].state)`)).toEqual(['disabled', 'recent']);
});

it('accepts only the configured Grunt API or a same-origin private preview', () => {
  expect(helpers('ui.resolveApiBase("https://api.grunt.run/admin", "https://grunt.run")'))
    .toBe('https://api.grunt.run/admin');
  expect(helpers('ui.resolveApiBase("https://grunt-gateway.fly.dev/admin", "https://grunt-gateway.fly.dev")'))
    .toBe('https://grunt-gateway.fly.dev/admin');
  expect(helpers('ui.resolveApiBase("http://127.0.0.1:8892/admin", "http://127.0.0.1:8892")'))
    .toBe('http://127.0.0.1:8892/admin');
  for (const base of ['https://attacker.example/admin', 'https://api.grunt.run.evil.example/admin',
    'https://api.grunt.run/admin?token=secret', 'https://owner:secret@api.grunt.run/admin',
    'http://api.grunt.run/admin', 'https://api.grunt.run/admin/other']) {
    expect(helpers(`(()=>{try{ui.resolveApiBase(${JSON.stringify(base)},"https://grunt.run");return false}catch{return true}})()`)).toBe(true);
  }
});

it('formats timing without inventing evidence for missing observations', () => {
  expect(helpers('[ui.relativeTime(undefined),ui.formatDuration(undefined),ui.formatDuration(0),ui.formatDuration(1250),ui.relativeTime(1000,61000)]'))
    .toEqual(['Not reported', 'Not reported', '0 ms', '1.3 s', '1m ago']);
  expect(helpers('[ui.relativeTime(91000,61000),ui.relativeTime(3661000,61000),ui.relativeTime(86461000,61000)]'))
    .toEqual(['in 30s', 'in 1h', 'in 1d']);
  expect(helpers('[ui.stateLabel("ready"),ui.stateLabel("unexpected"),ui.errorLabel("quota")]'))
    .toEqual(['Reply verified', 'Unknown', 'Quota or capacity limit']);
});

it('opens only full request identifiers for direct history lookup', () => {
  expect(helpers('[ui.isRequestId("11111111-1111-4111-8111-111111111111"),ui.isRequestId("../other"),ui.isRequestId("11111111"),ui.isRequestId(undefined)]'))
    .toEqual([true, false, false, false]);
});

it('keeps browser authentication in credentialed requests and excludes unsafe rendering or token storage', () => {
  expect(source).toContain("credentials: 'include'");
  expect(source).toContain("headers['X-CSRF-Token']");
  expect(source).toContain("method: 'POST'");
  expect(source).not.toMatch(/\b(?:innerHTML|outerHTML|insertAdjacentHTML|localStorage|sessionStorage|eval)\b/);
  expect(html).toContain("script-src 'self'");
  expect(html).toContain("object-src 'none'");
  expect(html).not.toMatch(/<script[^>]*>\s*[^<\s]/i);
  expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  expect(html).not.toContain('banana.man614305');
  expect(html).not.toContain('lunchboxfortwo');
});

it('keeps capitalized admin links canonical and restricts admin asset response headers', () => {
  const redirects = readFileSync(new URL('../../site/_redirects', import.meta.url), 'utf8');
  const headers = readFileSync(new URL('../../site/_headers', import.meta.url), 'utf8');
  expect(redirects).toContain('/Admin /admin/ 302');
  expect(redirects).toContain('/Admin/* /admin/:splat 302');
  expect(headers).toContain('frame-ancestors \'none\'');
  expect(headers).toContain('X-Frame-Options: DENY');
  expect(headers).toContain('Cache-Control: no-store');
  expect(headers).not.toMatch(/^\/\*\s*$/m);
});


it.each([
  ['request_body', 'Request format rejected'],
  ['request_tools', 'Tool envelope or history rejected'],
  ['request_tool_schema', 'Tool schema rejected'],
  ['request_size', 'Request exceeds source size limit'],
  ['stream_read', 'Reply stream could not be read'],
  ['stream_format', 'Invalid reply stream format'],
  ['stream_incomplete', 'Reply stream ended incomplete'],
  ['stream_cleanup', 'Reply stream cleanup failed']
])('preserves and displays the bounded %s request refusal reason', (failureReason, label) => {
  expect(sanitizeSafeDiagnosticMetadata({ failureReason, rawBody: 'PRIVATE_PAYLOAD' })).toEqual({ failureReason });
  const rendered = helpers(`(() => {
    class FixtureNode {
      children = []; value = '';
      set textContent(value) { this.value = String(value); }
      get textContent() { return [this.value, ...this.children.map(child => child.textContent)].join(' '); }
      append(...children) { this.children.push(...children); }
      replaceChildren(...children) { this.children = children; }
      addEventListener() {}
    }
    globalThis.Node = FixtureNode;
    globalThis.document = {
      createElement: () => new FixtureNode(),
      createTextNode: text => { const node = new FixtureNode(); node.textContent = text; return node; }
    };
    const content = new FixtureNode();
    ui.AdminConsole.prototype.renderTrace.call({el: {'trace-content': content}}, {outcome:'failed', source:'kilo'},
      [{type:'attempt.finish', outcome:'failed', source:'kilo', errorCode:'refused', failureReason:${JSON.stringify(failureReason)}}]);
    return content.textContent;
  })()`);
  expect(rendered).toContain('Failure detail');
  expect(rendered).toContain(label);
  expect(rendered).not.toContain('PRIVATE_PAYLOAD');
});
