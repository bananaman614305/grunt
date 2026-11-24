"""Actual checkpoint gate with owned synthetic proc/readers/signals only."""
import json,signal,tempfile,unittest
from pathlib import Path
from checkpoint_gate import CheckpointGate,GateError
class Floors(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent);self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name);self.now=0;self.cycle=5;self.state='S';self.events=[]
  root=self.root/'101';(root/'task/101').mkdir(parents=True);(root/'task/101/children').write_text('102')
  child=self.root/'102';child.mkdir();(child/'cmdline').write_bytes(b'/synthetic/node\0/synthetic/backend\0');(child/'exe').symlink_to('/synthetic/node');self.write_stat()
 def write_stat(self):(self.root/'101/stat').write_text('101 (synthetic) '+' '.join([self.state,'1']+['0']*17+['1000']))
 def sleep(self,seconds):
  self.now+=seconds
  if self.now>=2:self.cycle=6
 def send(self,pid,ticks,sig):
  self.events.append((self.now,sig));self.state='T' if sig==signal.SIGSTOP else 'S';self.write_stat()
 def gate(self,floor,host=None):
  kw={} if host is None else {'host_idle':host}
  gate=CheckpointGate(**kw,status_path=self.root/'unused',supervisor_pid=lambda:101,expected_backend_script='/synthetic/backend',expected_node='/synthetic/node',proc_root=self.root,status_reader=lambda path:{'phase':'checkpoint','workerPid':None,'cycles':self.cycle},pool_reader=lambda port:{'activeRequests':0,'workers':{'active':[],'queued':[]}},clock=lambda:self.now,sleep=self.sleep,after_cycle=floor);gate._send=self.send;return gate
 def test_same_completed_cycle_never_freezes_waits_for_distinct_natural_completion(self):
  with self.gate(5).acquire(timeout_seconds=10):self.assertEqual(self.now,2);self.assertEqual(self.events,[(2,signal.SIGSTOP)])
  self.assertEqual(self.events,[(2,signal.SIGSTOP),(2,signal.SIGCONT)])
 def test_first_attempt_preserves_legacy_no_cycle_requirement(self):
  self.cycle=None
  with self.gate(None).acquire(timeout_seconds=0):self.assertEqual(self.events,[(0,signal.SIGSTOP)])
 def test_malformed_or_unadvanced_cycle_cannot_be_admitted(self):
  for cycle in (None,True,'6',6.0,5,4):
   self.cycle=cycle
   with self.assertRaises(GateError):self.gate(5).acquire(timeout_seconds=0)
   self.assertEqual(self.events,[])
 def test_invalid_floor_rejected(self):
  for value in (True,-1,'5',5.0):
   with self.assertRaises(ValueError):self.gate(value)
 def test_cycle_regression_after_freeze_resumes_without_admission(self):
  self.cycle=6;gate=self.gate(5);original=self.send
  def changed(pid,ticks,sig):original(pid,ticks,sig);self.cycle=5
  gate._send=changed
  with self.assertRaises(GateError):gate.acquire(timeout_seconds=0)
  self.assertEqual(self.events,[(0,signal.SIGSTOP),(0,signal.SIGCONT)]);self.assertEqual(self.state,'S')
 # --- execution host quiescence: a builder checkpoint with a verification job still running on the host is not admissible ---
 def test_busy_host_at_checkpoint_never_freezes_and_waits_for_a_later_idle_checkpoint(self):
  reads=[]
  def host():reads.append(self.now);return self.now>=3
  with self.gate(None,host).acquire(timeout_seconds=10):self.assertEqual(self.events,[(3,signal.SIGSTOP)])
  self.assertEqual(self.events,[(3,signal.SIGSTOP),(3,signal.SIGCONT)]);self.assertEqual(reads[:3],[0,1,2]);self.assertEqual(self.state,'S')
 def test_idle_host_proceeds_immediately(self):
  with self.gate(None,lambda:True).acquire(timeout_seconds=0):self.assertEqual(self.events,[(0,signal.SIGSTOP)])
 def test_host_that_becomes_busy_during_the_freeze_is_released_and_waited_out(self):
  answers=iter([True,False,True,True])
  with self.gate(None,lambda:next(answers)).acquire(timeout_seconds=10):pass
  self.assertEqual(self.events,[(0,signal.SIGSTOP),(0,signal.SIGCONT),(1,signal.SIGSTOP),(1,signal.SIGCONT)])
 def test_busy_or_unreadable_host_until_the_budget_ends_never_freezes_and_reports_why(self):
  def broken():raise RuntimeError('Execution host health/identity not verified')
  for host in (lambda:False,broken):
   self.events.clear();self.now=0
   with self.assertRaisesRegex(GateError,'No verified idle checkpoint'):self.gate(None,host).acquire(timeout_seconds=3)
   self.assertEqual(self.events,[])
  with self.assertRaisesRegex(GateError,'health/identity not verified'):self.gate(None,broken).acquire(timeout_seconds=0)
 def test_no_host_check_keeps_the_pool_only_behavior(self):
  with self.gate(None).acquire(timeout_seconds=0):self.assertEqual(self.events,[(0,signal.SIGSTOP)])
if __name__=='__main__':unittest.main()
