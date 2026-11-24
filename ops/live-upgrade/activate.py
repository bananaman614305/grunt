#!/usr/bin/env python3
"""Reviewed runtime transaction (library). It has no command line: the planned-pause controller (pause-and-activate.py) calls
activate() on the supervisor it froze at a checkpoint, after exact public staging and a read-only preflight."""
import argparse, datetime, shutil, hashlib, importlib.util, json, os, re, select, stat, subprocess, sys, time, urllib.request
from pathlib import Path
from acquisition_guard import normalized_service_environment, assert_unit_opt_out, assert_process_opt_out
from rollout_checks import maintenance_coverage
import quota_store,host_metadata,sqlite_families,daemon_admission,collector_guard,source_transition,registry_cache
from rollout_config import VERSION, PREVIOUS_VERSION, CONSENT_GUARD_NAME
import hostpaths
from startup_gate import StartupGate, MaintenanceWindowError, TEMP_ENV_CONTENT
import stage as staging
from daemon_admission import OwnedDaemonAdmission
from release_proof import HOST_UNIT, tree_digest, assert_runtime, session_snapshot, assert_session_preserved, assert_profile, assert_host_installation, assert_public_archive, capture_cooldowns, assert_cooldowns
ROOT = Path(__file__).resolve().parent
OWNER = hostpaths.OWNER
STATE = hostpaths.STATE
NODE = hostpaths.NODE
HOST_POLICY = hostpaths.HOST_POLICY
PRIMARY_MAIN = hostpaths.PRIMARY_MAIN
UNITS = ('milo.service', 'grunt-amazing-adventure.service')
OBSERVERS = ('grunt-admin-collector.service', 'grunt-adventure-activity.service')
ENV = hostpaths.systemd_env()

def sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def save(path, data):
    temp = path.with_suffix('.tmp'); temp.write_text(json.dumps(data, indent=2) + '\n')
    temp.chmod(0o600); os.replace(temp, path)
def ctl(action, unit):
    subprocess.run(['systemctl', '--user', action, unit], env=ENV, check=True,
                   timeout=60, stdout=subprocess.DEVNULL)
def unit_value(unit, field):
    return subprocess.check_output(['systemctl', '--user', 'show', unit, '-p', field, '--value'],
                                   env=ENV, text=True, timeout=5).strip()
def inactive(unit): return unit_value(unit, 'MainPID') == '0' and unit_value(unit, 'ActiveState') in ('inactive', 'failed')
def pid(): return int(unit_value('grunt-amazing-adventure.service', 'MainPID'))
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs): raise RuntimeError('Unexpected loopback redirect')
def get(port, path):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(f'http://127.0.0.1:{port}{path}', timeout=5) as response:
        raw = response.read(4 * 1024 * 1024 + 1)
    if len(raw) > 4 * 1024 * 1024: raise RuntimeError('Oversized local response')
    return json.loads(raw)
def source_ids(status): return sorted(row['id'] for row in status['sources'])
def service_definition_hash():
    # ExecStart's tail contains process lifecycle metadata; pin only path/argv.
    exec_definition = unit_value('milo.service', 'ExecStart').split(' ; ignore_errors=', 1)[0]
    stable = [exec_definition, normalized_service_environment(unit_value('milo.service', 'Environment')), *[unit_value('milo.service', field) for field in ('EnvironmentFiles', 'UnsetEnvironment')]]
    return hashlib.sha256(json.dumps(stable).encode()).hexdigest()

def managed_primary_anchor():
    primary_pid = int(unit_value('milo.service', 'MainPID'))
    proc = Path('/proc') / str(primary_pid)
    command = [value.decode() for value in (proc / 'cmdline').read_bytes().split(b'\0') if value]
    if primary_pid <= 1 or command != [NODE, PRIMARY_MAIN] or os.readlink(proc / 'exe') != NODE:
        raise RuntimeError('Primary daemon is not the trusted managed entry point')
    effective = dict(row.split(b'=', 1) for row in (proc / 'environ').read_bytes().split(b'\0') if b'=' in row)
    def setting(name):
        value = effective.get(('GRUNT_' + name).encode(), effective.get(('MILO_' + name).encode()))
        return value.decode() if value is not None else None
    if setting('DAEMON') != '1' or setting('CONFIG_DIR') != str(hostpaths.CONFIG) or setting('PORT') != '8792':
        raise RuntimeError('Primary daemon lacks an unambiguous managed selection anchor')
    sources = [value.strip() for value in (setting('SOURCES') or '').split(',') if value.strip()]
    if not sources or len(sources) > 100 or len(set(sources)) != len(sources) or any(not re.fullmatch('[a-z][a-z0-9-]{0,63}', value) for value in sources):
        raise RuntimeError('Invalid actual primary source selection')
    # Hash the unit properties instead of exposing Environment secrets in a receipt.
    if unit_value('milo.service', 'EnvironmentFiles'): raise RuntimeError('Primary environment files require separate selection review')
    if any(name in unit_value('milo.service', 'UnsetEnvironment') for name in ('GRUNT_SOURCES', 'MILO_SOURCES', 'GRUNT_DAEMON', 'MILO_DAEMON')): raise RuntimeError('Primary source environment override is ambiguous')
    fingerprint = service_definition_hash()
    if int(unit_value('milo.service', 'MainPID')) != primary_pid: raise RuntimeError('Primary daemon changed during selection verification')
    return {'sources': sources, 'serviceDefinitionSha256': fingerprint}

