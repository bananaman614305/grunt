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
