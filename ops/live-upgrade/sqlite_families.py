"""Exact SQLite-family copies only after all runtime writers stop; no schema changes."""
import hashlib,json,os,shutil,stat
from pathlib import Path
SUFFIXES=('', '-journal','-wal','-shm')
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def _quiescent(paths,stopped_units,unit_reader):
    if not stopped_units:raise RuntimeError('Explicit stopped-writer proof required')
    for unit in stopped_units:
        if unit_reader(unit,'MainPID')!='0' or unit_reader(unit,'ActiveState') not in ('inactive','failed'):
            raise RuntimeError('All runtime SQLite writers must be stopped')
    # Writer scope is the explicitly admitted runtime services and their exact
    # descendants, proven dead by OwnedDaemonAdmission before this call. Do not
    # claim inaccessible unrelated /proc namespaces are inspected or quiescent.

def _identity(p):
    info=p.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid():raise RuntimeError('Unsafe SQLite family member')
    return (info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns,info.st_ctime_ns)
def backup(paths,target,*,stopped_units,unit_reader):
    paths=[Path(p) for p in paths];target=Path(target)
    if len(set(map(str,paths)))!=len(paths) or any(not p.is_absolute() or p.resolve()!=p for p in paths):raise RuntimeError('Unsafe SQLite family scope')
    if target.exists() or target.is_symlink():raise RuntimeError('Preserve existing complete/partial database backup')
    _quiescent(paths,stopped_units,unit_reader)
    temporary=target.with_name(target.name+'.incomplete');temporary.mkdir(mode=0o700)
    identities={};rows=[]
    for path in paths:
        for suffix in SUFFIXES:
            p=Path(str(path)+suffix)
            if p.is_symlink():raise RuntimeError('SQLite family symlink')
            if p.exists():identities[str(p)]=_identity(p)
    for index,path in enumerate(paths):
        family=[]
        for suffix in SUFFIXES:
            p=Path(str(path)+suffix)
            if p.is_symlink():raise RuntimeError('SQLite family symlink')
            if str(p) in identities:
                if _identity(p)!=identities[str(p)]:raise RuntimeError('SQLite family changed before copying')
                q=temporary/(str(index)+suffix)
                shutil.copyfile(p,q);q.chmod(0o600)
                with q.open('rb') as stream:os.fsync(stream.fileno())
                if identities[str(p)]!=_identity(p) or sha(p)!=sha(q):raise RuntimeError('SQLite family changed while all writers should be stopped')
                family.append({'suffix':suffix,'sha256':sha(q),'bytes':q.stat().st_size})
        rows.append({'path':str(path),'index':index,'members':family})
    _quiescent(paths,stopped_units,unit_reader)
    for path in paths:
        for suffix in SUFFIXES:
            p=Path(str(path)+suffix)
            if p.exists()!=(str(p) in identities) or p.exists() and _identity(p)!=identities[str(p)]:raise RuntimeError('SQLite family membership changed during snapshot')
    manifest={'families':rows,'knownRuntimeWritersStopped':True,'schemaChanges':False}
    receipt=temporary/'manifest.json';receipt.write_text(json.dumps(manifest,indent=2)+'\n');receipt.chmod(0o600)
    with receipt.open('rb') as stream:os.fsync(stream.fileno())
    descriptor=os.open(temporary,os.O_DIRECTORY)
    try:os.fsync(descriptor)
    finally:os.close(descriptor)
    os.rename(temporary,target)
    return manifest

def restore(target,manifest,failed,*,stopped_units,unit_reader):
    target=Path(target);failed=Path(failed)
    paths=[Path(row['path']) for row in manifest['families']]
    _quiescent(paths,stopped_units,unit_reader)
    for row in manifest['families']:
        for member in row['members']:
            if sha(target/(str(row['index'])+member['suffix']))!=member['sha256']:raise RuntimeError('SQLite backup integrity changed')
    failed.mkdir(mode=0o700)
    for row in manifest['families']:
        path=Path(row['path'])
        for suffix in SUFFIXES:
            p=Path(str(path)+suffix)
            if p.is_symlink():raise RuntimeError('Unsafe SQLite rollback family')
            if p.exists():os.rename(p,failed/(str(row['index'])+suffix))
        for member in row['members']:
            p=Path(str(path)+member['suffix']);p.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
            shutil.copyfile(target/(str(row['index'])+member['suffix']),p);p.chmod(0o600)
    _quiescent(paths,stopped_units,unit_reader)