class HostBusyError(RuntimeError):
    """The execution host is running (or has not yet acknowledged the hold over) a verification/publication job.
    Raised before any daemon is stopped or any file is changed, so it is a clean no-mutation, retryable outcome."""

def host_health(*, held):
    value = json.loads(subprocess.check_output([NODE, str(OWNER / 'runtime/dist/local/main.js'), 'execution-host', 'status', '--config', str(HOST_POLICY)], env=ENV, text=True, timeout=15))
    if (value.get('alive') is not True or value.get('policyMatches') is not True or value.get('pid') != int(unit_value(HOST_UNIT, 'MainPID'))
        or not isinstance(value.get('updatedAt'), (int, float)) or not 0 <= time.time() * 1000 - value['updatedAt'] < 30000):
        raise RuntimeError('Execution host health/identity not verified')
    if held and (value.get('state') != 'held' or value.get('activeVerification') is not False or value.get('activePublication') is not False):
        raise HostBusyError('Execution host must preserve startup hold without starting jobs')
    return {key: value[key] for key in ('pid', 'state', 'activeVerification', 'activePublication', 'updatedAt')}

RUNTIME_DIR=hostpaths.RUNTIME_DIR
ACTIVE_DEADLINE=None
ORIGINAL_CTL=ctl
def budget():
    if ACTIVE_DEADLINE is not None and time.monotonic()>=ACTIVE_DEADLINE:raise RuntimeError('Bounded held activation deadline exceeded')
def ctl(action,unit):
    budget();remaining=60 if ACTIVE_DEADLINE is None else max(.1,min(60,ACTIVE_DEADLINE-time.monotonic()))
    subprocess.run(['systemctl','--user',action,unit],env=ENV,check=True,timeout=remaining,stdout=subprocess.DEVNULL)
def primary_environment():
    p=int(unit_value('milo.service','MainPID'));root=Path('/proc')/str(p)
    values=dict(row.split(b'=',1) for row in (root/'environ').read_bytes().split(b'\0') if b'=' in row)
    if any(values.get(key) not in (None,b'') for key in (b'NODE_OPTIONS',b'NODE_PATH')):raise RuntimeError('Preserve unreviewed Node startup overrides')
    allowed=('PORT','SOURCES','OPT_IN_SOURCES','DAEMON','CONFIG_DIR','SETUP_NO_DATA_SHARING','BACKGROUND_ACCOUNT_ACQUISITION')
    return {k.decode():v.decode() for k,v in values.items() if any(k.decode()==prefix+name for prefix in ('GRUNT_','MILO_') for name in allowed)}
def source_sets():return {str(port):source_ids(get(port,'/v1/status')) for port in (8792,8793)}
def assert_idle():
    for port in (8792,8793):
        if get(port,'/v1/status').get('activeRequests')!=0:raise RuntimeError('Pool/native work is active; preserve it')
def host_idle(held=False):
    value=host_health(held=held)
    if value['activeVerification'] or value['activePublication']:raise HostBusyError('Execution host owns active work; preserve it')
    return value
def host_quiet():
    """Checkpoint admission precondition: the host reports state 'idle' with no verification or publication running.
    A builder checkpoint does not imply this: `grunt-release verify` jobs keep running on the host after a cycle ends."""
    value=host_idle(held=False)
    if value['state']!='idle':raise HostBusyError('Execution host is not idle (state '+str(value['state'])+')')
    return value
def host_quiet_since(since_ms,wait=10):
    """Idle AND refreshed after since_ms. The host throttles health.json writes to once per 5 s, so an older 'idle' record can
    predate a job it started afterwards; a record written after the freeze reflects the host's own pickup decision."""
    until=time.monotonic()+wait
    while True:
        value=host_quiet()
        if value['updatedAt']>=since_ms:return value
        if time.monotonic()>=until:raise HostBusyError('Execution host idle record is stale; cannot prove it is still idle')
        time.sleep(.25)

def assert_guarded_unit_fingerprints(admission, expected):
    """Normalize only this operation's exact owned Restart=no drop-in."""
    guards={row['unit']:row for row in admission.guards}
    for unit,digest in expected.items():
        rows={key:unit_value(unit,key) for key in ('ExecStart','Environment','EnvironmentFiles','UnsetEnvironment','Restart','FragmentPath','DropInPaths','User')}
        rows['ExecStart']=rows['ExecStart'].split(' ; ignore_errors=',1)[0]
        guard=guards.get(unit)
        if guard:
            path=guard['path'];info=path.lstat()
            if path.is_symlink() or not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_mode&0o777!=0o600 or (info.st_dev,info.st_ino)!=(guard['device'],guard['inode']) or path.read_bytes()!=guard['data'] or rows['Restart']!='no':raise RuntimeError('Owned restart guard changed during quiet wait')
            drops=rows['DropInPaths'].split()
            if drops.count(str(path))!=1:raise RuntimeError('Owned restart guard missing from effective unit')
            drops.remove(str(path));rows['DropInPaths']=' '.join(drops);rows['Restart']=guard['originalRestart']
        if hashlib.sha256(json.dumps(rows,sort_keys=True).encode()).hexdigest()!=digest:raise RuntimeError('Managed unit definition changed during quiet wait')

