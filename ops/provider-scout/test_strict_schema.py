import json, unittest
from pathlib import Path
import scout


def strict_problems(node, path=''):
    """OpenAI/Codex --output-schema runs in strict structured-output mode."""
    problems = []
    if isinstance(node, dict):
        if 'properties' in node or node.get('type') == 'object':
            props = node.get('properties', {})
            if node.get('additionalProperties') is not False:
                problems.append(f'{path}: additionalProperties must be false')
            missing = sorted(set(props) - set(node.get('required', [])))
            if missing:
                problems.append(f'{path}: not in required: {missing}')
        for key, value in node.items():
            problems += strict_problems(value, f'{path}/{key}')
    elif isinstance(node, list):
        for index, value in enumerate(node):
            problems += strict_problems(value, f'{path}[{index}]')
    return problems


class StrictOutputSchema(unittest.TestCase):
    def test_report_schema_is_strict_mode_compatible(self):
        schema = json.loads((Path(__file__).parent / 'report.schema.json').read_text())
        self.assertEqual(strict_problems(schema), [])

    def test_discovery_schema_is_strict_mode_compatible(self):
        schema = json.loads((Path(__file__).parent / 'report.schema.json').read_text())
        derived = scout.with_review_field(schema, 'change_evidence',
                                          {'anyOf': [scout.CHANGE_EVIDENCE, {'type': 'null'}]}, required=True)
        self.assertEqual(strict_problems(derived), [])


if __name__ == '__main__':
    unittest.main()
