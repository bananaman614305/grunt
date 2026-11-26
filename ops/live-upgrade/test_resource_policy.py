"""Read-only cgroup policy fixtures."""
import unittest
from unittest.mock import patch
import stage

class ResourcePolicyTest(unittest.TestCase):
    def test_exact_four_cpu_ratio_must_remain_unchanged(self):
        with patch.object(stage, 'cpu_policy', return_value='400000 100000'):
            stage.assert_cpu_policy('400000 100000')
            for expected in ('max 100000', '100000 100000', '800000 100000', '300000 100000', '200000 100000', '700000 100000', '900000 100000', '0 0', '400000', '800000 200000', None):
                with self.subTest(expected=expected), self.assertRaises(RuntimeError): stage.assert_cpu_policy(expected)

if __name__ == '__main__': unittest.main()
