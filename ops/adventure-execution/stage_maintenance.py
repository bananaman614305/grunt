#!/usr/bin/env python3
"""Stage owner pool maintenance wiring; never activate it or run inference."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat


def replace_once(text, before, after):
    if text.count(before) != 1:
        raise ValueError('Owner helper changed; review its current source before staging')
    return text.replace(before, after, 1)


def transform(source, runtime=None):
    if b'createSourceMaintenance' in source:
        raise ValueError('The owner helper already wires shared maintenance; nothing to stage')
    if runtime is not None and not (runtime / 'worker-runtime.js').is_file():
        raise ValueError('The installed Grunt runtime has no worker-runtime.js (subworkers were removed); '
                         'this helper only upgrades the older launcher that imports it. Nothing was staged')
    text = source.decode('utf-8')
    text = replace_once(text,
        "import { createWorkerRuntime } from './runtime/dist/local/worker-runtime.js';",
        "import { createWorkerRuntime } from './runtime/dist/local/worker-runtime.js';\n"
        "import { createSourceMaintenance } from './runtime/dist/local/runtime-maintenance.js';")
    text = replace_once(text, 'await sync.start();',
        'await sync.start();\n'
        'const maintenance=createSourceMaintenance(sources,{directory,notify:line=>console.error(line)});\n'
        'await maintenance.start();')
    text = replace_once(text, 'sync.close(),workerRuntime.close()',
                        'sync.close(),workerRuntime.close(),maintenance.close()')
    return text.encode('utf-8')


def stage(source, destination):
    source, destination = Path(source), Path(destination)
    if not source.is_absolute() or not destination.is_absolute() or destination.exists() or destination.is_symlink():
        raise ValueError('Use an absolute source path and a new absolute staging directory')
    fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_size > 128 * 1024:
            raise ValueError('Unexpected owner helper')
        original = stream.read()
    candidate = transform(original, source.parent / 'runtime' / 'dist' / 'local')
    destination.mkdir(mode=0o700)
    digest = lambda data: hashlib.sha256(data).hexdigest()
    receipt = {'schema': 'grunt-owner-maintenance-stage/v1', 'activated': False,
               'source': str(source), 'originalSha256': digest(original), 'candidateSha256': digest(candidate)}
    for name, data in [('free-pool.before.mjs', original), ('free-pool.next.mjs', candidate),
                       ('receipt.json', (json.dumps(receipt, indent=2) + '\n').encode())]:
        fd = os.open(destination / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    return receipt


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--stage', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(stage(args.source, args.stage)))
