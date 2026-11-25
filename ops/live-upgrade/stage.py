#!/usr/bin/env python3
"""Stage fresh, explicitly pinned public bytes; never modify live files/services."""
import argparse,base64,hashlib,json,os,re,shutil,subprocess,tarfile
from pathlib import Path,PurePosixPath
from release_proof import tree_digest,assert_profile
from rollout_config import VERSION,PREVIOUS_VERSION,helper_files,load_expectations,launcher_opt_ins
import hostpaths
ROOT=Path(__file__).resolve().parent
OWNER=hostpaths.OWNER;STATE=hostpaths.STATE;CONFIG=hostpaths.CONFIG
NODE=hostpaths.NODE
RUNTIMES=[CONFIG/'runtime',OWNER/'runtime']
# Owner-side files an attempt may replace together with the runtimes: the 8793 launcher, the Claude Code builder's brief and
# release CLI, and the hash manifest that pins them. Optional: only the files present in ROOT/payload (see `upgrade.py --payload`)
# are installed; an attempt without a payload leaves every owner file alone.
OWNER_FILES=('free-pool.mjs','claude/worker-brief.md','claude/bin/grunt-release','claude/assets.json')
ASSET_NAMES=('worker-brief.md','settings.json','hooks/stop_gate.py','bin/grunt-release','bin/claude')
# Same list the Claude Code cutover scans its runner and assets with; the removal release must never be re-introduced by an owner file.
FORBIDDEN_LAUNCHER_TOKENS=('worker-pi','worker-pool','worker-runtime','/v1/workers','grunt_spawn','grunt_coordinate','grunt_worker_','grunt_delegate','usegrunt workers','grunt_job_','grunt_checkpoint_','GRUNT_JOBS_STATE_DIR','GRUNT_CHECKPOINT_STATE_DIR','createWorkerRuntime')
UNITS=('milo.service','grunt-amazing-adventure.service','grunt-adventure-execution-host.service','grunt-admin-collector.service','grunt-adventure-activity.service','grunt-efficiency-observer.timer','grunt-efficiency-observer.service')
ENV=hostpaths.systemd_env()
MEMORY_ROOT=hostpaths.MEMORY_ROOT
OBSERVER_STATE=hostpaths.EFFICIENCY_STATE
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def save(p,v):
 t=p.with_suffix('.tmp');t.write_text(json.dumps(v,indent=2)+'\n');t.chmod(0o600);os.replace(t,p)
def unit_value(unit,field):return subprocess.check_output(['systemctl','--user','show',unit,'-p',field,'--value'],env=ENV,text=True,timeout=5).strip()
def unit_fingerprint(unit):
 rows={key:unit_value(unit,key) for key in ('ExecStart','Environment','EnvironmentFiles','UnsetEnvironment','Restart','FragmentPath','DropInPaths','User')}
 rows['ExecStart']=rows['ExecStart'].split(' ; ignore_errors=',1)[0]
 return hashlib.sha256(json.dumps(rows,sort_keys=True).encode()).hexdigest()
def protected_paths():
 return [STATE/'config.json',STATE/'worker/execution-channel.json',OWNER/'supervisor.py',CONFIG/'execution-host-adventure.json',hostpaths.ADMIN_STATE/'runtime/collector.env',CONFIG/'automatic-pool.json',CONFIG/'data-sharing-consent.json',CONFIG/'registry.json',hostpaths.SYSTEMD_USER/'grunt-adventure-execution-host.service',hostpaths.SYSTEMD_USER/'milo.service.d/50-grunt-account-acquisition.conf',hostpaths.RUNTIME_DIR/'systemd/user.control/grunt-amazing-adventure.service.d/50-MemoryHigh.conf',hostpaths.EFFICIENCY_LIB/'passive-efficiency-collector.py',*[hostpaths.SYSTEMD_USER/('grunt-efficiency-observer.'+x) for x in ('service','timer')]]
def expected_assets(owner,payload):
 """New assets.json bytes: the live manifest with only the payload's brief and/or release CLI re-hashed. Everything else must already match the live files."""
 root=Path(owner)/'claude';live=json.loads((root/'assets.json').read_text())
 if set(live.get('files',{}))!=set(ASSET_NAMES):raise RuntimeError('Claude Code asset set changed')
 files={}
 for name in ASSET_NAMES:
  path=root/name
  if path.is_symlink() or not path.is_file() or sha(path)!=live['files'][name]:raise RuntimeError('Live Claude Code asset differs from its manifest: '+name)
  shipped=Path(payload)/'claude'/name
  files[name]=sha(shipped) if name in ('worker-brief.md','bin/grunt-release') and shipped.is_file() else live['files'][name]
 return (json.dumps({'files':files},indent=1)+'\n').encode()
