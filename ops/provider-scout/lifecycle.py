"""Trusted candidate lifecycle: reconciliation, finish lane, bounded backoff, budgets.

Everything here is operator-owned. A worker report can never set these fields:
the report schema has no `released`, `retired` or `excluded` status, no rejection
basis and no reason code. All functions are pure over the ledger dictionary
(the caller persists it) and never delete a candidate row.
"""
import collections
import datetime as dt
import hashlib
import json
import re

from context_policy import meets_context_requirement
from owner_policy import owner_exclusion, provider_host, qualification_hold

LIFECYCLE_VERSION = 1

# Ledger-only states. Only reconcile() and the trusted pipeline controller set them.
TERMINAL = ('released', 'retired', 'excluded')
WORK = ('researched', 'setup_blocked', 'integration_pending')
# Statuses a worker report may carry (the report schema enum).
WORKER_STATUSES = ('researched', 'rejected', 'needs_approval', 'setup_blocked',
                   'integration_pending', 'ready_for_review')

# Operator-recorded removals from Grunt (the offer is a historical fact, not a hold).
DEFAULT_RETIRED = {'clixad.io': 'Removed from Grunt in PR 170; do not requalify.'}

# Fields owned by the operator, carried across a worker re-report of the same row.
OPERATOR_FIELDS = ('rework', 'rework_count', 'status_before', 'terminal_reason', 'terminal_at', 'released_at')

MAX_NO_PROGRESS = 2      # consecutive reviews with unchanged facts before parking
MAX_ATTEMPTS = 10        # total reviews before parking
MAX_OFFERS = 6           # selections without a returned review before parking
PARK_DAYS = 14           # a parked candidate is reconsidered only after this
MAX_REWORK = 3           # supervisor blocks that may be sent back to the worker
BACKOFF_BASE_HOURS = {'setup_blocked': 24}
DEFAULT_BACKOFF_HOURS = 12
MAX_BACKOFF_HOURS = 168

FINISH_PER_RUN = 2
VERIFY_PER_RUN = 1
SCOPE_PER_RUN = 6

# Registry sanity: refuse to infer "removed from Grunt" from a near-empty registry.
MIN_REGISTRY_ADAPTERS = 5

# Supervisor reasons a worker cannot repair: a human gate or an owner decision.
NOT_REWORKABLE = frozenset({'owner_excluded', 'qualification_held'})

# Owner rule: Grunt never routes to a Google model, so such a row is never requeued.
GOOGLE_MODEL = re.compile(r'(?i)(?<![a-z])(gemini|gemma)(?![a-z])')
GOOGLE_HOSTS = ('google.com', 'googleapis.com', 'google.dev')

SAFE_CODE = re.compile(r'^[a-z][a-z0-9_]{0,63}$')


def parse_time(value):
    return dt.datetime.fromisoformat(value.replace('Z', '+00:00'))


# -- gate facts ---------------------------------------------------------------

def hard_failures(candidate):
    """Gates a stated fact fails outright. The facts may be claimed or verified."""
    failures = []
    if candidate['free_access'] == 'one_time':
        failures.append('free_access_one_time')
    if candidate['quality'] == 'below_baseline':
        failures.append('quality_below_baseline')
    if candidate['signup_friction'] == 'high':
        failures.append('signup_friction_high')
    if candidate['context_tokens'] is not None and not meets_context_requirement(candidate):
        failures.append('context_below_minimum')
    return failures


def unverified_gates(candidate):
    """Gates nobody has established yet: verification work, never a rejection."""
    missing = []
    if candidate['free_access'] not in ('recurring', 'one_time'):
        missing.append('free_access_unverified')
    if candidate['quality'] not in ('target', 'above_baseline', 'below_baseline'):
        missing.append('quality_unverified')
    if candidate['context_tokens'] is None:
        missing.append('context_unverified')
    if candidate['signup_friction'] not in ('low', 'human_approval', 'high'):
        missing.append('signup_unverified')
    return missing


