"""Bring the live registry cache (~/.config/milo/registry.json) to the approved public registry without waiting for the daemon's own
six-hourly refresh. The running daemons keep the registry in memory and read this file only at startup, so writing it does not change
their routing; the planned restart loads it. The write is done by the installed runtime's own RegistrySync (registry_refresh.mjs), so
the validator, the acceptance rule, the canonical `{registry, etag}` shape and the atomic rename are the daemon's, not a copy.
Importing this module performs no action."""
import hashlib
import json
import os
import subprocess
import urllib.request
from pathlib import Path

import hostpaths

HERE = Path(__file__).resolve().parent
REGISTRY_URLS = ('https://api.grunt.run/v1/registry', 'https://milo-gateway.fly.dev/v1/registry')   # same order as src/local/registry.ts
SCRIPT = HERE / 'registry_refresh.mjs'


class RegistryRefreshError(RuntimeError):
    """The live cache could not be brought to a public registry; nothing was staged or paused."""


def fetch_public_registry(*, opener=urllib.request.urlopen):
    """(raw bytes, url, etag or None) from the first registry host that answers, like the daemon."""
    last = None
    for url in REGISTRY_URLS:
        try:
            with opener(url, timeout=20) as response:
                raw = response.read(8 * 1024 * 1024)
                headers = getattr(response, 'headers', None)
                etag = headers.get('ETag') if headers is not None else None
            json.loads(raw)
            return raw, url, etag if isinstance(etag, str) and 0 < len(etag) <= 4096 and not any(ord(c) < 32 or ord(c) == 127 for c in etag) else None
        except Exception as error:   # the first host does not resolve from every network; fall back like the daemon does
            last = error
    raise RegistryRefreshError('The public registry could not be fetched: ' + str(last)[:200])


def write_cache(runtime, directory, raw, etag, *, node, run=subprocess.run):
    """Write `raw` (a public registry body) into `directory`/registry.json through the installed runtime's RegistrySync. Returns its summary."""
    request = {'runtime': str(runtime), 'directory': str(directory), 'registry': raw.decode('utf-8'), 'etag': etag}
    result = run([node, str(SCRIPT)], input=json.dumps(request).encode(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60,
                 env={'PATH': '/usr/bin:/bin', 'HOME': str(hostpaths.HOME)})
    if result.returncode != 0:
        raise RegistryRefreshError((result.stderr or b'').decode('utf-8', 'replace').strip()[:300] or 'registry cache refresh failed')
    return json.loads(result.stdout)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def backup_bytes(path, body):
    """Keep the bytes the cache had before this attempt changed it (exclusive: never overwrites an earlier backup)."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(body)
        stream.flush()
        os.fsync(stream.fileno())
