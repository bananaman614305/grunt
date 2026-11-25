"""Pure status projection for the one reviewed packaged adapter retirement and the owner-approved per-port opt-in additions.

Raw source advertisements remain exact, including disabled tombstones. This module
never selects providers or changes source configuration, quota stores, or deadlines.

An owner-approved opt-in (rollout_config.OWNER_OPT_INS) belongs to one pool only. The pool that carries it may be seen with it already
served (a later release) or without it (the release that first adds it): all or none of that pool's additions, nothing else added,
removed or moved, and the other pool must never serve it.
"""
from startup_gate import EXPECTATIONS, EXPECTED_UNION, EXPECTED_PORTS

PORTS = ('8792', '8793')
RETIRED = EXPECTATIONS['retiredPackagedSources']
OWNER_OPT_INS = EXPECTATIONS['ownerOptIns']
# Existing owner-configured primary advertisement is not a packaged adapter.
# Its exact port and enablement are preserved; no other unknown source is ignored.
LEGACY_ADVERTISEMENTS = EXPECTATIONS['legacyAdvertisements']
PREVIOUS_ELIGIBLE = sorted(EXPECTED_UNION + RETIRED)


def _rows(snapshot):
    rows = snapshot.get('sources') if isinstance(snapshot, dict) else None
    if not isinstance(rows, list) or not rows or len(rows) > 100:
        raise RuntimeError('Missing bounded source status projection')
    result = {}
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get('id'), str) or not isinstance(row.get('state'), str) or row['id'] in result:
            raise RuntimeError('Invalid or duplicate source status row')
        result[row['id']] = row
    return result


def capture_before(snapshots, candidate):
    """Pin old raw/eligible sets and the exact candidate catalog projection."""
    if candidate.get('retiredPackagedSources') != RETIRED or candidate.get('eligibleUnion') != EXPECTED_UNION:
        raise RuntimeError('Candidate package retirement proof changed')
    if set(snapshots) != set(PORTS) or candidate.get('sourceIdsPerPort') != EXPECTED_PORTS:
        raise RuntimeError('Expected both managed pool source projections')
    raw, old_eligible, new_eligible, legacy, added = {}, {}, {}, {}, {}
    for port in PORTS:
        rows = _rows(snapshots[port])
        if any(key not in rows for key in LEGACY_ADVERTISEMENTS[port]):
            raise RuntimeError('Pre-existing legacy source advertisement missing')
        legacy[port] = [{'id': key, 'disabled': rows[key]['state'] == 'disabled'} for key in LEGACY_ADVERTISEMENTS[port]]
        eligible = sorted(key for key, row in rows.items() if row['state'] != 'disabled' and key not in LEGACY_ADVERTISEMENTS[port])
        new = candidate['sourceIdsPerPort'][port]
        # Ordinary registry adoption may already disable this exact tombstone on
        # one old pool, independently of its installed runtime package version.
        if any(key not in rows or rows[key]['state'] == 'disabled' and rows[key].get('active', 0) != 0 for key in RETIRED):
            raise RuntimeError('Retired adapter advertisement missing or active')
        # The owner-approved opt-ins of this pool: all already served, or none yet. Only the missing ones are an authorized addition.
        approved = OWNER_OPT_INS[port]
        served = [key for key in approved if key in eligible]
        if served not in ([], approved):
            raise RuntimeError('Owner-approved opt-in sources are only partly served: ' + ','.join(approved))
        previous = sorted([key for key in new if key not in approved or key in served] + [key for key in RETIRED if rows[key]['state'] != 'disabled'])
        retiring = sorted(set(previous) - set(new))
        additions = sorted(set(approved) - set(served))
        if eligible != previous or new != EXPECTED_PORTS[port] or sorted(set(eligible) - set(new)) != retiring or sorted(set(new) - set(eligible)) != additions:
            raise RuntimeError('Only the pinned packaged-source retirement and the owner-approved per-port opt-ins are authorized: ' + ','.join(RETIRED + [key for ids in OWNER_OPT_INS.values() for key in ids]))
        raw[port], old_eligible[port], new_eligible[port], added[port] = sorted(rows), eligible, list(new), additions
    return {'retiredPackagedSources': list(RETIRED), 'rawSourceSetsBefore': raw,
            'legacyAdvertisements': legacy, 'eligibleSourceSetsBefore': old_eligible, 'eligibleSourceSetsAfter': new_eligible,
            'ownerOptIns': copy_ids(OWNER_OPT_INS), 'ownerOptInAdditions': added,
            'retiredRawCooldownRowsRequired': True}


def copy_ids(value):
    return {port: list(ids) for port, ids in value.items()}


def assert_after(snapshot, port, proof):
    """Require the exact prior advertisements and only Clixad disabled by release."""
    if port not in PORTS or proof.get('retiredPackagedSources') != RETIRED:
        raise RuntimeError('Unexpected source retirement scope')
    rows = _rows(snapshot)
    legacy = [{'id': key, 'disabled': rows[key]['state'] == 'disabled'} for key in LEGACY_ADVERTISEMENTS[port] if key in rows]
    if legacy != proof['legacyAdvertisements'][port]:
        raise RuntimeError('Pre-existing legacy source enablement changed')
    eligible = sorted(key for key, row in rows.items() if row['state'] != 'disabled' and key not in LEGACY_ADVERTISEMENTS[port])
    if proof.get('ownerOptIns') != OWNER_OPT_INS or set(proof.get('ownerOptInAdditions', {})) != set(PORTS):
        raise RuntimeError('Unexpected owner opt-in scope')
    if sorted(rows) != sorted({*proof['rawSourceSetsBefore'][port], *proof['ownerOptInAdditions'][port]}) or eligible != proof['eligibleSourceSetsAfter'][port]:
        raise RuntimeError('Installed source set changed beyond packaged retirement')
    for key in RETIRED:
        if rows[key]['state'] != 'disabled' or rows[key].get('active', 0) != 0:
            raise RuntimeError('Retired adapter is still eligible or active')
    return {'rawSourceIds': sorted(rows), 'eligibleSourceIds': eligible,
            'retiredDisabledAndInactive': list(RETIRED)}


def current_cooldowns(captured, port, proof):
    """Only current adapter status can expose a deadline; raw DB rows stay pinned."""
    status_eligible = set(proof['eligibleSourceSetsAfter'][port])
    status_eligible.update(row['id'] for row in proof['legacyAdvertisements'][port] if not row['disabled'])
    return {'windows': [row for row in captured['windows'] if row['id'] in status_eligible]}
