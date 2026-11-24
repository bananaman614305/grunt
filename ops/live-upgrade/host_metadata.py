"""Read only host queue identities/hashes. Never read authority keys or job artifacts."""
import hashlib,json,os,re,stat
from pathlib import Path
UUID=re.compile('[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
def snapshot(policy):
    state,channel=Path(policy['stateDirectory']),Path(policy['channelDirectory']);rows={}
    specs=[(state/'verification/requests','verification'),(state/'publication','publication'),(state/'publication-requests','ledger')]
    specs.extend((channel/name,name) for name in ('verification-inbox','verification-results','publication-inbox','publication-results','releases'))
    for directory,label in specs:
        if directory.is_symlink():raise RuntimeError('Unsafe host metadata directory')
        for path in sorted(directory.rglob('*')) if directory.exists() else []:
            if path.is_symlink():raise RuntimeError('Unsafe host metadata entry')
            if not path.is_file():continue
            # Whitelist metadata only; never keys, payload snapshots or result artifacts.
            rel=path.relative_to(directory)
            if label=='verification' and path.name not in ('request.json','status.json','verification.json'):continue
            if label!='verification' and not path.name.endswith('.json'):continue
            info=path.stat()
            if info.st_uid!=os.getuid() or info.st_size>1024*1024:raise RuntimeError('Unbounded host metadata')
            rows[label+'/'+rel.as_posix()]=hashlib.sha256(path.read_bytes()).hexdigest()
    return rows
