"""Private synthetic SQLite families; no daemon, signal, provider, or live DB access."""
import hashlib,json,os,sqlite3,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import sqlite_families,quota_store,collector_guard
class SQLiteFamilies(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent);self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)
  self.db=self.root/'diagnostics.db';self.backup=self.root/'snapshot'
 def unit(self,u,k):return '0' if k=='MainPID' else 'inactive'
 def snapshot(self,paths=None):return sqlite_families.backup(paths or [self.db],self.backup,stopped_units=['fixture'],unit_reader=self.unit)
 def test_snapshot_full_family_and_absent_sibling_then_restore_without_new_schema(self):
  db=sqlite3.connect(self.db);db.execute('CREATE TABLE old_raw(seq INTEGER PRIMARY KEY,value TEXT)');db.execute('INSERT INTO old_raw VALUES(1,?)',('immutable fixture',));db.commit();db.close()
  expected={s:('family-'+s).encode() for s in ('-journal','-wal','-shm')}
  for suffix,body in expected.items():Path(str(self.db)+suffix).write_bytes(body)
  before=self.db.read_bytes();missing=self.root/'not-yet-created.db';manifest=self.snapshot([self.db,missing])
  self.assertTrue(manifest['knownRuntimeWritersStopped']);self.assertEqual(len(manifest['families'][0]['members']),4);self.assertEqual(manifest['families'][1]['members'],[])
  self.db.write_bytes(b'candidate bytes');missing.write_bytes(b'new additive schema')
  sqlite_families.restore(self.backup,manifest,self.root/'failed',stopped_units=['fixture'],unit_reader=self.unit)
  self.assertEqual(self.db.read_bytes(),before);self.assertFalse(missing.exists())
  for suffix,body in expected.items():self.assertEqual(Path(str(self.db)+suffix).read_bytes(),body)
 def test_refuses_active_writer_before_any_snapshot_directory(self):
  with self.assertRaisesRegex(RuntimeError,'writers must be stopped'):sqlite_families.backup([self.db],self.backup,stopped_units=['fixture'],unit_reader=lambda u,k:'100' if k=='MainPID' else 'active')
  self.assertFalse(self.backup.exists());self.assertFalse(self.backup.with_name('snapshot.incomplete').exists())
 def test_family_change_during_copy_fails_without_publishing_snapshot(self):
  self.db.write_bytes(b'old');copy=sqlite_families.shutil.copyfile
  def mutate(a,b):
   result=copy(a,b);Path(str(self.db)+'-wal').write_bytes(b'late writer');return result
  with patch.object(sqlite_families.shutil,'copyfile',side_effect=mutate),self.assertRaisesRegex(RuntimeError,'membership changed'):self.snapshot()
  self.assertFalse(self.backup.exists())
 def test_symlink_family_fails(self):
  self.db.symlink_to(self.root/'elsewhere')
  with self.assertRaisesRegex(RuntimeError,'scope|symlink'):self.snapshot()
 def test_changed_backup_rejected_before_restore_moves_files(self):
  self.db.write_bytes(b'old');manifest=self.snapshot();self.db.write_bytes(b'candidate');(self.backup/'0').write_bytes(b'corrupt')
  with self.assertRaisesRegex(RuntimeError,'backup integrity'):sqlite_families.restore(self.backup,manifest,self.root/'failed',stopped_units=['fixture'],unit_reader=self.unit)
  self.assertEqual(self.db.read_bytes(),b'candidate')
 def test_schema_two_only_and_raw_performance_deadlines_unchanged(self):
  path=self.root/'routing-history.db';db=sqlite3.connect(path);db.executescript('CREATE TABLE routing_performance(source TEXT,profile TEXT,value TEXT,at REAL);CREATE TABLE routing_backoff(source TEXT PRIMARY KEY,value TEXT,at REAL);PRAGMA user_version=2;')
  db.execute('INSERT INTO routing_performance VALUES(?,?,?,?)',('fixture','tools','{"successes":7}',12));db.execute('INSERT INTO routing_backoff VALUES(?,?,?)',('fixture','{"code":"quota","until":999999}',42));db.commit();before=quota_store.digest_rows(db);db.close()
  proof=quota_store.prepare(self.root,{'windows':[{'id':'fixture','code':'upstream','retryAt':888888}]},100)
  self.assertEqual((proof['schemaBefore'],proof['schemaAfter']),(2,2));self.assertEqual(proof['windows'],[{'id':'fixture','code':'quota','retryAt':999999}])
  db=sqlite3.connect(path);self.assertEqual(before,quota_store.digest_rows(db));db.execute('PRAGMA user_version=1');db.close()
  with self.assertRaisesRegex(RuntimeError,'Unsupported'):quota_store.prepare(self.root,{'windows':[]},100)
 def test_collector_snapshot_preserves_cursor_and_rejects_mutation(self):
  p=self.root/'admin-collector-state.json';p.write_text(json.dumps({'version':1,'cursor':'127','streamId':'fixture'}));p.chmod(0o600)
  before=p.read_bytes();snapshot=collector_guard.capture(self.root,self.root,self.unit);collector_guard.assert_preserved(self.root,snapshot,self.unit)
  self.assertEqual(Path(snapshot['snapshotPath']).read_bytes(),before);self.assertEqual(snapshot['cursor'],'127')
  p.write_text(json.dumps({'version':1,'cursor':'128','streamId':'fixture'}))
  with self.assertRaisesRegex(RuntimeError,'checkpoint changed'):collector_guard.assert_preserved(self.root,snapshot,self.unit)
if __name__=='__main__':unittest.main()
