#!/usr/bin/env python3
"""Planned-maintenance-pause controller for the live upgrade (runs as a transient unit started by upgrade.py).

Preparation (registry wait, installed-runtime check, stage, read-only preflight), then, instead of waiting for a lucky natural
checkpoint, pauses the builder between cycles (maintenance_pause.py), settles the host, pools,
maintenance schedule and transports on purpose, and runs the UNCHANGED activation transaction (activate.activate) on the frozen
supervisor. The builder and the two quieted pollers are resumed on every path. Exit codes: 0 activated and first cycle verified,
3 clean give-up with nothing mutated (builder resumed; use a fresh attempt directory), 4 state changed by someone else (resumed
only what this run froze), 1 anything else (see activation-receipt.json / pause-outcome.json).
"""
import argparse
import importlib.util
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import stage
import preflight
import activate
import maintenance_pause
from checkpoint_gate import CheckpointGate, GateError, read_json
from startup_gate import MaintenanceWindowError
from rollout_config import VERSION
import end_cycle as end_cycle_module

ROOT = Path(__file__).resolve().parent
STATE = activate.STATE


class Terminated(BaseException):
    """SIGTERM (systemctl stop of this unit) while paused: unwind through the finally blocks that resume the builder."""


def _on_term(*_):
    raise Terminated('SIGTERM')


def _load(name):
    return importlib.import_module(name)


def preflight_when_clear(deadline, *, run=None, clock=time.monotonic, sleep=time.sleep, log=print):
    """The read-only preflight runs the startup gate, which refuses while a source check is within the startup window. That is
    pure schedule timing and changes nothing, so wait for it (bounded) instead of failing the whole operation."""
    run = run or preflight.preflight
    while True:
        try:
            return run()
        except MaintenanceWindowError as error:
            if clock() + 15 >= deadline:
                raise
            log(f'[pause] preflight: source check for {error.earliest_source} is inside the startup window; retrying in 15 s')
            sleep(15)


def build_pauser(config, *, log=print):
    gate = CheckpointGate(status_path=STATE / 'status.json', supervisor_pid=activate.pid, expected_backend_script=activate.OWNER / 'free-pool.mjs',
                          expected_node=activate.NODE, after_cycle=None)  # no host check here: freeze at the checkpoint, settle the host while frozen
    holder = SimpleNamespace(pauser=None)

    def sockets():
        if holder.pauser.frozen is not None:
            backend = holder.pauser.frozen.backend_pid
        else:  # read-only --probe, nothing frozen: the supervisor's sole child is the free-pool backend
            supervisor = activate.pid()
            backend = int((Path('/proc') / str(supervisor) / 'task' / str(supervisor) / 'children').read_text().split()[0])
        return maintenance_pause.managed_sockets([int(activate.unit_value('milo.service', 'MainPID')), backend, int(activate.unit_value(activate.HOST_UNIT, 'MainPID'))])

    def watchdog(spec):
        return maintenance_pause.spawn_watchdog_unit(spec, ROOT / 'pause-watchdog.json', f'grunt-pause-watchdog-{os.getpid()}', ctl=activate.ctl)

    reserve = config['pauseSettleBudgetSeconds'] + config['activationBudgetSeconds'] + config['verifyBudgetSeconds']
    wait = max(0.0, min(float(config['checkpointWaitSeconds']), config['deadlineMonotonic'] - time.monotonic() - reserve))  # never let the cycle wait eat the pause/activation budget
    settings = maintenance_pause.Settings(settle_budget=config['pauseSettleBudgetSeconds'], freeze_timeout=wait)
    ending = config.get('endCycle')
    end_cycle = None
    if isinstance(ending, dict) and ending.get('authorized') is True:   # explicit owner authorization recorded by `upgrade.py --end-cycle`
        end_cycle = lambda deadline: end_cycle_module.end_running_cycle(
            read_status=lambda: read_json(STATE / 'status.json'), supervisor_pid=activate.pid, min_age=float(ending.get('minAgeSeconds', end_cycle_module.DEFAULT_MIN_AGE)),
            deadline=deadline, log=log)
    holder.pauser = maintenance_pause.Pauser(
        gate=gate, unit_value=activate.unit_value, ctl=activate.ctl, read_status=lambda: read_json(STATE / 'status.json'),
        pools=lambda: [activate.get(port, '/v1/status') for port in maintenance_pause.POOL_PORTS], host_quiet=lambda: activate.host_quiet(),
        maintenance=maintenance_pause.maintenance_lead, sockets=sockets, hold_path=STATE / 'execution-upgrade-hold',
        managed_units=(*activate.UNITS, activate.HOST_UNIT), preserve_paths=(STATE / 'execution-upgrade-hold', ROOT / 'startup-attempted.json', ROOT / 'work-may-resume.json'),
        log=log, state_writer=lambda value: activate.save(ROOT / 'pause-state.json', value), settings=settings, watchdog=watchdog, end_cycle=end_cycle)
    return holder.pauser


