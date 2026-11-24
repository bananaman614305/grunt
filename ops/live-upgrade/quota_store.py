"""Offline SQLite preservation only. Caller must stop every writer and back up family first."""
import hashlib,json,sqlite3,shutil,os
from pathlib import Path
SUFFIXES=('', '-journal','-wal','-shm')
def digest_rows(db):
    rows={}
    for table in ('routing_performance','routing_backoff'):
        rows[table]=db.execute('SELECT * FROM '+table+' ORDER BY rowid').fetchall()
    return hashlib.sha256(json.dumps(rows,separators=(',',':')).encode()).hexdigest()
def backup(directory,target):
    target=Path(target);target.mkdir(mode=0o700);rows=[]
    for suffix in SUFFIXES:
        p=Path(directory)/('routing-history.db'+suffix)
        if p.is_symlink() or p.exists() and not p.is_file():raise RuntimeError('Unsafe routing history family')
        if p.exists():
            q=target/p.name;shutil.copy2(p,q);q.chmod(0o600);rows.append({'name':p.name,'sha256':hashlib.sha256(q.read_bytes()).hexdigest()})
    return rows

def prepare(directory,captured,now):
    path=Path(directory)/'routing-history.db'
    if not path.exists(): return {'schemaBefore':None,'schemaAfter':None,'windows':captured['windows'],'rawRowsPreserved':True}
    if path.is_symlink():raise RuntimeError('Unsafe routing history database')
    db=sqlite3.connect(str(path),timeout=2)
    try:
        db.execute('BEGIN IMMEDIATE');version=db.execute('PRAGMA user_version').fetchone()[0]
        if version != 2:raise RuntimeError('Unsupported routing history schema')
        before=digest_rows(db);windows={row['id']:dict(row) for row in captured['windows'] if row['retryAt']>now}
        for source,raw in db.execute('SELECT source,value FROM routing_backoff'):
            value=json.loads(raw);until=value.get('until')
            if not isinstance(until,(int,float)) or isinstance(until,bool):raise RuntimeError('Invalid persisted cooldown')
            if until<=now:continue
            code=value.get('code')
            if code not in ('quota','upstream','timeout','refused') or until-now>32*86400000:raise RuntimeError('Unrecognized persisted cooldown')
            old=windows.get(source);windows[source]={'id':source,'code':'quota' if code=='quota' or old and old['code']=='quota' else code,'retryAt':max(until,old['retryAt'] if old else 0)}
        # Installed 0.9.7 and candidate both use schema 2. Never migrate/reset existing routing.
        if digest_rows(db)!=before:raise RuntimeError('Routing history raw rows changed during schema preparation')
        db.commit()
        return {'schemaBefore':version,'schemaAfter':2,'rawRowsSha256':before,'rawRowsPreserved':True,'windows':[windows[k] for k in sorted(windows)]}
    except BaseException:db.rollback();raise
    finally:db.close()

def restore(directory,target,rows,failed):
    target=Path(target);failed=Path(failed);failed.mkdir(mode=0o700)
    for row in rows:
        if hashlib.sha256((target/row['name']).read_bytes()).hexdigest()!=row['sha256']:raise RuntimeError('Routing backup changed')
    for suffix in SUFFIXES:
        p=Path(directory)/('routing-history.db'+suffix)
        if p.is_symlink():raise RuntimeError('Unsafe routing history rollback path')
        if p.exists():os.rename(p,failed/p.name)
    for row in rows:shutil.copy2(target/row['name'],Path(directory)/row['name'])

def assert_future(directory,captured,now):
    path=Path(directory)/'routing-history.db'
    if path.is_symlink():raise RuntimeError('Unsafe held routing history path')
    db=sqlite3.connect('file:'+str(path)+'?mode=ro',uri=True,timeout=2)
    try:
        if db.execute('PRAGMA user_version').fetchone()[0]!=2:raise RuntimeError('Unexpected routing schema; no migration is authorized')
        values={source:json.loads(raw) for source,raw in db.execute('SELECT source,value FROM routing_backoff')}
        for row in captured['windows']:
            if row['retryAt']<=now:continue
            value=values.get(row['id'],{})
            if value.get('until',0)<row['retryAt'] or row['code']=='quota' and value.get('code')!='quota':raise RuntimeError('Future persisted deadline deleted or shortened')
    finally:db.close()

def future_rows(directory,now):
    path=Path(directory)/'routing-history.db'
    if path.is_symlink():raise RuntimeError('Unsafe routing proof path')
    db=sqlite3.connect('file:'+str(path)+'?mode=ro',uri=True,timeout=2)
    try:
        rows={}
        for source,raw,at in db.execute('SELECT source,value,at FROM routing_backoff'):
            until=json.loads(raw).get('until')
            if isinstance(until,(int,float)) and not isinstance(until,bool) and until>now:
                rows[source]={'until':until,'rowSha256':hashlib.sha256(json.dumps([raw,at],separators=(',',':')).encode()).hexdigest()}
        return rows
    finally:db.close()

def assert_future_rows(directory,baseline,now):
    actual=future_rows(directory,now)
    expected={key:value for key,value in baseline.items() if value['until']>now}
    if actual!=expected:raise RuntimeError('Persisted future routing rows changed during held startup')
