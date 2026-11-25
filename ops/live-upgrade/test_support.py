"""Shared test configuration: the candidate runtime build and the Node binary the helper fixtures use.

`GRUNT_UPGRADE_TEST_RUNTIME` names a built checkout (dist/ present) of the release under test; it defaults to this repository, so run
`pnpm build` first. Tests that need it skip with a clear message when it is missing. `GRUNT_UPGRADE_TEST_NODE` overrides the Node
binary (default: `node` from PATH). Nothing here touches the live host."""
import os
import shutil
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def runtime():
    path = Path(os.environ.get('GRUNT_UPGRADE_TEST_RUNTIME') or REPO).resolve()
    if not (path / 'dist/local/registry.js').is_file():
        raise unittest.SkipTest(f'no built runtime at {path}: run `pnpm build` or set GRUNT_UPGRADE_TEST_RUNTIME')
    return path


def node():
    value = os.environ.get('GRUNT_UPGRADE_TEST_NODE') or shutil.which('node')
    value = os.path.realpath(value) if value else value   # the startup gate compares resolved binaries
    if not value:
        raise unittest.SkipTest('no node binary found; set GRUNT_UPGRADE_TEST_NODE')
    return value


def runtime_with_ifm(directory):
    """A private copy of the candidate build in which `ifm` is a local opt-in source with a manual, material data-sharing policy: what the
    release that adds IFM ships. A candidate that already carries it is copied unchanged. Fixtures use this to exercise the owner-approved
    per-port opt-in without depending on which release the checkout is."""
    source = runtime()
    target = Path(directory) / 'ifm-runtime'
    shutil.copytree(source / 'dist', target / 'dist')
    shutil.copy2(source / 'package.json', target / 'package.json')
    (target / 'node_modules').symlink_to(source / 'node_modules')
    registry, sharing = target / 'dist/registry.js', target / 'dist/local/data-sharing.js'
    text = registry.read_text()
    if "id: 'ifm'" not in text:
        anchor = 'export const localOptInAdapters = ['
        assert text.count(anchor) == 1
        registry.write_text(text.replace(anchor, anchor + "\n    { id: 'ifm', kind: 'model', tier: 'experimental', weight: 0.001, modalities: ['text'], install: 'builtin:ifm', model: 'IFM/K2-Horizon-375B-A23B' },"))
    text = sharing.read_text()
    if "provider: 'ifm'" not in text:
        anchor = 'export const DATA_SHARING_POLICIES = [{'
        assert text.count(anchor) == 1
        sharing.write_text(text.replace(anchor, anchor + "\n  provider: 'ifm', name: 'IFM K2 Horizon (fixture)', version: '2026-11-25-fixture', disclosure: 'Fixture policy.', url: 'https://example.invalid/privacy', approval: 'material', manual: true\n}, {"))
    return target
