#!/usr/bin/env python3
"""Retain allowlisted diagnostic aggregates without writing to Grunt's live DB."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import stat
import sys
import time
import uuid

KINDS = {'user', 'setup', 'maintenance', 'diagnostic'}
ACTORS = {'client', 'worker'}
TYPES = {'request.start', 'request.finish', 'attempt.start', 'attempt.finish',
         'route.selection', 'route.skip', 'transport.finish', 'work.start', 'work.finish', 'release.marker'}
OUTCOMES = {'passed', 'failed', 'cancelled', 'skipped'}
ERRORS = {'not_installed', 'logged_out', 'quota', 'timeout', 'upstream', 'refused', 'cancelled'}
STAGES = {'task', 'queue', 'setup', 'tool', 'verification', 'checkpoint', 'collection', 'capture'}
DISPOSITIONS = {'fresh', 'reused', 'deduplicated'}
OPERATIONS = {'checkpoint_write', 'checkpoint_read', 'checkpoint_resume'}
FAILURES = {'request_body', 'request_tools', 'request_tool_schema', 'request_size', 'response_body',
            'response_json', 'response_choices', 'response_content', 'response_tools', 'completion_model',
            'completion_billing', 'completion_usage', 'completion_attestation', 'completion_protocol',
            'stream_read', 'stream_format', 'stream_incomplete', 'stream_cleanup', 'turn_limit',
            'token_limit', 'price_limit', 'deadline', 'terminated', 'length', 'refusal'}
PROVIDERS = {'dots', 'codex', 'opencode', 'kilo', 'nvidia', 'zro', 'tokenharbor', 'runcrate',
             'mistral-vibe', 'livekit', 'pollinations', 'beatapi', 'perch', 'nous', 'kenari',
             'numes', 'goedel', 'darus', 'aperture-ai', 'crowllm', 'millionseek', 'freepi', 'fikra',
             'openference', 'reflection-beam', 'antseed-vikey', 'freellmapi'}
BINS_MS = (1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 180000, 600000, 3600000)
SEMVER = re.compile(r'\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,32})?(?:\+[0-9A-Za-z.-]{1,32})?\Z')
MAX_AGGREGATES = 100000
MAX_SEEN = 500000
MAX_GAPS = 1024
MAX_MARKERS = 4096
MAX_STREAMS = 1024
MAX_SAFE = 9007199254740991
MAX_STATE_BYTES = 256 * 1024 * 1024


def safe_version(value):
    return value if isinstance(value, str) and SEMVER.fullmatch(value) else None


def safe_uuid(value):
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value.lower()
    except (ValueError, AttributeError):
        return False


def private_directory(path):
    path = Path(os.path.abspath(path))
    # Reject symlink ancestors as well as a symlink at the output boundary.
    if path.resolve() != path:
        raise ValueError('private_state_required')
    try:
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
    except OSError:
        raise ValueError('private_state_required') from None
    s = path.lstat()
    if not stat.S_ISDIR(s.st_mode) or s.st_uid != os.getuid() or stat.S_IMODE(s.st_mode) != 0o700:
        raise ValueError('private_state_required')
    return path


def private_file(path):
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        os.close(fd)
    except FileExistsError:
        pass
    s = path.lstat()
    if not stat.S_ISREG(s.st_mode) or s.st_uid != os.getuid() or stat.S_IMODE(s.st_mode) != 0o600 or s.st_size > MAX_STATE_BYTES:
        raise ValueError('private_state_required')
    for suffix in ('-wal', '-shm', '-journal'):
        sidecar = Path(str(path) + suffix)
        if sidecar.exists() or sidecar.is_symlink():
            z = sidecar.lstat()
            if not stat.S_ISREG(z.st_mode) or z.st_uid != os.getuid() or stat.S_IMODE(z.st_mode) != 0o600:
                raise ValueError('private_state_required')


def open_state(directory):
    path = private_directory(directory) / 'efficiency.sqlite'
    private_file(path)
    con = sqlite3.connect(path, timeout=.5)
    con.execute('PRAGMA busy_timeout=500')
    page_size = con.execute('PRAGMA page_size').fetchone()[0]
    con.execute('PRAGMA max_page_count=' + str(MAX_STATE_BYTES // page_size))
    con.executescript('''
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS streams(id TEXT PRIMARY KEY,cursor INTEGER NOT NULL,first_seen INTEGER NOT NULL,last_tick INTEGER NOT NULL,version TEXT,version_since INTEGER,cursor_fingerprint TEXT);
      CREATE TABLE IF NOT EXISTS seen(stream TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(stream,id));
      CREATE INDEX IF NOT EXISTS seen_time ON seen(at);
      CREATE TABLE IF NOT EXISTS hourly(hour INTEGER NOT NULL,dimensions TEXT NOT NULL,events INTEGER NOT NULL,duration_count INTEGER NOT NULL,duration_sum REAL NOT NULL,histogram TEXT NOT NULL,input_known INTEGER NOT NULL,input_sum INTEGER NOT NULL,output_known INTEGER NOT NULL,output_sum INTEGER NOT NULL,duration_max REAL,PRIMARY KEY(hour,dimensions));
      CREATE TABLE IF NOT EXISTS gaps(id INTEGER PRIMARY KEY,at INTEGER NOT NULL,reason TEXT NOT NULL,from_seq INTEGER,to_seq INTEGER);
      CREATE TABLE IF NOT EXISTS markers(id TEXT PRIMARY KEY,at INTEGER NOT NULL,kind TEXT NOT NULL,version TEXT);
    ''')
    if 'cursor_fingerprint' not in {r[1] for r in con.execute('PRAGMA table_info(streams)')}:
        con.execute('ALTER TABLE streams ADD COLUMN cursor_fingerprint TEXT')
    if 'duration_max' not in {r[1] for r in con.execute('PRAGMA table_info(hourly)')}:
        con.execute('ALTER TABLE hourly ADD COLUMN duration_max REAL')
    con.commit()
    return con


def source_connection(database, deadline):
    path = Path(os.path.abspath(database))
    s = path.lstat()
    if path.resolve() != path or not stat.S_ISREG(s.st_mode) or s.st_uid != os.getuid():
        raise ValueError('private_source_required')
    con = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=.25)
    con.execute('PRAGMA query_only=ON')
    con.execute('PRAGMA busy_timeout=250')
    con.set_progress_handler(lambda: int(time.monotonic() >= deadline), 1000)
    return con


def package_version(path):
    if not path:
        return None
    p = Path(path)
    if p.stat().st_size > 65536:
        raise ValueError('invalid_runtime_package')
    with p.open(encoding='utf-8') as f:
        value = json.load(f)
        if not isinstance(value, dict):
            raise ValueError('invalid_runtime_package')
        return safe_version(value.get('version'))


def in_enum(value, choices):
    return isinstance(value, str) and value in choices


def cursor_fingerprint(event_id):
    return hashlib.sha256((type(event_id).__name__ + ':' + repr(event_id)).encode()).hexdigest()


def finite_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and 0 <= value <= 9007199254740991


def token_count(value):
    return isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 9007199254740991


def project_event(raw, row_id, row_at, version, version_since, now):
    if not isinstance(raw, str) or len(raw) > 8192:
        return None
    try:
        v = json.loads(raw)
    except (ValueError, TypeError):
        return None
    if not isinstance(v, dict) or type(v.get('version')) is not int or v.get('version') != 1 or not safe_uuid(row_id) or v.get('id') != row_id or v.get('at') != row_at:
        return None
    if not in_enum(v.get('type'), TYPES) or not in_enum(v.get('kind'), KINDS) or not token_count(row_at) or row_at > now + 300000:
        return None
    # A package observed now cannot establish the version of already-retained events.
    attributed = safe_version(v.get('runtimeVersion')) or (version if version_since is not None and row_at >= version_since else None) or 'unknown'
    dims = (attributed, v['kind'], v.get('actor') if in_enum(v.get('actor'), ACTORS) else 'unknown',
            v.get('source') if in_enum(v.get('source'), PROVIDERS) else 'other', v['type'],
            v.get('outcome') if in_enum(v.get('outcome'), OUTCOMES) else 'unknown',
            v.get('errorCode') if in_enum(v.get('errorCode'), ERRORS) else 'none',
            v.get('failureReason') if in_enum(v.get('failureReason'), FAILURES) else 'none',
            v.get('stage') if in_enum(v.get('stage'), STAGES) else 'none',
            v.get('workDisposition') if in_enum(v.get('workDisposition'), DISPOSITIONS) else 'none',
            v.get('workOperation') if in_enum(v.get('workOperation'), OPERATIONS) else 'none')
    return dims, (v.get('durationMs') if finite_number(v.get('durationMs')) else None), \
        (v.get('inputTokens') if v['type'] == 'attempt.finish' and token_count(v.get('inputTokens')) else None), \
        (v.get('outputTokens') if v['type'] == 'attempt.finish' and token_count(v.get('outputTokens')) else None)


def gap(con, now, reason, start=None, end=None):
    con.execute('INSERT INTO gaps(at,reason,from_seq,to_seq) VALUES(?,?,?,?)', (now, reason, start, end))


def collect(database, directory, runtime_package=None, max_events=10000, retention_days=90, now=None):
    if not 1 <= max_events <= 50000 or not 7 <= retention_days <= 365:
        raise ValueError('invalid_limits')
    now = int(time.time() * 1000) if now is None else now
    version = package_version(runtime_package)
    deadline = time.monotonic() + 10
    state = open_state(directory)
    state.set_progress_handler(lambda: int(time.monotonic() >= deadline), 1000)
    source = None
    try:
        state.execute('BEGIN IMMEDIATE')
        source = source_connection(database, deadline)
        source.execute('BEGIN')
        row = source.execute("SELECT value FROM diagnostic_meta WHERE key='stream_id'").fetchone()
        stream = row[0] if row else None
        if not safe_uuid(stream):
            raise ValueError('invalid_source_identity')
        first = source.execute('SELECT seq,at FROM diagnostic_events ORDER BY seq LIMIT 1').fetchone()
        last = source.execute('SELECT seq,at FROM diagnostic_events ORDER BY seq DESC LIMIT 1').fetchone()
        prior = state.execute('SELECT cursor,first_seen,last_tick,version,version_since,cursor_fingerprint FROM streams WHERE id=?', (stream,)).fetchone()
        active = state.execute("SELECT value FROM meta WHERE key='active_stream'").fetchone()
        if active and active[0] != stream:
            gap(state, now, 'source_stream_changed')
        if prior is None:
            cursor, first_seen, version_since, cursor_identity = 0, now, now if version else None, None
            if first and first[0] > 1:
                gap(state, now, 'startup_history_unavailable', 1, first[0] - 1)
        else:
            cursor, first_seen, _, old_version, version_since, cursor_identity = prior
            if old_version != version:
                version_since = now if version else None
                gap(state, now, 'runtime_version_boundary_unobserved')
            if last and last[0] < cursor:
                gap(state, now, 'source_sequence_reset', last[0] + 1, cursor)
                cursor, cursor_identity = 0, None
            elif cursor and first and first[0] <= cursor:
                actual_cursor = source.execute('SELECT substr(id,1,129) FROM diagnostic_events WHERE seq=?', (cursor,)).fetchone()
                if actual_cursor is None or cursor_identity != cursor_fingerprint(actual_cursor[0]):
                    gap(state, now, 'source_cursor_identity_changed')
                    cursor, cursor_identity = 0, None
        if prior and first and first[0] > cursor + 1:
            gap(state, now, 'unobserved_sequence_range', cursor + 1, first[0] - 1)
        rows = source.execute('SELECT seq,substr(id,1,129),at,substr(data,1,8193) FROM diagnostic_events WHERE seq>? ORDER BY seq LIMIT ?', (cursor, max_events)).fetchall()
        source.commit()
        source.close()
        source = None
        groups = {}
        processed = invalid = duplicates = late = 0
        floor_row = state.execute("SELECT value FROM meta WHERE key='dedup_floor'").fetchone()
        floor = max(int(floor_row[0]) if floor_row else 0, now - retention_days * 86400000 - 1)
        for seq, event_id, at, raw in rows:
            if time.monotonic() >= deadline:
                break
            cursor_identity = cursor_fingerprint(event_id)
            projected = project_event(raw, event_id, at, version, version_since, now)
            if projected is None:
                invalid += 1
                cursor = seq
                continue
            if at <= floor:
                late += 1
                cursor = seq
                continue
            inserted = state.execute('INSERT OR IGNORE INTO seen(stream,id,at) VALUES(?,?,?)', (stream, event_id, at)).rowcount
            cursor = seq
            if not inserted:
                duplicates += 1
                continue
            dimensions, duration, input_tokens, output_tokens = projected
            key = (at // 3600000 * 3600000, json.dumps(dimensions, separators=(',', ':')))
            g = groups.setdefault(key, [0, 0, 0., [0] * (len(BINS_MS) + 1), 0, 0, 0, 0, None])
            g[0] += 1
            if duration is not None:
                g[1] += 1
                g[2] += duration
                g[8] = max(g[8] or 0, duration)
                bucket = next((i for i, upper in enumerate(BINS_MS) if duration <= upper), len(BINS_MS))
                g[3][bucket] += 1
            if input_tokens is not None:
                g[4] += 1
                g[5] += input_tokens
            if output_tokens is not None:
                g[6] += 1
                g[7] += output_tokens
            processed += 1
        saturated = False
        for (hour, dims), g in groups.items():
            old = state.execute('SELECT events,duration_count,duration_sum,histogram,input_known,input_sum,output_known,output_sum,duration_max FROM hourly WHERE hour=? AND dimensions=?', (hour, dims)).fetchone()
            if old:
                g = [g[0] + old[0], g[1] + old[1], g[2] + old[2],
                     [x + y for x, y in zip(g[3], json.loads(old[3]))],
                     g[4] + old[4], g[5] + old[5], g[6] + old[6], g[7] + old[7],
                     max(g[8] or 0, old[8] or 0) if g[8] is not None or old[8] is not None else None]
            for index in (2, 5, 7):
                if g[index] > MAX_SAFE:
                    g[index] = MAX_SAFE
                    saturated = True
            state.execute('INSERT OR REPLACE INTO hourly VALUES(?,?,?,?,?,?,?,?,?,?,?)', (hour, dims, g[0], g[1], g[2], json.dumps(g[3]), *g[4:]))
        if saturated:
            gap(state, now, 'metric_total_saturated')
        if invalid:
            gap(state, now, 'invalid_events_skipped')
        if late:
            gap(state, now, 'late_events_excluded')
        state.execute('INSERT OR REPLACE INTO streams VALUES(?,?,?,?,?,?,?)', (stream, cursor, first_seen, now, version, version_since, cursor_identity))
        state.execute("INSERT OR REPLACE INTO meta VALUES('active_stream',?)", (stream,))
        state.execute("INSERT OR REPLACE INTO meta VALUES('histogram_upper_bounds_ms',?)", (json.dumps([*BINS_MS, '+Inf']),))
        cutoff = now - retention_days * 86400000
        state.execute('DELETE FROM hourly WHERE hour<?', (cutoff,))
        state.execute('DELETE FROM seen WHERE at<?', (cutoff,))
        aggregate_count = state.execute('SELECT count(*) FROM hourly').fetchone()[0]
        if aggregate_count > MAX_AGGREGATES:
            state.execute('DELETE FROM hourly WHERE rowid IN (SELECT rowid FROM hourly ORDER BY hour,dimensions LIMIT ?)', (aggregate_count - MAX_AGGREGATES,))
            gap(state, now, 'aggregate_capacity_eviction')
        seen_count = state.execute('SELECT count(*) FROM seen').fetchone()[0]
        if seen_count > MAX_SEEN:
            evicted_at = state.execute('SELECT at FROM seen ORDER BY at LIMIT 1 OFFSET ?', (seen_count - MAX_SEEN - 1,)).fetchone()[0]
            floor = max(floor, evicted_at)
            state.execute('DELETE FROM seen WHERE at<=?', (floor,))
            gap(state, now, 'dedup_capacity_eviction')
        state.execute("INSERT OR REPLACE INTO meta VALUES('dedup_floor',?)", (str(floor),))
        state.execute('DELETE FROM streams WHERE id NOT IN (SELECT id FROM streams ORDER BY last_tick DESC LIMIT ?)', (MAX_STREAMS,))
        state.execute('DELETE FROM gaps WHERE id NOT IN (SELECT id FROM gaps ORDER BY id DESC LIMIT ?)', (MAX_GAPS,))
        state.commit()
        return {'version': 1, 'observedAt': now, 'processedEvents': processed, 'invalidEvents': invalid,
                'duplicateEvents': duplicates, 'lateEvents': late, 'deduplicationFloorAt': floor, 'cursor': cursor, 'backlogRemaining': bool(last and cursor < last[0]),
                'sourceFirstAt': first[1] if first else None, 'sourceLastAt': last[1] if last else None,
                'runtimeVersionObserved': version or 'unknown', 'runtimeVersionBoundaryAt': version_since,
                'gapRecords': state.execute('SELECT count(*) FROM gaps').fetchone()[0]}
    except Exception:
        state.rollback()
        raise
    finally:
        if source:
            source.close()
        state.close()


def marker(directory, kind, version=None, marker_id=None, now=None):
    if kind not in ('baseline', 'release') or version is not None and not safe_version(version):
        raise ValueError('invalid_marker')
    marker_id = marker_id or str(uuid.uuid4())
    if not safe_uuid(marker_id):
        raise ValueError('invalid_marker')
    con = open_state(directory)
    try:
        with con:
            prior = con.execute('SELECT kind,version FROM markers WHERE id=?', (marker_id,)).fetchone()
            if prior and prior != (kind, version):
                raise ValueError('marker_identity_conflict')
            con.execute('INSERT OR IGNORE INTO markers VALUES(?,?,?,?)', (marker_id, int(time.time() * 1000) if now is None else now, kind, version))
            con.execute('DELETE FROM markers WHERE id NOT IN (SELECT id FROM markers ORDER BY at DESC,id LIMIT ?)', (MAX_MARKERS,))
        return {'version': 1, 'markerId': marker_id, 'kind': kind, 'runtimeVersion': version or 'unknown'}
    finally:
        con.close()


def report(directory):
    con = open_state(directory)
    try:
        keys = ('runtimeVersion', 'kind', 'actor', 'provider', 'type', 'outcome', 'errorCode', 'failureReason', 'stage', 'workDisposition', 'workOperation')
        rows = []
        for hour, dims, events, dc, ds, hist, ik, isum, ok, osum, dmax in con.execute('SELECT * FROM hourly ORDER BY hour,dimensions'):
            rows.append({'hourAt': hour, **dict(zip(keys, json.loads(dims))), 'events': events,
                         'durationCount': dc, 'durationSumMs': ds, 'durationMaxMs': dmax, 'histogram': json.loads(hist),
                         'inputTokensKnownEvents': ik, 'inputTokensUnknownEvents': events - ik if json.loads(dims)[4] == 'attempt.finish' else 0, 'inputTokensSum': isum,
                         'outputTokensKnownEvents': ok, 'outputTokensUnknownEvents': events - ok if json.loads(dims)[4] == 'attempt.finish' else 0, 'outputTokensSum': osum})
        floor_row = con.execute("SELECT value FROM meta WHERE key='dedup_floor'").fetchone()
        return {'version': 1, 'deduplicationFloorAt': int(floor_row[0]) if floor_row else None, 'histogramUpperBoundsMs': [*BINS_MS, '+Inf'], 'hourly': rows,
                'coverageGaps': [dict(zip(('at', 'reason', 'fromSeq', 'toSeq'), r)) for r in con.execute('SELECT at,reason,from_seq,to_seq FROM gaps ORDER BY id')],
                'markers': [dict(zip(('id', 'at', 'kind', 'runtimeVersion'), r)) for r in con.execute('SELECT id,at,kind,version FROM markers ORDER BY at')],
                'limitations': ['Counts cover only observed retained events; gaps are explicit.', 'Histogram percentiles are bounds, not exact percentiles.', 'Summed durations can overlap and are not critical-path wall time.', 'Historical version is unknown without event attribution.']}
    finally:
        con.close()


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--database', help='Read-only live diagnostics.db path')
    p.add_argument('--state-directory', required=True, help='Separate private aggregate directory (0700)')
    p.add_argument('--runtime-package', help='Trusted runtime package.json; observed version only applies prospectively')
    p.add_argument('--max-events', type=int, default=10000)
    p.add_argument('--retention-days', type=int, default=90)
    mode = p.add_mutually_exclusive_group(required=True)
    mode.add_argument('--once', action='store_true')
    mode.add_argument('--report', action='store_true')
    mode.add_argument('--mark', choices=('baseline', 'release'))
    p.add_argument('--version-label', help='Explicit marker version; never backfills raw events')
    p.add_argument('--marker-id', help='UUID for idempotent marker creation')
    a = p.parse_args(argv)
    try:
        if a.once:
            if not a.database:
                p.error('--once requires --database')
            result = collect(a.database, a.state_directory, a.runtime_package, a.max_events, a.retention_days)
        elif a.report:
            result = report(a.state_directory)
        else:
            result = marker(a.state_directory, a.mark, a.version_label, a.marker_id)
        print(json.dumps(result, separators=(',', ':'), allow_nan=False))
        return 0
    except (OSError, sqlite3.Error, ValueError, TypeError, KeyError, OverflowError):
        # Raw errors can include private source paths or SQL values.
        print(json.dumps({'version': 1, 'error': 'collection_failed'}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
