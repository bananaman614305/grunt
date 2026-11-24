"""The release pair is derived (attempt.json from `--version` and the installed runtime), never edited by hand. Guard against a version
literal creeping back into the helpers, and check the runtime contract against the candidate build."""
import ast
import re
import subprocess
import unittest
from pathlib import Path

import attempt
import test_support

HERE = Path(__file__).resolve().parent
VERSION = re.compile(r'\d+\.\d+\.\d+')


class NoVersionLiterals(unittest.TestCase):
    def test_no_helper_or_tool_names_a_release_in_a_string_literal(self):
        found = []
        for name in sorted(set(attempt.helper_names()) | set(attempt.TOOLING)):
            if not name.endswith('.py'):
                continue
            for node in ast.walk(ast.parse((HERE / name).read_text())):
                if isinstance(node, ast.Constant) and isinstance(node.value, str) and VERSION.fullmatch(node.value):
                    found.append((name, node.value))
        self.assertEqual(found, [])

    def test_the_version_pair_is_never_assigned_a_literal(self):
        for name in attempt.helper_names():
            if name.endswith('.py'):
                text = (HERE / name).read_text()
                self.assertNotRegex(text, r"(?m)^\s*(PREVIOUS_)?VERSION\s*=\s*'", name)


class RuntimeContract(unittest.TestCase):
    def test_the_candidate_build_satisfies_the_runner_contract(self):
        runtime, node = test_support.runtime(), test_support.node()
        result = subprocess.run([node, str(HERE / 'check_runtime_contract.mjs'), str(runtime), '--import'], capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stdout[-800:] + result.stderr[-400:])
        self.assertIn('CONTRACT OK', result.stdout)


if __name__ == '__main__':
    unittest.main()
