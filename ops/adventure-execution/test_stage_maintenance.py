import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


spec = importlib.util.spec_from_file_location('maintenance_stage', Path(__file__).with_name('stage_maintenance.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
SOURCE = b"""import { createWorkerRuntime } from './runtime/dist/local/worker-runtime.js';
await sync.start();
await Promise.all([sync.close(),workerRuntime.close()]);
"""


def runtime(root):
    directory = root / 'runtime' / 'dist' / 'local'
    directory.mkdir(parents=True)
    (directory / 'worker-runtime.js').write_text('// synthetic runtime fixture\n')


class StageMaintenanceTests(unittest.TestCase):
    def test_refuses_a_runtime_without_subworkers_and_an_already_wired_helper(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            source, destination = root / 'free-pool.mjs', root / 'stage'
            source.write_bytes(SOURCE)
            with self.assertRaisesRegex(ValueError, 'no worker-runtime.js'):
                module.stage(source, destination)
            self.assertFalse(destination.exists())
            runtime(root)
            source.write_bytes(SOURCE + b'const maintenance=createSourceMaintenance(sources,{directory});\n')
            with self.assertRaisesRegex(ValueError, 'already wires'):
                module.stage(source, destination)
            self.assertFalse(destination.exists())

    def test_stages_only_and_keeps_current_helper_untouched(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            source, destination = root / 'free-pool.mjs', root / 'stage'
            runtime(root)
            source.write_bytes(SOURCE)
            receipt = module.stage(source, destination)
            self.assertEqual(source.read_bytes(), SOURCE)
            self.assertFalse(receipt['activated'])
            candidate = (destination / 'free-pool.next.mjs').read_text()
            self.assertIn('createSourceMaintenance(sources,{directory', candidate)
            self.assertIn('maintenance.close()', candidate)
            self.assertEqual((destination / 'free-pool.next.mjs').stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads((destination / 'receipt.json').read_text()), receipt)
            with self.assertRaises(ValueError):
                module.stage(source, destination)

    def test_changed_anchor_stops_before_creating_output(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            source, destination = root / 'free-pool.mjs', root / 'stage'
            runtime(root)
            source.write_bytes(SOURCE.replace(b'await sync.start();', b'await different.start();'))
            with self.assertRaises(ValueError):
                module.stage(source, destination)
            self.assertFalse(destination.exists())

    def test_refuses_a_source_symlink(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            source, target = root / 'free-pool.mjs', root / 'target'
            runtime(root)
            target.write_bytes(SOURCE)
            source.symlink_to(target)
            with self.assertRaises(OSError):
                module.stage(source, root / 'stage')
            self.assertEqual(target.read_bytes(), SOURCE)


if __name__ == '__main__':
    unittest.main()
