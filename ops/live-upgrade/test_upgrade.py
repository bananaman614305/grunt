"""Synthetic transaction fixtures. Real public archive and SQLite; zero live signals/services."""
import contextlib,hashlib,importlib.util,io,json,os,shutil,sqlite3,sys,tarfile,tempfile,time,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import stage,activate,quota_store,host_metadata,base64,collector_guard
from daemon_admission import AdmissionError, OwnedDaemonAdmission as KernelAdmission
from rollout_config import helper_files
from startup_gate import StartupGate,GateError,MaintenanceWindowError,EXPECTED_UNION,EXPECTED_DEFERRED,EXPECTED_PORTS,EXPECTATIONS
HERE=Path(__file__).resolve().parent
OPT_INS="const options={GRUNT_OPT_IN_SOURCES:'antseed-vikey,reflection-beam'};\n"   # the launcher's reviewed opt-in literal; stage refuses any other
REAL_HOST_QUIET,REAL_HOST_QUIET_SINCE,REAL_HOST_IDLE=getattr(activate,'host_quiet',None),getattr(activate,'host_quiet_since',None),activate.host_idle  # before any fixture patching
class Upgrade(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent);self.addCleanup(self.temp.cleanup);self.base=Path(self.temp.name)
  self.root=self.base/'upgrade';self.root.mkdir();self.config=self.base/'config';self.config.mkdir();self.owner=self.base/'owner';self.owner.mkdir();self.state=self.base/'state';(self.state/'worker/claude/projects/game').mkdir(parents=True)
  (self.config/'registry.json').write_text('{"registry":"original fixture cache"}');(self.config/'registry.json').chmod(0o600)
  (self.state/'config.json').write_text('{"sessionId":"fixture","harness":"claude-code"}');(self.state/'worker/claude/projects/game/fixture.jsonl').write_text('saved history\n');(self.state/'worker/execution-channel.json').write_text('trusted binding')
  self.policy=self.config/'execution-host-adventure.json';self.policy.write_text(json.dumps({'stateDirectory':str(self.state/'execution-host'),'channelDirectory':str(self.state/'channel')}))
  (self.owner/'supervisor.py').write_text('trusted owner supervisor.py');(self.owner/'free-pool.mjs').write_text("import { createWorkerRuntime } from './runtime/dist/local/worker-pool.js';\n")
  assets={'worker-brief.md':b'old brief','settings.json':b'settings','hooks/stop_gate.py':b'hook','bin/grunt-release':b'old release cli','bin/claude':b'binary'}
  payload_files={'free-pool.mjs':b"import { configure } from './runtime/dist/local/main.js';\n"+OPT_INS.encode(),'claude/worker-brief.md':b'new brief','claude/bin/grunt-release':b'new release cli'}
  for name,body in assets.items():(self.owner/'claude'/name).parent.mkdir(parents=True,exist_ok=True);(self.owner/'claude'/name).write_bytes(body);(self.owner/'claude'/name).chmod(0o700 if name.startswith('bin/') else 0o600)
  (self.owner/'claude/assets.json').write_text(json.dumps({'files':{n:hashlib.sha256(b).hexdigest() for n,b in assets.items()}},indent=1)+'\n');(self.owner/'claude/assets.json').chmod(0o600)
  self.payload=self.root/'payload'
  for name,body in payload_files.items():(self.payload/name).parent.mkdir(parents=True,exist_ok=True);(self.payload/name).write_bytes(body)
  new_assets={**{n:hashlib.sha256(b).hexdigest() for n,b in assets.items()},'worker-brief.md':hashlib.sha256(b'new brief').hexdigest(),'bin/grunt-release':hashlib.sha256(b'new release cli').hexdigest()}
  (self.payload/'claude/assets.json').write_text(json.dumps({'files':new_assets},indent=1)+'\n')
  self.source=self.base/'source';self.source.mkdir()
  fixture_package={'name':'usegrunt','version':stage.VERSION,'dependencies':{'fixture':'1.0.0'},'engines':{'node':'>=22'}}
  payload={'package.json':json.dumps(fixture_package).encode(),'README.md':b'fixture readme','dist/local/main.js':b'fixture runtime','dist/admin/collector.js':b'fixture collector'}
  self.archive=self.base/'public.tgz'
  with tarfile.open(self.archive,'w:gz') as package:
   for name,body in payload.items():
    member=tarfile.TarInfo('package/'+name);member.size=len(body);member.mode=0o644;package.addfile(member,io.BytesIO(body))
    path=self.source/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(body)
  self.pins=self.base/'release-manifest.json';self.pins.write_text(json.dumps({'version':stage.VERSION,'previousVersion':stage.PREVIOUS_VERSION,'sourceCommit':'a'*40,'archiveIntegrity':'sha512-'+base64.b64encode(hashlib.sha512(self.archive.read_bytes()).digest()).decode(),'archiveSha256':stage.sha(self.archive),'packageFiles':{n:hashlib.sha256(b).hexdigest() for n,b in payload.items()}}))
  pkg=json.loads((self.source/'package.json').read_text());self.runtimes=[self.config/'runtime',self.owner/'runtime']
  for live in self.runtimes:
   (live/'dist').mkdir(parents=True);(live/'dist/old.js').write_text('old');(live/'README.md').write_text('old');(live/'package.json').write_text(json.dumps({**pkg,'version':stage.PREVIOUS_VERSION}));(live/'node_modules').mkdir();(live/'node_modules/dependency').write_text('unchanged')
  for p in helper_files(HERE):shutil.copy2(p,self.root/p.name)
  gate='''import contextlib,json\nfrom types import SimpleNamespace\nfrom pathlib import Path\ndef read_json(p):return json.loads(Path(p).read_text())\nclass CheckpointGate:\n def __init__(self,**kw):self.frozen=False\n def _identity(self,pid):return ('supervisor','T' if self.frozen else 'S')\n def _idle(self):return True\n def _checkpoint(self):return True\n def verify_frozen(self,frozen):\n  self.verified=getattr(self,'verified',0)+1;self.frozen=True;return frozen\n @contextlib.contextmanager\n def acquire(self,**kw):\n  self.frozen=True\n  value=SimpleNamespace(pid=102,backend_pid=104,start_ticks='supervisor',gate=self,stopped=True,terminate_before_stop=lambda:None)\n  try:yield value\n  finally:self.frozen=False;value.stopped=False\n'''
  (self.root/'checkpoint_gate.py').write_text(gate)
  protected=[self.config/'registry.json',self.state/'config.json',self.state/'worker/execution-channel.json',self.policy,self.owner/'supervisor.py']
  self.stack=contextlib.ExitStack();self.addCleanup(self.stack.close)
  for module in (stage,activate):
   for key,val in {'ROOT':self.root,'OWNER':self.owner,'STATE':self.state}.items():self.stack.enter_context(patch.object(module,key,val))
  self.stack.enter_context(patch.object(stage,'RUNTIMES',self.runtimes));self.stack.enter_context(patch.object(stage,'protected_paths',return_value=protected));self.stack.enter_context(patch.object(stage,'unit_fingerprint',return_value='fixture'))
  self.stack.enter_context(patch.object(stage,'memory_policy',return_value={'memory.high':'3221225472','memory.max':'4294967296'}))
  self.stack.enter_context(patch.object(stage,'cpu_policy',return_value='800000 100000'));self.stack.enter_context(patch.object(stage,'assert_cpu_policy',return_value=None));self.stack.enter_context(patch.object(stage,'assert_memory_policy',return_value=None));self.stack.enter_context(patch.object(stage,'observer_snapshot',return_value={'fixture':True}));self.stack.enter_context(patch.object(stage,'assert_observer',return_value=None));self.stack.enter_context(patch.object(stage,'sqlite_paths',return_value=[str(self.config/'routing-history.db'),str(self.config/'diagnostics.db')]))
  with patch.object(stage.subprocess,'check_output',return_value='a'*40),contextlib.redirect_stdout(io.StringIO()):self.plan=stage.stage(SimpleNamespace(archive=self.archive,source=self.source,release_manifest=self.pins,opencode_profile_sha256='f'*64))
  self.states={u:'active' for u in (*activate.UNITS,*activate.OBSERVERS,activate.HOST_UNIT)};self.calls=[]
  (self.state/'status.json').write_text('{"phase":"checkpoint","cycles":1,"modelReplies":2}')
  now=int(time.time()*1000);self.until=now+3600000;self.maint=self.until;db=sqlite3.connect(self.config/'routing-history.db');db.executescript('CREATE TABLE routing_performance(source TEXT,profile TEXT,value TEXT,at REAL);CREATE TABLE routing_backoff(source TEXT PRIMARY KEY,value TEXT,at REAL);PRAGMA user_version=2;');db.execute('INSERT INTO routing_backoff VALUES(?,?,?)',('kilo',json.dumps({'code':'quota','signature':'quota:::','streak':1,'at':now,'until':self.until}),now));db.execute('INSERT INTO routing_backoff VALUES(?,?,?)',('clixad',json.dumps({'code':'quota','signature':'quota:::','streak':1,'at':now,'until':self.until}),now));db.commit();db.close();(self.config/'routing-history.db').chmod(0o600)
  def uv(unit,field):return self.states.get(unit,'inactive') if field=='ActiveState' else ('0' if self.states.get(unit)!='active' else '101' if unit=='milo.service' else '103' if unit==activate.HOST_UNIT else '102')
  def ctl(action,unit):
   self.calls.append((action,unit))
   if action=='stop':self.states[unit]='inactive'
   if action=='start':
    self.states[unit]='active'
    if unit=='grunt-amazing-adventure.service':(self.state/'status.json').write_text('{"phase":"paused","workerPid":null}')
  self.old_disabled_ports=set()
  def get(port,path):
   if 'diagnostics' in path:return {'health':{'available':True}}
   return {'activeRequests':0,'sources':[{'id':id,'state':('disabled' if id=='clixad' and (port in self.old_disabled_ports or json.loads((self.runtimes[0]/'package.json').read_text())['version']==stage.VERSION) else 'available'),'active':0,'maintenance':{},**({'errorCode':'quota','retryAt':self.until} if id=='kilo' or id=='clixad' and port not in self.old_disabled_ports and json.loads((self.runtimes[0]/'package.json').read_text())['version']!=stage.VERSION else {})} for id in sorted(EXPECTED_UNION+['clixad']+(['freellmapi'] if port==8792 else []))]}
  class Guard:
   def __init__(self,**kw):self.kill_started=False;self.all_dead=False;self.receipt={};self.kw=kw;self.frozen=[];self.guards=[]
   def install_restart_guards(self):pass
   def freeze_and_verify(self):pass
   def kill_verified_daemons(self):self.kill_started=True;self.all_dead=True
   def _all_targets(self):return [{'pid':self.kw[key],'ticks':str(self.kw[key])} for key in ('primary_pid','backend_pid','host_pid')]
   def _identity(self,pid):return (str(pid),'T' if self.frozen else 'S')
   def abort_before_kill(self):self.frozen.clear();self.guards.clear();self.receipt.update(restartGuardsRestored=True,daemonAdmission='aborted_without_terminating_work',restartGuards=[])
   def restore_restart_guards(self):self.receipt['restartGuardsRestored']=True
  for key,val in {'HOST_POLICY':self.policy,'RUNTIME_DIR':self.base/'run','unit_value':uv,'ctl':ctl,'get':get,'host_idle':lambda held=False:{'state':'held','activeVerification':False,'activePublication':False},'host_quiet':lambda:{'state':'idle','activeVerification':False,'activePublication':False,'updatedAt':int(time.time()*1000)},'host_quiet_since':lambda since,wait=10:{'state':'idle','activeVerification':False,'activePublication':False,'updatedAt':int(time.time()*1000)},'primary_environment':lambda:{'GRUNT_CONFIG_DIR':str(self.config),'GRUNT_PORT':'8792','GRUNT_DAEMON':'1','GRUNT_BACKGROUND_ACCOUNT_ACQUISITION':'0'},'assert_process_opt_out':lambda *a,**kw:None,'OwnedDaemonAdmission':Guard}.items():self.stack.enter_context(patch.object(activate,key,val))
  self.stack.enter_context(patch.object(collector_guard,'assert_entry',return_value=None));self.stack.enter_context(patch.object(collector_guard,'capture',return_value={'fixture':True}));self.stack.enter_context(patch.object(collector_guard,'assert_preserved',return_value=None))
  self.stack.enter_context(patch.object(activate.subprocess,'run',return_value=SimpleNamespace(returncode=0)));self.stack.enter_context(patch.object(activate.subprocess,'check_output',return_value='{"performanceUnchanged":true}'))
  original=StartupGate.capture
  def capture(**kw):
   def metadata(value):return {'version':1,'retiredPackagedSources':['clixad'],'eligibleUnion':EXPECTED_UNION,'consentDeferred':EXPECTED_DEFERRED,'staleOrdinaryPolicies':[],'optOut':True,'accountAcquisitionDisabled':True,'primaryManagedAutomatic':True,'sourceIdsPerPort':EXPECTED_PORTS,'ownerOptIns':EXPECTATIONS['ownerOptIns'],**{k:'a'*64 for k in ('consentSha256','policySha256','registrySha256','maintenanceSha256','probeEntriesSha256')},'potentialChecks':[k for k in EXPECTED_UNION if k not in EXPECTED_DEFERRED],'nextCheckAt':{k:self.maint for k in EXPECTED_UNION if k not in EXPECTED_DEFERRED}}
   return original(**kw,metadata_reader=metadata)
  self.stack.enter_context(patch.object(StartupGate,'capture',side_effect=capture));self.stack.enter_context(patch.object(StartupGate,'assert_process_environment',return_value={}))
 def run_upgrade(self):
  with contextlib.redirect_stdout(io.StringIO()):return activate.activate(0)
 def test_public160_stage_preserves_dependency_trees(self):
  self.assertEqual(len(self.plan['packageFiles']),4)
  for row in self.plan['runtimes']:self.assertEqual(stage.sha(Path(row['live'])/'node_modules/dependency'),stage.sha(Path(row['new'])/'node_modules/dependency'))
 def test_owner_files_are_staged_and_installed_with_backups_after_the_runtimes(self):
  rows={Path(r['dest']).relative_to(self.owner).as_posix():r for r in self.plan['ownerFiles']};self.assertEqual(set(rows),set(stage.OWNER_FILES))
  self.assertEqual(rows['free-pool.mjs']['oldSha256'],stage.sha(self.owner/'free-pool.mjs'));self.assertNotIn(str(self.owner/'free-pool.mjs'),self.plan['protectedFiles'])
  receipt=self.run_upgrade();self.assertTrue(receipt['success'])
  self.assertEqual((self.owner/'free-pool.mjs').read_bytes(),(self.payload/'free-pool.mjs').read_bytes());self.assertEqual((self.owner/'claude/worker-brief.md').read_bytes(),b'new brief');self.assertEqual((self.owner/'claude/bin/grunt-release').stat().st_mode&0o777,0o700);self.assertEqual((self.owner/'claude/assets.json').stat().st_mode&0o777,0o600)
  self.assertEqual(len(receipt['ownerFiles']),4)
  for row in receipt['ownerFiles']:self.assertTrue(Path(row['backup']).is_file())
  self.assertIn('createWorkerRuntime',Path(next(r['backup'] for r in receipt['ownerFiles'] if r['dest'].endswith('free-pool.mjs'))).read_text())
  manifest=json.loads((self.owner/'claude/assets.json').read_text())['files']
  for name,digest in manifest.items():self.assertEqual(stage.sha(self.owner/'claude'/name),digest)
 def restage_without_payload(self):
  shutil.rmtree(self.root/'staged');(self.root/'runtime-stage.json').unlink();shutil.rmtree(self.payload)
  with patch.object(stage.subprocess,'check_output',return_value='a'*40),contextlib.redirect_stdout(io.StringIO()):return stage.stage(SimpleNamespace(archive=self.archive,source=self.source,release_manifest=self.pins,opencode_profile_sha256='f'*64))
 def test_an_attempt_without_a_payload_leaves_every_owner_file_alone(self):
  (self.owner/'free-pool.mjs').write_text("import { configure } from './runtime/dist/local/main.js';\n"+OPT_INS)   # the installed launcher already runs on the removal release
  before={n:(self.owner/n).read_bytes() for n in stage.OWNER_FILES}
  plan=self.restage_without_payload();self.assertEqual(plan['ownerFiles'],[])
  receipt=self.run_upgrade();self.assertTrue(receipt['success']);self.assertEqual(receipt['ownerFiles'],[])
  self.assertEqual({n:(self.owner/n).read_bytes() for n in stage.OWNER_FILES},before);self.assertFalse([p for p in self.owner.rglob('*.before-*') if p.is_file()])
  self.assertEqual(json.loads((self.runtimes[0]/'package.json').read_text())['version'],stage.VERSION)
 def test_without_a_payload_the_live_launcher_must_still_import_modules_the_new_package_has(self):
  (self.owner/'free-pool.mjs').write_text("import { x } from './runtime/dist/local/removed-by-this-release.js';\n"+OPT_INS)
  with self.assertRaisesRegex(RuntimeError,'lacks'):self.restage_without_payload()
 def test_a_payload_manifest_must_accompany_exactly_a_changed_brief_or_release_cli(self):
  shutil.rmtree(self.root/'staged');(self.root/'runtime-stage.json').unlink()
  (self.payload/'claude/assets.json').unlink()
  with patch.object(stage.subprocess,'check_output',return_value='a'*40),self.assertRaisesRegex(RuntimeError,'assets.json must accompany'):stage.stage(SimpleNamespace(archive=self.archive,source=self.source,release_manifest=self.pins,opencode_profile_sha256='f'*64))
 def test_prestart_failure_restores_owner_files_with_the_runtimes(self):
  before={n:(self.owner/n).read_bytes() for n in stage.OWNER_FILES}
  with patch.object(activate.subprocess,'check_output',side_effect=[RuntimeError('synthetic seed failure'),'{}']),self.assertRaisesRegex(RuntimeError,'seed failure'):self.run_upgrade()
  self.assertEqual({n:(self.owner/n).read_bytes() for n in stage.OWNER_FILES},before)
  self.assertEqual(json.loads((self.root/'activation-receipt.json').read_text())['rollback'],'restored_previous_packages_and_quota_store_held_stopped')
 def test_changed_owner_file_before_install_is_refused_without_mutation(self):
  (self.owner/'claude/worker-brief.md').write_text('someone edited the brief')
  with self.assertRaises(RuntimeError):self.run_upgrade()
  self.assertEqual(json.loads((self.runtimes[0]/'package.json').read_text())['version'],stage.PREVIOUS_VERSION)
 def test_stage_refuses_launcher_with_subworker_runtime_or_stale_assets(self):
  shutil.rmtree(self.root/'staged');(self.root/'runtime-stage.json').unlink()
  (self.payload/'free-pool.mjs').write_text("import { createWorkerRuntime } from './runtime/dist/local/main.js';\n")
  with patch.object(stage.subprocess,'check_output',return_value='a'*40),self.assertRaisesRegex(RuntimeError,'removed subworker'):stage.stage(SimpleNamespace(archive=self.archive,source=self.source,release_manifest=self.pins,opencode_profile_sha256='f'*64))
  (self.payload/'free-pool.mjs').write_text("import { configure } from './runtime/dist/local/main.js';\n"+OPT_INS);shutil.rmtree(self.root/'staged',ignore_errors=True)
  (self.payload/'claude/worker-brief.md').write_text('different brief')
  with patch.object(stage.subprocess,'check_output',return_value='a'*40),self.assertRaisesRegex(RuntimeError,'assets.json'):stage.stage(SimpleNamespace(archive=self.archive,source=self.source,release_manifest=self.pins,opencode_profile_sha256='f'*64))
  shutil.rmtree(self.root/'staged',ignore_errors=True)
  (self.payload/'claude/worker-brief.md').write_text('new brief');(self.payload/'free-pool.mjs').write_text("import { x } from './runtime/dist/local/missing.js';\n"+OPT_INS)
  with patch.object(stage.subprocess,'check_output',return_value='a'*40),self.assertRaisesRegex(RuntimeError,'lacks'):stage.stage(SimpleNamespace(archive=self.archive,source=self.source,release_manifest=self.pins,opencode_profile_sha256='f'*64))
 def stage_with_launcher(self,text,*,expectations=None):
  shutil.rmtree(self.root/'staged',ignore_errors=True)
  if (self.root/'runtime-stage.json').exists():(self.root/'runtime-stage.json').unlink()
  (self.payload/'free-pool.mjs').write_text(text)
  with contextlib.ExitStack() as stack:
   stack.enter_context(patch.object(stage.subprocess,'check_output',return_value='a'*40));stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
   if expectations is not None:stack.enter_context(patch.object(stage,'load_expectations',return_value=expectations))
   return stage.stage(SimpleNamespace(archive=self.archive,source=self.source,release_manifest=self.pins,opencode_profile_sha256='f'*64))
 def test_stage_pins_the_launcher_opt_in_sources_to_the_reviewed_set_including_owner_additions(self):
  imports="import { configure } from './runtime/dist/local/main.js';\n"
  owner={**EXPECTATIONS,'ownerOptIns':{'8792':[],'8793':['ifm']}}
  literal=lambda ids:imports+"const options={GRUNT_OPT_IN_SOURCES:'"+ids+"'};\n"
  for name,text,pins in (('an unreviewed extra opt-in',literal('antseed-vikey,reflection-beam,ifm'),None),('a missing opt-in',literal('antseed-vikey'),None),('the owner addition without approval',literal('antseed-vikey,ifm,reflection-beam'),EXPECTATIONS),
                         ('an approved pin but a launcher still without it',literal('antseed-vikey,reflection-beam'),owner),('a duplicate',literal('antseed-vikey,antseed-vikey,reflection-beam'),None),
                         ('no literal',imports,None),('two literals',literal('antseed-vikey,reflection-beam')+literal('antseed-vikey,reflection-beam'),None),('a different extra with the approved one',literal('antseed-vikey,crowllm,ifm,reflection-beam'),owner)):
   with self.subTest(name),self.assertRaisesRegex(RuntimeError,'GRUNT_OPT_IN_SOURCES'):self.stage_with_launcher(text,expectations=pins)
  self.assertTrue(self.stage_with_launcher(literal('antseed-vikey,reflection-beam'))['ownerFiles'])
  plan=self.stage_with_launcher(literal('reflection-beam,ifm,antseed-vikey'),expectations=owner)   # order is free, content is exact
  self.assertIn('free-pool.mjs',{Path(r['dest']).name for r in plan['ownerFiles']})
 def test_real_startup_gate_wiring_preserves_schema_two(self):
  receipt=self.run_upgrade();self.assertTrue(receipt['success']);self.assertFalse((self.state/'execution-upgrade-hold').exists());self.assertTrue(receipt['schemaProof']['rawRowsPreserved']);self.assertEqual(receipt['schemaProof']['schemaBefore'],2);quota_store.assert_future(self.config,receipt['preservedCooldowns'],int(time.time()*1000));self.assertEqual((self.state/'worker/claude/projects/game/fixture.jsonl').read_text(),'saved history\n')
 def test_backend_clixad_already_disabled_preserves_raw_future_row_and_completes(self):
  self.old_disabled_ports={8793}
  db=sqlite3.connect(self.config/'routing-history.db');before=db.execute("SELECT rowid,source,value,at FROM routing_backoff WHERE source='clixad'").fetchall();db.close()
  receipt=self.run_upgrade();self.assertTrue(receipt['success']);self.assertEqual(receipt['sourceTransitionProof']['eligibleSourceSetsBefore']['8793'],EXPECTED_UNION)
  db=sqlite3.connect(self.config/'routing-history.db');after=db.execute("SELECT rowid,source,value,at FROM routing_backoff WHERE source='clixad'").fetchall();db.close()
  self.assertEqual(after,before);quota_store.assert_future(self.config,receipt['preservedCooldowns'],int(time.time()*1000))
 def test_both_clixad_already_disabled_still_requires_retained_future_db_row(self):
  self.old_disabled_ports={8792,8793};original=activate.ctl
  def clear(action,unit):
   original(action,unit)
   if action=='start' and unit==activate.HOST_UNIT:
    db=sqlite3.connect(self.config/'routing-history.db');db.execute("DELETE FROM routing_backoff WHERE source='clixad'");db.commit();db.close()
  with patch.object(activate,'ctl',side_effect=clear),self.assertRaisesRegex(RuntimeError,'Persisted|persisted'):self.run_upgrade()
  receipt=json.loads((self.root/'activation-receipt.json').read_text());self.assertTrue((self.state/'execution-upgrade-hold').exists());self.assertTrue(receipt['promptRootRecoveryRequired']);self.assertEqual(receipt['rollback'],'not_attempted_after_new_start_preserve_installed_runtimes_work_and_hold')
 def checkpoint_retry_fixture(self, queued_listener=False):
  import signal
  proc=self.base/'synthetic-proc';(proc/'102/task/102').mkdir(parents=True);(proc/'102/task/102/children').write_text('104')
  (proc/'102/stat').write_text('102 (synthetic) '+' '.join(['S','1']+['0']*17+['10200']))
  (proc/'104').mkdir();(proc/'104/cmdline').write_bytes((activate.NODE+'\0'+str(self.owner/'free-pool.mjs')+'\0').encode());(proc/'104/exe').symlink_to(activate.NODE)
  baseline=time.monotonic();clock_file=self.root/'clock';clock_file.write_text(str(baseline));events=self.root/'synthetic-signals';events.write_text('')
  status=self.state/'status.json';status.write_text('{"phase":"checkpoint","workerPid":null,"cycles":1,"modelReplies":2}')
  def clock():return float(clock_file.read_text())
  def sleep(seconds):
   now=clock()+seconds;clock_file.write_text(str(now))
   if now>=baseline+62:status.write_text('{"phase":"checkpoint","workerPid":null,"cycles":2,"modelReplies":3}')
  code=(HERE/'checkpoint_gate.py').read_text()+"\n_ReviewedCheckpointGate=CheckpointGate\n"
  code+=f"_fixture_proc=Path({str(proc)!r})\n_fixture_clock=Path({str(clock_file)!r})\n_fixture_status=Path({str(status)!r})\n_fixture_events=Path({str(events)!r})\n_fixture_baseline={baseline!r}\n"
  code+='''def _fixture_now():return float(_fixture_clock.read_text())
def _fixture_sleep(seconds):
 now=_fixture_now()+seconds;_fixture_clock.write_text(str(now))
 if now>=_fixture_baseline+62:_fixture_status.write_text('{"phase":"checkpoint","workerPid":null,"cycles":2,"modelReplies":3}')
class CheckpointGate(_ReviewedCheckpointGate):
 def __init__(self,**kw):super().__init__(**kw,proc_root=_fixture_proc,pool_reader=lambda port:{'activeRequests':0},clock=_fixture_now,sleep=_fixture_sleep)
 def _send(self,pid,ticks,sig):
  if self._identity(pid)[0]!=ticks:raise GateError('synthetic identity drift')
  with _fixture_events.open('a') as stream:stream.write(json.dumps([_fixture_now(),int(sig)])+'\\n')
  state='T' if sig==signal.SIGSTOP else 'S' if sig==signal.SIGCONT else self._identity(pid)[1]
  (_fixture_proc/str(pid)/'stat').write_text(str(pid)+' (synthetic) '+' '.join([state,'1']+['0']*17+['10200']))
'''
  (self.root/'checkpoint_gate.py').write_text(code)
  plan=json.loads((self.root/'runtime-stage.json').read_text());plan['helpers']['checkpoint_gate.py']=stage.sha(self.root/'checkpoint_gate.py');(self.root/'runtime-stage.json').write_text(json.dumps(plan))
  attempts=[]
  def freeze(guard):
   attempts.append(clock())
   if len(attempts)==1:
    if queued_listener:
     # Use the actual socket classifier, not a manually supplied retry tag.
     probe=object.__new__(KernelAdmission);probe.receipt=guard.receipt
     probe._network=lambda row:({'fixture-inode':{'18'}},{'fixture-inode':{'table':'tcp','state':'0A','local':'0100007F:2258','remote':'00000000:0000','queue':'00000000:00000001'}},set())
     guard.frozen.append({'pid':101,'ticks':'101'})
     KernelAdmission._sockets(probe,{'pid':101,'unit':'milo.service','port':8792})
     self.fail('Nonempty queue must never authorize admission')
    clock_file.write_text(str(baseline+60));error=AdmissionError('Managed idle transport did not naturally close; preserve it');error.admission_rejection_code='socket_busy';guard.receipt['managedTransportTimeout']=True;raise error
  kills=[];original_kill=activate.OwnedDaemonAdmission.kill_verified_daemons
  def checked_kill(guard):kills.append(clock());return original_kill(guard)
  with patch.object(activate.time,'monotonic',side_effect=clock),patch.object(activate.OwnedDaemonAdmission,'freeze_and_verify',freeze),patch.object(activate.OwnedDaemonAdmission,'kill_verified_daemons',checked_kill):receipt=activate.run_with_retries(100,clock=clock,sleep=sleep)
  self.assertTrue(receipt['success']);self.assertEqual(attempts,[baseline,baseline+62]);self.assertEqual(receipt['beforeActivity']['cycles'],2)
  intermediate=list(self.root.glob('admission-attempt-*.json'));self.assertEqual(len(intermediate),1);proof=json.loads(intermediate[0].read_text());self.assertFalse(proof['terminal']);self.assertEqual(proof['retryCleanupProof']['completedCycle'],1);self.assertTrue(proof['daemonAdmissionProof'].get('managedTransportTimeout') or queued_listener)
  stops=[row for row in map(json.loads,events.read_text().splitlines()) if row[1]==int(signal.SIGSTOP)];self.assertEqual([row[0] for row in stops],[baseline,baseline+62])
  self.assertEqual(json.loads((self.root/'activation-ready.json').read_text())['overallMonotonicDeadline'],baseline+100)
  self.assertEqual(kills,[baseline+62]);self.assertTrue(proof['retryCleanupProof']['restartGuardsRestored']);self.assertTrue(proof['retryCleanupProof']['noFrozenOwnedTargets']);self.assertTrue(proof['retryCleanupProof']['ownedHoldRemoved']);self.assertTrue(proof['collectorRecoveredWithoutRuntimeMutation'])
  if queued_listener:self.assertEqual(proof['daemonAdmissionProof']['socketRejections'][0]['reason'],'listener_queued_ingress')
 def test_timeout_full_cleanup_then_distinct_actual_checkpoint_retries_successfully(self):self.checkpoint_retry_fixture()
 def test_queued_listener_full_cleanup_then_later_checkpoint_with_same_total_budget(self):self.checkpoint_retry_fixture(queued_listener=True)
 def test_retry_timeout_cleanup_failure_or_missing_cycle_is_terminal(self):
  error=AdmissionError('Managed idle transport did not naturally close; preserve it');error.admission_rejection_code='socket_busy'
  with patch.object(activate.OwnedDaemonAdmission,'freeze_and_verify',side_effect=error),patch.object(activate,'verify_retry_cleanup',side_effect=RuntimeError('synthetic cleanup failure')),self.assertRaisesRegex(RuntimeError,'cleanup failure'):activate.run_with_retries(10)
  self.assertFalse(getattr(error,'upgrade_retry_safe',False));self.assertEqual(len(list(self.root.glob('admission-attempt-*.json'))),0);self.assertTrue((self.root/'activation-receipt.json').exists())
  for cycle in (None,True,'1',1.0,-1):
   status=json.loads((self.state/'status.json').read_text());status['cycles']=cycle;(self.state/'status.json').write_text(json.dumps(status))
   error=AdmissionError('Managed idle transport did not naturally close; preserve it');error.admission_rejection_code='socket_busy'
   with patch.object(activate.OwnedDaemonAdmission,'freeze_and_verify',side_effect=error),self.assertRaisesRegex(RuntimeError,'exact completed-cycle'):activate.run_with_retries(10)
   self.assertFalse(getattr(error,'upgrade_retry_safe',False))
 def test_real_transaction_quiet_callback_runs_before_any_kill(self):
  callbacks=[]
  def freeze(guard):
   self.assertTrue(guard.kw['quiet_checker']());callbacks.append(True)
  with patch.object(activate,'assert_guarded_unit_fingerprints') as units,patch.object(activate.OwnedDaemonAdmission,'freeze_and_verify',freeze):receipt=self.run_upgrade()
  self.assertTrue(receipt['success']);self.assertEqual(callbacks,[True]);units.assert_called_once()
 def test_deadline_expiring_after_freeze_prevents_first_kill(self):
  real=activate.time.monotonic;expired=[False]
  def now():return real()+(181 if expired[0] else 0)
  def freeze(guard):expired[0]=True
  with patch.object(activate.time,'monotonic',side_effect=now),patch.object(activate.OwnedDaemonAdmission,'freeze_and_verify',freeze),patch.object(activate.OwnedDaemonAdmission,'kill_verified_daemons') as kill,self.assertRaisesRegex(RuntimeError,'startup budget'):self.run_upgrade()
  kill.assert_not_called();self.assertFalse((self.state/'execution-upgrade-hold').exists());self.assertEqual(json.loads((self.runtimes[0]/'package.json').read_text())['version'],stage.PREVIOUS_VERSION)
 def test_quiet_callback_foreign_hold_is_preserved_before_kill(self):
  def freeze(guard):
   hold=self.state/'execution-upgrade-hold';hold.unlink();hold.write_text('operator hold');guard.kw['quiet_checker']()
  with patch.object(activate.OwnedDaemonAdmission,'freeze_and_verify',freeze),patch.object(activate.OwnedDaemonAdmission,'kill_verified_daemons') as kill,self.assertRaisesRegex(RuntimeError,'Owned startup hold changed'):self.run_upgrade()
  kill.assert_not_called();self.assertEqual((self.state/'execution-upgrade-hold').read_text(),'operator hold');self.assertEqual(json.loads((self.runtimes[0]/'package.json').read_text())['version'],stage.PREVIOUS_VERSION)
 def test_guarded_unit_fingerprint_normalizes_only_exact_owned_dropin(self):
  path=self.base/'owned-dropin';path.write_bytes(b'owned guard');path.chmod(0o600);info=path.stat()
  original={key:'' for key in ('ExecStart','Environment','EnvironmentFiles','UnsetEnvironment','Restart','FragmentPath','DropInPaths','User')};original.update(ExecStart='trusted argv',Restart='on-failure',DropInPaths='/original.conf')
  digest=hashlib.sha256(json.dumps(original,sort_keys=True).encode()).hexdigest();current={**original,'Restart':'no','DropInPaths':'/original.conf '+str(path)}
  guard=SimpleNamespace(guards=[{'unit':'fixture','path':path,'device':info.st_dev,'inode':info.st_ino,'data':b'owned guard','originalRestart':'on-failure'}])
  with patch.object(activate,'unit_value',side_effect=lambda u,k:current[k]):
   activate.assert_guarded_unit_fingerprints(guard,{'fixture':digest})
   current['Environment']='foreign change'
   with self.assertRaisesRegex(RuntimeError,'unit definition'):activate.assert_guarded_unit_fingerprints(guard,{'fixture':digest})
   current['Environment']='';path.write_bytes(b'foreign')
   with self.assertRaisesRegex(RuntimeError,'restart guard'):activate.assert_guarded_unit_fingerprints(guard,{'fixture':digest})
 def test_partial_first_start_fails_held_without_rollback(self):
  real=activate.ctl
  def fail(action,unit):
   if action=='start' and unit=='milo.service':raise RuntimeError('synthetic partial start')
   return real(action,unit)
  with patch.object(activate,'ctl',side_effect=fail),self.assertRaisesRegex(RuntimeError,'partial start'):self.run_upgrade()
  receipt=json.loads((self.root/'activation-receipt.json').read_text());self.assertTrue((self.state/'execution-upgrade-hold').exists());self.assertTrue(receipt['promptRootRecoveryRequired']);self.assertEqual(json.loads((self.runtimes[0]/'package.json').read_text())['version'],stage.VERSION)
 def test_prestart_seed_failure_restores_packages_and_original_db_held(self):
  with patch.object(activate.subprocess,'check_output',side_effect=[RuntimeError('synthetic seed failure'),'{}']),self.assertRaisesRegex(RuntimeError,'seed failure'):self.run_upgrade()
  self.assertEqual(json.loads((self.runtimes[0]/'package.json').read_text())['version'],stage.PREVIOUS_VERSION)
  self.assertTrue((self.state/'execution-upgrade-hold').exists())
  db=sqlite3.connect(self.config/'routing-history.db');self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0],2);db.close()
  self.assertEqual(json.loads((self.root/'activation-receipt.json').read_text())['rollback'],'restored_previous_packages_and_quota_store_held_stopped')
 def test_unlink_exception_after_resume_marker_never_rolls_back(self):
  original=Path.unlink
  def fail(path,*a,**kw):
   if path==self.state/'execution-upgrade-hold':raise RuntimeError('synthetic unlink failure')
   return original(path,*a,**kw)
  with patch.object(Path,'unlink',fail),self.assertRaisesRegex(RuntimeError,'unlink failure'):self.run_upgrade()
  receipt=json.loads((self.root/'activation-receipt.json').read_text());self.assertTrue(receipt['workMayResume']);self.assertEqual(receipt['rollback'],'not_attempted_after_work_resumed');self.assertEqual(json.loads((self.runtimes[0]/'package.json').read_text())['version'],stage.VERSION)
 def test_persisted_row_deletion_fails_held_even_when_status_retains_deadline(self):
  original=activate.ctl
  def clear(action,unit):
   original(action,unit)
   if action=='start' and unit==activate.HOST_UNIT:
    db=sqlite3.connect(self.config/'routing-history.db');db.execute('DELETE FROM routing_backoff');db.commit();db.close()
  with patch.object(activate,'ctl',side_effect=clear),self.assertRaisesRegex(RuntimeError,'Persisted|persisted'):self.run_upgrade()
  receipt=json.loads((self.root/'activation-receipt.json').read_text());self.assertTrue(receipt['promptRootRecoveryRequired']);self.assertTrue((self.state/'execution-upgrade-hold').exists())
 def test_retired_clixad_raw_row_deletion_fails_held_without_rollback(self):
  original=activate.ctl
  def clear(action,unit):
   original(action,unit)
   if action=='start' and unit==activate.HOST_UNIT:
    db=sqlite3.connect(self.config/'routing-history.db');db.execute("DELETE FROM routing_backoff WHERE source='clixad'");db.commit();db.close()
  with patch.object(activate,'ctl',side_effect=clear),self.assertRaisesRegex(RuntimeError,'Persisted|persisted'):self.run_upgrade()
  receipt=json.loads((self.root/'activation-receipt.json').read_text());self.assertTrue(receipt['promptRootRecoveryRequired']);self.assertTrue((self.state/'execution-upgrade-hold').exists());self.assertEqual(receipt['rollback'],'not_attempted_after_new_start_preserve_installed_runtimes_work_and_hold')
 def test_final_idle_read_crossing_deadline_never_releases_hold(self):
  original=activate.assert_idle;calls=[0]
  def expire():
   original();calls[0]+=1
   if calls[0]>=3:activate.ACTIVE_DEADLINE=time.monotonic()-1
  with patch.object(activate,'assert_idle',side_effect=expire),self.assertRaisesRegex(RuntimeError,'deadline exceeded'):self.run_upgrade()
  receipt=json.loads((self.root/'activation-receipt.json').read_text());self.assertFalse(receipt['success']);self.assertNotIn('workMayResume',receipt);self.assertTrue((self.state/'execution-upgrade-hold').exists());self.assertTrue(receipt['promptRootRecoveryRequired'])
 def test_retryable_socket_reject_writes_only_unique_nonterminal_receipt(self):
  error=AdmissionError('synthetic socket busy');error.admission_rejection_code='socket_busy'
  with patch.object(activate.OwnedDaemonAdmission,'freeze_and_verify',side_effect=error),self.assertRaises(AdmissionError):
   with contextlib.redirect_stdout(io.StringIO()):activate.activate(0,retry_mode=True)
  self.assertTrue(error.upgrade_retry_safe);self.assertFalse((self.root/'activation-receipt.json').exists())
  attempts=list(self.root.glob('admission-attempt-*.json'));self.assertEqual(len(attempts),1);receipt=json.loads(attempts[0].read_text());self.assertFalse(receipt['terminal']);self.assertTrue(receipt['retrySafe']);self.assertFalse((self.state/'execution-upgrade-hold').exists())
  self.assertFalse(any(action in ('stop','start','restart') and unit!=collector_guard.UNIT for action,unit in self.calls))
  self.assertEqual(json.loads((self.runtimes[0]/'package.json').read_text())['version'],stage.PREVIOUS_VERSION)
  self.assertTrue(receipt['retryCleanupProof']['noFrozenOwnedTargets'])
  # A new activate call rebuilds admission/native proof at a fresh boundary.
  with contextlib.redirect_stdout(io.StringIO()):final=activate.activate(0,retry_mode=True,attempt_number=2)
  self.assertTrue(final['success']);self.assertTrue(json.loads((self.root/'activation-receipt.json').read_text())['terminal'])
 # --- execution host must be idle before a hold is created (attempt 2: the Claude builder leaves `grunt-release verify` jobs running on the host) ---
 def host_busy_attempt(self,**kw):
  with contextlib.redirect_stdout(io.StringIO()):return activate.activate(0,retry_mode=True,**kw)
 def no_mutation(self,error,reason='execution_host_busy'):
  self.assertTrue(error.upgrade_retry_safe);self.assertEqual(error.upgrade_retry_after_cycle,1)
  self.assertFalse((self.state/'execution-upgrade-hold').exists());self.assertFalse((self.root/'activation-receipt.json').exists())
  self.assertFalse(any(action in ('stop','start','restart') for action,unit in self.calls));self.assertEqual(json.loads((self.runtimes[0]/'package.json').read_text())['version'],stage.PREVIOUS_VERSION)
  attempts=list(self.root.glob('admission-attempt-*.json'));self.assertEqual(len(attempts),1);receipt=json.loads(attempts[0].read_text())
  self.assertFalse(receipt['terminal']);self.assertTrue(receipt['retrySafe']);self.assertEqual(receipt['retryReason'],reason);self.assertTrue(receipt['retryCleanupProof']['supervisorResumed']);self.assertTrue(receipt['retryCleanupProof']['ownedHoldRemoved'])
  self.assertNotIn('daemonAdmissionProof',receipt)
 def test_host_busy_just_before_hold_creates_no_hold_and_retries_at_a_later_checkpoint(self):
  with patch.object(activate,'host_quiet_since',side_effect=activate.HostBusyError('Execution host is not idle (state working)')) as read,self.assertRaises(activate.HostBusyError) as caught:self.host_busy_attempt()
  read.assert_called_once();self.no_mutation(caught.exception)
  self.assertFalse(any(action=='stop' and unit==collector_guard.UNIT for action,unit in self.calls))
  final=self.host_busy_attempt(attempt_number=2);self.assertTrue(final['success']);self.assertTrue(json.loads((self.root/'activation-receipt.json').read_text())['terminal'])
 def test_host_that_never_acknowledges_the_hold_is_a_retryable_no_mutation_failure(self):
  # The host started a job between the last idle read and the hold; it never reaches 'held' within the 30 s wait.
  offset=[0.0];real=time.monotonic
  def busy(held=False):
   if held:raise activate.HostBusyError('Execution host must preserve startup hold without starting jobs')
   return {'state':'held','activeVerification':False,'activePublication':False}
  with patch.object(activate,'host_idle',side_effect=busy),patch.object(activate.time,'monotonic',side_effect=lambda:real()+offset[0]),patch.object(activate.time,'sleep',side_effect=lambda d:offset.__setitem__(0,offset[0]+d)),self.assertRaises(activate.HostBusyError) as caught:self.host_busy_attempt()
  self.assertGreater(offset[0],29.9);self.no_mutation(caught.exception)
  final=self.host_busy_attempt(attempt_number=2);self.assertTrue(final['success'])
 def test_host_that_acknowledges_the_hold_late_within_thirty_seconds_proceeds(self):
  calls=[0]
  def slow(held=False):
   if held:
    calls[0]+=1
    if calls[0]<3:raise activate.HostBusyError('Execution host must preserve startup hold without starting jobs')
   return {'state':'held','activeVerification':False,'activePublication':False}
  with patch.object(activate,'host_idle',side_effect=slow),patch.object(activate.time,'sleep',return_value=None):final=self.host_busy_attempt()
  self.assertTrue(final['success'])

 # --- attempt 3: a source maintenance check inside hard deadline + margin at the checkpoint is schedule timing, not a defect ---
 def test_maintenance_check_inside_the_startup_window_is_a_retryable_no_mutation_failure(self):
  self.maint=int(time.time()*1000)+100000   # inside 180 s deadline + 60 s margin
  with self.assertRaises(MaintenanceWindowError) as caught:self.host_busy_attempt()
  self.no_mutation(caught.exception,'startup_maintenance_window')
  self.assertFalse(any(action=='stop' and unit==collector_guard.UNIT for action,unit in self.calls))
  receipt=json.loads(next(iter(self.root.glob('admission-attempt-*.json'))).read_text())
  self.assertEqual(receipt['maintenanceWindow']['earliestCheckAtMs'],self.maint);self.assertGreater(receipt['maintenanceWindow']['floorMs'],self.maint)
  self.assertNotIn('startupProof',receipt);self.assertNotIn('sourceTransitionProof',receipt)
  self.maint=int(time.time()*1000)+3600000   # the due check ran and was rescheduled
  final=self.host_busy_attempt(attempt_number=2);self.assertTrue(final['success']);self.assertTrue(json.loads((self.root/'activation-receipt.json').read_text())['terminal'])
 def test_run_with_retries_waits_for_the_next_checkpoint_after_a_maintenance_window_rejection(self):
  self.maint=int(time.time()*1000)+100000;slept=[]
  def sleep(delay):
   slept.append(delay);self.maint=int(time.time()*1000)+3600000
   (self.state/'status.json').write_text('{"phase":"checkpoint","cycles":2,"modelReplies":3}')
  with contextlib.redirect_stdout(io.StringIO()):final=activate.run_with_retries(600,sleep=sleep,clock=time.monotonic,initial_after_cycle=0)
  self.assertTrue(final['success']);self.assertEqual(len(slept),1);self.assertEqual(final['attemptNumber'],2);self.assertEqual(final['beforeActivity']['cycles'],2)
  proof=json.loads(next(iter(self.root.glob('admission-attempt-*.json'))).read_text());self.assertEqual(proof['retryReason'],'startup_maintenance_window');self.assertEqual(proof['retryCleanupProof']['completedCycle'],1)
 def test_maintenance_window_without_a_newer_cycle_is_terminal(self):
  self.maint=int(time.time()*1000)+100000
  with contextlib.redirect_stdout(io.StringIO()),self.assertRaisesRegex(RuntimeError,'not newer'):activate.run_with_retries(600,sleep=lambda d:None,clock=time.monotonic,initial_after_cycle=1)
 def test_maintenance_window_after_the_first_mutation_is_never_retried(self):
  original=activate.ctl
  def move(action,unit):
   original(action,unit)
   if action=='stop' and unit==activate.HOST_UNIT:self.maint=int(time.time()*1000)+100000
  with patch.object(activate,'ctl',side_effect=move),self.assertRaises(MaintenanceWindowError) as caught:self.host_busy_attempt()
  self.assertFalse(getattr(caught.exception,'upgrade_retry_safe',False));self.assertEqual(list(self.root.glob('admission-attempt-*.json')),[])
  receipt=json.loads((self.root/'activation-receipt.json').read_text());self.assertTrue(receipt['terminal']);self.assertFalse(receipt['success']);self.assertNotIn('retryReason',receipt)
 def test_malformed_probe_schedule_is_not_a_retryable_maintenance_window(self):
  self.maint=True   # bool is never a valid timestamp
  with self.assertRaises(GateError) as caught:self.host_busy_attempt()
  self.assertNotIsInstance(caught.exception,MaintenanceWindowError);self.assertFalse(getattr(caught.exception,'upgrade_retry_safe',False))
 def test_host_health_failure_at_the_hold_wait_is_not_retryable(self):
  def broken(held=False):
   if held:raise RuntimeError('Execution host health/identity not verified')
   return {'state':'held','activeVerification':False,'activePublication':False}
  offset=[0.0];real=time.monotonic
  with patch.object(activate,'host_idle',side_effect=broken),patch.object(activate.time,'monotonic',side_effect=lambda:real()+offset[0]),patch.object(activate.time,'sleep',side_effect=lambda d:offset.__setitem__(0,offset[0]+d)),self.assertRaisesRegex(RuntimeError,'health/identity') as caught:self.host_busy_attempt()
  self.assertFalse(getattr(caught.exception,'upgrade_retry_safe',False));self.assertTrue((self.root/'activation-receipt.json').exists());self.assertFalse((self.state/'execution-upgrade-hold').exists())
 def test_host_quiet_requires_idle_state_without_active_jobs(self):
  fresh=int(time.time()*1000)
  def health(**row):return {'pid':1,'updatedAt':fresh,'state':'idle','activeVerification':False,'activePublication':False,**row}
  with patch.object(activate,'host_idle',REAL_HOST_IDLE),patch.object(activate,'host_health',side_effect=lambda held:health()):self.assertEqual(REAL_HOST_QUIET()['state'],'idle')
  for row in ({'state':'working','activeVerification':True},{'state':'working'},{'state':'held'},{'state':'idle','activeVerification':True},{'state':'idle','activePublication':True},{'state':'stopping'}):
   with patch.object(activate,'host_idle',REAL_HOST_IDLE),patch.object(activate,'host_health',side_effect=lambda held,row=row:health(**row)),self.assertRaises(activate.HostBusyError):REAL_HOST_QUIET()
 def test_host_quiet_since_needs_an_idle_record_written_after_the_freeze(self):
  now=[1000.0]
  def sleep(delay):now[0]+=delay
  records=iter([{'state':'idle','activeVerification':False,'activePublication':False,'updatedAt':900},{'state':'idle','activeVerification':False,'activePublication':False,'updatedAt':1200}])
  with patch.object(activate,'host_quiet',side_effect=lambda:next(records)),patch.object(activate.time,'monotonic',side_effect=lambda:now[0]),patch.object(activate.time,'sleep',side_effect=sleep):self.assertEqual(REAL_HOST_QUIET_SINCE(1000)['updatedAt'],1200)
  now[0]=0
  with patch.object(activate,'host_quiet',return_value={'state':'idle','activeVerification':False,'activePublication':False,'updatedAt':900}),patch.object(activate.time,'monotonic',side_effect=lambda:now[0]),patch.object(activate.time,'sleep',side_effect=sleep),self.assertRaisesRegex(activate.HostBusyError,'stale'):REAL_HOST_QUIET_SINCE(1000,wait=3)
 def test_gate_is_given_the_host_quiescence_check(self):
  seen={}
  class Spy:
   def __init__(self,**kw):seen.update(kw);self.frozen=False
   def _identity(self,pid):return ('supervisor','S')
   @contextlib.contextmanager
   def acquire(self,**kw):raise RuntimeError('stop after wiring')
  spec=importlib.util.spec_from_file_location('spy_gate',self.root/'checkpoint_gate.py')
  with patch.object(importlib.util,'module_from_spec',return_value=SimpleNamespace(CheckpointGate=Spy,read_json=lambda p:{})),patch.object(importlib.util,'spec_from_file_location',return_value=SimpleNamespace(name='spy',loader=SimpleNamespace(exec_module=lambda m:None))),self.assertRaisesRegex(RuntimeError,'stop after wiring'):self.host_busy_attempt()
  self.assertIs(seen['host_idle'],activate.host_quiet)
 def test_channel_binding_drift_rejected(self):
  (self.state/'worker/execution-channel.json').write_text('unexpected')
  with self.assertRaisesRegex(RuntimeError,'Protected'):self.run_upgrade()
  self.assertFalse(self.calls)
 def test_old_owned_hold_preserved(self):
  hold=self.state/'execution-upgrade-hold';hold.write_text('deliberate')
  with self.assertRaisesRegex(RuntimeError,'Preserve existing'):self.run_upgrade()
  self.assertEqual(hold.read_text(),'deliberate');self.assertFalse(self.calls)
 def test_collector_stop_error_after_accepted_stop_restores_old_collector(self):
  original=activate.ctl
  def fail(action,unit):
   original(action,unit)
   if action=='stop' and unit==collector_guard.UNIT:raise RuntimeError('synthetic accepted collector stop timeout')
  with patch.object(activate,'ctl',side_effect=fail),self.assertRaisesRegex(RuntimeError,'accepted collector stop timeout'):self.run_upgrade()
  self.assertEqual(self.states[collector_guard.UNIT],'active');self.assertFalse((self.state/'execution-upgrade-hold').exists())
  receipt=json.loads((self.root/'activation-receipt.json').read_text());self.assertTrue(receipt['collectorRecoveredWithoutRuntimeMutation']);self.assertEqual(json.loads((self.runtimes[0]/'package.json').read_text())['version'],stage.PREVIOUS_VERSION)
 def test_collector_capture_failure_is_reported_without_masking_or_runtime_mutation(self):
  with patch.object(collector_guard,'capture',side_effect=RuntimeError('synthetic checkpoint read failure')),self.assertRaisesRegex(RuntimeError,'checkpoint read failure'):self.run_upgrade()
  receipt=json.loads((self.root/'activation-receipt.json').read_text());self.assertTrue(receipt['promptRootRecoveryRequired']);self.assertEqual(receipt['failure'],'synthetic checkpoint read failure');self.assertEqual(self.states[collector_guard.UNIT],'inactive')
  self.assertFalse(any(action=='stop' and unit in activate.UNITS for action,unit in self.calls))
 def test_start_marker_precedes_first_new_daemon_and_resume_marker_precedes_unlink(self):
  original=activate.ctl
  def checked(action,unit):
   if action=='start' and unit in activate.UNITS:self.assertTrue((self.root/'startup-attempted.json').exists())
   if action=='start' and unit==collector_guard.UNIT:self.assertTrue((self.root/'work-may-resume.json').exists());self.assertFalse((self.state/'execution-upgrade-hold').exists())
   return original(action,unit)
  with patch.object(activate,'ctl',side_effect=checked):self.assertTrue(self.run_upgrade()['success'])
 def test_existing_startup_attempt_marker_refuses_rearming(self):
  (self.root/'startup-attempted.json').write_text('{"noAutomaticRollback":true}')
  with self.assertRaisesRegex(RuntimeError,'previous startup'):self.run_upgrade()
  self.assertFalse(self.calls)
 def test_resume_marker_write_crossing_deadline_keeps_hold_and_never_resumes(self):
  original=activate.save
  def expire(path,value):
   original(path,value)
   if path.name=='work-may-resume.json':activate.ACTIVE_DEADLINE=time.monotonic()-1
  with patch.object(activate,'save',side_effect=expire),self.assertRaisesRegex(RuntimeError,'deadline exceeded'):self.run_upgrade()
  self.assertTrue((self.state/'execution-upgrade-hold').exists());receipt=json.loads((self.root/'activation-receipt.json').read_text());self.assertNotIn('workMayResume',receipt);self.assertTrue(receipt['promptRootRecoveryRequired'])
 def test_signed_verification_metadata_included(self):
  policy=json.loads(self.policy.read_text());p=Path(policy['stateDirectory'])/'verification/requests/fixture/verification.json';p.parent.mkdir(parents=True);p.write_text('{"safe":"receipt"}')
  before=host_metadata.snapshot(policy);p.write_text('{"safe":"changed"}');self.assertNotEqual(before,host_metadata.snapshot(policy))
 # --- planned maintenance pause: activate() runs on a supervisor that maintenance_pause froze earlier (frozen_in) ---
 def preheld(self):
  fake=SimpleNamespace(frozen=True);events=[]
  fake._identity=lambda pid:('supervisor','T' if fake.frozen else 'S')
  class Handle:
   pid=102;backend_pid=104;start_ticks='supervisor';gate=fake
   def __init__(handle):handle.stopped=True
   def release(handle):
    if handle.stopped:handle.stopped=False;fake.frozen=False;events.append('SIGCONT')
   def terminate_before_stop(handle):handle.stopped=False;events.append('TERM+CONT')
   def __enter__(handle):return handle
   def __exit__(handle,*error):handle.release()
  return Handle(),events
 def paused_attempt(self,handle,**kw):
  with contextlib.redirect_stdout(io.StringIO()):return activate.activate(0,retry_mode=True,frozen_in=handle,**kw)
 def test_planned_pause_runs_the_unchanged_transaction_on_the_preheld_supervisor(self):
  handle,events=self.preheld();receipt=self.paused_attempt(handle)
  self.assertTrue(receipt['success']);self.assertEqual(events,['TERM+CONT']);self.assertFalse((self.state/'execution-upgrade-hold').exists())
  self.assertEqual(json.loads((self.runtimes[0]/'package.json').read_text())['version'],stage.VERSION);self.assertTrue(receipt['startupHoldReleased'])
 def test_planned_pause_host_busy_before_hold_resumes_the_builder_and_mutates_nothing(self):
  handle,events=self.preheld()
  with patch.object(activate,'host_quiet_since',side_effect=activate.HostBusyError('Execution host is not idle (state working)')),self.assertRaises(activate.HostBusyError) as caught:self.paused_attempt(handle)
  self.no_mutation(caught.exception);self.assertEqual(events,['SIGCONT']);self.assertFalse(handle.stopped)
 def test_planned_pause_maintenance_window_resumes_the_builder_and_mutates_nothing(self):
  with patch.object(StartupGate,'capture',side_effect=MaintenanceWindowError('perch',1,2)):
   handle,events=self.preheld()
   with self.assertRaises(MaintenanceWindowError) as caught:self.paused_attempt(handle)
  self.no_mutation(caught.exception,'startup_maintenance_window');self.assertEqual(events,['SIGCONT'])
 def test_planned_pause_socket_busy_rejection_resumes_the_builder_and_is_retry_safe(self):
  error=AdmissionError('synthetic socket busy');error.admission_rejection_code='socket_busy';handle,events=self.preheld()
  with patch.object(activate.OwnedDaemonAdmission,'freeze_and_verify',side_effect=error),self.assertRaises(AdmissionError):self.paused_attempt(handle)
  self.assertTrue(error.upgrade_retry_safe);self.assertEqual(events,['SIGCONT']);self.assertFalse((self.state/'execution-upgrade-hold').exists());self.assertFalse((self.root/'activation-receipt.json').exists())
 def test_planned_pause_failed_freeze_reproof_changes_nothing_and_leaves_the_handle_to_its_owner(self):
  gate_file=self.root/'checkpoint_gate.py';gate_file.write_text(gate_file.read_text().replace("self.verified=getattr(self,'verified',0)+1;self.frozen=True;return frozen","raise RuntimeError('Checkpoint or pool admission changed during planned pause')"))
  plan=json.loads((self.root/'runtime-stage.json').read_text());plan['helpers']['checkpoint_gate.py']=stage.sha(gate_file);(self.root/'runtime-stage.json').write_text(json.dumps(plan))
  handle,events=self.preheld()
  with self.assertRaisesRegex(RuntimeError,'changed during planned pause'):self.paused_attempt(handle)
  self.assertEqual(events,[]);self.assertTrue(handle.stopped);self.assertFalse(any(action in ('stop','start','restart') for action,unit in self.calls))
  self.assertFalse((self.state/'execution-upgrade-hold').exists());self.assertEqual(json.loads((self.runtimes[0]/'package.json').read_text())['version'],stage.PREVIOUS_VERSION)
 def test_planned_pause_partial_admission_keeps_the_supervisor_frozen_for_recovery(self):
  handle,events=self.preheld()
  def partial(admission):admission.kill_started=True;raise RuntimeError('synthetic partial kill')
  with patch.object(activate.OwnedDaemonAdmission,'kill_verified_daemons',autospec=True,side_effect=partial),self.assertRaisesRegex(RuntimeError,'partial kill'):self.paused_attempt(handle)
  self.assertEqual(events,[]);self.assertFalse(handle.stopped)
  receipt=json.loads((self.root/'activation-receipt.json').read_text());self.assertTrue(receipt['promptRootRecoveryRequired']);self.assertTrue((self.state/'execution-upgrade-hold').exists())
if __name__=='__main__':unittest.main()
