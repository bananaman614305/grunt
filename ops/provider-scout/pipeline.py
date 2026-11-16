"""Supervisor-owned, resumable discovery-to-default-pool orchestration.

Worker evidence is preliminary. Two fresh reviews and a supervisor probe bind
release authority to an exact commit; worker-writable files never authorize it.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import tempfile
import time

from validation import validate_release_request, run_checks, review_candidate
from worker import run_agent
from sandbox import SandboxRunner
from promotion import promote_candidate

SHA = re.compile(r'^[a-f0-9]{40}$')


def _private(path):
    path = Path(path)
    if any(item.is_symlink() for item in (path, *path.parents)):
        raise ValueError('unsafe_pipeline_path')
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.stat()
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError('unsafe_pipeline_directory')
    return path


def _write(path, value):
    fd, name = tempfile.mkstemp(prefix=path.name + '.', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        Path(name).unlink(missing_ok=True)


def _read(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 2 * 1024 * 1024:
        raise ValueError('unsafe_pipeline_checkpoint')
    return json.loads(path.read_text())


class Pipeline:
    """Injected stages support offline lifecycle tests without external writes."""

    def __init__(self, config, root, *, validate=None, review=None, checks=None,
                 probe=None, promote=None, agent=None, check_runner=None):
        self.config = dict(config)
        self.root = _private(Path(root).absolute())
        self.workspace = Path(config['workspace']).resolve()
        if self.root.is_relative_to(self.workspace):
            raise ValueError('supervisor_state_inside_workspace')
        self.releases = _private(self.root / 'releases')
        self.validate = validate or validate_release_request
        self.review = review or review_candidate
        self.checks = checks or run_checks
        self.probe = probe or self._probe
        self.promote = promote or promote_candidate
        self.agent = agent or self._agent
        self.check_runner = check_runner
        self.deadline = config.get('_deadline_monotonic', time.monotonic() + config.get('timeout_seconds', 2700))

    def _budget(self):
        if time.monotonic() >= self.deadline:
            raise TimeoutError('pipeline_budget_exhausted')

    def _agent(self, request):
        self._budget()
        request = {**request, 'timeout_seconds': min(request['timeout_seconds'], max(1, int(self.deadline - time.monotonic())))}
        if request.get('role') == 'reviewer':
            request['require_web_search'] = True
        if self.config.get('_lock_fd') is not None:
            request['lock_fd'] = self.config['_lock_fd']
        return run_agent(request, self.config)

    def _runner(self):
        if self.check_runner is None:
            self.check_runner = SandboxRunner(self.root, self.config)
        def bounded(argv, *, cwd, timeout, env, network):
            self._budget()
            remaining = max(1, self.deadline - time.monotonic())
            return self.check_runner(argv, cwd=cwd, timeout=min(timeout, remaining), env=env, network=network)
        return bounded

    def _probe(self, receipt, directory):
        self._budget()
        if not receipt.get('config_dir'):
            # Anonymous adapters still need isolated scratch/config storage.
            parent = _private(self.workspace / 'probe-configs')
            receipt['config_dir'] = str(_private(parent / receipt['head_sha']))
        review_path = directory / 'probe-review.json'
        output = directory / 'trusted-proof.json'
        _write(review_path, receipt['reviews'][0])
        # A stale successful file cannot make a failed reprobe successful.
        output.unlink(missing_ok=True)
        command = [self.config.get('node_binary', 'node'), str(Path(__file__).with_name('probe.mjs')),
                   '--workspace', str(self.workspace), '--sandbox-state', str(self.root), '--checkout', receipt['checkout'],
                   '--source-id', receipt['source_id'], '--model', receipt['model'],
                   '--config-dir', receipt['config_dir'], '--head', receipt['head_sha'],
                   '--registry-sha', receipt['registry_sha256'], '--review-receipt', str(review_path), '--output', str(output)]
        env = {key: value for key, value in os.environ.items() if key in ('HOME', 'PATH', 'LANG', 'LC_ALL')}
        env.update(NPM_CONFIG_USERCONFIG='/dev/null', CI='1')
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL, env=env, start_new_session=True)
        try:
            code = process.wait(timeout=min(360, max(1, self.deadline - time.monotonic())))
        finally:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
        if not output.exists():
            return {'outcome': 'failed', 'code': 'probe_no_protected_evidence'}
        proof = _read(output)
        if code != 0 or proof.get('outcome') != 'passed':
            return {'outcome': 'deferred' if code == 2 else 'failed', 'code': 'trusted_probe_not_passed'}
        return {'outcome': 'passed', 'evidence_file': str(output)}

    def _result(self, checkpoint, status, reason=None, **extra):
        receipt = checkpoint.get('receipt', {})
        result = {'status': status, 'source_id': receipt.get('source_id'),
                  'head_sha': receipt.get('head_sha'), **({'reason': reason} if reason else {}), **extra}
        checkpoint.update(result=result, updated_at=dt.datetime.now(dt.timezone.utc).isoformat())
        _write(Path(checkpoint['directory']) / 'checkpoint.json', checkpoint)
        return result

    def _continue(self, checkpoint):
        receipt = checkpoint['receipt']
        directory = Path(checkpoint['directory'])
        try:
            # Once promotion starts, its own protected checkpoint owns merge/npm
            # retries, including when main has advanced or the worker clone is gone.
            if checkpoint.get('phase') != 'promotion':
                fresh = self.validate(checkpoint['candidate'], self.workspace, Path(self.config['source_repo']))
                if any(fresh.get(key) != receipt.get(key) for key in ('head_sha', 'base_sha', 'registry_sha256', 'evidence_sha256')):
                    return self._result(checkpoint, 'blocked', 'candidate_changed_requires_fresh_review')
                self._budget()
                if not receipt['reviews']:
                    review = self.review(receipt, directory, self.agent)
                    review['phase'] = 'pre_execution'
                    if review['verdict'] != 'approve':
                        return self._result(checkpoint, 'needs_approval' if review['verdict'] == 'needs_approval' else 'blocked', 'pre_execution_review_not_approved')
                    receipt['reviews'].append(review)
                    checkpoint['phase'] = 'reviewed'
                    _write(directory / 'checkpoint.json', checkpoint)
                self._budget()
                if receipt.get('checks', {}).get('passed') is not True:
                    receipt = self.checks(receipt, run=self._runner())
                    if receipt.get('checks', {}).get('passed') is not True:
                        return self._result(checkpoint, 'blocked', 'local_checks_not_passed')
                    checkpoint['receipt'] = receipt
                    checkpoint['phase'] = 'checked'
                    _write(directory / 'checkpoint.json', checkpoint)
                self._budget()
                if not receipt.get('probe_verified_by_supervisor'):
                    probe = self.probe(receipt, directory)
                    if probe.get('outcome') != 'passed':
                        return self._result(checkpoint, 'deferred' if probe.get('outcome') == 'deferred' else 'blocked', 'trusted_probe_not_passed')
                    evidence = Path(probe['evidence_file'])
                    if not evidence.resolve().is_relative_to(self.releases) or evidence.is_symlink():
                        raise ValueError('probe_evidence_outside_authority')
                    proof = _read(evidence)
                    if (any(proof.get(key) != receipt.get(key) for key in ('head_sha', 'registry_sha256', 'source_id', 'model'))
                            or proof.get('http_status') != 200 or not all(proof.get(key) is True for key in
                              ('reply_received', 'attribution_verified', 'tool_call_verified', 'free_guard_verified'))):
                        return self._result(checkpoint, 'blocked', 'trusted_probe_binding_failed')
                    receipt.update(trusted_evidence_file=str(evidence), trusted_evidence_sha256=hashlib.sha256(evidence.read_bytes()).hexdigest(),
                                   probe_verified_by_supervisor=True)
                    checkpoint['phase'] = 'probed'
                    _write(directory / 'checkpoint.json', checkpoint)
                self._budget()
                if len(receipt['reviews']) < 2:
                    def post_agent(request):
                        proof_summary = {key: receipt[key] for key in ('head_sha', 'registry_sha256', 'source_id', 'model', 'trusted_evidence_sha256')}
                        return self.agent({**request, 'prompt': request['prompt'] + '\nPost-validation review. Supervisor completed fixed local checks and independently repeated exact-source hello/native-tool probes. Verify these protected receipts: '
                                           + json.dumps(proof_summary) + '\nProtected live evidence file: ' + receipt['trusted_evidence_file']})
                    review = self.review(receipt, directory, post_agent)
                    review['phase'] = 'post_validation'
                    if review['verdict'] != 'approve':
                        return self._result(checkpoint, 'needs_approval' if review['verdict'] == 'needs_approval' else 'blocked', 'post_validation_review_not_approved')
                    if review['review_id'] == receipt['reviews'][0]['review_id']:
                        return self._result(checkpoint, 'blocked', 'reviews_not_independent')
                    receipt['reviews'].append(review)
                    checkpoint['phase'] = 'approved'
                    _write(directory / 'checkpoint.json', checkpoint)
                self._budget()
                checkpoint['phase'] = 'promotion'
                _write(directory / 'checkpoint.json', checkpoint)
            self._budget()
            config = {**self.config, 'release_check_runner': self._runner()}
            result = self.promote(receipt, config, self.releases)
            if result.get('reason') in ('main_changed_requires_fresh_review', 'npm_version_requires_fresh_review'):
                publication = self.releases / ('release-' + receipt['head_sha']) / 'checkpoint.json'
                state = _read(publication) if publication.exists() else {}
                if not state.get('merge_sha'):
                    # This exact authorization is stale. Repeatedly attempting
                    # it would prevent the worker's rebased candidate advancing.
                    checkpoint['phase'] = 'superseded'
                    result['status'] = 'superseded'
            return self._result(checkpoint, result.pop('status'), **{key: value for key, value in result.items() if key not in ('source_id', 'head_sha')})
        except TimeoutError:
            return self._result(checkpoint, 'deferred', 'pipeline_budget_exhausted')
        except Exception:
            # No worker/upstream exception text or raw tool output is retained.
            return self._result(checkpoint, 'blocked', 'pipeline_stage_failed')

    def process(self, candidate):
        if self.config.get('release_enabled') is not True:
            return {'status': 'disabled', 'reason': 'automatic_release_not_enabled'}
        try:
            self._budget()
            receipt = self.validate(candidate, self.workspace, Path(self.config['source_repo']))
            head = receipt['head_sha']
            if not SHA.fullmatch(head):
                raise ValueError('invalid_head')
            directory = _private(self.releases / ('pipeline-' + head))
            path = directory / 'checkpoint.json'
            if path.exists():
                checkpoint = _read(path)
                if checkpoint.get('phase') == 'superseded':
                    return checkpoint['result']
                if checkpoint.get('result', {}).get('status') == 'released':
                    return checkpoint['result']
                # A corrected, explicitly resubmitted candidate needs fresh
                # reviews of its current facts. Never reset release authority
                # after promotion has begun: that state owns merge/npm retries.
                if checkpoint.get('phase') != 'promotion' and checkpoint.get('result', {}).get('status') in ('blocked', 'needs_approval'):
                    checkpoint = {'version': 1, 'candidate': candidate, 'receipt': receipt, 'phase': 'validated', 'directory': str(directory)}
                    _write(path, checkpoint)
            else:
                checkpoint = {'version': 1, 'candidate': candidate, 'receipt': receipt, 'phase': 'validated', 'directory': str(directory)}
                _write(path, checkpoint)
            return self._continue(checkpoint)
        except TimeoutError:
            return {'status': 'deferred', 'reason': 'pipeline_budget_exhausted'}
        except Exception:
            return {'status': 'blocked', 'reason': 'candidate_validation_failed'}

    def resume_pending(self):
        if self.config.get('release_enabled') is not True:
            return []
        # A single promotion per pass keeps inference and publication bounded.
        for path in sorted(self.releases.glob('pipeline-*/checkpoint.json')):
            try:
                checkpoint = _read(path)
                if checkpoint.get('phase') == 'superseded':
                    continue
                if checkpoint.get('result', {}).get('status') == 'released':
                    continue
                if checkpoint.get('phase') != 'promotion' and checkpoint.get('result', {}).get('status') in ('blocked', 'needs_approval'):
                    continue  # A fresh worker correction must resubmit this head.
                return [self._continue(checkpoint)]
            except (OSError, ValueError, KeyError, TypeError):
                return [{'status': 'blocked', 'reason': 'invalid_pipeline_checkpoint'}]
        return []
