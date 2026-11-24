"""Read-only collector identity/checkpoint preservation; never sends a collector cycle."""
import hashlib,json,os,stat,uuid
from pathlib import Path
import hostpaths
UNIT='grunt-admin-collector.service'
def assert_entry(unit_reader,node):
 value=unit_reader(UNIT,'ExecStart').split(' ; ignore_errors=',1)[0]
 expected=node+' '+hostpaths.COLLECTOR_ENTRY
 if 'argv[]='+expected not in value:raise RuntimeError('Collector entry point differs from the upgraded primary runtime')
def _stopped(unit_reader):
 if unit_reader(UNIT,'MainPID')!='0' or unit_reader(UNIT,'ActiveState') not in ('inactive','failed'):raise RuntimeError('Collector must remain gracefully stopped')
def _read(config):
 path=Path(config)/'admin-collector-state.json'
 info=path.lstat()
 if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_mode&0o077:raise RuntimeError('Unsafe collector checkpoint')
 raw=path.read_bytes()
 if len(raw)>4096:raise RuntimeError('Oversized collector checkpoint')
 value=json.loads(raw)
 if value.get('version')!=1 or value.get('cursor') is not None and not str(value['cursor']).isdigit():raise RuntimeError('Invalid collector checkpoint')
 return raw,value

def capture(config,root,unit_reader):
 _stopped(unit_reader);raw,value=_read(config)
 path=Path(root)/('collector-checkpoint-before-'+uuid.uuid4().hex+'.json')
 with path.open('xb') as stream:os.chmod(path,0o600);stream.write(raw);stream.flush();os.fsync(stream.fileno())
 return {'sha256':hashlib.sha256(raw).hexdigest(),'cursor':value.get('cursor'),'streamId':value.get('streamId'),'snapshotPath':str(path)}
def assert_preserved(config,baseline,unit_reader):
 _stopped(unit_reader);raw,_=_read(config)
 if hashlib.sha256(raw).hexdigest()!=baseline['sha256']:raise RuntimeError('Collector checkpoint changed while stopped')