def verify_retry_cleanup(admission, frozen, hold, validate):
    if (admission is None or admission.kill_started or admission.frozen
        or admission.guards or admission.receipt.get('restartGuardsRestored') is not True
        or admission.receipt.get('daemonAdmission') != 'aborted_without_terminating_work'):
        raise RuntimeError('Admission rejection cleanup is not retry-safe')
    if hold.exists() or hold.is_symlink(): raise RuntimeError('Hold remains after admission rejection')
    for row in admission.receipt.get('restartGuards', []):
        path=Path(row['path'])
        if path.exists() or path.is_symlink():raise RuntimeError('Restart guard remains after admission rejection')
    deadline=time.monotonic()+2
    while True:
        pending=False
        for row in admission._all_targets():
            ticks,state=admission._identity(row['pid'])
            if ticks!=row['ticks']:raise RuntimeError('Owned daemon identity changed during cleanup')
            if state in ('T','t'):pending=True
            elif state not in ('R','S','D','I'):raise RuntimeError('Owned daemon not resumed after rejection')
        ticks,state=frozen.gate._identity(frozen.pid)
        if ticks!=frozen.start_ticks:raise RuntimeError('Supervisor identity changed during cleanup')
        if state in ('T','t'):pending=True
        elif state not in ('R','S','D','I'):raise RuntimeError('Supervisor not resumed after rejection')
        if not pending:break
        if time.monotonic()>=deadline:raise RuntimeError('Owned freeze remains after rejection')
        time.sleep(.01)
    validate()
    return {'ownedHoldRemoved':True,'restartGuardsRestored':True,'noFrozenOwnedTargets':True,'noKillStarted':True,'unchangedUnitStageAndProtectedFingerprints':True}

def verify_host_busy_cleanup(frozen, hold, validate):
    """After a host-busy rejection before any admission: no hold, supervisor running again and identical, stage/units unchanged."""
    if hold.exists() or hold.is_symlink():raise RuntimeError('Hold remains after host-busy rejection')
    deadline=time.monotonic()+2
    while True:
        ticks,state=frozen.gate._identity(frozen.pid)
        if ticks!=frozen.start_ticks:raise RuntimeError('Supervisor identity changed during cleanup')
        if state in ('R','S','D','I'):break
        if state not in ('T','t') or time.monotonic()>=deadline:raise RuntimeError('Supervisor not resumed after host-busy rejection')
        time.sleep(.01)
    validate()
    return {'ownedHoldRemoved':True,'supervisorResumed':True,'noDaemonAdmission':True,'noKillStarted':True,'unchangedUnitStageAndProtectedFingerprints':True}


