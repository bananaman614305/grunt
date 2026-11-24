"""The live registry cache is brought current by the installed runtime's own RegistrySync (real candidate build, temp directories only)."""
import datetime
import hashlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

import preparation
import registry_cache
import registry_refresh
import test_support

RUNTIME = test_support.runtime()
NODE = test_support.node()
ENV = {'PATH': '/usr/bin:/bin'}


def node_eval(script, *args):
    return subprocess.check_output([NODE, '--input-type=module', '-e', script, *args], env=ENV)


class RegistryRefresh(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = self.root / 'config'
        self.config.mkdir(mode=0o700)
        self.cache = self.config / 'registry.json'
        self.cache.write_text('{"registry":{"legacy":"original"},"etag":"old"}')
        self.cache.chmod(0o600)
        script = 'const m=await import(process.argv[1]);process.stdout.write(JSON.stringify(m.bundledRegistry))'
        self.bundled = json.loads(node_eval(script, (RUNTIME / 'dist/registry.js').as_uri()))

    def newer(self, days=1):
        published = datetime.datetime.fromisoformat(self.bundled['published'].replace('Z', '+00:00')) + datetime.timedelta(days=days)
        return {**self.bundled, 'published': published.strftime('%Y-%m-%dT%H:%M:%S.000Z')}

    def raw(self, registry, **kw):
        return json.dumps(registry, **kw).encode()

    def write(self, registry, etag='"public-etag"', **kw):
        return registry_refresh.write_cache(RUNTIME, self.config, self.raw(registry, **kw), etag, node=NODE)

    def loaded(self):
        script = 'const {RegistrySync}=await import(process.argv[1]);const s=new RegistrySync({directory:process.argv[2]});await s.load();process.stdout.write(JSON.stringify(s.current.published))'
        return json.loads(node_eval(script, (RUNTIME / 'dist/local/registry.js').as_uri(), str(self.config)))

    def test_the_cache_gets_the_daemons_canonical_shape_atomically_with_its_private_mode(self):
        target = self.newer()
        # whitespace and key order in the public body must not matter: the runtime's own writer decides the bytes
        summary = self.write(target, indent=2)
        self.assertEqual(summary['published'], target['published'])
        body = self.cache.read_text()
        saved = json.loads(body)
        self.assertEqual(set(saved), {'registry', 'etag'})
        self.assertEqual(saved['etag'], '"public-etag"')
        self.assertEqual(body, json.dumps({'registry': saved['registry'], 'etag': saved['etag']}, ensure_ascii=False, separators=(',', ':')))
        self.assertEqual(self.cache.stat().st_mode & 0o777, 0o600)
        self.assertEqual([path.name for path in self.config.iterdir()], ['registry.json'])      # no temp file left behind
        self.assertEqual(self.loaded(), target['published'])
        # the existing proof helper accepts it as normal-writer output of the catalog the candidate computes
        script = 'const m=await import(process.argv[1]);process.stdout.write(JSON.stringify(m.validateRegistry(JSON.parse(process.argv[2]))))'
        catalog = hashlib.sha256(node_eval(script, (RUNTIME / 'dist/registry.js').as_uri(), self.raw(target).decode())).hexdigest()
        proof = {'path': str(self.cache), 'originalRawSha256': 'f' * 64, 'originalBackup': str(self.root / 'none'), 'candidateCatalogSha256': catalog}
        (self.root / 'none').write_bytes(b'x')
        (self.root / 'none').chmod(0o600)
        proof['originalRawSha256'] = hashlib.sha256(b'x').hexdigest()
        self.assertTrue(registry_cache.assert_preserved(proof, candidate_runtime=RUNTIME, node=NODE, allow_derived=True)['normalWriterShape'])

    def test_a_registry_without_an_etag_is_written_without_one(self):
        self.write(self.newer(), etag=None)
        self.assertEqual(set(json.loads(self.cache.read_text())), {'registry'})

    def test_an_older_or_invalid_registry_is_refused_and_the_cache_is_untouched(self):
        self.write(self.newer(2))
        before = self.cache.read_bytes()
        for label, body in (('older publication', self.raw(self.newer(1))), ('invalid', b'{"published":"2030-01-01T00:00:00.000Z","adapters":"no"}'), ('not json', b'nope')):
            with self.subTest(label), self.assertRaises(registry_refresh.RegistryRefreshError):
                registry_refresh.write_cache(RUNTIME, self.config, body, '"x"', node=NODE)
            self.assertEqual(self.cache.read_bytes(), before)

    def test_the_identical_publication_is_accepted_again(self):
        target = self.newer()
        self.write(target, etag='"a"')
        self.write(target, etag='"b"')
        self.assertEqual(json.loads(self.cache.read_text())['etag'], '"b"')

    def test_bring_registry_current_end_to_end_keeps_the_old_bytes_and_records_the_change(self):
        target = self.newer()
        old = self.cache.read_bytes()
        receipt = preparation.bring_registry_current(self.root, self.raw(target), '"public-etag"', runtime=RUNTIME, node=NODE, directory=self.config, check_pause=lambda: None,
                                                     read_cache=lambda: preparation._read_cache_bytes(self.cache), log=lambda text: None)
        self.assertEqual((receipt['action'], receipt['publication'], receipt['refetched']), ('written', target['published'], False))
        self.assertEqual((self.root / 'registry-cache-before-refresh.json').read_bytes(), old)
        self.assertEqual(json.loads(self.cache.read_text())['registry']['published'], target['published'])
        self.assertEqual(json.loads((self.root / 'registry-refresh.json').read_text())['rawSha256'], hashlib.sha256(self.cache.read_bytes()).hexdigest())
        second = self.root / 'second'
        second.mkdir()
        again = preparation.bring_registry_current(second, self.raw(target), '"public-etag"', runtime=RUNTIME, node=NODE, directory=self.config, check_pause=lambda: None,
                                                   read_cache=lambda: preparation._read_cache_bytes(self.cache), log=lambda text: None)
        self.assertEqual(again['action'], 'none')       # already current: no write, no backup
        self.assertFalse((second / 'registry-cache-before-refresh.json').exists())


if __name__ == '__main__':
    unittest.main()
