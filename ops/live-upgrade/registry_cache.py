"""Preserve original raw cache; allow only identical validated derived catalog output.

The caller permits this exception only after new startup. No configuration or live
cache is written here. Normal RegistrySync may rewrite this generated cache.
"""
import hashlib,json,os,stat,subprocess
from pathlib import Path


def private_bytes(path):
    path=Path(path)
    if not path.is_absolute() or path.resolve()!=path:raise RuntimeError('Unsafe registry cache proof path')
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    with os.fdopen(fd,'rb') as stream:
        before=os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_uid!=os.getuid() or stat.S_IMODE(before.st_mode)!=0o600 or before.st_nlink!=1 or before.st_size>131072:raise RuntimeError('Unsafe registry cache proof file')
        body=stream.read(131073);after=os.fstat(stream.fileno())
        fields=lambda info:(info.st_ino,info.st_dev,info.st_size,info.st_mtime_ns,info.st_ctime_ns)
        if len(body)>131072 or fields(before)!=fields(after):raise RuntimeError('Registry cache changed during proof')
    return body


def capture(root,path,before_sha256,catalog_sha256):
    path=Path(path);body=private_bytes(path)
    if hashlib.sha256(body).hexdigest()!=before_sha256:raise RuntimeError('Original registry cache changed before checkpoint')
    if not isinstance(catalog_sha256,str) or len(catalog_sha256)!=64 or any(c not in '0123456789abcdef' for c in catalog_sha256):raise RuntimeError('Invalid candidate catalog pin')
    backup=Path(root)/'registry-cache-before.json'
    try:fd=os.open(backup,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    except FileExistsError:
        if private_bytes(backup)!=body:raise RuntimeError('Existing original registry cache backup changed')
    else:
        with os.fdopen(fd,'wb') as stream:stream.write(body);stream.flush();os.fsync(stream.fileno())
    return {'path':str(path),'originalRawSha256':before_sha256,'originalBackup':str(backup),
            'candidateCatalogSha256':catalog_sha256,'scope':'normal_generated_cache_only'}


def assert_preserved(proof,*,candidate_runtime,node,allow_derived):
    backup=private_bytes(proof['originalBackup'])
    if hashlib.sha256(backup).hexdigest()!=proof['originalRawSha256']:raise RuntimeError('Original registry cache backup was altered')
    raw=private_bytes(proof['path']);digest=hashlib.sha256(raw).hexdigest()
    if digest==proof['originalRawSha256']:return {'rawBytesUnchanged':True,'rawSha256':digest}
    if not allow_derived:raise RuntimeError('Protected registry cache changed before new startup')
    result=subprocess.run([node,str(Path(__file__).with_name('registry_cache_metadata.mjs'))],input=json.dumps({'path':proof['path'],'candidateRuntime':str(candidate_runtime),'expectedCatalogSha256':proof['candidateCatalogSha256']}).encode(),stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=10,env={'PATH':'/usr/bin:/bin','HOME':'/home/alan'})
    if result.returncode or len(result.stdout)>16384:raise RuntimeError('Protected generated registry cache changed semantics or shape')
    value=json.loads(result.stdout)
    if value.get('rawSha256')!=digest or value.get('catalogSha256')!=proof['candidateCatalogSha256'] or value.get('normalWriterShape') is not True:raise RuntimeError('Derived registry cache proof mismatch')
    return {'rawBytesUnchanged':False,**value,'originalRawBackupPreserved':True}
