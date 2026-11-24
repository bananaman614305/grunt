"""Preparation steps shared by the planned-pause controller: pinned private metadata, the wait for the normal registry writer's
cache refresh, and the "preserve any deliberate pause" guard. Imports perform no actions."""
import math
import os
from pathlib import Path
import stat
import time
import json

import hostpaths
import stage

ROOT = Path(__file__).resolve().parent
CACHE = hostpaths.CONFIG / 'registry.json'
STATE = hostpaths.STATE


def private_json(path, limit=2 * 1024 * 1024):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        before = os.fstat(stream.fileno())
        if (not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid()
                or stat.S_IMODE(before.st_mode) != 0o600 or before.st_nlink != 1
                or before.st_size > limit):
            raise ValueError('Private preparation metadata is unsafe')
        raw = stream.read(limit + 1)
        after = os.fstat(stream.fileno())
        if len(raw) > limit or (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise ValueError('Private preparation metadata changed during read')
    return json.loads(raw)


def cache_matches(cache, approved):
    return (isinstance(cache, dict) and set(cache).issubset({'registry', 'etag'})
            and cache.get('registry') == approved)


def preserve_pause():
    hold = STATE / 'execution-upgrade-hold'
    if hold.exists() or hold.is_symlink():
        raise RuntimeError('Preserve existing deliberate/upgrade hold')
    value = private_json(STATE / 'status.json')
    if value.get('phase') in ('paused', 'stopped'):
        raise RuntimeError('Preserve deliberate worker pause')
    for unit in ('milo.service', 'grunt-amazing-adventure.service', 'grunt-adventure-execution-host.service'):
        if stage.unit_value(unit, 'ActiveState') != 'active':
            raise RuntimeError('Preserve inactive managed service')
        pid = int(stage.unit_value(unit, 'MainPID'))
        fields = Path(f'/proc/{pid}/stat').read_text().rpartition(') ')[2].split()
        if not fields or fields[0] in ('T', 't', 'Z'):
            raise RuntimeError('Preserve paused/nonrunning managed process')


def remaining_timeout(deadline, now):
    if not math.isfinite(deadline) or not math.isfinite(now):
        raise ValueError('Finite absolute admission budget required')
    remaining = math.floor(deadline - now)
    if not 0 < remaining <= 7200:
        raise RuntimeError('Fresh authorized admission budget expired or invalid')
    return remaining


def wait_for_normal_registry(deadline, approved, *, clock=time.monotonic,
                             sleep=time.sleep, read=lambda: private_json(CACHE),
                             check_pause=preserve_pause):
    while True:
        remaining_timeout(deadline, clock())
        check_pause()
        if cache_matches(read(), approved):
            return
        sleep(min(15, max(0, deadline - clock())))