def owner_rows(staged,payload=None):
 """Verify the payload against the live owner tree and copy it into the private stage; returns the plan rows (none without a payload)."""
 payload=Path(payload or ROOT/'payload');rows=[]
 names=tuple(name for name in OWNER_FILES if (payload/name).exists() or (payload/name).is_symlink()) if payload.is_dir() else ()
 if not names:return rows
 if ('claude/assets.json' in names)!=any(name in names for name in ('claude/worker-brief.md','claude/bin/grunt-release')):raise RuntimeError('Payload claude/assets.json must accompany exactly a changed brief or release CLI')
 for name in names:
  source=payload/name;dest=OWNER/name
  if source.is_symlink() or not source.is_file() or dest.is_symlink() or not dest.is_file():raise RuntimeError('Owner payload or live owner file missing: '+name)
  if any(p.is_symlink() for p in source.parents if p!=payload.parent) or any(p.is_symlink() for p in dest.parents if p!=OWNER.parent):raise RuntimeError('Unsafe owner path: '+name)
 for name in names:
  body=(payload/name).read_text()
  if any(token in body for token in FORBIDDEN_LAUNCHER_TOKENS):raise RuntimeError('Owner payload references removed subworker features: '+name)
 if 'claude/assets.json' in names and (payload/'claude/assets.json').read_bytes()!=expected_assets(OWNER,payload):raise RuntimeError('Payload assets.json is not the live manifest with the new brief and release CLI')
 for name in names:
  source=payload/name;dest=OWNER/name;target=staged/'owner'/name;target.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
  data=source.read_bytes();target.write_bytes(data);target.chmod(0o600)
  rows.append({'dest':str(dest),'staged':str(target),'oldSha256':sha(dest),'newSha256':hashlib.sha256(data).hexdigest(),'mode':dest.stat().st_mode&0o777})
 return rows
def memory_policy():
 return {name:(MEMORY_ROOT/name).read_text().strip() for name in ('memory.high','memory.max')}
def assert_memory_policy(expected):
 if expected!={'memory.high':'3221225472','memory.max':'4294967296'} or memory_policy()!=expected:raise RuntimeError('Intentional Grunt memory policy changed')
def cpu_policy():
 return (MEMORY_ROOT/'cpu.max').read_text().strip()
def assert_cpu_policy(expected):
 try:
  quota,period=map(int,expected.split())
  valid=quota>0 and period>0 and quota==2*period
 except (AttributeError,TypeError,ValueError):valid=False
 if not valid or cpu_policy()!=expected:raise RuntimeError('Intentional Grunt two-CPU policy changed')
def observer_snapshot():
 info=OBSERVER_STATE.stat()
 if OBSERVER_STATE.is_symlink() or info.st_uid!=os.getuid() or info.st_mode&0o077:raise RuntimeError('Unsafe passive observer state directory')
 return {'path':str(OBSERVER_STATE),'device':info.st_dev,'inode':info.st_ino,'timerActive':unit_value('grunt-efficiency-observer.timer','ActiveState')}
def assert_observer(expected):
 actual=observer_snapshot()
 if actual!=expected or actual['timerActive']!='active':raise RuntimeError('Passive observer timer/state identity changed')
def sqlite_paths():
 # Runtime-owned schema stores only. Provider-owned router/account databases and the
 # independent observer database are preserved in place, never opened or copied here.
 # (The per-worker background-jobs databases are not listed: 0.10.0 removed Grunt's jobs and no runtime writes them.)
 paths={str(CONFIG/'routing-history.db'),str(CONFIG/'diagnostics.db'),str(CONFIG/'maintenance-lock.db'),str(STATE/'execution-host/efficiency/diagnostics.db')}
 for unit in ('milo.service','grunt-amazing-adventure.service','grunt-adventure-execution-host.service'):
  if int(unit_value(unit,'MainPID'))<=1:raise RuntimeError('Expected active runtime writer for SQLite inventory')
 return sorted(paths)
