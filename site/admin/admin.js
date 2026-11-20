const VIEWS = {
  home: ['Grunt overview', ''],
  play: ['Play', ''],
  overview: ['Diagnostics', 'Follow requests, provider availability and background work.'],
  activity: ['Live activity', 'Follow Grunt’s progress and free provider activity.'],
  requests: ['Requests', 'Inspect each request, provider attempt and fallback.'],
  providers: ['Providers', 'See what is ready, limited or waiting for setup.'],
  usage: ['Usage', 'Measure delivered work and reporting coverage.'],
  runs: ['Maintenance & scout', 'Follow provider checks, discovery and release progress.'],
  system: ['System', 'Check installation connectivity and runtime versions.']
};
const LABELS = {
  unknown: 'Not observed', available: 'Configured', ready: 'Reply verified', answering: 'Answering',
  connecting: 'Connecting', verifying: 'Verifying', approval: 'Approval needed', limited: 'Rate limited',
  error: 'Error', disabled: 'Disabled', unavailable: 'Unavailable', passed: 'Succeeded', failed: 'Failed',
  cancelled: 'Cancelled', pending: 'In progress', skipped: 'Skipped', healthy: 'Connected', degraded: 'Degraded',
  offline: 'Offline', running: 'Running', completed: 'Completed', rejected: 'Rejected', deferred: 'Deferred',
  blocked: 'Blocked', integration_pending: 'Integration pending', needs_approval: 'Approval needed',
  setup_blocked: 'Setup blocked', ready_for_review: 'Ready for review', researched: 'Researched',
  released: 'Published', ci_pending: 'CI pending', publication_pending: 'Publication pending',
  superseded: 'Superseded', reviewed: 'Reviewed', no_data: 'Awaiting collector'
};
const ERROR_LABELS = {
  not_installed: 'Not installed', logged_out: 'Authentication unavailable', quota: 'Quota or capacity limit',
  timeout: 'Timed out', upstream: 'Upstream failure', refused: 'Request refused', cancelled: 'Cancelled',
  busy: 'Busy', foreground: 'Foreground work active', consent: 'Consent needed'
};
const FAILURE_REASONS = {
  request_body: 'Request format rejected', request_tools: 'Tool envelope or history rejected',
  request_tool_schema: 'Tool schema rejected',
  request_size: 'Request exceeds source size limit',
  response_body: 'Reply body could not be read', response_json: 'Invalid JSON reply',
  response_choices: 'Reply has no usable choices', response_content: 'Invalid reply content',
  response_tools: 'Invalid tool call', completion_model: 'Returned model did not match',
  completion_billing: 'Free billing could not be verified', completion_usage: 'Usage was missing, invalid, or over budget',
  completion_attestation: 'Completion metadata could not be verified',
  completion_protocol: 'Reply did not match the expected protocol',
  turn_limit: 'Native turn limit reached', token_limit: 'Native token limit reached',
  price_limit: 'Native price limit reached', deadline: 'Native deadline reached',
  terminated: 'Native run terminated', length: 'Model stopped at its length limit', refusal: 'Model refused the request'
};
const EVENT_LABELS = {
  'request.start': 'Request received', 'request.finish': 'Request finished', 'attempt.start': 'Provider attempt started',
  'attempt.finish': 'Provider attempt finished', 'route.selection': 'Provider selected',
  'route.skip': 'Provider skipped', 'transport.finish': 'Transport finished'
};
const REASONS = {
  not_listed: 'Outside the enabled provider list', pending_setup: 'Provider setup is pending',
  context_not_approved: 'Request context is outside the provider’s approved scope',
  cooldown: 'Routing cooldown is active', tools_unsupported: 'Function tools are unsupported',
  input_unsupported: 'Input type is unsupported', unavailable: 'Provider is unavailable',
  sticky: 'Existing request route', weighted: 'Selected from the weighted pool',
  explicit: 'Explicit provider selection', fallback: 'Fallback after an earlier attempt', local: 'Local handling'
};
const PIPELINE_REASONS = {
  upstream_capacity: 'Reported blocker: upstream capacity', review_rejected: 'Review did not approve',
  ci_pending: 'Waiting for CI', validation_failed: 'Validation did not pass', publication_pending: 'Publication pending',
  approval_required: 'Human approval required', quota: 'Allowance or rate limit', setup_required: 'Setup required',
  pipeline_failed: 'Pipeline stage failed'
};
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const array = value => Array.isArray(value) ? value : [];
const text = (value, fallback = 'Not reported', limit = 256) => typeof value === 'string' && value.trim() ? value.slice(0, limit) : fallback;
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const date = value => number(value) !== null && value > 0 ? new Date(value) : null;
export const formatCount = value => count(value) === null ? 'Not reported' : new Intl.NumberFormat('en-US').format(value);
export const isRequestId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export const stateLabel = value => own(LABELS, value) ? LABELS[value] : 'Unknown';
export const errorLabel = value => own(ERROR_LABELS, value) ? ERROR_LABELS[value] : 'Not reported';
export function formatDuration(value) {
  if (number(value) === null) return 'Not reported';
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60000) return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)} s`;
  return `${Math.floor(value / 60000)}m ${Math.floor(value % 60000 / 1000)}s`;
}
export function relativeTime(value, now = Date.now()) {
  if (!date(value)) return 'Not reported';
  const seconds = Math.round((now - value) / 1000);
  if (seconds <= -86400) return `in ${Math.ceil(-seconds / 86400)}d`;
  if (seconds <= -3600) return `in ${Math.ceil(-seconds / 3600)}h`;
  if (seconds <= -60) return `in ${Math.ceil(-seconds / 60)} min`;
  if (seconds < 0) return `in ${-seconds}s`;
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
export function usageCoverage(usage) {
  const value = object(usage), knownInput = count(value.knownInputEvents), unknownInput = count(value.unknownInputEvents),
    knownOutput = count(value.knownOutputEvents), unknownOutput = count(value.unknownOutputEvents);
  if ([knownInput, unknownInput, knownOutput, unknownOutput].some(item => item === null)) return 'Token-reporting coverage has not been reported.';
  return `Input reported for ${formatCount(knownInput)} attempt events; ${formatCount(unknownInput)} unknown. Output reported for ${formatCount(knownOutput)} attempt events; ${formatCount(unknownOutput)} unknown.`;
}
export function usageWindows(now = new Date()) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const monday = new Date(today);
  monday.setDate(today.getDate() - (today.getDay() + 6) % 7);
  return { today: today.getTime(), week: monday.getTime() };
}

const HOME_STATUS = {
  answering: ['answering', 'In use', 0], ready: ['ready', 'Ready', 1],
  limited: ['limited', 'Rate limited', 2], error: ['error', 'Having trouble', 3],
  unavailable: ['offline', 'Down', 3], approval: ['approval', 'Needs approval', 4],
  connecting: ['connecting', 'Setting up', 4], verifying: ['verifying', 'Checking', 4],
  available: ['unknown', 'Configured', 5], recent: ['ready', 'Used recently', 5],
  retryable: ['limited', 'Can retry', 5],
  unknown: ['unknown', 'Not checked', 6], disabled: ['disabled', 'Off', 7], stale: ['unknown', 'No recent status', 8]
};
const freshActivity = (entry, now) => number(entry.receivedAt) !== null && now - entry.receivedAt <= 20000;
const PHASE_LABELS = { starting: 'Starting', working: 'Working', checkpoint: 'Between work cycles',
  waiting_for_free_pool: 'Waiting for a free source', stopped: 'Stopped', offline: 'Offline' };
const WORK_STATUS = {
  working: ['running', 'Working'], provider_wait: ['limited', 'Waiting for a provider'],
  stalled: ['error', 'No recent progress'], offline: ['offline', 'Runner offline'],
  between_cycles: ['unknown', 'Between work cycles'], starting: ['connecting', 'Starting'],
  paused: ['unknown', 'Paused'], unknown: ['unknown', 'Work status unknown']
};

const WORKER_STATUS = {
  queued: ['limited', 'Queued'], running: ['running', 'Working'], completed: ['ready', 'Finished'],
  failed: ['error', 'Failed'], cancelled: ['unknown', 'Cancelled']
};

const WORKER_ACTIVITY = { review: 'Code review', tests: 'Tests', implementation: 'Implementation', research: 'Research' };

function workDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function homeSources(overview, activity, usage, now = Date.now()) {
  const instances = new Map(array(overview?.instances).map(row => [row.id, row]));
  const perInstance = new Map();
  const put = (id, instanceId, state, error) => {
    if (typeof id !== 'string' || !id) return;
    const key = `${instanceId}:${id}`;
    perInstance.set(key, { id, state: own(HOME_STATUS, state) ? state : 'unknown', error });
  };
  for (const row of array(overview?.providers)) {
    const installation = instances.get(row.instanceId);
    const fresh = installation?.connected === true && installation.system?.daemonReachable !== false
      && number(row.lastObservedAt) !== null && now - row.lastObservedAt <= 90000;
    put(row.id, row.instanceId, fresh ? row.state : 'stale', fresh ? row.errorCode : undefined);
  }
  for (const entry of array(activity?.instances).filter(row => freshActivity(row, now))) {
    const current = object(entry.activity);
    if (current.phase === 'offline') continue;
    if (current.lastReply?.source) {
      const source = current.lastReply.source, prior = perInstance.get(`${entry.instanceId}:${source}`);
      if (!prior || ['unknown', 'stale', 'available'].includes(prior.state)) put(source, entry.instanceId, 'recent');
    }
    for (const issue of array(current.issues)) {
      const state = issue.state === 'available' ? 'retryable' : issue.state
        ?? (issue.error === 'quota' ? 'limited' : ['logged_out', 'not_installed'].includes(issue.error) ? 'unavailable' : 'error');
      put(issue.source, entry.instanceId, state, issue.error);
    }
    for (const call of array(current.active)) put(call.source, entry.instanceId, 'answering');
  }
  const grouped = new Map();
  for (const row of perInstance.values()) {
    const prior = grouped.get(row.id);
    if (!prior || HOME_STATUS[row.state][2] < HOME_STATUS[prior.state][2]) grouped.set(row.id, row);
  }
  for (const record of array(usage?.sources)) {
    const source = grouped.get(record.source) ?? { id: record.source, state: 'stale' };
    if (['stale', 'unknown', 'available'].includes(source.state) && Number.isFinite(record.lastReplyAt)
      && now - record.lastReplyAt < 86400000) source.state = 'recent';
    grouped.set(source.id, { ...source, ...record });
  }
  return [...grouped.values()].sort((a, b) => HOME_STATUS[a.state][2] - HOME_STATUS[b.state][2]
    || (b.today?.replies ?? 0) - (a.today?.replies ?? 0) || a.id.localeCompare(b.id));
}
export function resolveApiBase(configured, origin) {
  const value = new URL(configured, origin);
  const local = new URL(origin);
  const allowedSameOrigin = value.origin === local.origin && (local.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(local.hostname));
  if (value.username || value.password || value.search || value.hash || value.pathname.replace(/\/$/, '') !== '/admin'
    || !(value.origin === 'https://api.grunt.run' || value.origin === 'https://grunt.run' || allowedSameOrigin)) {
    throw new Error('invalid_admin_endpoint');
  }
  return value.href.replace(/\/$/, '');
}
function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = String(content);
  return node;
}
function badge(value, label) {
  return element('span', `badge ${own(LABELS, value) ? value : 'unknown'}`, label ?? stateLabel(value));
}
function empty(title, description) {
  const node = element('div', 'empty-state');
  node.append(element('h3', '', title), element('p', '', description));
  return node;
}
function loading(description = 'Loading diagnostic observations…') { return element('div', 'skeleton', description); }
function timestamp(value, exact = false) {
  const node = element('time', '', exact && date(value) ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(value) : relativeTime(value));
  if (date(value)) { node.dateTime = new Date(value).toISOString(); node.title = new Date(value).toLocaleString(); }
  return node;
}
function fields(items, className = '') {
  const list = element('dl', `field-list ${className}`);
  for (const [label, value, mono] of items) {
    const group = element('div');
    const description = element('dd', mono ? 'mono' : '');
    description.append(value instanceof Node ? value : document.createTextNode(String(value)));
    group.append(element('dt', '', label), description);
    list.append(group);
  }
  return list;
}
function table(headers, className = '') {
  const result = element('table', `data-table ${className}`), head = element('thead'), row = element('tr');
  for (const item of headers) {
    const [label, cls] = Array.isArray(item) ? item : [item, ''];
    const cell = element('th', cls, label); cell.scope = 'col'; row.append(cell);
  }
  head.append(row); const body = element('tbody'); result.append(head, body);
  return { result, body };
}
function cell(row, value, className = '') {
  const node = element('td', className);
  node.append(value instanceof Node ? value : document.createTextNode(String(value)));
  row.append(node); return node;
}
class HttpError extends Error { constructor(status) { super('admin_request_failed'); this.status = status; } }

export class AdminConsole {
  constructor(options = {}) {
    this.fetcher = options.fetcher ?? window.fetch.bind(window);
    this.base = options.apiBase ?? resolveApiBase(document.querySelector('meta[name="grunt-admin-api"]')?.content ?? 'https://api.grunt.run/admin', window.location.origin);
    this.activity = null; this.sourceUsage = null; this.session = null; this.view = 'home'; this.instanceId = ''; this.overview = null;
    this.requests = []; this.providers = []; this.runs = null; this.nextCursor = null; this.pagesLoaded = false;
    this.sourceFilter = ''; this.outcomeFilter = ''; this.instanceOptions = [];
    this.lastFetchedAt = null; this.refreshing = false; this.abort = null; this.traceAbort = null;
    this.traceRequest = null; this.traceBusy = false; this.lastFocused = null; this.timer = null; this.detailSequence = 0; this.refreshSequence = 0;
    this.el = Object.fromEntries([...document.querySelectorAll('[id]')].map(node => [node.id, node]));
  }
  async api(path, options = {}) {
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 12000);
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    try {
      const response = await this.fetcher(`${this.base}${path}`, { ...options, credentials: 'include', redirect: 'error', signal,
        headers: { Accept: 'application/json', ...(options.headers ?? {}) } });
      if (!response.ok) throw new HttpError(response.status);
      return options.download ? response : response.status === 204 ? null : await response.json();
    } finally { clearTimeout(timeout); }
  }
  query(params = {}) {
    const query = new URLSearchParams();
    if (this.instanceId) query.set('instanceId', this.instanceId);
    for (const [key, value] of Object.entries(params)) if (value !== '' && value !== undefined && value !== null) query.set(key, String(value));
    const value = query.toString(); return value ? `?${value}` : '';
  }
  async start() {
    this.el['auth-retry'].addEventListener('click', () => this.signInState());
    this.el.refresh.addEventListener('click', () => this.refresh(true));
    this.el.export.addEventListener('click', () => this.exportData());
    this.el['provider-usage-period'].addEventListener('change', () => this.renderProviderUsage());
    this.el['sign-out'].addEventListener('click', () => this.signOut());
    this.el['instance-select'].addEventListener('change', () => {
      this.instanceId = this.el['instance-select'].value; this.resetRequests(); this.closeTrace();
      this.overview = null; this.providers = []; this.runs = null; this.activity = null; this.sourceUsage = null;
      if (this.view === 'usage') this.renderProviderUsage();
      this.refresh(true);
    });
    this.el['request-filters'].addEventListener('submit', event => { event.preventDefault(); this.sourceFilter = this.el['source-filter'].value; this.outcomeFilter = this.el['outcome-filter'].value; this.resetRequests(); this.refresh(true); });
    this.el['request-search'].addEventListener('input', () => { this.renderRequests(); this.el['open-request-id'].disabled = !isRequestId(this.el['request-search'].value.trim()); });
    this.el['open-request-id'].addEventListener('click', () => { const id = this.el['request-search'].value.trim(); if (isRequestId(id)) this.openTrace({ id, ...(this.instanceId ? { instanceId: this.instanceId } : {}) }); });
    this.el['load-more'].addEventListener('click', () => this.loadEarlier());
    this.el['close-trace'].addEventListener('click', () => this.closeTrace());
    this.el['trace-dialog'].addEventListener('close', () => { this.traceAbort?.abort(); this.traceRequest = null; this.lastFocused?.focus(); });
    window.addEventListener('hashchange', () => this.navigate());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { clearTimeout(this.timer); this.abort?.abort(); this.traceAbort?.abort(); this.el['polling-note'].textContent = 'Automatic refresh paused while this tab is hidden'; }
      else { this.updatePollingNote(); if (this.session) this.refresh(); }
    });
    this.el['google-login'].href = `${this.base}/auth/google`;
    this.el['overview-providers'].replaceChildren(loading()); this.el['overview-requests'].replaceChildren(loading());
    this.navigate(false); await this.signInState();
  }
  authState(message, options = {}) {
    this.session = null; this.abort?.abort(); this.traceAbort?.abort(); clearTimeout(this.timer); this.refreshSequence++;
    this.el.console.hidden = true; this.el['auth-screen'].hidden = false;
    this.el['auth-description'].textContent = options.description ?? 'Use an authorized Google account to view your Grunt installations and diagnostics.';
    this.el['auth-message'].textContent = message;
    this.el['google-login'].hidden = options.login !== true;
    this.el['auth-retry'].hidden = options.retry !== true;
    this.el['owner-email'].textContent = '';
    this.closeTrace(); this.overview = null; this.requests = []; this.providers = []; this.runs = null; this.activity = null; this.sourceUsage = null;
    this.el['activity-list'].replaceChildren(loading('Loading recent activity…'));
    this.el['home-work'].replaceChildren(); this.el['home-source-list'].replaceChildren();
    this.renderHomeWorkers();
    this.el['provider-usage-list'].replaceChildren();
    this.renderWorkUptime(undefined);
    this.renderProjectContext(undefined);
    this.renderPlaytest();
    this.el['trace-content'].replaceChildren();
  }
  async signInState() {
    this.el['auth-retry'].disabled = true;
    this.el['auth-message'].textContent = '';
    this.el['auth-description'].textContent = 'Connecting to the admin service…';
    try {
      const result = object(await this.api('/api/session'));
      if (typeof object(result.user).email !== 'string') throw new Error('invalid_session');
      this.session = result; this.el['owner-email'].textContent = result.user.email;
      this.el['auth-screen'].hidden = true; this.el.console.hidden = false;
      await this.refresh(true);
    } catch (error) {
      if (error.status === 401) {
        const reason = new URL(window.location.href).searchParams.get('auth');
        const message = reason === 'owner_denied' ? 'This Google account does not have owner access. Sign in with an authorized account.'
          : reason === 'signin_failed' ? 'Google sign-in did not finish. Please try again.' : '';
        this.authState(message, { login: true });
        if (['owner_denied', 'signin_failed'].includes(reason)) { const url = new URL(window.location.href); url.searchParams.delete('auth'); window.history.replaceState(null, '', url); }
      } else if (error.status === 403) this.authState('This account does not have owner access.', { login: true });
      else if (error.status === 503) this.authState('Google owner sign-in is not configured on the admin service yet. Complete the backend configuration, then reconnect.', { retry: true });
      else this.authState('The admin service could not be reached. Reconnect when the service is available.', { retry: true });
    } finally { this.el['auth-retry'].disabled = false; }
  }
  navigate(refresh = true) {
    const name = window.location.hash.slice(1).split('/')[0]; this.view = own(VIEWS, name) ? name : 'home';
    document.querySelectorAll('[data-view]').forEach(node => { if (node.dataset.view === this.view) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current'); });
    for (const name of Object.keys(VIEWS)) this.el[`view-${name}`].hidden = name !== this.view;
    [this.el['page-title'].textContent, this.el['page-description'].textContent] = VIEWS[this.view];
    this.el['page-description'].hidden = !VIEWS[this.view][1];
    this.el['page-title'].closest('.workspace').classList.toggle('home-view', this.view === 'home');
    this.el['page-title'].closest('.workspace').classList.toggle('play-view', this.view === 'play');
    this.el.export.hidden = ['home', 'play'].includes(this.view);
    this.el['context-bar'].hidden = this.view === 'play';
    if (this.view === 'play') this.renderPlaytest();
    this.updatePollingNote();
    document.title = `${VIEWS[this.view][0]} · Grunt admin`;
    if (refresh) { this.el['main-content'].focus({ preventScroll: true }); window.scrollTo(0, 0); }
    if (refresh && this.session) this.refresh(true);
  }
  resetRequests() { this.requests = []; this.nextCursor = null; this.pagesLoaded = false; }
  requestParams(limit = 50) { return { limit, source: this.sourceFilter, outcome: this.outcomeFilter }; }
  async refresh(manual = false) {
    if (!this.session || document.hidden) return;
    clearTimeout(this.timer); this.abort?.abort(); this.abort = new AbortController();
    const signal = this.abort.signal, sequence = ++this.refreshSequence;
    this.refreshing = true; this.el.refresh.disabled = true; this.el.refresh.querySelector('span').textContent = 'Refreshing…';
    this.el[`view-${this.view}`].setAttribute('aria-busy', 'true');
    const tasks = this.view === 'play' ? [['session', '/api/session']] : [['overview', '/api/overview' + this.query()]];
    if (this.view === 'overview') tasks.push(['requests', '/api/requests' + this.query({ limit: 8 })]);
    if (['home', 'activity'].includes(this.view)) tasks.push(['activity', '/api/activity' + this.query()]);
    if (['home', 'usage'].includes(this.view)) tasks.push(['sourceUsage', '/api/source-usage' + this.query(usageWindows())]);
    if (this.view === 'requests') tasks.push(['requests', '/api/requests' + this.query(this.requestParams())]);
    if (this.view === 'providers') tasks.push(['providers', '/api/providers' + this.query()]);
    if (this.view === 'runs') tasks.push(['runs', '/api/runs' + this.query()]);
    try {
      const responses = await Promise.allSettled(tasks.map(async ([key, path]) => [key, await this.api(path, { signal })]));
      if (signal.aborted || sequence !== this.refreshSequence) return;
      const denied = responses.find(response => response.status === 'rejected' && [401, 403].includes(response.reason?.status));
      if (denied) { this.authState(denied.reason.status === 403 ? 'Owner access is no longer available for this account.' : 'Your owner session expired. Sign in again.', { login: true }); return; }
      let successful = 0;
      for (const response of responses) {
        if (response.status !== 'fulfilled') continue;
        const [key, payload] = response.value, value = object(payload); successful++;
        if (key === 'session' && typeof object(value.user).email === 'string') this.session = value;
        else if (key === 'overview') this.overview = value;
        else if (key === 'requests') {
          const incoming = array(value.requests);
          if (this.view === 'requests' && this.pagesLoaded) {
            const seen = new Set(incoming.map(row => `${object(row).instanceId}:${object(row).id}`));
            this.requests = [...incoming, ...this.requests.filter(row => !seen.has(`${object(row).instanceId}:${object(row).id}`))].slice(0, 1000);
          } else { this.requests = incoming; this.nextCursor = typeof value.nextCursor === 'string' ? value.nextCursor : null; }
        }
        else if (key === 'providers') this.providers = array(value.providers);
        else if (key === 'runs') this.runs = value;
        else if (key === 'activity') this.activity = value;
        else if (key === 'sourceUsage') this.sourceUsage = value;
      }
      if (successful) this.lastFetchedAt = Date.now();
      this.connectionNotice(successful === tasks.length ? null : successful ? 'Some diagnostic data could not be refreshed. Previously collected observations remain visible.' : 'The admin service is unreachable. Showing the last collected observations.', successful === 0);
      this.render();
      if (this.el['trace-dialog'].open && this.traceRequest) void this.updateTrace();
      if (manual && successful === tasks.length) this.el.announcement.textContent = this.view === 'play' ? 'Playtest status refreshed.' : 'Diagnostic observations refreshed.';
    } finally {
      if (sequence === this.refreshSequence) {
        this.refreshing = false; this.el.refresh.disabled = false; this.el.refresh.querySelector('span').textContent = 'Refresh';
        document.querySelectorAll('.view[aria-busy]').forEach(node => node.removeAttribute('aria-busy'));
        if (this.session && !document.hidden) this.timer = setTimeout(() => this.refresh(), ['home', 'activity'].includes(this.view) ? 5000 : 10000);
      }
    }
  }
  connectionNotice(message, error = false) {
    this.el['connection-notice'].hidden = !message;
    this.el['connection-notice'].classList.toggle('error', error);
    this.el['connection-notice'].textContent = message ?? '';
  }
  render() {
    if (this.view === 'play') { this.renderPlaytest(); return; }
    this.renderContext();
    if (this.view === 'home') this.renderHome();
    else if (this.view === 'overview') this.renderOverview();
    else if (this.view === 'activity') this.renderActivity();
    else if (this.view === 'requests') this.renderRequests();
    else if (this.view === 'providers') this.el['provider-list'].replaceChildren(this.providerTable(this.providers));
    else if (this.view === 'usage') this.renderUsage();
    else if (this.view === 'runs') this.renderRuns();
    else if (this.view === 'system') this.renderSystem();
  }
  updatePollingNote() {
    this.el['polling-note'].textContent = document.hidden ? 'Automatic refresh paused while this tab is hidden'
      : ['home', 'activity'].includes(this.view) ? 'Refreshes every 5 seconds while this tab is visible'
        : 'Refreshes every 10 seconds while this tab is visible';
  }
  renderPlaytest() {
    const launch = this.el['playtest-launch'];
    const value = this.session?.playtestUrl;
    let url;
    if (typeof value === 'string' && URL.canParse(value)) {
      const parsed = new URL(value);
      if (parsed.protocol === 'https:' && parsed.hostname.endsWith('.pages.dev') &&
          !parsed.username && !parsed.password && !parsed.port && !parsed.search && !parsed.hash) url = parsed.href;
    }
    if (url) launch.href = url;
    else launch.removeAttribute('href');
    launch.hidden = !url;
    this.el['playtest-status'].textContent = url ? 'Opens in a new tab.' : 'No mobile playtest is available yet.';
  }
  renderHome() {
    const now = Date.now();
    const latest = [...array(this.activity?.instances)].sort((a, b) => b.receivedAt - a.receivedAt)[0];
    const work = this.el['home-work'];
    const measurement = latest?.activity?.work;
    if (latest) {
      const data = object(latest.activity), fresh = freshActivity(latest, now);
      const title = element('div', 'home-project');
      let workStatus = ['unknown', 'Last known update'];
      if (fresh && measurement && now - measurement.at <= 25000 && own(WORK_STATUS, measurement.state)) workStatus = WORK_STATUS[measurement.state];
      else if (fresh && !measurement) workStatus = [data.phase === 'working' ? 'running' : 'unknown', PHASE_LABELS[data.phase] ?? 'Unknown'];
      title.append(element('h3', '', 'Amazing Adventure'), badge(...workStatus));
      const progress = [...array(data.events)].reverse().find(event => event.kind === 'progress');
      const checkpoint = data.project?.checkpoint;
      const current = fresh ? array(data.active).map(row => text(row.source)).join(', ') : '';
      const route = current ? `${measurement?.state === 'stalled' ? 'Waiting on' : 'Answering now'}: ${current}`
        : data.lastReply?.source ? `Last reply: ${text(data.lastReply.source)}` : 'Waiting for a source reply';
      const note = element('p', 'home-progress', text(progress?.text ?? checkpoint?.summary, 'Waiting for a progress message.', 400));
      const meta = element('p', 'home-work-meta');
      meta.append(element('span', '', route));
      const updateAt = progress?.at ?? (checkpoint?.summary ? checkpoint.at : null);
      if (updateAt) meta.append(timestamp(updateAt));
      work.replaceChildren(title, note, meta);
    } else {
      work.replaceChildren(element('p', 'home-progress', 'No work status reported.'),
        element('p', 'section-note', 'Updates appear here when the Amazing Adventure runner is connected.'));
    }

    this.renderHomeWorkers(now);
    this.renderWorkUptime(measurement, now);
    this.renderProjectContext(latest?.activity?.project);

    const windows = usageWindows(new Date(now));
    const received = this.sourceUsage?.today === windows.today && this.sourceUsage?.week === windows.week;
    const rows = homeSources(this.overview, this.activity, received ? this.sourceUsage : null, now);
    const target = this.el['home-source-list'];
    const note = this.el['home-usage-note'];
    note.hidden = !rows.length;
    if (!rows.length) {
      target.replaceChildren(empty('No sources reported yet', 'Source status and usage appear here as Grunt reports them.'));
      return;
    }
    const periods = [['today', 'Today'], ['week', 'This week'], ['lifetime', 'Lifetime']];
    const { result, body } = table(['Source', ['Status', 'home-source-status'], ...periods.map(([, label]) => [label, 'number'])], 'home-source-table');
    const usage = received ? this.sourceUsage : null;
    const since = date(usage?.lifetimeSince);
    const lifetimeStart = since ? ` Lifetime uses available history from ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(since)}.` : '';
    note.textContent = 'Counts successful replies and reported tokens. Today starts at local midnight. This week starts Monday.' + lifetimeStart;
    const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
    const amount = (range, available) => {
      const node = element('div', 'home-amount');
      if (!available) { node.textContent = '—'; return node; }
      const replies = count(range?.replies) ?? 0, tokens = count(range?.tokens);
      if (tokens !== null) {
        const total = element('strong', '', `${compact.format(tokens)} tokens`);
        total.title = `${formatCount(tokens)} reported tokens`;
        node.append(total);
      }
      const complete = count(range?.completeReports) ?? 0;
      node.append(element('span', 'secondary', `${formatCount(replies)} ${replies === 1 ? 'reply' : 'replies'}${tokens === null && replies > 0 ? ' · tokens unknown' : complete < replies ? ' · partial' : ''}`));
      return node;
    };
    for (const source of rows) {
      const row = element('tr'), name = element('th', 'home-source-name', source.id);
      name.scope = 'row'; row.append(name);
      const [tone, label] = HOME_STATUS[source.state], status = badge(tone, label);
      if (source.error) status.title = (source.state === 'retryable' ? 'Last error: ' : '') + errorLabel(source.error);
      const inlineStatus = status.cloneNode(true); inlineStatus.classList.add('home-inline-status'); name.append(inlineStatus);
      cell(row, status, 'home-source-status');
      for (const [period] of periods) cell(row, amount(source[period], received && (period !== 'lifetime' || !!usage?.totals?.lifetime)), 'number');
      body.append(row);
    }
    const totalRow = element('tr'), totalLabel = element('th', 'home-source-name', 'All providers');
    totalLabel.scope = 'row'; totalRow.append(totalLabel);
    cell(totalRow, '', 'home-source-status');
    for (const [period] of periods) cell(totalRow, amount(usage?.totals?.[period], !!usage?.totals?.[period]), 'number');
    const footer = element('tfoot', 'home-source-totals');
    footer.append(totalRow); result.append(footer);
    target.replaceChildren(result);
  }
  renderHomeWorkers(now = Date.now()) {
    const section = this.el['home-workers'], list = this.el['home-worker-list'];
    const installations = array(this.overview?.instances).filter(instance => instance.snapshot?.workers);
    section.hidden = !installations.length;
    list.replaceChildren();
    const counts = this.el['home-worker-counts'];
    counts.textContent = '';
    if (!installations.length) return;

    const current = [], recent = [];
    let active = 0, queued = 0, stale = false;
    for (const instance of installations) {
      const workers = instance.snapshot.workers;
      const fresh = instance.connected === true && instance.system?.daemonReachable !== false &&
        number(instance.snapshotObservedAt) !== null && now - instance.snapshotObservedAt <= 90000;
      if (!fresh) stale = true;
      else { active += array(workers.active).length; queued += array(workers.queued).length; }
      for (const worker of [...array(workers.active), ...array(workers.queued)]) current.push({ worker, instance, fresh });
      for (const worker of array(workers.recent)) recent.push({ worker, instance, fresh });
    }
    counts.textContent = stale ? 'Showing last known status where updates are missing' : `${active} active · ${queued} queued`;
    const finished = ({ worker }) => worker.finishedAt ?? worker.startedAt ?? worker.createdAt;
    const entries = [...current, ...recent.sort((a, b) => finished(b) - finished(a)).slice(0, 3)];
    list.hidden = !entries.length;
    for (const { worker, instance, fresh } of entries) {
      if (!own(WORKER_STATUS, worker.state)) continue;
      let status = WORKER_STATUS[worker.state];
      if (!fresh && ['running', 'queued'].includes(worker.state)) status = ['unknown', `Was ${status[1].toLowerCase()}`];
      else if (worker.state === 'running' && !worker.source) status = ['limited', 'Waiting for a source'];
      const item = element('li');
      const activity = own(WORKER_ACTIVITY, worker.activity) ? WORKER_ACTIVITY[worker.activity] : '';
      const provider = text(worker.source, ['running', 'queued'].includes(worker.state) ? 'Source pending' : 'No source');
      const name = [activity, provider,
        installations.length > 1 ? text(instance.id) : ''].filter(Boolean).join(' · ');
      item.append(badge(...status), element('span', '', name), timestamp(worker.finishedAt ?? worker.startedAt ?? worker.createdAt));
      list.append(item);
    }
  }
  renderWorkUptime(measurement, now = Date.now()) {
    const root = this.el['home-uptime'], target = this.el['home-uptime-totals'];
    root.hidden = !measurement;
    if (!measurement) { target.replaceChildren(); return; }
    const stale = now - measurement.at > 25000;
    this.el['home-uptime-freshness'].textContent = stale ? 'Last measured ' + relativeTime(measurement.at, now) : 'Updates every few seconds';
    const { result, body } = table(['Window', 'Uptime', 'Downtime', 'Measured'], 'home-uptime-table');
    for (const [label, value, cap] of [['Last 24h', measurement.day, 86400000], ['Last 7d', measurement.week, 604800000]]) {
      const row = element('tr'), period = element('th', 'home-source-name', label);
      period.scope = 'row'; row.append(period);
      const { workingMs = 0, downtimeMs = 0, providerWaitMs = 0 } = object(value);
      const measured = workingMs + downtimeMs;
      const uptime = element('div', 'home-uptime-value'), downtime = element('div', 'home-uptime-value');
      if (measured > 0) {
        const percentage = workingMs / measured * 100;
        const display = percentage > 99.95 && downtimeMs > 0 ? '>99.9%' : percentage.toFixed(percentage === 0 || percentage === 100 ? 0 : 1) + '%';
        uptime.append(element('strong', '', display), element('span', 'secondary', workDuration(workingMs) + ' working'));
        downtime.append(element('strong', '', workDuration(downtimeMs)));
        if (providerWaitMs) downtime.append(element('span', 'secondary', workDuration(providerWaitMs) + ' provider wait'));
      } else { uptime.textContent = '—'; downtime.textContent = '—'; }
      cell(row, uptime); cell(row, downtime);
      const coverage = element('div', 'home-uptime-value');
      coverage.append(element('strong', '', workDuration(measured)));
      if (measured < cap) coverage.append(element('span', 'secondary', workDuration(cap - measured) + ' unmeasured'));
      cell(row, coverage); body.append(row);
    }
    target.replaceChildren(result);
  }
  renderProjectContext(value) {
    const root = this.el['home-project-context'];
    root.hidden = !value;
    const project = object(value), key = JSON.stringify(project);
    if (root.dataset.renderKey === key) return;
    root.dataset.renderKey = key;
    const milestones = element('ol', 'home-milestones');
    const labels = { review: ['running', 'In review'], draft: ['unknown', 'Draft'], merged: ['passed', 'Merged'], closed: ['unknown', 'Closed'] };
    const calendar = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
    for (const row of array(project.milestones)) {
      if (!Number.isSafeInteger(row.number) || row.number < 1 || !own(labels, row.status)) continue;
      const item = element('li'), meta = element('div', 'milestone-meta');
      const [tone, label] = labels[row.status];
      if (date(row.at)) {
        const time = timestamp(row.at);
        time.textContent = calendar.format(row.at);
        meta.append(time);
      }
      meta.append(badge(tone, label));
      const link = element('a', '', text(row.title));
      link.href = `https://github.com/bananaman614305/amazing-adventure/pull/${row.number}`;
      item.append(meta, link); milestones.append(item);
    }
    this.el['home-milestones'].replaceChildren(milestones.children.length ? milestones
      : element('p', 'section-note', 'No project milestones available right now.'));

    const checkpoint = object(project.checkpoint), steps = array(checkpoint.next);
    const next = this.el['home-next'];
    if (steps.length > 1) {
      const plan = element('ol', 'home-next-steps');
      for (const step of steps) plan.append(element('li', '', text(step, '', 400)));
      next.replaceChildren(plan);
    } else next.replaceChildren(element('p', 'home-plan-text', text(steps[0], 'Grunt hasn’t posted its next steps yet.', 400)));
    if (date(checkpoint.at)) {
      const attribution = element('p', 'section-note home-plan-date');
      attribution.append(document.createTextNode('Grunt’s checkpoint · '), timestamp(checkpoint.at));
      next.append(attribution);
    }
    if (checkpoint.summary) {
      const details = element('details', 'home-checkpoint');
      details.append(element('summary', '', 'Checkpoint summary'), element('p', 'home-plan-text', text(checkpoint.summary, '', 400)));
      next.append(details);
    }
  }
  renderActivity() {
    const target = this.el['activity-list'];
    const instances = array(object(this.activity).instances).filter(row => Date.now() - row.receivedAt < 120000);
    if (!instances.length) {
      const title = this.activity ? 'No live activity' : 'Activity unavailable';
      target.replaceChildren(empty(title, 'Start the activity publisher on Chad to follow the Amazing Adventure run.'));
      return;
    }

    const providerList = (rows, fallback) => {
      if (!rows.length) return document.createTextNode(fallback);
      const list = element('ul', 'activity-providers');
      for (const provider of rows) {
        const row = object(provider), item = element('li');
        item.append(element('strong', '', text(row.source)));
        if (row.model) item.append(element('span', 'mono', text(row.model)));
        if (row.error) {
          const retryable = row.state === 'available';
          item.append(badge(retryable ? 'unknown' : 'failed', (retryable ? 'Can retry · ' : '') + errorLabel(row.error)));
        }
        if (row.at) item.append(timestamp(row.at));
        list.append(item);
      }
      return list;
    };
    target.replaceChildren(...instances.map(item => {
      const entry = object(item), data = object(entry.activity);
      const stale = !date(entry.receivedAt) || Date.now() - entry.receivedAt > 20000;
      const section = element('section', 'activity-instance');
      const header = element('div', 'item-heading activity-heading'), label = element('h3', '', text(entry.instanceId));
      const phase = !stale && own(PHASE_LABELS, data.phase) ? PHASE_LABELS[data.phase] : 'Stale feed';
      header.append(label, badge(stale || data.phase === 'offline' ? 'offline' : data.phase === 'working' ? 'running' : 'unknown', phase), timestamp(entry.receivedAt));
      const grid = element('div', 'activity-grid'), routing = element('section', 'activity-routing');
      routing.append(element('h3', '', 'Provider activity'), fields([
        ['Answering now', providerList(stale ? [] : array(data.active), stale ? 'Waiting for a fresh update' : 'No active request')],
        ['Last reply', providerList(data.lastReply ? [data.lastReply] : [], 'No reply observed')],
        ['Provider issues', providerList(array(data.issues), 'None observed')]
      ]), element('p', 'section-note', 'Model labels show the provider’s configured route.'));
      const timeline = element('section', 'activity-timeline'), list = element('ol', 'activity-events');
      timeline.append(element('h3', '', 'Progress and tools'));
      for (const value of [...array(data.events)].reverse()) {
        const event = object(value), row = element('li');
        const isProgress = event.kind === 'progress';
        row.append(timestamp(event.at, true));
        row.append(isProgress ? element('p', '', text(event.text, '', 400))
          : badge(event.failed ? 'failed' : 'passed', text(event.tool, 'Tool') + (event.failed ? ' failed' : ' finished')));
        list.append(row);
      }
      timeline.append(list.children.length ? list : empty('Waiting for progress', 'New messages appear when Grunt completes a reply.'));
      grid.append(routing, timeline); section.append(header, grid);
      return section;
    }));
  }
  renderContext() {
    const overview = object(this.overview), instances = array(overview.instances);
    const selector = this.el['instance-select'];
    const incomingIds = instances.map(row => text(object(row).id, ''));
    this.instanceOptions = this.instanceId ? [...new Set([...this.instanceOptions, ...incomingIds])] : incomingIds;
    const ids = this.instanceOptions;
    if (JSON.stringify([...selector.options].slice(1).map(option => option.value)) !== JSON.stringify(ids)) {
      const selected = this.instanceId;
      selector.replaceChildren(new Option('All installations', ''), ...ids.filter(Boolean).map(id => new Option(id, id)));
      if (selected && !ids.includes(selected)) selector.append(new Option(selected, selected));
      selector.value = selected;
    }
    const newest = number(overview.lastUpdated);
    this.el['installation-label'].hidden = this.view === 'home' && ids.length <= 1 && !this.instanceId;
    this.el.freshness.textContent = this.view === 'home' && this.lastFetchedAt ? `Updated ${relativeTime(this.lastFetchedAt)}` : this.lastFetchedAt ? `Fetched ${relativeTime(this.lastFetchedAt)} · ${newest ? `collector data ${relativeTime(newest)}` : 'no collector data yet'}` : 'Waiting for a snapshot';
    const sourceIds = [...new Set([...array(overview.providers), ...this.providers].map(row => text(object(row).id, '')).filter(Boolean))].sort();
    const source = this.el['source-filter'], selected = source.value;
    if (JSON.stringify([...source.options].slice(1).map(option => option.value)) !== JSON.stringify(sourceIds)) {
      source.replaceChildren(new Option('All providers', ''), ...sourceIds.map(id => new Option(id, id)));
      if (selected && !sourceIds.includes(selected)) source.append(new Option(selected, selected)); source.value = selected;
    }
  }
  renderOverview() {
    const overview = object(this.overview), health = object(overview.health), usage = object(overview.usage), status = this.el['overview-status'];
    const name = ['healthy', 'degraded', 'offline', 'no_data'].includes(health.status) ? health.status : 'no_data';
    const titles = { healthy: 'Installation data is current', degraded: 'Some sources need attention', offline: 'Installations are disconnected', no_data: 'Waiting for the first collector' };
    const descriptions = {
      healthy: 'Inspect individual provider observations below. Connected does not guarantee every request will succeed.',
      degraded: 'Review limited providers, errors and recent request attempts to find the next step.',
      offline: 'No installation is reporting fresh data. The last observations remain available for diagnosis.',
      no_data: 'Connect the private collector on your Grunt installation to start collecting request history.'
    };
    status.className = `pool-status ${name}`;
    status.querySelector('h2').textContent = titles[name]; status.querySelector('p').textContent = descriptions[name];
    const active = array(overview.instances).map(object).filter(row => row.connected === true && object(row.system).daemonReachable !== false)
      .map(row => object(row.snapshot).activeRequests).filter(value => count(value) !== null);
    const items = [['Connected installations', count(health.connectedInstances) === null ? 'Not reported' : `${formatCount(health.connectedInstances)} / ${formatCount(health.totalInstances)}`],
      ['Active source calls', active.length ? formatCount(active.reduce((sum, value) => sum + value, 0)) : 'Not reported'],
      ['Verified providers', formatCount(health.readyProviders)], ['Failed provider attempts', formatCount(usage.failures)]];
    this.el['summary-strip'].replaceChildren(...items.map(([label, value]) => { const group = element('div'); group.append(element('dt', '', label), element('dd', '', value)); return group; }));
    this.el['overview-providers'].replaceChildren(this.providerTable(array(overview.providers), true));
    this.el['overview-requests'].replaceChildren(this.requestTable(this.requests, true));
  }
  providerTable(values, compact = false) {
    const providers = values.map(object);
    if (!providers.length) return empty('No provider observations yet', 'Provider rows appear after a connected collector reads the local daemon. This view never sends test prompts.');
    const headers = compact ? ['Provider', 'State', ['Last reply', 'number'], ['Active', 'number']]
      : ['Provider / configured model', 'State', ['Last reply', 'number'], ['Retry / failure', 'hide-mobile'], ['Observed', 'hide-mobile']];
    const { result, body } = table(headers, 'provider-table');
    for (const provider of providers) {
      const row = element('tr'), identity = element('div'), providerButton = element('button', 'row-button', text(provider.id));
      providerButton.type = 'button'; providerButton.title = `Inspect ${text(provider.id)} on ${text(provider.instanceId)}`;
      providerButton.addEventListener('click', () => this.openProvider(provider)); identity.append(providerButton);
      identity.append(element('span', 'secondary', text(provider.instanceId, 'Installation not reported')));
      if (!compact) identity.append(element('code', 'secondary', text(provider.model, 'Model not reported')));
      const installation = array(object(this.overview).instances).map(object).find(item => item.id === provider.instanceId);
      const stale = !installation || installation.connected !== true || object(installation.system).daemonReachable === false
        || !date(provider.lastObservedAt) || Date.now() - provider.lastObservedAt > 90000;
      cell(row, identity, 'model-cell');
      const status = element('div');
      status.append(stale ? badge('offline', 'Stale observation') : badge(provider.state));
      if (stale) status.append(element('span', 'secondary', `Last state: ${stateLabel(provider.state)}`));
      cell(row, status);
      const reply = element('div'); reply.append(document.createTextNode(formatDuration(provider.lastReplyMs)), element('span', 'secondary', provider.lastSuccessAt ? relativeTime(provider.lastSuccessAt) : 'No observed reply'));
      cell(row, reply, 'number');
      if (compact) cell(row, stale ? '—' : formatCount(provider.active), 'number');
      else {
        const failure = element('div', '', provider.errorCode ? errorLabel(provider.errorCode) : 'None reported');
        if (number(provider.retryAt) !== null && provider.retryAt > Date.now()) failure.append(element('span', 'secondary', `Retry ${relativeTime(provider.retryAt)}`));
        cell(row, failure, 'hide-mobile'); cell(row, timestamp(provider.lastObservedAt), 'hide-mobile');
      }
      body.append(row);
    }
    return result;
  }
  requestTable(values, compact = false) {
    const requests = values.map(object);
    if (!requests.length) return empty('No requests in this view', 'Normal coding requests will appear after collection starts. Try another provider or outcome filter if history is already available.');
    const { result, body } = table(compact ? ['Request / route', 'Outcome', ['Duration', 'number'], ['Started', 'hide-mobile']]
      : ['Request / route', 'Outcome', ['Attempts', 'number hide-mobile'], ['HTTP', 'number'], ['Duration', 'number'], ['Started', 'hide-mobile']], 'request-table');
    for (const request of requests) {
      const row = element('tr'), identity = element('div'), button = element('button', 'row-button', text(request.id).slice(0, 8));
      button.type = 'button'; button.title = `Open request ${text(request.id)}`;
      button.addEventListener('click', () => this.openTrace(request));
      identity.append(button, element('span', 'secondary mono', text(request.source, array(request.sources).map(source => text(source, '')).filter(Boolean).join(' → ') || 'No provider reported')),
        element('span', 'secondary', `${text(request.instanceId)} · ${text(request.kind, 'Kind not reported')}`));
      cell(row, identity, 'request-model'); cell(row, badge(request.outcome));
      if (!compact) { cell(row, formatCount(request.attemptCount), 'number hide-mobile'); cell(row, count(request.httpStatus) === null ? '—' : String(request.httpStatus), 'number'); }
      cell(row, formatDuration(request.durationMs), 'number'); cell(row, timestamp(request.startedAt), 'hide-mobile'); body.append(row);
    }
    return result;
  }
  renderRequests() {
    const search = this.el['request-search'].value.trim().toLowerCase();
    const requests = search ? this.requests.filter(row => text(object(row).id, '').toLowerCase().includes(search)) : this.requests;
    this.el['request-list'].replaceChildren(this.requestTable(requests));
    this.el['request-count'].textContent = `${formatCount(requests.length)} loaded requests${search ? ' matching this ID' : ''}`;
    this.el['load-more'].hidden = !this.nextCursor;
  }
  async loadEarlier() {
    if (!this.nextCursor || !this.session) return;
    const button = this.el['load-more']; button.disabled = true;
    const instance = this.instanceId, before = this.nextCursor, filter = JSON.stringify(this.requestParams());
    try {
      const result = object(await this.api('/api/requests' + this.query({ ...this.requestParams(), before })));
      if (instance !== this.instanceId || filter !== JSON.stringify(this.requestParams())) return;
      const known = new Set(this.requests.map(row => `${object(row).instanceId}:${object(row).id}`));
      this.requests.push(...array(result.requests).filter(row => !known.has(`${object(row).instanceId}:${object(row).id}`)));
      this.pagesLoaded = true;
      this.nextCursor = typeof result.nextCursor === 'string' ? result.nextCursor : null; this.renderRequests();
    } catch (error) {
      if ([401, 403].includes(error.status)) this.authState('Your owner session is no longer available. Sign in again.', { login: true });
      else this.connectionNotice('Earlier requests could not be loaded. Try again; the current rows are still available.');
    } finally { button.disabled = false; }
  }
  renderUsage() {
    const usage = object(object(this.overview).usage);
    const items = [['Input tokens reported', formatCount(usage.inputTokens), 'Repeated context is included when reported.'],
      ['Output tokens reported', formatCount(usage.outputTokens), 'Generated output reported by providers.'],
      ['Logical requests', formatCount(usage.requests), 'Collected requests in this reporting window.'],
      ['Provider attempts', formatCount(usage.attempts), 'Includes retries and fallback attempts.']];
    this.el['usage-summary'].replaceChildren(...items.map(([label, value, description]) => { const group = element('div'); group.append(element('dt', '', label), element('dd', '', value), element('dd', 'usage-description', description)); return group; }));
    this.el['usage-coverage'].textContent = `${usageCoverage(usage)}${date(usage.since) ? ` Reporting window starts ${new Date(usage.since).toLocaleString()}.` : ''}`;
    this.renderProviderUsage();
  }
  renderProviderUsage() {
    const period = this.el['provider-usage-period'].value === 'week' ? 'week' : 'today';
    const target = this.el['provider-usage-list'];
    const windows = usageWindows();
    if (this.sourceUsage?.today !== windows.today || this.sourceUsage?.week !== windows.week) {
      target.replaceChildren(loading('Waiting for provider usage…'));
      return;
    }
    const rows = array(this.sourceUsage.sources).filter(record => {
      const range = object(record[period]);
      return range.replies > 0 || range.quotaAttempts > 0 || range.http429s > 0;
    }).sort((a, b) => b[period].replies - a[period].replies);
    if (!rows.length) {
      target.replaceChildren(empty('No usage recorded', 'Provider replies and limit events will appear here.'));
      return;
    }
    const { result, body } = table(['Provider', ['Input tokens', 'number'], ['Output tokens', 'number'], 'Observed limits'], 'provider-usage-table');
    const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
    const tokens = (value, reports, replies) => {
      const total = count(value), reported = count(reports);
      const node = element('div', 'home-amount');
      node.append(element('span', total === null ? 'secondary' : '', total === null ? (replies ? 'Unknown' : '—') : compact.format(total)));
      if (total !== null) node.firstChild.title = `${formatCount(total)} tokens`;
      if (total !== null && reported !== null && reported < replies) {
        node.append(element('span', 'secondary', `${formatCount(reported)} of ${formatCount(replies)} replies`));
      }
      return node;
    };
    for (const row of rows) {
      const range = object(row[period]), replies = count(range.replies) ?? 0;
      const tr = element('tr'), name = element('th', '', text(row.source));
      name.scope = 'row'; tr.append(name);
      cell(tr, tokens(range.inputTokens, range.inputReports, replies), 'number');
      cell(tr, tokens(range.outputTokens, range.outputReports, replies), 'number');
      const limits = element('div', 'provider-usage-limits');
      const quota = count(range.quotaAttempts) ?? 0, http429s = count(range.http429s) ?? 0;
      if (quota) limits.append(element('span', '', `${formatCount(quota)} quota ${quota === 1 ? 'failure' : 'failures'}`));
      if (http429s) limits.append(element('span', '', `${formatCount(http429s)} HTTP 429`));
      if (number(range.maxRetryAfterSeconds) !== null) {
        limits.append(element('span', 'secondary', `Retry-After up to ${formatDuration(range.maxRetryAfterSeconds * 1000)}`));
      }
      if (!limits.children.length) limits.append(element('span', 'secondary', 'None observed'));
      cell(tr, limits); body.append(tr);
    }
    target.replaceChildren(result);
  }
  renderRuns() {
    const runs = object(this.runs), maintenance = array(runs.maintenance).map(object), scouts = array(runs.scout).map(object);
    if (!maintenance.length) this.el['maintenance-list'].replaceChildren(empty('No maintenance observations yet', 'The collector will report each source’s last check, evidence type and next scheduled check.'));
    else {
      const { result, body } = table(['Provider / installation', 'Outcome', 'Evidence', ['Last check', 'hide-mobile'], 'Next check']);
      for (const item of maintenance) {
        const row = element('tr'), identity = element('div', 'mono', text(item.source)); identity.append(element('span', 'secondary', text(item.instanceId)));
        const outcome = element('div'); outcome.append(badge(item.outcome));
        if (item.code) outcome.append(element('span', 'secondary', errorLabel(item.code)));
        cell(row, identity); cell(row, outcome); cell(row, text(item.evidence)); cell(row, timestamp(item.lastCheckedAt ?? item.lastAttemptAt), 'hide-mobile'); cell(row, timestamp(item.nextCheckAt));
        body.append(row);
      }
      this.el['maintenance-list'].replaceChildren(element('div', 'table-area')); this.el['maintenance-list'].firstChild.append(result);
    }
    if (!scouts.length) this.el['scout-list'].replaceChildren(empty('No scout observations yet', 'Connect the Chad collector to see discovery and release progress. Research, successful probes and publication are distinct stages.'));
    else {
      const list = element('div', 'run-list');
      for (const scout of scouts) {
        const item = element('article', 'run-item'), heading = element('div', 'item-heading');
        heading.append(element('h3', '', text(scout.instanceId)), badge(scout.status)); item.append(heading,
          fields([['Run', text(scout.runId), true], ['Started', timestamp(scout.startedAt)], ['Finished', timestamp(scout.finishedAt)], ['Last progress', timestamp(scout.heartbeatAt)], ['Candidates observed', formatCount(array(scout.candidates).length)]]));
        const candidates = array(scout.candidates).map(object);
        if (candidates.length) {
          const details = element('details', 'run-candidates'); details.append(element('summary', '', 'Inspect candidate stages'));
          const { result, body } = table(['Model', 'Qualification', 'Release']);
          for (const candidate of candidates) {
            const row = element('tr'), model = element('div'), release = element('div');
            model.append(element('code', '', text(candidate.model, text(candidate.id))));
            if (own(PIPELINE_REASONS, candidate.reasonCode)) model.append(element('span', 'secondary', PIPELINE_REASONS[candidate.reasonCode]));
            cell(row, model); cell(row, badge(candidate.status));
            release.append(candidate.pipelineStatus ? badge(candidate.pipelineStatus, candidate.pipelineStatus === 'ready' ? 'Ready for release' : undefined) : document.createTextNode('Not submitted'));
            if (typeof candidate.phase === 'string') release.append(element('span', 'secondary', `Phase: ${text(candidate.phase)}`));
            const proof = value => value === true ? 'passed' : value === false ? 'not passed' : 'unknown';
            release.append(element('span', 'secondary', `Checks ${proof(candidate.checksPassed)} · live probe ${proof(candidate.supervisorProbePassed)}`));
            if (count(candidate.approvedReviewCount) !== null) release.append(element('span', 'secondary', `${candidate.approvedReviewCount}/2 independent reviews approved`));
            cell(row, release); body.append(row);
          }
          const scroll = element('div', 'table-area'); scroll.append(result); details.append(scroll); item.append(details);
        }
        list.append(item);
      }
      this.el['scout-list'].replaceChildren(list);
    }
  }
  renderSystem() {
    const instances = array(object(this.overview).instances).map(object);
    if (!instances.length) { this.el['system-list'].replaceChildren(empty('No installation has connected', 'Configure and run the private collector on your installation. The inference daemon can remain bound to loopback.')); return; }
    const list = element('div', 'system-list');
    for (const instance of instances) {
      const system = object(instance.system), item = element('article', 'system-item'), heading = element('div', 'item-heading');
      heading.append(element('h3', '', text(instance.id)), badge(instance.connected === true ? 'healthy' : 'offline', instance.connected === true ? 'Collector connected' : 'Collector offline')); item.append(heading);
      const bytes = value => number(value) === null ? 'Not reported' : `${(value / 1024 ** 3).toFixed(2)} GiB`;
      const uptime = value => number(value) === null ? 'Not reported' : formatDuration(value * 1000);
      item.append(fields([['Last collector contact', timestamp(instance.lastSeenAt)], ['Observation collected', timestamp(instance.observedAt)],
        ['Runtime version', text(system.version), true], ['Node version', text(system.nodeVersion), true], ['Platform', text(system.platform)], ['CPU count', formatCount(system.cpuCount)],
        ['Load average · 1 / 5 / 15 min', array(system.loadAverage).length === 3 && system.loadAverage.every(value => number(value) !== null) ? system.loadAverage.map(value => value.toFixed(2)).join(' / ') : 'Not reported'],
        ['System uptime', uptime(system.systemUptimeSeconds)], ['Collector uptime', uptime(system.collectorUptimeSeconds)],
        ['Memory free / total', `${bytes(system.memoryFreeBytes)} / ${bytes(system.memoryTotalBytes)}`],
        ['Daemon connection', typeof system.daemonReachable === 'boolean' ? system.daemonReachable ? 'Reachable' : 'Unreachable' : 'Not reported'],
        ['Request diagnostics', typeof system.diagnosticsAvailable === 'boolean' ? system.diagnosticsAvailable ? 'Available' : 'Unavailable' : 'Not reported'],
        ['Collector observations', array(system.collectorErrors).length ? array(system.collectorErrors).map(value => text(value).replaceAll('_', ' ')).join('; ') : 'No errors reported']]));
      list.append(item);
    }
    this.el['system-list'].replaceChildren(list);
  }
  async openTrace(request) {
    if (typeof request.id !== 'string') return;
    this.traceAbort?.abort(); this.traceAbort = new AbortController();
    const signal = this.traceAbort.signal, sequence = ++this.detailSequence; this.traceBusy = true;
    this.lastFocused = document.activeElement; this.traceRequest = request;
    this.el['trace-title'].textContent = 'Request details'; this.el['trace-id'].textContent = request.id;
    this.el['trace-content'].replaceChildren(loading('Loading this request’s timeline…'));
    if (!this.el['trace-dialog'].open) this.el['trace-dialog'].showModal();
    try {
      const query = new URLSearchParams(); if (request.instanceId) query.set('instanceId', request.instanceId);
      const value = object(await this.api(`/api/requests/${encodeURIComponent(request.id)}${query.size ? `?${query}` : ''}`, { signal }));
      if (signal.aborted || sequence !== this.detailSequence) return;
      this.renderTrace(object(value.request), array(value.events));
    } catch (error) {
      if (signal.aborted) return;
      if ([401, 403].includes(error.status)) { this.authState('Your owner session is no longer available. Sign in again.', { login: true }); return; }
      const wrapper = element('div'); wrapper.append(empty(error.status === 404 ? 'Request history is no longer available' : 'Timeline could not be loaded', error.status === 404 ? 'The request may have expired from the retention window. Return to request history for current observations.' : 'The admin service could not return this request. Try loading it again.'));
      if (error.status !== 404) { const retry = element('button', 'button', 'Load timeline again'); retry.type = 'button'; retry.addEventListener('click', () => this.openTrace(request)); wrapper.append(retry); }
      this.el['trace-content'].replaceChildren(wrapper);
    } finally { if (sequence === this.detailSequence) this.traceBusy = false; }
  }
  openProvider(provider) {
    this.traceAbort?.abort(); this.detailSequence++; this.traceBusy = false; this.traceRequest = null;
    this.lastFocused = document.activeElement;
    const installation = array(object(this.overview).instances).map(object).find(item => item.id === provider.instanceId);
    const stale = !installation || installation.connected !== true || object(installation.system).daemonReachable === false
      || !date(provider.lastObservedAt) || Date.now() - provider.lastObservedAt > 90000;
    this.el['trace-title'].textContent = text(provider.id);
    this.el['trace-id'].textContent = `${text(provider.instanceId)} · provider observation`;
    const summary = element('section', 'trace-summary');
    const quota = object(provider.quotaWindow), policy = object(provider.quotaPolicy);
    const seller = object(provider.sellerQuota);
    const sellerLimits = [
      ...(seller.perAddress ? [`${formatCount(seller.perAddress)} per buyer address`] : []),
      ...(seller.perIp ? [`${formatCount(seller.perIp)} per IP`] : []),
    ].join(', ');
    const sellerWindow = seller.windowSeconds === 86400 ? '24-hour' : formatDuration(seller.windowSeconds * 1000);
    const limits = array(policy.limits).map(limit => `${formatCount(limit.amount)} ${text(limit.unit)} per ${text(limit.period)} · ${text(limit.scope)}`).join(' / ');
    summary.append(fields([['Current observation', stale ? badge('offline', 'Stale observation') : badge(provider.state)],
      ['Last reported state', stateLabel(provider.state)], ['Configured model', text(provider.model), true],
      ['Active calls', stale ? 'Unknown while disconnected' : formatCount(provider.active)],
      ['Last verified reply', timestamp(provider.lastSuccessAt, true)], ['Last reply duration', formatDuration(provider.lastReplyMs)],
      ['Last reported failure', provider.errorCode ? errorLabel(provider.errorCode) : 'None reported'],
      ['Retry time', timestamp(provider.retryAt, true)],
      ...(date(quota.resetAt) ? [['Allowance window started', timestamp(quota.startedAt, true)], ['Allowance renews', timestamp(quota.resetAt, true)]] : []),
      ...(date(provider.scheduledQuotaRefillAt) ? [['Scheduled allowance refill', timestamp(provider.scheduledQuotaRefillAt, true)]] : []),
      ...(policy.detail ? [['Free allowance policy', text(policy.detail)]] : []),
      ...(limits ? [['Published limits', limits]] : []),
      ...(sellerLimits ? [['Seller base limits', `${sellerLimits} per ${sellerWindow} sliding window`]] : []),
      ['Observed', timestamp(provider.lastObservedAt, true)]]));
    const history = element('button', 'button', 'View this provider’s requests'); history.type = 'button';
    history.addEventListener('click', () => {
      this.instanceId = text(provider.instanceId, ''); this.sourceFilter = text(provider.id, ''); this.outcomeFilter = '';
      this.el['source-filter'].value = this.sourceFilter; this.el['outcome-filter'].value = '';
      this.el['request-search'].value = ''; this.el['open-request-id'].disabled = true;
      this.resetRequests(); this.lastFocused = null; this.closeTrace();
      if (window.location.hash === '#requests') this.navigate(); else window.location.hash = '#requests';
    });
    const note = element('p', 'section-note', 'A configured model label describes the requested route. It does not independently identify the physical model. Quota and capacity failures need the request timeline for more evidence.');
    const documentation = element('a', 'button', 'Provider quota documentation');
    if (typeof policy.documentation === 'string' && policy.documentation.startsWith('https://')) documentation.href = policy.documentation;
    documentation.target = '_blank'; documentation.rel = 'noopener noreferrer';
    this.el['trace-content'].replaceChildren(summary, history, ...(documentation.hasAttribute('href') ? [documentation] : []), note);
    if (!this.el['trace-dialog'].open) this.el['trace-dialog'].showModal();
  }
  async updateTrace() {
    if (this.traceBusy || !this.traceRequest || !this.el['trace-dialog'].open) return;
    const request = this.traceRequest; this.traceAbort = new AbortController();
    const signal = this.traceAbort.signal, sequence = ++this.detailSequence; this.traceBusy = true;
    try {
      const query = new URLSearchParams(); if (request.instanceId) query.set('instanceId', request.instanceId);
      const value = object(await this.api(`/api/requests/${encodeURIComponent(request.id)}${query.size ? `?${query}` : ''}`, { signal }));
      if (signal.aborted || sequence !== this.detailSequence) return;
      const scroll = this.el['trace-dialog'].scrollTop;
      this.renderTrace(object(value.request), array(value.events)); this.el['trace-dialog'].scrollTop = scroll;
    } catch (error) {
      if (signal.aborted) return;
      if ([401, 403].includes(error.status)) { this.authState('Your owner session is no longer available. Sign in again.', { login: true }); return; }
      if (!this.el['trace-content'].querySelector('.trace-error')) this.el['trace-content'].prepend(element('div', 'notice trace-error', 'This timeline could not be refreshed. The last loaded snapshot remains visible.'));
    } finally { if (sequence === this.detailSequence) this.traceBusy = false; }
  }
  closeTrace() { this.traceAbort?.abort(); if (this.el['trace-dialog'].open) this.el['trace-dialog'].close(); }
  renderTrace(request, values) {
    const content = this.el['trace-content'], summary = element('section', 'trace-summary');
    const sourceChain = array(request.sources).map(value => text(value, '')).filter(Boolean).join(' → ');
    summary.append(fields([['Outcome', badge(request.outcome)], ['Installation', text(request.instanceId)], ['Started', timestamp(request.startedAt, true)], ['Duration', formatDuration(request.durationMs)],
      ['Provider route', sourceChain || text(request.source)], ['Attempt count', formatCount(request.attemptCount)], ['Input tokens', formatCount(request.inputTokens)], ['Output tokens', formatCount(request.outputTokens)],
      ['HTTP outcome', count(request.httpStatus) === null ? 'Not reported' : String(request.httpStatus)], ['Failure class', request.errorCode ? errorLabel(request.errorCode) : 'None reported']]));
    const copy = element('button', 'button copy-id', 'Copy request ID'); copy.type = 'button';
    copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(text(request.id, '')); copy.textContent = 'Request ID copied'; } catch { copy.textContent = 'Select the request ID above to copy'; } }); summary.append(copy);
    const title = element('h2', 'trace-title', 'Routing timeline'), list = element('ol', 'timeline');
    for (const event of values.map(object).sort((left, right) => (number(left.at) ?? 0) - (number(right.at) ?? 0))) {
      const item = element('li', own(LABELS, event.outcome) ? event.outcome : ''), header = element('div', 'event-heading'), identity = element('div');
      identity.append(element('h3', '', own(EVENT_LABELS, event.type) ? EVENT_LABELS[event.type] : 'Diagnostic observation'));
      const source = [typeof event.source === 'string' ? event.source : null, typeof event.model === 'string' ? event.model : null].filter(Boolean).join(' · ');
      if (source) identity.append(element('p', 'event-source mono', source));
      header.append(identity, timestamp(event.at, true)); item.append(header);
      const details = [];
      if (own(LABELS, event.outcome)) details.push(['Outcome', badge(event.outcome)]);
      if (number(event.durationMs) !== null) details.push(['Duration', formatDuration(event.durationMs)]);
      if (count(event.httpStatus) !== null) details.push(['HTTP status', String(event.httpStatus)]);
      if (event.httpMethod) details.push(['Method', text(event.httpMethod), true]);
      if (event.endpointLabel) details.push(['Endpoint', text(event.endpointLabel), true]);
      if (event.transport) details.push(['Transport', text(event.transport)]);
      if (event.errorCode) details.push(['Failure class', errorLabel(event.errorCode)]);
      if (own(FAILURE_REASONS, event.failureReason)) details.push(['Failure detail', FAILURE_REASONS[event.failureReason]]);
      if (event.networkCode) details.push(['Network code', text(event.networkCode), true]);
      if (Number.isInteger(event.exitCode)) details.push(['CLI exit code', String(event.exitCode)]);
      if (number(event.retryAfterSeconds) !== null) details.push(['Reported retry delay', `${event.retryAfterSeconds} s`]);
      if (own(REASONS, event.reason)) details.push(['Routing reason', REASONS[event.reason]]);
      if (event.type === 'attempt.finish' || event.type === 'request.finish') details.push(['Input / output tokens', `${formatCount(event.inputTokens)} / ${formatCount(event.outputTokens)}`]);
      if (details.length) item.append(fields(details, 'event-fields'));
      list.append(item);
    }
    content.replaceChildren(summary, title, values.length ? list : empty('No attempt events retained', 'The request summary is available, but its detailed events were not reported or have expired.'));
    const note = element('p', 'section-note'); note.textContent = 'HTTP 429 identifies a limit response; it does not alone confirm daily quota exhaustion. Only observed diagnostic fields are shown. Request content and raw upstream payloads are excluded.'; content.append(note);
  }
  async signOut() {
    this.el['sign-out'].disabled = true;
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (typeof this.session?.csrfToken === 'string') headers['X-CSRF-Token'] = this.session.csrfToken;
      await this.api('/auth/logout', { method: 'POST', headers, body: '{}' }); this.authState('You have signed out.', { login: true });
    } catch (error) {
      if ([401, 403].includes(error.status)) this.authState('Your owner session is no longer available.', { login: true });
      else this.connectionNotice('Sign-out could not be confirmed. Try again before leaving this device.');
    } finally { this.el['sign-out'].disabled = false; }
  }
  async exportData() {
    const button = this.el.export; button.disabled = true;
    try {
      const response = await this.api('/api/export' + this.query(), { download: true });
      if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json') || Number(response.headers.get('content-length')) > 16 * 1024 * 1024) throw new Error('invalid_export');
      const blob = await response.blob();
      if (blob.size > 16 * 1024 * 1024) throw new Error('export_too_large');
      const url = URL.createObjectURL(blob), link = element('a');
      link.href = url; link.download = `grunt-diagnostics-${new Date().toISOString().slice(0, 10)}.json`; link.hidden = true;
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
      this.el.announcement.textContent = 'Redacted diagnostic export downloaded.';
    } catch (error) {
      if ([401, 403].includes(error.status)) this.authState('Your owner session is no longer available. Sign in again.', { login: true });
      else this.connectionNotice('The diagnostic export could not be downloaded. Try again after checking the admin connection.');
    } finally { button.disabled = false; }
  }
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  try { const console = new AdminConsole(); void console.start(); }
  catch {
    const message = document.getElementById('auth-message');
    if (message) message.textContent = 'The admin endpoint configuration is invalid. Check the deployment configuration.';
  }
}
