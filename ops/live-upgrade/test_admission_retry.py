"""Pure retry/controller fixtures. No real processes, service calls or provider requests."""
import json,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import activate
from daemon_admission import AdmissionError
class Retries(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent);self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name);self.patch=patch.object(activate,'ROOT',self.root);self.patch.start();self.addCleanup(self.patch.stop);self.now=0
 def clock(self):return self.now
 def sleep(self,delay):self.now+=delay
 def rejection(self):
  error=AdmissionError('synthetic socket');error.upgrade_retry_safe=True;error.upgrade_retry_after_cycle=1;return error
 def test_expiry_during_backoff_never_calls_activate_zero(self):
  calls=[]
  def run(timeout,**kw):calls.append((timeout,kw));self.now+=.5;raise self.rejection()
  def pause(delay):
   self.sleep(delay);(self.root/'execution-upgrade-hold').write_text('operator pause')
  with patch.object(activate,'STATE',self.root),patch.object(activate,'activate',side_effect=run),self.assertRaisesRegex(RuntimeError,'budget exhausted'):activate.run_with_retries(1,clock=self.clock,sleep=pause)
  self.assertEqual(len(calls),1);value=json.loads((self.root/'activation-receipt.json').read_text());self.assertFalse(value['success']);self.assertTrue(value['terminal']);self.assertTrue(value['startupHoldPresent']);self.assertEqual((self.root/'execution-upgrade-hold').read_text(),'operator pause')
 def test_retries_use_same_deadline_and_only_remaining_budget(self):
  calls=[]
  def run(timeout,**kw):
   calls.append((timeout,kw));self.now+=2
   if len(calls)==1:raise self.rejection()
   return {'success':True}
  with patch.object(activate,'activate',side_effect=run):self.assertTrue(activate.run_with_retries(10,clock=self.clock,sleep=self.sleep)['success'])
  self.assertEqual([v[0] for v in calls],[10,7]);self.assertEqual([v[1]['overall_deadline'] for v in calls],[10,10]);self.assertEqual([v[1]['attempt_number'] for v in calls],[1,2]);self.assertEqual([v[1]['after_cycle'] for v in calls],[None,1])
 def test_ordinary_admission_errors_do_not_retry(self):
  with patch.object(activate,'activate',side_effect=AdmissionError('deliberate pause')) as run,self.assertRaises(AdmissionError):activate.run_with_retries(10,clock=self.clock,sleep=self.sleep)
  run.assert_called_once()
 def test_semantic_or_partial_kill_errors_do_not_retry(self):
  for error in [RuntimeError('protected bytes drift'),AdmissionError('partial kill')]:
   with patch.object(activate,'activate',side_effect=error) as run,self.assertRaises(type(error)):activate.run_with_retries(10,clock=self.clock,sleep=self.sleep)
   run.assert_called_once()
 def test_missing_or_nonadvancing_retry_cycle_stops_controller(self):
  for cycle in (None,True,-1,'1',1.0):
   error=self.rejection();error.upgrade_retry_after_cycle=cycle
   with patch.object(activate,'activate',side_effect=error) as run,self.assertRaisesRegex(RuntimeError,'cycle proof'):activate.run_with_retries(10,clock=self.clock,sleep=self.sleep)
   run.assert_called_once()
  with patch.object(activate,'activate',side_effect=self.rejection()) as run,self.assertRaisesRegex(RuntimeError,'not newer'):activate.run_with_retries(10,clock=self.clock,sleep=self.sleep)
  self.assertEqual(run.call_count,2)
 def test_initial_cycle_floor_is_validated_and_sent_to_first_gate(self):
  with patch.object(activate,'activate',return_value={'success':True}) as run:activate.run_with_retries(10,clock=self.clock,sleep=self.sleep,initial_after_cycle=215)
  self.assertEqual(run.call_args.kwargs['after_cycle'],215)
  for value in (True,-1,'215',215.0):
   with self.assertRaises(ValueError):activate.run_with_retries(10,clock=self.clock,sleep=self.sleep,initial_after_cycle=value)
 def test_cleanup_proof_requires_every_safety_fact(self):
  guard=SimpleNamespace(kill_started=False,frozen=[],guards=[],receipt={'restartGuardsRestored':True,'daemonAdmission':'aborted_without_terminating_work','restartGuards':[]},_all_targets=lambda:[{'pid':100,'ticks':'t'}],_identity=lambda pid:('t','S'))
  frozen=SimpleNamespace(pid=200,start_ticks='s',gate=SimpleNamespace(_identity=lambda pid:('s','S')))
  with patch.object(activate,'time') as clock:
   clock.monotonic.return_value=0
   self.assertTrue(activate.verify_retry_cleanup(guard,frozen,self.root/'hold',lambda:None)['noKillStarted'])
   for field,value in [('kill_started',True),('frozen',[1]),('guards',[1])]:
    old=getattr(guard,field);setattr(guard,field,value)
    with self.assertRaises(RuntimeError):activate.verify_retry_cleanup(guard,frozen,self.root/'hold',lambda:None)
    setattr(guard,field,old)
   (self.root/'hold').write_text('operator pause')
   with self.assertRaises(RuntimeError):activate.verify_retry_cleanup(guard,frozen,self.root/'hold',lambda:None)
 def test_cleanup_semantic_failure_is_not_a_retry_token(self):
  guard=SimpleNamespace(kill_started=False,frozen=[],guards=[],receipt={'restartGuardsRestored':True,'daemonAdmission':'aborted_without_terminating_work','restartGuards':[]},_all_targets=lambda:[],_identity=lambda pid:('t','S'))
  frozen=SimpleNamespace(pid=200,start_ticks='s',gate=SimpleNamespace(_identity=lambda pid:('s','S')))
  def bad():raise RuntimeError('fingerprint changed')
  with self.assertRaisesRegex(RuntimeError,'fingerprint changed'):activate.verify_retry_cleanup(guard,frozen,self.root/'hold',bad)
if __name__=='__main__':unittest.main()