def google_barred(candidate):
    host = provider_host(candidate['homepage'])
    return bool(GOOGLE_MODEL.search(candidate['model'])) or any(host == name or host.endswith('.' + name) for name in GOOGLE_HOSTS)


def reason_codes(candidate):
    """Fixed, safe codes describing why a row is where it is. Never model prose."""
    codes = hard_failures(candidate) + unverified_gates(candidate)
    if google_barred(candidate):
        codes.insert(0, 'google_model_barred')
    if qualification_hold(candidate):
        codes.append('human_gate')
    if candidate.get('status') == 'integration_pending':
        codes.append('integration_incomplete')
    return codes[:8]


def fingerprint(candidate):
    """Structured facts only: reworded prose is not new evidence."""
    request = candidate.get('release_request')
    probe = candidate.get('probe') if isinstance(candidate.get('probe'), dict) else {}
    facts = {
        'status': candidate.get('status'), 'setup': candidate.get('setup_status'),
        'context': candidate.get('context_tokens'), 'free': candidate.get('free_access'),
        'quality': candidate.get('quality'), 'friction': candidate.get('signup_friction'),
        'blocker': candidate.get('qualification_blocker'),
        'sources': sorted(candidate.get('primary_sources') or []),
        'head': request.get('head_sha') if isinstance(request, dict) else None,
        'probe': sorted(probe.items()),
    }
    return hashlib.sha256(json.dumps(facts, sort_keys=True, default=str).encode()).hexdigest()[:16]


# -- finish lane --------------------------------------------------------------

def stage_rank(row):
    """How close the row is to release; higher resumes first."""
    if row.get('rework'):
        return 6
    status = row.get('status')
    if status == 'integration_pending':
        return 5 if row.get('setup_status') in ('anonymous', 'reused', 'signed_up') else 4
    if status == 'setup_blocked':
        return 3
    if status == 'researched':
        if not hard_failures(row) and row.get('free_access') == 'recurring' and row.get('quality') in ('target', 'above_baseline'):
            return 2
        return 1 if row.get('free_access') == 'recurring' else 0
    return 0


def lane(row):
    if row.get('rework'):
        return 'finish'
    if row.get('status') == 'rejected':
        return 'verify'
    if row.get('qualification_attempts', 0) > 0 or row.get('status') in ('integration_pending', 'setup_blocked'):
        return 'finish'
    return 'new'


def plan_scope(due, fresh=frozenset()):
    """Order and cap the due offers. due maps review id -> (key, row).

    finish: furthest-along first, rotating by how often each was offered, so no
    candidate is re-offered while another equally advanced one waits. new:
    this run's fresh discoveries first, then the backlog. verify: claimed label
    rejections, lowest priority. Nothing excluded here is dropped; it stays due.
    """
    groups = {'finish': [], 'new': [], 'verify': []}
    for review, (key, row) in due.items():
        groups[lane(row)].append((review, key, row))

    def rotation(item):
        row = item[2]
        return (-stage_rank(row), row.get('qualification_offered', 0),
                str(row.get('qualification_last_offered_at') or ''), item[1])

    finish = sorted(groups['finish'], key=rotation)[:FINISH_PER_RUN]
    verify = sorted(groups['verify'], key=lambda item: (item[2].get('qualification_offered', 0),
                                                         str(item[2].get('qualification_last_offered_at') or ''), item[1]))[:VERIFY_PER_RUN]
    room = max(0, SCOPE_PER_RUN - len(finish) - len(verify))
    new = sorted(groups['new'], key=lambda item: (item[0] not in fresh, *rotation(item)))[:room]
    return {review: (key, row) for review, key, row in (*finish, *new, *verify)}


def backoff_hours(row, no_progress):
    base = BACKOFF_BASE_HOURS.get(row.get('status'), DEFAULT_BACKOFF_HOURS)
    return min(MAX_BACKOFF_HOURS, base * 2 ** min(4, max(0, no_progress - 1)))