def verify_first_cycle(config, *, read_status=None, run_verify=None, clock=time.monotonic, sleep=time.sleep, log=print):
    """After the hold is released the new supervisor starts the first cycle on the new release by itself. Observe (read-only) that the builder
    is working on the Claude harness, that model replies rise, and run the existing success verification."""
    read_status = read_status or (lambda: json.loads((STATE / 'status.json').read_text()))
    run_verify = run_verify or (lambda: subprocess.run([sys.executable, str(ROOT / 'verify_success.py')], capture_output=True, text=True, timeout=120,
                                                         env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1', 'XDG_RUNTIME_DIR': f'/run/user/{os.getuid()}',
                                                              'DBUS_SESSION_BUS_ADDRESS': f'unix:path=/run/user/{os.getuid()}/bus'}))
    deadline = clock() + config['verifyBudgetSeconds']
    result = {'at': time.time(), 'working': False, 'modelRepliesRising': False, 'verifySuccess': None}
    baseline = None
    while clock() < deadline:
        try:
            status = read_status()
        except (OSError, ValueError):
            sleep(2)
            continue
        if status.get('phase') == 'working' and status.get('harness') == 'claude-code' and type(status.get('workerPid')) is int:
            if not result['working']:
                result.update(working=True, firstWorkingSeen=time.time(), cyclesAtWork=status.get('cycles'))
                baseline = status.get('modelReplies')
                log(f'[pause] first cycle working (pid {status["workerPid"]}); modelReplies baseline {baseline}')
            elif type(status.get('modelReplies')) is int and type(baseline) is int and status['modelReplies'] > baseline:
                result.update(modelRepliesRising=True, modelReplies=status['modelReplies'], baselineModelReplies=baseline)
                break
        sleep(5)
    completed = run_verify()
    result.update(verifySuccess=completed.returncode == 0, verifyOutput=(completed.stdout or completed.stderr or '')[-600:])
    result['ok'] = bool(result['working'] and result['modelRepliesRising'] and result['verifySuccess'])
    return result


def clean_outcome(kind, error, pauser, *, supervisor_state=None):
    state = supervisor_state
    if state is None and pauser is not None and pauser.frozen is not None:
        try:
            state = pauser.gate._identity(pauser.frozen.pid)[1]
        except Exception:
            state = 'unknown'
    value = {'version': VERSION, 'outcome': kind, 'failureType': type(error).__name__, 'failure': str(error)[:600], 'at': time.time(), 'mutated': False,
             'supervisorStateAfter': state, 'builderResumed': state not in ('T', 't'), 'newAttemptDirectoryRequired': True,
             'holdPresent': (STATE / 'execution-upgrade-hold').exists(), 'settle': pauser.report if pauser is not None else None}
    activate.save(ROOT / 'pause-outcome.json', value)
    activate.save(ROOT / 'release-state.json', {'version': VERSION, 'state': 'pause_window_ended_without_mutation', 'reason': kind,
                  'receipt': str(ROOT / 'pause-outcome.json'), 'holdPresent': value['holdPresent']})
    return value


