"""Inert catalog/status fixtures; no runtime processes or provider requests."""
import copy
import unittest
from source_transition import capture_before, assert_after, current_cooldowns, EXPECTED_UNION, PREVIOUS_ELIGIBLE


def snapshot(ids):
    return {'sources': [{'id': key, 'state': 'available', 'active': 0} for key in ids] +
            [{'id': key, 'state': 'disabled', 'active': 0} for key in ('freebuff', 'apinex')]}


class SourceTransitionTest(unittest.TestCase):
    def setUp(self):
        self.old = {port: snapshot(PREVIOUS_ELIGIBLE + (['freellmapi'] if port == '8792' else [])) for port in ('8792', '8793')}
        self.candidate = {'retiredPackagedSources': ['clixad'], 'eligibleUnion': EXPECTED_UNION,
                          'sourceIdsPerPort': {port: EXPECTED_UNION for port in ('8792', '8793')}}
        self.proof = capture_before(self.old, self.candidate)
        self.after = copy.deepcopy(self.old['8792'])
        next(row for row in self.after['sources'] if row['id'] == 'clixad')['state'] = 'disabled'

    def test_only_eligibility_loses_clixad_raw_tombstone_remains(self):
        result = assert_after(self.after, '8792', self.proof)
        self.assertIn('clixad', result['rawSourceIds'])
        self.assertNotIn('clixad', result['eligibleSourceIds'])
        self.assertEqual(self.proof['eligibleSourceSetsBefore']['8792'], PREVIOUS_ELIGIBLE)
        self.assertEqual(self.proof['eligibleSourceSetsAfter']['8792'], EXPECTED_UNION)

    def test_exact_clixad_may_already_be_disabled_on_either_or_both_old_ports(self):
        for disabled_ports in (('8792',),('8793',),('8792','8793')):
            with self.subTest(disabledPorts=disabled_ports):
                old=copy.deepcopy(self.old)
                for port in disabled_ports:
                    next(row for row in old[port]['sources'] if row['id']=='clixad')['state']='disabled'
                proof=capture_before(old,self.candidate)
                for port in ('8792','8793'):
                    self.assertEqual(proof['eligibleSourceSetsBefore'][port],EXPECTED_UNION if port in disabled_ports else PREVIOUS_ELIGIBLE)
                    self.assertEqual(proof['rawSourceSetsBefore'][port],sorted(row['id'] for row in self.old[port]['sources']))
                    after=copy.deepcopy(old[port]);next(row for row in after['sources'] if row['id']=='clixad')['state']='disabled'
                    self.assertEqual(assert_after(after,port,proof)['eligibleSourceIds'],EXPECTED_UNION)
                windows={'windows':[{'id':'clixad','retryAt':9999999999999,'code':'quota'},{'id':'kilo','retryAt':9999999999999,'code':'quota'}]}
                preserved=copy.deepcopy(windows)
                self.assertEqual(current_cooldowns(windows,'8793',proof),{'windows':[windows['windows'][1]]})
                self.assertEqual(windows,preserved)

    def test_already_disabled_clixad_does_not_authorize_any_other_old_or_new_change(self):
        for target in ('missing_clixad','active_clixad','other_disabled','other_missing','other_extra','legacy_disabled_after'):
            with self.subTest(target=target):
                old=copy.deepcopy(self.old)
                next(row for row in old['8793']['sources'] if row['id']=='clixad')['state']='disabled'
                if target=='missing_clixad':old['8793']['sources']=[row for row in old['8793']['sources'] if row['id']!='clixad']
                if target=='active_clixad':next(row for row in old['8793']['sources'] if row['id']=='clixad')['active']=1
                if target=='other_disabled':next(row for row in old['8793']['sources'] if row['id']=='kilo')['state']='disabled'
                if target=='other_missing':old['8793']['sources']=[row for row in old['8793']['sources'] if row['id']!='kilo']
                if target=='other_extra':old['8793']['sources'].append({'id':'unexpected','state':'available','active':0})
                with self.assertRaises(RuntimeError):
                    proof=capture_before(old,self.candidate)
                    after=copy.deepcopy(old['8792']);next(row for row in after['sources'] if row['id']=='clixad')['state']='disabled'
                    if target=='legacy_disabled_after':next(row for row in after['sources'] if row['id']=='freellmapi')['state']='disabled'
                    assert_after(after,'8792',proof)


    def test_candidate_registry_must_prove_exact_retirement(self):
        for value in ([], ['clixad', 'kilo'], None):
            candidate = copy.deepcopy(self.candidate); candidate['retiredPackagedSources'] = value
            with self.assertRaises(RuntimeError): capture_before(self.old, candidate)

    def test_old_and_new_catalog_drift_and_duplicate_rows_fail_closed(self):
        for target in ('old_missing', 'old_disabled', 'old_duplicate', 'new_missing', 'new_extra', 'new_active', 'new_clixad_enabled', 'new_other_disabled', 'legacy_missing', 'legacy_moved', 'legacy_disabled'):
            with self.subTest(target=target):
                old, after = copy.deepcopy(self.old), copy.deepcopy(self.after)
                if target == 'old_missing': old['8793']['sources'] = old['8793']['sources'][1:]
                if target == 'old_disabled': old['8793']['sources'][0]['state'] = 'disabled'
                if target == 'old_duplicate': old['8793']['sources'].append(old['8793']['sources'][0])
                if target == 'new_missing': after['sources'] = after['sources'][1:]
                if target == 'new_extra': after['sources'].append({'id': 'unexpected', 'state': 'available'})
                if target == 'new_active': next(r for r in after['sources'] if r['id'] == 'clixad')['active'] = 1
                if target == 'new_clixad_enabled': next(r for r in after['sources'] if r['id'] == 'clixad')['state'] = 'available'
                if target == 'new_other_disabled': next(r for r in after['sources'] if r['id'] == 'kilo')['state'] = 'disabled'
                if target == 'legacy_missing': old['8792']['sources'] = [r for r in old['8792']['sources'] if r['id'] != 'freellmapi']
                if target == 'legacy_moved': old['8793']['sources'].append({'id': 'freellmapi', 'state': 'available'})
                if target == 'legacy_disabled': next(r for r in after['sources'] if r['id'] == 'freellmapi')['state'] = 'disabled'
                with self.assertRaises(RuntimeError):
                    proof = capture_before(old, self.candidate)
                    assert_after(after, '8792', proof)

    def test_retired_raw_cooldown_is_preserved_but_status_projection_excludes_it(self):
        captured = {'windows': [{'id': 'clixad', 'until': 999999, 'code': 'quota'},
                                {'id': 'kilo', 'until': 999999, 'code': 'quota'},
                                {'id': 'freellmapi', 'until': 999999, 'code': 'upstream'},
                                {'id': 'freebuff', 'until': 999999, 'code': 'quota'}]}
        before = copy.deepcopy(captured)
        self.assertEqual(current_cooldowns(captured, '8792', self.proof), {'windows': captured['windows'][1:3]})
        self.assertEqual(captured, before)


if __name__ == '__main__': unittest.main()