def review_outcome(item, result, stamp):
    """Decide the next pending state after one returned review.

    Progress (changed structured facts) resumes at the next run. An unchanged
    review backs off, and a second unchanged review parks the candidate: no
    attempt is spent again without new evidence.
    """
    attempts = min(1000, item.get('qualification_attempts', 0) + 1)
    progressed = fingerprint(item) != fingerprint(result)
    no_progress = 0 if progressed else item.get('qualification_no_progress', 0) + 1
    outcome = {'qualification_attempts': attempts, 'qualification_no_progress': no_progress,
               'qualification_last_reviewed_at': stamp, 'qualification_offered': 0,
               'qualification_parked': None}
    parked = ('no_new_evidence' if no_progress >= MAX_NO_PROGRESS
              else 'attempts_exhausted' if attempts >= MAX_ATTEMPTS else None)
    if qualification_hold(result):
        outcome['qualification_retry_at'] = None
    elif parked:
        outcome['qualification_parked'] = parked
        outcome['qualification_retry_at'] = (parse_time(stamp) + dt.timedelta(days=PARK_DAYS)).isoformat()
    elif progressed:
        outcome['qualification_retry_at'] = None
    else:
        outcome['qualification_retry_at'] = (parse_time(stamp) + dt.timedelta(hours=backoff_hours(result, no_progress))).isoformat()
    return outcome


def record_offer(row, stamp, *, hold=False):
    """Count a selection so unreturned offers rotate behind their peers."""
    offered = row.get('qualification_offered', 0) + 1
    row['qualification_offered'] = offered
    row['qualification_last_offered_at'] = stamp
    if offered >= MAX_OFFERS and not hold:
        row['qualification_parked'] = 'offered_without_result'
        row['qualification_retry_at'] = (parse_time(stamp) + dt.timedelta(days=PARK_DAYS)).isoformat()
        row['qualification_offered'] = 0


# -- reconciliation -----------------------------------------------------------

def host_related(left, right):
    return left == right or left.endswith('.' + right) or right.endswith('.' + left)


def registry_entries(registry):
    """Adapters as (signup host, exact models), or None when the registry is unusable."""
    adapters = registry.get('adapters') if isinstance(registry, dict) else None
    if not isinstance(adapters, list):
        return None
    entries = []
    for adapter in adapters:
        if not isinstance(adapter, dict):
            continue
        host = None
        if isinstance(adapter.get('signup'), str):
            try:
                host = provider_host(adapter['signup'])
            except (AttributeError, ValueError):
                host = None
        models = [adapter['model']] if isinstance(adapter.get('model'), str) else []
        models += [model for model in adapter.get('models', []) if isinstance(model, str)]
        entries.append({'host': host, 'models': {model.strip().casefold() for model in models}})
    return entries


def retirement(row, ledger):
    decisions = {host: {'retired': True, 'reason': reason} for host, reason in DEFAULT_RETIRED.items()}
    decisions.update(ledger.get('retired_sources', {}))
    host = provider_host(row['homepage'])
    applicable = [domain for domain in decisions if host == domain or host.endswith('.' + domain)]
    if not applicable:
        return None
    decision = decisions[max(applicable, key=len)]
    return decision.get('reason', 'retired') if decision.get('retired') is True else None


def _set(row, status, code, stamp):
    if row.get('status') == status and row.get('terminal_reason') == code:
        return False
    if row.get('status') not in TERMINAL:
        row['status_before'] = row.get('status')
    row.update(status=status, terminal_reason=code, terminal_at=stamp)
    if status == 'released':
        row.setdefault('released_at', row.get('pipeline_updated_at') or stamp)
    return True


def _restore(row):
    row['status'] = row.pop('status_before', None) or 'researched'
    row.pop('terminal_reason', None)
    row.pop('terminal_at', None)