def run(config, *, pauser_factory=None, activate_fn=None, verify=None, log=print):
    started = time.time()
    paa = _load('preparation')
    pauser = None
    old_term = signal.signal(signal.SIGTERM, _on_term)
    try:
        prep = paa.private_json(ROOT / 'attempt-preparation.json')
        if prep.get('newAdmissionBudgetAuthorized') is not True or prep.get('totalAdmissionBudgetSeconds') != 7200:
            raise ValueError('Explicit fresh bounded authorization required')
        approved_path = ROOT / 'approved-registry-public.json'
        if stage.sha(approved_path) != prep['publicRegistrySha256']:
            raise ValueError('Pinned public registry changed')
        approved = paa.private_json(approved_path)
        if approved.get('published') != prep['publicRegistryPublication']:
            raise ValueError('Pinned registry publication changed')
        activate.save(ROOT / 'release-state.json', {'version': VERSION, 'state': 'waiting_for_normal_registry_refresh', 'mode': 'planned_pause',
                      'deadlineMonotonic': config['deadlineMonotonic'], 'publicRegistrySha256': prep['publicRegistrySha256'], 'at': time.time(), 'liveChanges': False, 'providerProbes': 0})
        paa.wait_for_normal_registry(config['deadlineMonotonic'], approved)
        paa.preserve_pause()
        for row in paa.private_json(ROOT / 'old-runtime-manifests.json'):
            for name, digest in row['oldFiles'].items():
                if stage.sha(Path(row['live']) / name) != digest:
                    raise RuntimeError('Previously verified installed runtime changed')
        stage.stage(SimpleNamespace(archive=prep['archive'], source=prep['source'], release_manifest=prep['releaseManifest'], opencode_profile_sha256=prep['opencodeProfileSha256']))
        preflight_when_clear(config['deadlineMonotonic'], log=log)
        paa.preserve_pause()
        activate.save(ROOT / 'release-state.json', {'version': VERSION, 'state': 'staged_waiting_for_cycle_end_then_planned_pause', 'mode': 'planned_pause',
                      'at': time.time(), 'liveChanges': False, 'checkpointWaitSeconds': config['checkpointWaitSeconds'], 'pauseSettleBudgetSeconds': config['pauseSettleBudgetSeconds']})
        pauser = pauser_factory(config) if pauser_factory else build_pauser(config, log=log)

        box = {}

        def go(frozen, report):
            pauser.gate.verify_frozen(frozen)  # a GateError here is a clean give-up (nothing mutated, no terminal receipt); activate re-runs the same proof itself
            deadline = time.monotonic() + config['activationBudgetSeconds']
            activate.save(ROOT / 'activation-ready.json', {'version': VERSION, 'pid': os.getpid(), 'phase': 'planned_pause_settled', 'at': time.time(),
                          'stageSha256': activate.sha(ROOT / 'runtime-stage.json'), 'timeout': config['activationBudgetSeconds'], 'overallMonotonicDeadline': deadline,
                          'liveChanges': False, 'afterCycle': None, 'settle': report})
            signal.signal(signal.SIGTERM, signal.SIG_IGN)  # a stop mid-transaction must not interleave with its own cleanup
            try:
                box['receipt'] = (activate_fn or activate.activate)(config['activationBudgetSeconds'], retry_mode=True, attempt_number=1, overall_deadline=deadline, after_cycle=None, frozen_in=frozen)
                return box['receipt']
            finally:
                signal.signal(signal.SIGTERM, _on_term)

        try:
            pauser.run(go)
        except BaseException as error:
            if box.get('receipt') is not None:
                # The upgrade itself succeeded; only restoring a passive poller failed. Never report that as a clean no-mutation outcome.
                log('[pause] WARNING after a successful activation: ' + str(error)[:200])
                activate.save(ROOT / 'pause-restore-warning.json', {'at': time.time(), 'failureType': type(error).__name__, 'failure': str(error)[:300]})
            elif isinstance(error, maintenance_pause.PauseAborted):
                clean_outcome('state_changed_by_someone_else', error, pauser)
                raise SystemExit(4) from error
            elif isinstance(error, maintenance_pause.PauseError):
                clean_outcome('settle_timeout' if isinstance(error, maintenance_pause.SettleTimeout) else 'pause_error', error, pauser)
                raise SystemExit(3) from error
            elif isinstance(error, GateError):
                clean_outcome('checkpoint_not_admitted', error, pauser)
                raise SystemExit(3) from error
            elif isinstance(error, Terminated):
                clean_outcome('stopped_by_operator', error, pauser)
                raise SystemExit(3) from error
            elif getattr(error, 'upgrade_retry_safe', False) is True:
                clean_outcome('activation_rejected_before_mutation_' + str(getattr(error, 'admission_rejection_code', None) or type(error).__name__), error, pauser)
                raise SystemExit(3) from error
            else:
                raise
        receipt = box['receipt']
        # Builder: resumed by the new supervisor at hold release (activate), pollers restored by pauser.close(). Observe the first cycle.
        outcome = verify(config) if verify else verify_first_cycle(config, log=log)
        activate.save(ROOT / 'pause-verification.json', outcome)
        if outcome.get('ok'):
            activate.save(ROOT / 'release-state.json', {'version': VERSION, 'state': 'activated_and_first_cycle_verified', 'receipt': str(ROOT / 'activation-receipt.json'),
                          'verification': str(ROOT / 'pause-verification.json'), 'at': time.time()})
        else:
            log('[pause] ACTIVATED, but first-cycle verification did not complete: ' + json.dumps({k: v for k, v in outcome.items() if k != 'verifyOutput'}))
        return {'receipt': {k: receipt.get(k) for k in ('success', 'workResumed', 'startupHoldReleased', 'completedAt')}, 'verification': outcome}
    except SystemExit:
        raise
    except BaseException as error:
        target = ROOT / 'activation-receipt.json'
        if not target.exists() or target.stat().st_mtime < started:
            try:
                activate.save(target, {'version': VERSION, 'success': False, 'terminal': True, 'failureType': type(error).__name__, 'failure': str(error)[:600],
                                       'phase': 'planned_pause_not_completed', 'at': time.time(), 'mode': 'planned_pause',
                                       'startupHoldPresent': (STATE / 'execution-upgrade-hold').exists(), 'stagePresent': (ROOT / 'runtime-stage.json').exists()})
            except OSError:
                pass
        raise
    finally:
        signal.signal(signal.SIGTERM, old_term)


