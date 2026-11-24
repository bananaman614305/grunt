"""Pure checks shared by activation and read-only completion verification."""
def maintenance_coverage(snapshot, eligible):
    eligible = set(eligible)
    rows = snapshot.get('sources')
    if not isinstance(rows, list): raise RuntimeError('Missing provider status rows')
    expected = {row['id'] for row in rows if isinstance(row, dict) and row.get('id') in eligible}
    present = {row['id'] for row in rows if isinstance(row, dict) and row.get('id') in expected and isinstance(row.get('maintenance'), dict)}
    missing = sorted(expected - present)
    if missing: raise RuntimeError('Missing shared maintenance coverage: ' + ','.join(missing))
    if not expected: raise RuntimeError('No eligible installed sources have maintenance coverage')
    return sorted(present)