def reconcile(ledger, registry, *, stamp):
    """Make released/retired/excluded reflect the registry and owner decisions.

    Idempotent and non-destructive: rows are re-labelled, never removed.
    """
    counts = collections.Counter()
    entries = registry_entries(registry)
    usable = entries is not None and len(entries) >= MIN_REGISTRY_ADAPTERS
    for row in ledger.get('candidates', {}).values():
        host = provider_host(row['homepage'])
        model = row['model'].strip().casefold()
        in_registry = entries is not None and any(
            entry['host'] and host_related(entry['host'], host) and model in entry['models'] for entry in entries)
        # An adapter without a signup host (built-in agents) can only be recognised by model:
        # that is enough to keep a shipped row from being retired, never to call one released.
        host_listed = entries is not None and any(
            entry['host'] and host_related(entry['host'], host) or not entry['host'] and model in entry['models']
            for entry in entries)
        shipped = row.get('pipeline_status') == 'released' or row.get('status') == 'released'
        if in_registry:
            counts['released'] += _set(row, 'released', 'released_verified'
                                       if row.get('pipeline_status') == 'released' else 'released_registry', stamp)
        elif shipped:
            if usable and not host_listed:
                counts['retired'] += _set(row, 'retired', 'removed_from_registry', stamp)
            elif row.get('status') != 'released':
                counts['released'] += _set(row, 'released', 'released_verified', stamp)
        elif retirement(row, ledger):
            counts['retired'] += _set(row, 'retired', 'retired_by_operator', stamp)
        elif row.get('status') == 'retired' and row.get('terminal_reason') == 'retired_by_operator':
            _restore(row)
            counts['reopened'] += 1
        elif owner_exclusion(row, ledger):
            counts['excluded'] += _set(row, 'excluded', 'owner_excluded', stamp)
        elif row.get('status') == 'excluded':
            _restore(row)
            counts['reopened'] += 1
    return counts


def plan_rework(ledger, stamp):
    """Send a supervisor-blocked candidate back to the worker, a bounded number of times.

    A blocked or superseded head is terminal for the supervisor: nothing else
    would ever ask the worker to repair or rebase it.
    """
    counts = collections.Counter()
    for row in ledger.get('candidates', {}).values():
        request = row.get('release_request')
        if (row.get('status') != 'ready_for_review' or not isinstance(request, dict)
                or row.get('pipeline_status') not in ('blocked', 'superseded')):
            continue
        reason = row.get('pipeline_reason') if isinstance(row.get('pipeline_reason'), str) else ''
        if reason in NOT_REWORKABLE:
            continue
        count = row.get('rework_count', 0)
        if count >= MAX_REWORK:
            counts['rework_exhausted'] += 1
            continue
        safe = reason if SAFE_CODE.fullmatch(reason) else 'pipeline_blocked'
        row['status_before'] = row['status']
        row['status'] = 'integration_pending'
        row['rework_count'] = count + 1
        row['rework'] = {'reason': safe, 'stage': row.get('pipeline_stage'), 'detail': row.get('pipeline_detail'),
                         'head_sha': request.get('head_sha'), 'at': stamp}
        counts['rework'] += 1
    return counts


def backfill_basis(ledger):
    """Label every rejection claimed (a discovery pass only) or verified (reviewed)."""
    counts = collections.Counter()
    for row in ledger.get('candidates', {}).values():
        if row.get('status') != 'rejected' or 'rejection_basis' in row:
            continue
        basis = 'claimed' if row.get('sightings', 0) <= 1 and 'qualification_attempts' not in row else 'verified'
        row['rejection_basis'] = basis
        counts['claimed_rejections' if basis == 'claimed' else 'verified_rejections'] += 1
    return counts


def _queueable(row, ledger):
    if (row.get('pipeline_status') in ('released', 'publication_pending')
            or row.get('status') in TERMINAL or owner_exclusion(row, ledger) or retirement(row, ledger)
            or qualification_hold(row) or google_barred(row)):
        return False
    if row.get('status') in WORK:
        # A row failing a hard gate on its own labels is a rejection, not work.
        return not hard_failures(row) or bool(row.get('rework'))
    # A claimed label rejection earns one verification pass.
    return row.get('status') == 'rejected' and row.get('rejection_basis') == 'claimed' and bool(hard_failures(row))