def activate(timeout, *, retry_mode=False, attempt_number=1, overall_deadline=None, after_cycle=None, frozen_in=None):
    global ACTIVE_DEADLINE
    if (ROOT/'startup-attempted.json').exists() or (ROOT/'work-may-resume.json').exists():raise RuntimeError('Preserve previous startup/release attempt; prompt root recovery required')
    plan=json.loads((ROOT/'runtime-stage.json').read_text())
    if plan.get('version')!=VERSION or plan.get('previousVersion')!=PREVIOUS_VERSION or plan.get('startupJobs') is not False:raise RuntimeError('Wrong staged upgrade')
    daemon_admission.OPENCODE_CONTENT_SHA256=plan['opencodeProfileSha256']
    stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    hold=STATE/'execution-upgrade-hold';hold_bytes=('grunt-'+VERSION+'-'+stamp).encode()
    temp_drop=RUNTIME_DIR/'systemd/user/milo.service.d'/CONSENT_GUARD_NAME
    receipt={'version':VERSION,'startedAt':stamp,'success':False,'runtimes':[],'workResumed':False,'afterCycle':after_cycle}
    changed=[];frozen=None;owned=False;admission=None;admission_for_retry=None;retry_safe=False;partial=False;mutating=False;resumed=False;new_started=False;store_backup=None;drop_owned=False;hold_identity=None;drop_identity=None;registry_proof=None;collector_stopped=False;collector_stop_attempted=False;collector_checkpoint=None
    owner_state={'installed':False,'changed':[]}
    def owner_files_expected():
        for row in plan.get('ownerFiles',[]):
            if sha(row['dest'])!=(row['newSha256'] if owner_state['installed'] else row['oldSha256']):raise RuntimeError('Owner launcher/brief/release CLI changed: '+row['dest'])
    def install_owner_files():
        # Called only with every managed daemon stopped. Each file is backed up beside itself, then replaced atomically.
        for row in plan.get('ownerFiles',[]):
            dest=Path(row['dest']);staged=Path(row['staged']);backup=dest.with_name(dest.name+'.before-'+VERSION+'-'+stamp)
            if dest.is_symlink() or staged.is_symlink() or sha(staged)!=row['newSha256'] or sha(dest)!=row['oldSha256']:raise RuntimeError('Owner file changed before install: '+row['dest'])
            if backup.exists() or backup.is_symlink():raise RuntimeError('Preserve existing owner-file backup')
            holder=dest.with_name('.'+dest.name+'.backup-'+stamp);holder.write_bytes(dest.read_bytes());holder.chmod(row['mode'])
            if sha(holder)!=row['oldSha256']:raise RuntimeError('Owner-file backup differs')
            os.replace(holder,backup);owner_state['changed'].append((dest,backup))
            temp=dest.with_name('.'+dest.name+'.new-'+stamp);temp.write_bytes(staged.read_bytes());temp.chmod(row['mode'])
            if sha(temp)!=row['newSha256']:raise RuntimeError('Owner-file copy differs')
            os.replace(temp,dest)
        owner_state['installed']=True;receipt['ownerFiles']=[{'dest':str(d),'backup':str(b)} for d,b in owner_state['changed']]
    def restore_owner_files():
        for dest,backup in reversed(owner_state['changed']):os.replace(backup,dest)
        owner_state['changed'].clear();owner_state['installed']=False
    def protected():
        for path,digest in plan['protectedFiles'].items():
            if registry_proof is not None and path==registry_proof['path']:
                verification=registry_cache.assert_preserved(registry_proof,candidate_runtime=plan['runtimes'][0]['live'],node=NODE,allow_derived=new_started)
                receipt['registryCacheTransitionProof']={**registry_proof,'verification':verification}
            elif sha(path)!=digest:raise RuntimeError('Protected configuration/owner/session profile changed: '+path)
        owner_files_expected();assert_profile(STATE,OWNER)
    def validate():
        budget();protected();assert_public_archive(plan);staging.assert_observer(plan['passiveObserver']);staging.assert_memory_policy(plan['memoryPolicy']);staging.assert_cpu_policy(plan['cpuPolicy'])
        for name,digest in plan['helpers'].items():
            if sha(ROOT/name)!=digest:raise RuntimeError('Reviewed upgrade helper changed: '+name)
        for row in plan.get('ownerFiles',[]):
            if Path(row['staged']).is_symlink() or sha(row['staged'])!=row['newSha256']:raise RuntimeError('Staged owner file changed: '+row['dest'])
        for unit,digest in plan['unitFingerprints'].items():
            if staging.unit_fingerprint(unit)!=digest:raise RuntimeError('Managed unit/source fingerprint changed: '+unit)
            if unit!='grunt-efficiency-observer.service' and not (collector_stopped and unit==collector_guard.UNIT):ctl('is-active',unit)
        for row in plan['runtimes']:
            live=Path(row['live']);new=Path(row['new'])
            if live.is_symlink() or new.is_symlink():raise RuntimeError('Unsafe runtime path')
            for name,digest in row['oldFiles'].items():
                if sha(live/name)!=digest:raise RuntimeError('Installed runtime changed since stage')
            if tree_digest(live/'node_modules')!=row['dependenciesSha256']:raise RuntimeError('Installed dependency tree changed')
            assert_runtime(new,plan,row)
        assert_process_opt_out(lambda field:unit_value('milo.service',field),NODE,PRIMARY_MAIN)
    def remove_hold():
        if owned and hold.is_file() and not hold.is_symlink() and (hold.stat().st_dev,hold.stat().st_ino)==hold_identity and hold.read_bytes()==hold_bytes:hold.unlink()
        else:raise RuntimeError('Owned startup hold changed; preserve and inspect')
    def restore_drop():
        nonlocal drop_owned
        if drop_owned:
            if temp_drop.is_symlink() or (temp_drop.stat().st_dev,temp_drop.stat().st_ino)!=drop_identity or temp_drop.read_bytes()!=TEMP_ENV_CONTENT:raise RuntimeError('Owned consent drop-in changed')
            temp_drop.unlink();drop_owned=False
            subprocess.run(['systemctl','--user','daemon-reload'],env=ENV,check=True,timeout=30,stdout=subprocess.DEVNULL)
    if hold.exists() or hold.is_symlink():raise RuntimeError('Preserve existing deliberate/upgrade hold')
    validate()
    ready_path=ROOT/'activation-ready.json'
    existing=json.loads(ready_path.read_text()) if ready_path.exists() else {}
    if existing.get('pid')!=os.getpid():save(ready_path,{'version':VERSION,'pid':os.getpid(),'phase':'waiting_for_natural_checkpoint','at':time.time(),'stageSha256':sha(ROOT/'runtime-stage.json'),'timeout':timeout,'overallMonotonicDeadline':overall_deadline,'liveChanges':False,'afterCycle':after_cycle})
    spec=importlib.util.spec_from_file_location('upgrade_checkpoint',ROOT/'checkpoint_gate.py');gate=importlib.util.module_from_spec(spec);sys.modules[spec.name]=gate;spec.loader.exec_module(gate)
    checkpoint=gate.CheckpointGate(status_path=STATE/'status.json',supervisor_pid=pid,expected_backend_script=OWNER/'free-pool.mjs',expected_node=NODE,after_cycle=after_cycle,host_idle=host_quiet)
    try:
        # frozen_in: the supervisor was frozen at a natural checkpoint by the planned maintenance pause (maintenance_pause.py); every post-freeze proof is re-run on it.
        with (checkpoint.verify_frozen(frozen_in) if frozen_in is not None else checkpoint.acquire(timeout_seconds=timeout)) as frozen:
            frozen_at_ms=int(time.time()*1000)
            validate();assert_idle();before_pools={p:get(p,'/v1/status') for p in (8792,8793)};sets={str(p):source_ids(v) for p,v in before_pools.items()}
            environment=primary_environment();environment['GRUNT_SETUP_NO_DATA_SHARING']='1'
            # Frozen builder: its status cannot change. Read now so a pre-mutation retry (host busy / maintenance window) has an exact completed cycle.
            receipt['beforeActivity']=gate.read_json(STATE/'status.json')
            hard_deadline_ms=int(time.time()*1000)+180000
            startup=StartupGate.capture(config_directory=HOST_POLICY.parent,candidate_runtime=Path(plan['runtimes'][0]['new']),node=NODE,effective_environment=environment,hard_deadline_ms=hard_deadline_ms,margin_ms=60000,source_ids_per_port=sets)
            startup.assert_ready(environment,source_ids_per_port=sets)
            transition=source_transition.capture_before({str(p):v for p,v in before_pools.items()},startup.baseline)
            receipt['sourceTransitionProof']=transition
            registry_path=str(HOST_POLICY.parent/'registry.json')
            registry_proof=registry_cache.capture(ROOT,registry_path,plan['protectedFiles'][registry_path],startup.baseline['registrySha256'])
            receipt['registryCacheTransitionProof']=registry_proof
            receipt.update(startupHardDeadlineMs=startup.hard_deadline_ms,earliestPotentialMaintenanceMs=min(startup.baseline['nextCheckAt'].values()),startupProof=startup.baseline)
            saved=session_snapshot(STATE,json.loads((STATE/'config.json').read_text())['sessionId']);receipt['savedSession']=saved
            receipt['sourceSets']=sets
            captured=capture_cooldowns(before_pools,sorted(set().union(*[set(v) for v in sets.values()])),int(time.time()*1000));receipt['preservedCooldowns']=captured
            if overall_deadline is not None and time.monotonic()>=overall_deadline:raise RuntimeError('Original admission budget expired before hold creation')
            # Last read before the hold: the builder is frozen at its checkpoint so it cannot queue new work, but the host may have
            # picked up an already queued job meanwhile. Busy here means no hold yet: HostBusyError is a retryable no-mutation outcome.
            host_quiet_since(frozen_at_ms)
            fd=os.open(hold,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600);owned=True
            hold_identity=(os.fstat(fd).st_dev,os.fstat(fd).st_ino)
            with os.fdopen(fd,'wb') as stream:stream.write(hold_bytes);stream.flush();os.fsync(stream.fileno())
            # Do not stop a host's in-flight checks/review. A held idle acknowledgement
            # precedes atomic process/socket admission of ALL three managed daemons.
            # The host checks the hold between jobs, so after the idle reads above only a job it started in the few milliseconds
            # between its last pickup scan and this file's creation can still be running; if it does not acknowledge 'held' within 30 s
            # that is a HostBusyError (nothing mutated yet: hold removed, supervisor resumed) and the next checkpoint is awaited.
            until=time.monotonic()+30
            while True:
                try:host_idle(held=True);break
                except Exception:
                    if time.monotonic()>=until:raise
                    time.sleep(.2)
            # Gracefully abort the old outbound collector before snapshot/admission.
            # It stays stopped until release; no verification cycle is sent.
            collector_guard.assert_entry(unit_value,NODE)
            collector_stop_attempted=True
            ctl('stop',collector_guard.UNIT);collector_stopped=True
            collector_checkpoint=collector_guard.capture(HOST_POLICY.parent,ROOT,unit_value)
            receipt['collectorCheckpoint']=collector_checkpoint
            policy=json.loads(HOST_POLICY.read_text());metadata=host_metadata.snapshot(policy);receipt['startupJobMetadataBefore']=metadata
            def quiet_time_budget():
                if time.monotonic()>=startup.monotonic_deadline or int(time.time()*1000)>=startup.hard_deadline_ms:raise RuntimeError('Fixed startup budget expired before daemon termination')
                if overall_deadline is not None and time.monotonic()>=overall_deadline:raise RuntimeError('Original admission budget expired before daemon termination')
            def quiet_checker():
                quiet_time_budget()
                if not frozen.stopped or checkpoint._identity(frozen.pid)!=(frozen.start_ticks,'T') or not checkpoint._checkpoint():raise RuntimeError('Owned frozen supervisor checkpoint changed')
                if not owned or hold.is_symlink() or not hold.is_file() or (hold.stat().st_dev,hold.stat().st_ino)!=hold_identity or hold.read_bytes()!=hold_bytes:raise RuntimeError('Owned startup hold changed during quiet wait')
                protected();assert_session_preserved(STATE,saved)
                for name,digest in plan['helpers'].items():
                    if sha(ROOT/name)!=digest:raise RuntimeError('Reviewed upgrade helper changed during quiet wait')
                for row in plan['runtimes']:
                    assert_runtime(Path(row['new']),plan,row)
                    if any(sha(Path(row['live'])/name)!=digest for name,digest in row['oldFiles'].items()) or tree_digest(Path(row['live'])/'node_modules')!=row['dependenciesSha256']:raise RuntimeError('Installed runtime changed during quiet wait')
                assert_guarded_unit_fingerprints(admission,plan['unitFingerprints'])
                assert_idle();host_idle(held=True)
                startup.assert_ready(environment,source_ids_per_port=sets)
                quiet_time_budget()
                return True
            admission=OwnedDaemonAdmission(node=NODE,primary_script=PRIMARY_MAIN,backend_script=str(OWNER/'free-pool.mjs'),primary_pid=int(unit_value('milo.service','MainPID')),backend_pid=frozen.backend_pid,supervisor_pid=frozen.pid,runtime_directory=RUNTIME_DIR,env=ENV,idle_checker=checkpoint._idle,host_pid=int(unit_value(HOST_UNIT,'MainPID')),host_script=str(OWNER/'runtime/dist/local/main.js'),host_policy=str(HOST_POLICY),quiet_checker=quiet_checker,quiet_timeout=60)
            admission_for_retry=admission
            receipt['daemonAdmissionProof']=admission.receipt
            try:
                admission.install_restart_guards();admission.freeze_and_verify();quiet_time_budget();admission.kill_verified_daemons()
            except BaseException:
                if admission.kill_started:partial=True;frozen.stopped=False
                else:
                    try:admission.abort_before_kill();admission=None
                    except BaseException:partial=True;frozen.stopped=False
                raise
            if not admission.all_dead:partial=True;frozen.stopped=False;raise RuntimeError('Daemon death not verified')
            mutating=True;ACTIVE_DEADLINE=startup.monotonic_deadline
            frozen.terminate_before_stop()
            for unit in (HOST_UNIT,*UNITS):ctl('stop',unit)
            if not all(inactive(u) for u in (HOST_UNIT,*UNITS)):raise RuntimeError('Managed units not confirmed stopped')
            admission.restore_restart_guards();admission=None;receipt['restartGuardsRestoredBeforeStart']=True
            protected();assert_session_preserved(STATE,saved);startup.assert_ready(environment,source_ids_per_port=sets)
            store_backup=sqlite_families.backup(plan['sqliteFamilies'],ROOT/'sqlite-families-before',stopped_units=(HOST_UNIT,*UNITS,collector_guard.UNIT),unit_reader=unit_value)
            receipt['sqliteFamilyBackup']=store_backup
            schema=quota_store.prepare(HOST_POLICY.parent,captured,int(time.time()*1000));captured={'capturedAt':int(time.time()*1000),'windows':schema['windows']};receipt['preservedCooldowns']=captured;receipt['schemaProof']=schema
            for row in plan['runtimes']:
                budget();live,new=Path(row['live']),Path(row['new']);backup=live.with_name(live.name+'.before-'+VERSION+'-'+stamp)
                if backup.exists() or backup.is_symlink():raise RuntimeError('Preserve existing runtime backup')
                os.rename(live,backup);changed.append((live,backup));os.rename(new,live);receipt['runtimes'].append({'live':str(live),'backup':str(backup)})
            install_owner_files()
            save(ROOT/'captured-cooldowns.json',captured)
            receipt['cooldownSeed']=json.loads(subprocess.check_output([NODE,str(ROOT/'seed-routing-history.mjs'),str(OWNER/'runtime'),str(HOST_POLICY.parent),str(ROOT/'captured-cooldowns.json')],text=True,timeout=20))
            if not receipt['cooldownSeed'].get('performanceUnchanged'):raise RuntimeError('Quota seed changed performance')
            future_rows=quota_store.future_rows(HOST_POLICY.parent,int(time.time()*1000));receipt['futureRoutingRowsAfterSeed']=future_rows
            # This temporary override changes only startup consent renewal behavior.
            # It is restored before release; the running process retains the opt-out.
            temp_drop.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
            if temp_drop.parent.resolve()!=temp_drop.parent or temp_drop.parent.stat().st_uid!=os.getuid() or temp_drop.parent.stat().st_mode&0o022:raise RuntimeError('Unsafe temporary unit drop-in directory')
            fd=os.open(temp_drop,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
            drop_identity=(os.fstat(fd).st_dev,os.fstat(fd).st_ino)
            with os.fdopen(fd,'wb') as stream:stream.write(TEMP_ENV_CONTENT);stream.flush();os.fsync(stream.fileno())
            drop_owned=True;subprocess.run(['systemctl','--user','daemon-reload'],env=ENV,check=True,timeout=20,stdout=subprocess.DEVNULL)
            new_started=True
            save(ROOT/'startup-attempted.json',{'version':VERSION,'stageSha256':sha(ROOT/'runtime-stage.json'),'at':time.time(),'noAutomaticRollback':True,'holdDevice':hold_identity[0],'holdInode':hold_identity[1]})
            for unit in UNITS:ctl('start',unit)
            ctl('start',HOST_UNIT)
            startup.candidate_runtime=str(Path(plan['runtimes'][0]['live']))
            # Poll only readiness. Every semantic invariant below is evaluated once and
            # fails held immediately; do not retry immutable/consent/quota failures.
            while True:
                budget()
                try:
                    for port in (8792,8793):get(port,'/v1/status')
                    host_idle(held=False)
                    break
                except (OSError,ValueError,subprocess.SubprocessError):
                    budget();time.sleep(1)
                except RuntimeError as error:
                    if 'health/identity not verified' not in str(error):raise
                    budget();time.sleep(1)
            protected();assert_idle();host_idle(held=True);startup.assert_ready(environment,source_ids_per_port=sets)
            for port in (8792,8793):
                value=get(port,'/v1/status')
                after_sources=source_transition.assert_after(value,str(port),transition)
                receipt.setdefault('sourceSetsAfter',{})[str(port)]=after_sources
                assert_cooldowns(value,source_transition.current_cooldowns(captured,str(port),transition),int(time.time()*1000));maintenance_coverage(value,startup.baseline['eligibleUnion'])
                if not get(port,'/v1/diagnostics/summary')['health']['available']:raise RuntimeError('Diagnostics unavailable')
            if host_metadata.snapshot(policy)!=metadata:raise RuntimeError('Startup verification/review/publication metadata changed')
            for row in plan['runtimes']:assert_runtime(row['live'],plan,row)
            quota_store.assert_future(HOST_POLICY.parent,captured,int(time.time()*1000))
            quota_store.assert_future_rows(HOST_POLICY.parent,future_rows,int(time.time()*1000))
            assert_session_preserved(STATE,saved)
            assert_process_opt_out(lambda field:unit_value('milo.service',field),NODE,PRIMARY_MAIN)
            startup.assert_process_environment(int(unit_value('milo.service','MainPID')),PRIMARY_MAIN)
            restore_drop()
            for unit,digest in plan['unitFingerprints'].items():
                if staging.unit_fingerprint(unit)!=digest:raise RuntimeError('Unit fingerprint not restored')
            for unit in OBSERVERS:
                if unit!=collector_guard.UNIT:ctl('is-active',unit)
            collector_guard.assert_preserved(HOST_POLICY.parent,collector_checkpoint,unit_value)
            staging.assert_observer(plan['passiveObserver'])
            staging.assert_memory_policy(plan['memoryPolicy']);staging.assert_cpu_policy(plan['cpuPolicy'])
            status=gate.read_json(STATE/'status.json')
            if status.get('phase')!='paused' or status.get('workerPid') is not None:raise RuntimeError('Replacement supervisor did not honor startup hold')
            quota_store.assert_future_rows(HOST_POLICY.parent,future_rows,int(time.time()*1000));startup.assert_ready(environment,source_ids_per_port=sets);protected();assert_session_preserved(STATE,saved);host_idle(held=True);assert_idle()
            # From this point, no automatic rollback may interrupt naturally resumed work.
            if not (owned and hold.is_file() and not hold.is_symlink() and (hold.stat().st_dev,hold.stat().st_ino)==hold_identity and hold.read_bytes()==hold_bytes):raise RuntimeError('Owned startup hold changed before release')
            budget()
            save(ROOT/'work-may-resume.json',{'version':VERSION,'stageSha256':sha(ROOT/'runtime-stage.json'),'at':time.time(),'noAutomaticRollback':True,'holdDevice':hold_identity[0],'holdInode':hold_identity[1]})
            budget()
            resumed=True;receipt['workMayResume']=True
            remove_hold()
            ctl('start',collector_guard.UNIT);collector_stopped=False
            ctl('is-active',collector_guard.UNIT)
            receipt.update(collectorRestartedFromNewPrimaryRuntime=True,success=True,startupHoldReleased=True,workResumed=True,startupJobMetadataUnchanged=True,completedAt=time.time())
    except BaseException as error:
        ACTIVE_DEADLINE=None;receipt.update(failureType=type(error).__name__,failure=str(error)[:600])
        if partial:
            receipt['rollback']='blocked_partial_admission_preserve_frozen_processes_and_hold'
            receipt['promptRootRecoveryRequired']=True
        elif resumed:receipt['rollback']='not_attempted_after_work_resumed'
        elif mutating:
            # Never kill newly admitted work while trying to roll back a startup failure.
            if new_started:
                receipt['rollback']='not_attempted_after_new_start_preserve_installed_runtimes_work_and_hold'
                receipt['promptRootRecoveryRequired']=True
                receipt['startupNoProbeProofNotIndefinite']=True
                receipt['operatorRecoveryRequiredByMs']=receipt.get('earliestPotentialMaintenanceMs',int(time.time()*1000))-60000
            else:
                for unit in (HOST_UNIT,*UNITS):ctl('stop',unit)
                if not all(inactive(u) for u in (HOST_UNIT,*UNITS)):raise RuntimeError('Preserve hold/backups: stop unverified') from error
                if admission is not None:admission.restore_restart_guards();admission=None
                restore_drop()
                restore_owner_files()
                for live,backup in reversed(changed):
                    if live.exists():os.rename(live,live.with_name(live.name+'.failed-'+VERSION+'-'+stamp))
                    os.rename(backup,live)
                if store_backup is not None:sqlite_families.restore(ROOT/'sqlite-families-before',store_backup,ROOT/'failed-sqlite-families',stopped_units=(HOST_UNIT,*UNITS,collector_guard.UNIT),unit_reader=unit_value)
                # Old runtime has durable history: restore original DB, then preserve any
                # live-captured deadline which had not reached that DB before the freeze.
                save(ROOT/'rollback-cooldowns.json',receipt['preservedCooldowns'])
                subprocess.check_output([NODE,str(ROOT/'seed-routing-history.mjs'),str(OWNER/'runtime'),str(HOST_POLICY.parent),str(ROOT/'rollback-cooldowns.json')],text=True,timeout=20)
                protected();assert_session_preserved(STATE,receipt['savedSession'])
                # Keep the hold: old primary would refresh policies and due maintenance
                # on restart. Recovery must re-prove the same startup gates first.
                receipt['rollback']='restored_previous_packages_and_quota_store_held_stopped'
        else:
            if admission is not None:admission.abort_before_kill()
            if owned:remove_hold()
            if collector_stop_attempted:
                try:
                    state=unit_value(collector_guard.UNIT,'ActiveState');main=unit_value(collector_guard.UNIT,'MainPID')
                    if state in ('inactive','failed') and main=='0':
                        if collector_checkpoint is None:collector_checkpoint=collector_guard.capture(HOST_POLICY.parent,ROOT,unit_value)
                        collector_guard.assert_preserved(HOST_POLICY.parent,collector_checkpoint,unit_value)
                        collector_guard.assert_entry(unit_value,NODE)
                        ctl('start',collector_guard.UNIT);ctl('is-active',collector_guard.UNIT)
                    elif state!='active' or not main.isdigit() or int(main)<=1:raise RuntimeError('Collector stop result is ambiguous')
                    collector_stopped=False;receipt['collectorRecoveredWithoutRuntimeMutation']=True
                except BaseException as collector_error:
                    receipt.update(promptRootRecoveryRequired=True,collectorRecoveryFailureType=type(collector_error).__name__,collectorRecovery='preserve_checkpoint_and_inspect_stopped_collector')
                    raise error
            if retry_mode and isinstance(error,(HostBusyError,MaintenanceWindowError)) and admission_for_retry is None and frozen is not None and not collector_stop_attempted and not receipt.get('promptRootRecoveryRequired'):
                # Host job in flight before any daemon was touched: the hold (if created) is already removed above and the
                # frozen supervisor is resumed on leaving the checkpoint context. Prove that, then wait for a later checkpoint.
                try:
                    completed_cycle=receipt.get('beforeActivity',{}).get('cycles')
                    if type(completed_cycle) is not int or completed_cycle<0:raise RuntimeError('Retry requires an exact completed-cycle identity')
                    receipt['retryCleanupProof']=verify_host_busy_cleanup(frozen,hold,validate)
                    receipt['retryCleanupProof']['completedCycle']=completed_cycle
                except BaseException as cleanup_error:
                    receipt.update(failureType=type(cleanup_error).__name__,failure=str(cleanup_error)[:600],retryDeclinedReason='cleanup verification failed')
                    raise
                if isinstance(error,MaintenanceWindowError):receipt['retryReason']='startup_maintenance_window';receipt['maintenanceWindow']={'earliestSource':error.earliest_source,'earliestCheckAtMs':error.earliest_at_ms,'floorMs':error.floor_ms}
                else:receipt['retryReason']='execution_host_busy'
                retry_safe=True;error.upgrade_retry_safe=True;error.upgrade_retry_after_cycle=completed_cycle
            if retry_mode and getattr(error,'admission_rejection_code',None)=='socket_busy' and not receipt.get('promptRootRecoveryRequired'):
                try:
                    completed_cycle=receipt.get('beforeActivity',{}).get('cycles')
                    if type(completed_cycle) is not int or completed_cycle<0:raise RuntimeError('Retry requires an exact completed-cycle identity')
                    receipt['retryCleanupProof']=verify_retry_cleanup(admission_for_retry,frozen,hold,validate)
                    receipt['retryCleanupProof']['completedCycle']=completed_cycle
                except BaseException as cleanup_error:
                    receipt.update(failureType=type(cleanup_error).__name__,failure=str(cleanup_error)[:600],retryDeclinedReason='cleanup verification failed')
                    raise
                retry_safe=True;error.upgrade_retry_safe=True;error.upgrade_retry_after_cycle=completed_cycle
        raise
    finally:
        ACTIVE_DEADLINE=None
        receipt['attemptNumber']=attempt_number
        if retry_safe:
            receipt['terminal']=False;receipt['retrySafe']=True
            path=ROOT/('admission-attempt-'+str(attempt_number).zfill(4)+'-'+str(time.time_ns())+'.json')
            save(path,receipt);save(ROOT/'release-state.json',{'version':VERSION,'state':'waiting_for_next_natural_checkpoint','lastAdmissionReceipt':str(path),'overallMonotonicDeadline':overall_deadline,'nextAfterCycle':completed_cycle})
        else:
            receipt['terminal']=True
            save(ROOT/'activation-receipt.json',receipt);save(ROOT/'release-state.json',{'version':VERSION,'state':'activated_pending_natural_activity' if receipt['success'] else 'unresolved','holdPresent':hold.exists(),'receipt':str(ROOT/'activation-receipt.json'),'promptRootRecoveryRequired':receipt.get('promptRootRecoveryRequired',False),'startupHardDeadlineMs':receipt.get('startupHardDeadlineMs'),'earliestPotentialMaintenanceMs':receipt.get('earliestPotentialMaintenanceMs'),'operatorRecoveryRequiredByMs':receipt.get('operatorRecoveryRequiredByMs')})
    return receipt

def run_with_retries(timeout, *, pause=1, clock=time.monotonic, sleep=time.sleep, initial_after_cycle=None):
    """One total checkpoint budget; only proven clean socket rejections retry. The planned-pause controller does not use this loop (it
    gives up cleanly and upgrade.py starts a fresh attempt); it stays because the cleanup proofs it relies on are what make a
    rejection retry-safe, and they are exercised end to end by the tests."""
    if initial_after_cycle is not None and (type(initial_after_cycle) is not int or initial_after_cycle<0):raise ValueError('Initial completed-cycle floor must be a nonnegative integer')
    deadline=clock()+timeout;attempt=0;last_error=None;after_cycle=initial_after_cycle
    while True:
        # Gate.acquire(0) may admit an already-visible boundary. Preserve that first
        # explicit no-wait call, but NEVER make an extra retry after budget expiry.
        if attempt and clock()>=deadline:
            value={'version':VERSION,'success':False,'terminal':True,'failureType':'AdmissionRetryBudgetExhausted','failure':'Original natural-checkpoint admission budget exhausted','attempts':attempt,'at':time.time(),'startupHoldPresent':(STATE/'execution-upgrade-hold').exists() or (STATE/'execution-upgrade-hold').is_symlink()}
            save(ROOT/'activation-receipt.json',value);save(ROOT/'release-state.json',{'version':VERSION,'state':'admission_budget_exhausted','receipt':str(ROOT/'activation-receipt.json')})
            raise RuntimeError(value['failure']) from last_error
        attempt+=1
        try:return activate(max(0,deadline-clock()),retry_mode=True,attempt_number=attempt,overall_deadline=deadline,after_cycle=after_cycle)
        except BaseException as error:
            if getattr(error,'upgrade_retry_safe',False) is not True:raise
            completed_cycle=getattr(error,'upgrade_retry_after_cycle',None)
            if type(completed_cycle) is not int or completed_cycle<0 or after_cycle is not None and completed_cycle<=after_cycle:raise RuntimeError('Retry completed-cycle proof is missing or not newer') from error
            after_cycle=completed_cycle
            last_error=error;remaining=deadline-clock()
            if remaining>0:sleep(min(pause,remaining))
