"""Private generated-cache fixtures using the candidate validator and stub fetcher."""
import hashlib,json,os,sqlite3,subprocess,tempfile,time,unittest
from pathlib import Path
import registry_cache

import test_support
RUNTIME=test_support.runtime()
NODE=test_support.node()

class RegistryCacheTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(dir=Path(__file__).parent);self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.config=self.root/'config';self.config.mkdir(mode=0o700)
        self.path=self.config/'registry.json';self.path.write_text('{"registry":{"legacy":"original"},"etag":"old"}');self.path.chmod(0o600)
        script='const m=await import(process.argv[1]);process.stdout.write(JSON.stringify(m.validateRegistry(m.bundledRegistry)))'
        self.registry=json.loads(subprocess.check_output([NODE,'--input-type=module','-e',script,(RUNTIME/'dist/registry.js').as_uri()],env={'PATH':'/usr/bin:/bin'}))
        self.catalog=hashlib.sha256(json.dumps(self.registry,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
        self.proof=registry_cache.capture(self.root,self.path,hashlib.sha256(self.path.read_bytes()).hexdigest(),self.catalog)
    def write(self,value):self.path.write_text(json.dumps(value,ensure_ascii=False,separators=(',',':')))
    def verify(self,allow=True):return registry_cache.assert_preserved(self.proof,candidate_runtime=RUNTIME,node=NODE,allow_derived=allow)
    def normal_sync(self):
        script='''const [{RegistrySync},m]=await Promise.all([import(process.argv[1]),import(process.argv[2])]);const sync=new RegistrySync({directory:process.argv[3],fetcher:async()=>new Response(JSON.stringify(m.bundledRegistry),{status:200,headers:{ETag:'"fixture-next"'}})});try{await sync.start()}finally{await sync.close()}'''
        subprocess.check_call([NODE,'--input-type=module','-e',script,(RUNTIME/'dist/local/registry.js').as_uri(),(RUNTIME/'dist/registry.js').as_uri(),str(self.config)],env={'PATH':'/usr/bin:/bin'})
    def test_original_raw_backup_and_unchanged_cache_require_no_derivation(self):
        self.assertTrue(self.verify(False)['rawBytesUnchanged'])
        self.assertEqual(Path(self.proof['originalBackup']).read_bytes(),self.path.read_bytes())
        self.assertEqual(registry_cache.capture(self.root,self.path,self.proof['originalRawSha256'],self.catalog),self.proof)
    def test_genuine_registry_sync_stub_write_is_accepted_only_after_startup(self):
        original=Path(self.proof['originalBackup']).read_bytes();self.normal_sync()
        with self.assertRaisesRegex(RuntimeError,'before new startup'):self.verify(False)
        value=self.verify();self.assertFalse(value['rawBytesUnchanged']);self.assertTrue(value['normalWriterShape']);self.assertEqual(value['catalogSha256'],self.catalog)
        self.assertEqual(Path(self.proof['originalBackup']).read_bytes(),original)
    def test_equal_bundled_publication_refresh_does_not_clear_actual_retired_backoff(self):
        self.assertEqual(self.catalog,'f6c7f89e7573797ce8da77764d0ebb1b422a70da79c2b15837cf1ba8988bb383')
        now=int(time.time()*1000)
        raw=json.dumps({'code':'upstream','signature':'upstream:::','streak':5,'at':now,'until':now+3600000},separators=(',',':'))
        database=self.config/'routing-history.db'
        db=sqlite3.connect(database);db.executescript('CREATE TABLE routing_performance(source TEXT,profile TEXT,value TEXT,at REAL);CREATE TABLE routing_backoff(source TEXT PRIMARY KEY,value TEXT,at REAL);PRAGMA user_version=2;')
        db.execute('INSERT INTO routing_backoff VALUES(?,?,?)',('opencode',raw,now));db.commit();before=db.execute('SELECT rowid,source,value,at FROM routing_backoff').fetchall();db.close();database.chmod(0o600)
        script='''import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const [root,directory,scenario='equal']=process.argv.slice(1);
const newer=scenario==='newer';
const mod=name=>import(pathToFileURL(root+'/dist/'+name+'.js').href);
const [{RegistrySync},m,{Sources},{RoutingHistory}]=await Promise.all([mod('local/registry'),mod('registry'),mod('local/source'),mod('local/routing-history')]);
globalThis.fetch=async()=>{throw Error('Unexpected live fetch')};
let current=m.bundledRegistry,published,unretireCalls=0,fetches=0,providerCalls=0;
const source={id:'opencode',available:async()=>{providerCalls++;throw Error('Provider must not run')},complete:async()=>{providerCalls++;throw Error('Provider must not run')}};
const sources=new Sources([source],{registry:()=>current});
const history=await RoutingHistory.open(directory);
await sources.setRoutingHistory(history);
assert.equal(sources.retired('opencode'),true);
const publications=[];
const payload=structuredClone(m.bundledRegistry);
if(newer)payload.published=new Date(Date.parse(payload.published)+1).toISOString();
const sync=new RegistrySync({directory,fetcher:async()=>{fetches++;return new Response(JSON.stringify(payload),{status:200,headers:{ETag:'"approved-same-publication"'}})},changed:value=>{
  // The exact newer-publication condition/binding used by actual main.ts.
  if(published!==undefined&&Date.parse(value.published)>Date.parse(published)){unretireCalls++;sources.unretire(value.adapters.map(adapter=>adapter.id))}
  published=value.published;current=value;publications.push(value.published);
}});
try{
 await sync.start();await sources.flushRoutingHistory();await history.flush();
 assert.equal(fetches,1);assert.equal(providerCalls,0);assert.equal(unretireCalls,Number(newer));
 assert.equal(publications.length,2);assert.equal(publications[0],m.bundledRegistry.published);assert.equal(publications[1],payload.published);
 assert.equal(sources.retired('opencode'),!newer);
 process.stdout.write(JSON.stringify({fetches,providerCalls,unretireCalls,publications,retiredStillTrue:sources.retired('opencode')}));
}finally{await sync.close();await sources.close();await history.close()}
'''
        result=json.loads(subprocess.check_output([NODE,'--input-type=module','-e',script,str(RUNTIME),str(self.config)],env={'PATH':'/usr/bin:/bin'},timeout=15))
        self.assertEqual(result['unretireCalls'],0);self.assertTrue(result['retiredStillTrue']);self.assertEqual(result['providerCalls'],0)
        db=sqlite3.connect(database);after=db.execute('SELECT rowid,source,value,at FROM routing_backoff').fetchall();db.close()
        self.assertEqual(after,before)
        self.assertTrue(self.verify()['normalWriterShape'])
        # Sensitivity control: a newer publication must expose the real old hazard.
        # Only this temporary synthetic row is deleted; live stores are never opened.
        control=json.loads(subprocess.check_output([NODE,'--input-type=module','-e',script,str(RUNTIME),str(self.config),'newer'],env={'PATH':'/usr/bin:/bin'},timeout=15))
        self.assertEqual(control['unretireCalls'],1);self.assertFalse(control['retiredStillTrue']);self.assertEqual(control['providerCalls'],0)
        db=sqlite3.connect(database);cleared=db.execute('SELECT rowid,source,value,at FROM routing_backoff').fetchall();db.close()
        self.assertEqual(cleared,[])
        with self.assertRaisesRegex(RuntimeError,'semantics or shape'):self.verify()

    def test_same_valid_catalog_with_new_or_absent_etag_is_accepted(self):
        for suffix in ({'etag':'"new"'},{}):
            self.write({'registry':self.registry,**suffix});self.assertTrue(self.verify()['normalWriterShape'])
    def test_changed_catalog_extra_keys_invalid_registry_or_nonwriter_shape_fail_closed(self):
        changed=json.loads(json.dumps(self.registry));changed['published']='2026-12-01T00:00:00.000Z'
        for value in ({'registry':changed,'etag':'new'}, {'registry':self.registry,'etag':'new','other':'unexpected'}, {'registry':{'invalid':True}}, {'registry':self.registry,'etag':None}):
            with self.subTest(valueKeys=list(value)):
                self.write(value)
                with self.assertRaisesRegex(RuntimeError,'semantics or shape'):self.verify()
        self.path.write_text(json.dumps({'registry':self.registry},indent=2))
        with self.assertRaisesRegex(RuntimeError,'semantics or shape'):self.verify()
    def test_active_cache_and_original_backup_reject_symlink_hardlink_mode_and_size_changes(self):
        for path in (self.path,Path(self.proof['originalBackup'])):
            original=path.read_bytes()
            with self.subTest(path=path.name,kind='symlink'):
                saved=path.with_name(path.name+'-saved');path.rename(saved);path.symlink_to(saved)
                try:
                    with self.assertRaises(RuntimeError):self.verify()
                finally:path.unlink();saved.rename(path)
            with self.subTest(path=path.name,kind='hardlink'):
                alias=path.with_name(path.name+'-alias');os.link(path,alias)
                try:
                    with self.assertRaises(RuntimeError):self.verify()
                finally:alias.unlink()
            with self.subTest(path=path.name,kind='mode'):
                path.chmod(0o644)
                try:
                    with self.assertRaises(RuntimeError):self.verify()
                finally:path.chmod(0o600)
            with self.subTest(path=path.name,kind='size'):
                path.write_bytes(b'x'*131073)
                try:
                    with self.assertRaises(RuntimeError):self.verify()
                finally:path.write_bytes(original)
        self.assertTrue(self.verify(False)['rawBytesUnchanged'])
    def test_etag_must_be_bounded_string_without_control_characters(self):
        for etag in ('x'*4097,'x\0y','x\ry','x\ny','x\ty','x\x7fy',{},[],True,1):
            with self.subTest(etagType=type(etag).__name__):
                self.write({'registry':self.registry,'etag':etag})
                with self.assertRaisesRegex(RuntimeError,'semantics or shape'):self.verify()
    def test_original_backup_contents_cannot_be_substituted(self):
        Path(self.proof['originalBackup']).write_text('tampered')
        with self.assertRaisesRegex(RuntimeError,'backup was altered'):self.verify()

if __name__=='__main__':unittest.main()