def requeue(ledger, review_of):
    """Put every unfinished candidate back in the pending queue; drop stale queue entries.

    Only the queue entry is removed for a terminal row; the candidate row stays.
    """
    counts = collections.Counter()
    pending = ledger.setdefault('discovery_pending', {})
    candidates = ledger.get('candidates', {})
    for key in list(pending):
        row = candidates.get(key)
        if row is not None and (row.get('status') in TERMINAL or owner_exclusion(row, ledger) or retirement(row, ledger)):
            del pending[key]
            counts['unqueued_terminal'] += 1
    for key, row in candidates.items():
        if key in pending or not _queueable(row, ledger):
            continue
        pending[key] = {**row, 'review_id': review_of(row),
                        'qualification_attempts': row.get('qualification_attempts', 0),
                        'qualification_retry_at': None, 'queued_by': 'requeue'}
        counts['requeued'] += 1
    return counts


def apply_reason_codes(ledger):
    for row in ledger.get('candidates', {}).values():
        if row.get('status') in TERMINAL:
            continue
        codes = reason_codes(row)
        if codes != row.get('reason_codes'):
            row['reason_codes'] = codes


def ledger_counts(ledger):
    candidates = ledger.get('candidates', {})
    pending = ledger.get('discovery_pending', {})
    return {'candidates': len(candidates),
            'by_status': dict(sorted(collections.Counter(row.get('status') for row in candidates.values()).items())),
            'pending': len(pending),
            'pending_by_status': dict(sorted(collections.Counter(row.get('status') for row in pending.values()).items())),
            'rejection_basis': dict(sorted(collections.Counter(
                row.get('rejection_basis') for row in candidates.values() if row.get('status') == 'rejected').items(),
                key=lambda item: str(item[0])))}


def migrate(ledger, registry, review_of, *, stamp):
    """One idempotent pass: reconcile, rework, label rejections, requeue.

    Raises if any candidate row would be lost.
    """
    keys = set(ledger.get('candidates', {}))
    summary = collections.Counter()
    summary.update(reconcile(ledger, registry, stamp=stamp))
    summary.update(plan_rework(ledger, stamp))
    summary.update(backfill_basis(ledger))
    summary.update(requeue(ledger, review_of))
    apply_reason_codes(ledger)
    ledger['lifecycle_version'] = LIFECYCLE_VERSION
    if set(ledger.get('candidates', {})) != keys:
        raise ValueError('lifecycle_migration_would_drop_rows')
    return dict(summary)


# -- budgets ------------------------------------------------------------------

MAX_RUN_SECONDS = 3 * 3600  # below the four-hour cadence so a run never overlaps the next
RELEASE_RESERVE_SECONDS = 4500
DISCOVERY_SECONDS = 600
QUALIFICATION_SECONDS = 2400
MIN_CANDIDATE_SECONDS = 600  # do not start a release candidate with less than this left


def plan_budget(total, release_enabled):
    """Per-stage seconds. The release stages keep their share whatever research uses.

    resume: pending promotions from earlier runs. release: new candidates after
    qualification. Research is clipped to whatever the two leave.
    """
    total = max(0.0, min(float(total), MAX_RUN_SECONDS))
    reserve = min(RELEASE_RESERVE_SECONDS, total * 0.5) if release_enabled else 0.0
    research = total - reserve
    discovery = min(DISCOVERY_SECONDS, research * 0.2)
    qualification = min(QUALIFICATION_SECONDS, max(0.0, research - discovery))
    return {'total': total, 'resume': reserve / 2, 'release': reserve - reserve / 2,
            'discovery': discovery, 'qualification': qualification,
            'minimum_stage': min(60.0, total * 0.1)}