def stage(args):
 if (ROOT/'runtime-stage.json').exists():raise RuntimeError('Preserve existing stage')
 archive=Path(args.archive).resolve();source=Path(args.source).resolve();pins=json.loads(Path(args.release_manifest).read_text())
 if pins.get('version')!=VERSION or pins.get('previousVersion')!=PREVIOUS_VERSION:raise RuntimeError('Explicit fresh release versions required')
 if not re.fullmatch('[0-9a-f]{40}',pins.get('sourceCommit','')):raise RuntimeError('Reviewed release commit required')
 if subprocess.check_output(['git','-C',str(source),'rev-parse','HEAD'],text=True,timeout=5).strip()!=pins['sourceCommit']:raise RuntimeError('Reviewed source commit mismatch')
 integrity='sha512-'+base64.b64encode(hashlib.sha512(archive.read_bytes()).digest()).decode()
 if integrity!=pins.get('archiveIntegrity') or sha(archive)!=pins.get('archiveSha256'):raise RuntimeError('Public archive integrity mismatch')
 if not re.fullmatch('[0-9a-f]{64}',args.opencode_profile_sha256):raise RuntimeError('Explicit reviewed native OpenCode profile pin required')
 contents={}
 with tarfile.open(archive) as package:
  for member in package.getmembers():
   parts=PurePosixPath(member.name).parts
   if not parts or parts[0]!='package' or any(p in ('.','..') for p in parts):raise RuntimeError('Unsafe package path')
   if member.isdir():continue
   if not member.isfile() or len(parts)<2 or member.size>20*1024*1024:raise RuntimeError('Unsupported package entry')
   name='/'.join(parts[1:])
   if name in contents:raise RuntimeError('Duplicate package entry')
   body=package.extractfile(member).read()
   if (source/name).is_symlink() or (source/name).read_bytes()!=body:raise RuntimeError('Reviewed build bytes differ')
   contents[name]=(body,member.mode&0o755)
 hashes={n:hashlib.sha256(b).hexdigest() for n,(b,m) in contents.items()}
 if hashes!=pins.get('packageFiles') or not hashes:raise RuntimeError('Explicit public package manifest mismatch')
 identity=json.loads(contents['package.json'][0])
 if identity.get('name')!='usegrunt' or identity.get('version')!=VERSION:raise RuntimeError('Unexpected public package manifest')
 assert_profile(STATE,OWNER);memory=memory_policy();assert_memory_policy(memory);cpu=cpu_policy();assert_cpu_policy(cpu);observer=observer_snapshot();assert_observer(observer)
 protected={str(p):sha(p) for p in protected_paths()}
 staged=ROOT/'staged';staged.mkdir(mode=0o700);rows=[]
 for index,live in enumerate(RUNTIMES):
  if live.is_symlink() or not live.is_dir():raise RuntimeError('Unsafe live runtime')
  old=json.loads((live/'package.json').read_text())
  if old.get('name') not in ('usegrunt','grunt-runtime','milo-runtime') or old.get('version')!=PREVIOUS_VERSION:raise RuntimeError('Unexpected installed previous runtime')
  for key in ('dependencies','devDependencies','optionalDependencies','engines'):
   if old.get(key)!=identity.get(key):raise RuntimeError('Dependency/engine manifest changed; no installs authorized')
  # Verify dependency tree before beginning its copy, then verify both copies again.
  digest=tree_digest(live/'node_modules')
  new=staged/str(index);new.mkdir(mode=0o700)
  if new.stat().st_dev!=live.parent.stat().st_dev:raise RuntimeError('Cross-filesystem package swap')
  for name,(body,mode) in contents.items():
   p=new/name;p.parent.mkdir(mode=0o700,parents=True,exist_ok=True);p.write_bytes(body);p.chmod(mode)
  shutil.copytree(live/'node_modules',new/'node_modules',symlinks=True)
  if tree_digest(live/'node_modules')!=digest or tree_digest(new/'node_modules')!=digest:raise RuntimeError('Dependency copy differs')
  files={str(p.relative_to(live)):sha(p) for p in [live/'package.json',live/'README.md',*(live/'dist').rglob('*')] if p.is_file() and not p.is_symlink()}
  rows.append({'live':str(live),'new':str(new),'oldFiles':files,'dependenciesSha256':digest})
 owner=owner_rows(staged)
 launcher=((ROOT/'payload/free-pool.mjs') if (ROOT/'payload/free-pool.mjs').is_file() else OWNER/'free-pool.mjs').read_text()   # the launcher that will run: the payload's, else the live one
 # The launcher alone decides which opt-in sources 8793 serves; the gate pins that set (the owner-approved per-port additions included), so a
 # launcher that names more, fewer or other opt-ins is refused here, before anything is paused, not discovered after the restart.
 literals=re.findall(r"GRUNT_OPT_IN_SOURCES\s*:\s*'([^']*)'",launcher);expected=launcher_opt_ins(load_expectations())
 if len(literals)!=1 or sorted(literals[0].split(','))!=expected or len(set(literals[0].split(',')))!=len(literals[0].split(',')):raise RuntimeError('Launcher GRUNT_OPT_IN_SOURCES must be exactly the reviewed opt-ins: '+','.join(expected))
 for target in sorted(set(re.findall(r"from '\./runtime/([^']+)'",launcher))):
  if not (staged/'1'/target).is_file():raise RuntimeError('Launcher imports a module the staged runtime lacks: '+target)
 helpers={p.name:sha(p) for p in helper_files(ROOT)}
 plan={'version':VERSION,'previousVersion':PREVIOUS_VERSION,'archive':str(archive),'archiveIntegrity':integrity,'archiveSha256':pins['archiveSha256'],'reviewedSource':str(source),'sourceCommit':pins['sourceCommit'],'publicPinsSha256':sha(args.release_manifest),'packageFiles':hashes,'runtimes':rows,'protectedFiles':protected,'ownerFiles':owner,'unitFingerprints':{u:unit_fingerprint(u) for u in UNITS},'helpers':helpers,'files':[],'startupJobs':False,'opencodeProfileSha256':args.opencode_profile_sha256,'memoryPolicy':memory,'cpuPolicy':cpu,'passiveObserver':observer,'sqliteFamilies':sqlite_paths()}
 save(ROOT/'runtime-stage.json',plan);save(ROOT/'release-state.json',{'version':VERSION,'state':'staged','liveChanges':False,'packageFiles':len(contents)})
 return plan
if __name__=='__main__':
 parser=argparse.ArgumentParser(description=__doc__)
 for name in ('archive','source','release-manifest','opencode-profile-sha256'):parser.add_argument('--'+name,required=True)
 stage(parser.parse_args())