def probe(config):
    """Read-only: what would hold up the upgrade preconditions right now? Freezes, signals and stops nothing."""
    pauser = build_pauser(config, log=lambda message: None)
    reasons = pauser.unsettled()
    try:
        lead = maintenance_pause.maintenance_lead()
    except Exception as error:
        lead = str(error)[:100]
    return {'unsettledReasons': reasons, 'settledNow': not reasons, 'maintenanceLeadMs': lead, 'leadRequiredMs': pauser.s.lead_ms,
            'builderPhase': read_json(STATE / 'status.json').get('phase'), 'holdPresent': (STATE / 'execution-upgrade-hold').exists()}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=ROOT / 'controller-config.json')
    parser.add_argument('--probe', action='store_true', help='read-only: print what currently blocks the upgrade preconditions (needs no config)')
    args = parser.parse_args(argv)
    if args.probe:
        print(json.dumps(probe({'pauseSettleBudgetSeconds': 1500, 'activationBudgetSeconds': 900, 'verifyBudgetSeconds': 900, 'checkpointWaitSeconds': 3600, 'deadlineMonotonic': time.monotonic() + 7200}), indent=1))
        return 0
    paa = _load('preparation')
    try:
        result = run(paa.private_json(args.config))
    except SystemExit as stop:
        return int(stop.code or 0)
    print(json.dumps(result), flush=True)
    return 0 if result['verification'].get('ok') else 1


if __name__ == '__main__':
    raise SystemExit(main())
