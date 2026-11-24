#!/usr/bin/env python3
"""Read-only live metadata compatibility proof; never authorizes checkpoint admission."""
import json,time
from pathlib import Path
import activate,stage,source_transition
from startup_gate import StartupGate

def preflight():
    hold=activate.STATE/'execution-upgrade-hold'
    if hold.exists() or hold.is_symlink():raise RuntimeError('Preserve deliberate/current rollout hold; do not issue local HTTP preflight')
    plan=json.loads((stage.ROOT/'runtime-stage.json').read_text())
    for path,digest in plan['protectedFiles'].items():
        if stage.sha(path)!=digest:raise RuntimeError('Protected owner/config bytes changed')
    for row in plan['ownerFiles']:
        if stage.sha(row['dest'])!=row['oldSha256'] or stage.sha(row['staged'])!=row['newSha256']:raise RuntimeError('Owner launcher/brief/release CLI changed since stage')
    for name,digest in plan['helpers'].items():
        if stage.sha(stage.ROOT/name)!=digest:raise RuntimeError('Reviewed upgrade helper changed')
    for unit,digest in plan['unitFingerprints'].items():
        if stage.unit_fingerprint(unit)!=digest:raise RuntimeError('Managed unit fingerprint changed')
    environment=activate.primary_environment();environment['GRUNT_SETUP_NO_DATA_SHARING']='1'
    snapshots={str(port):activate.get(port,'/v1/status') for port in (8792,8793)}
    sets={port:activate.source_ids(value) for port,value in snapshots.items()};now=int(time.time()*1000)
    gate=StartupGate.capture(config_directory=activate.HOST_POLICY.parent,candidate_runtime=plan['runtimes'][0]['new'],node=activate.NODE,effective_environment=environment,hard_deadline_ms=now+180000,margin_ms=60000,source_ids_per_port=sets)
    gate.assert_ready(environment,source_ids_per_port=sets)
    transition=source_transition.capture_before(snapshots,gate.baseline)
    value={'version':stage.VERSION,'readOnlyPreflightPassed':True,'at':time.time(),'admissionAuthorization':False,'naturalCheckpointRequired':True,'providerRequests':0,'liveChanges':False,'startupProof':gate.baseline,'sourceTransitionProof':transition,'stageSha256':stage.sha(stage.ROOT/'runtime-stage.json')}
    stage.save(stage.ROOT/'preflight-proof.json',value)
    return value
if __name__=='__main__':print(json.dumps(preflight()))
