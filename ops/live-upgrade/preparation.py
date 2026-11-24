"""Preparation steps shared by the planned-pause controller: pinned private metadata, the registry cache refresh, and the "preserve any deliberate pause" guard. Imports perform no actions."""
import math
import os
from pathlib import Path
import stat
import time
import json

import hostpaths
import registry_cache
import registry_refresh
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


def _read_cache_bytes(path=CACHE):
    try:
        return registry_cache.private_bytes(path)
    except FileNotFoundError:
        return None


def _holds(body, registry_raw):
    """True when the cache bytes hold exactly this public registry (the etag may differ)."""
    try:
        return body is not None and cache_matches(json.loads(body), json.loads(registry_raw))
    except ValueError:
        return False


def bring_registry_current(root, approved_raw, approved_etag, *, runtime, node, directory=CACHE.parent, check_pause=preserve_pause, read_cache=_read_cache_bytes,
                           fetch=registry_refresh.fetch_public_registry, write=registry_refresh.write_cache, log=print, now=time.time):
    """Make the live registry cache equal the approved public registry now, instead of waiting (up to 6 h) for the daemon's own refresh.

    The running daemons keep the registry in memory and read the file only at startup, so this changes no routing; the planned restart
    loads it. The write goes through the installed runtime's RegistrySync (same validator, acceptance rule, canonical shape, atomic
    rename), the previous bytes are kept in `registry-cache-before-refresh.json`, and everything is recorded in `registry-refresh.json`.
    It runs before staging, so the protected-file digests and the registry-cache transition proof are computed against the new bytes.
    If the cache does not hold the registry right after the write (the daemon refreshed meanwhile, or the pinned publication is no
    longer accepted), the public registry is fetched again and the write retried once; then RegistryRefreshError. Nothing is staged or paused."""
    root = Path(root)
    receipt = {'at': now(), 'approvedSha256': registry_refresh.sha256(approved_raw), 'liveChanges': False, 'attempts': []}
    check_pause()
    before = read_cache()
    target = {'raw': approved_raw, 'etag': approved_etag, 'url': None}
    if before is not None and not _holds(before, approved_raw):
        registry_refresh.backup_bytes(root / 'registry-cache-before-refresh.json', before)
        receipt['originalBackup'] = str(root / 'registry-cache-before-refresh.json')
    if before is not None:
        receipt['originalRawSha256'] = registry_refresh.sha256(before)
    for attempt in (0, 1):
        published = json.loads(target['raw']).get('published')
        step = {'publication': published, 'sha256': registry_refresh.sha256(target['raw']), 'refetched': attempt == 1, 'source': target['url']}
        current = read_cache()
        if _holds(current, target['raw']):
            receipt.update(action='written' if receipt['liveChanges'] else 'none', rawSha256=registry_refresh.sha256(current), publication=published, refetched=attempt == 1)
            stage.save(root / 'registry-refresh.json', receipt)
            return receipt
        try:
            summary = write(runtime, directory, target['raw'], target['etag'], node=node)
            receipt['liveChanges'] = True
            written = read_cache()
            if written is None or registry_refresh.sha256(written) != summary.get('rawSha256'):   # compared to the bytes the writer reported, so a validator that normalizes cannot cause a false alarm
                raise registry_refresh.RegistryRefreshError('the live registry cache does not hold the registry that was just written (it was rewritten meanwhile)')
        except registry_refresh.RegistryRefreshError as error:
            receipt['attempts'].append({**step, 'error': str(error)[:300]})
            if attempt == 1:
                receipt.update(action='failed', failure=str(error)[:300])
                stage.save(root / 'registry-refresh.json', receipt)
                raise registry_refresh.RegistryRefreshError(f'the live registry cache could not be brought to the public registry after a re-fetch: {error}') from error
            log(f'[pause] registry cache not current ({str(error)[:160]}); fetching the public registry once more')
            check_pause()
            raw, url, etag = fetch()
            target = {'raw': raw, 'etag': etag, 'url': url}
            continue
        receipt.update(action='written', publication=summary.get('published'), previousPublication=summary.get('previousPublished'), rawSha256=registry_refresh.sha256(written),
                       refetched=attempt == 1, etag=target['etag'])
        receipt['attempts'].append({**step, 'written': True})
        stage.save(root / 'registry-refresh.json', receipt)
        return receipt
