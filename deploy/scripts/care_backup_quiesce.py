"""Quiesce the Care closure worker and API for an operator-owned backup.

The caller supplies every deployment identity explicitly.  This module does
not discover a project, container, compose file, timer, or service and has no
CLI side effects.  The caller must also prevent a manual closure runner or
another maintenance entry point from running concurrently; the systemd state
check alone cannot provide that global mutual exclusion.
"""

from contextlib import contextmanager
from dataclasses import dataclass
import json
import os
import re
import subprocess
import time


BUSY_STATES = frozenset({'active', 'activating', 'reloading', 'deactivating'})
EXITED_STATES = frozenset({'inactive', 'failed'})
PROJECT_PATTERN = re.compile(r'^cboard-care-[a-z0-9][a-z0-9_-]{0,49}$')


@dataclass(frozen=True)
class CareBackupQuiesceConfig:
    project: str
    api_container_id: str
    closure_timer: str
    closure_service: str
    restore_hold_path: str

    def __post_init__(self):
        if not isinstance(self.project, str) or not PROJECT_PATTERN.fullmatch(self.project):
            raise ValueError('Care backup requires a dedicated cboard-care-* project')
        if not isinstance(self.api_container_id, str) or not re.fullmatch(r'[0-9a-f]{64}', self.api_container_id):
            raise ValueError('A fixed Care API container id is required')
        if self.closure_timer != f'{self.project}-closure.timer':
            raise ValueError('A project-bound closure timer name is required')
        if self.closure_service != f'{self.project}-closure.service':
            raise ValueError('A project-bound closure service name is required')
        if not isinstance(self.restore_hold_path, str) or not self.restore_hold_path:
            raise ValueError('A restore security hold path is required')
        hold_name = self.restore_hold_path.replace('\\', '/').rsplit('/', 1)[-1]
        if not os.path.isabs(self.restore_hold_path) or hold_name != f'.restore-security-review-required.{self.project}':
            raise ValueError('Restore security hold path must match the Care project')


def _completed(result, action):
    if result.returncode:
        raise RuntimeError(f'{action} failed')
    return result


def _output(runner, command, timeout=5):
    result = _completed(runner(command, capture_output=True, text=True, timeout=timeout), ' '.join(command))
    return (result.stdout or '').strip()


def _run(runner, command, timeout=30):
    return _completed(runner(command, capture_output=True, text=True, timeout=timeout), ' '.join(command))


def _hold_present(config):
    # lexists also catches a dangling symlink; a hold must never be bypassed.
    return os.path.lexists(config.restore_hold_path)


def _assert_no_hold(config):
    if _hold_present(config):
        raise RuntimeError('Restore security review hold is present; recovery is blocked')


def _api_snapshot(runner, config):
    raw = _output(runner, ['docker', 'inspect', config.api_container_id])
    try:
        containers = json.loads(raw)
        container = containers[0]
        labels = container['Config']['Labels']
        state = container['State']
        valid = (
            len(containers) == 1
            and container.get('Id') == config.api_container_id
            and labels.get('com.docker.compose.project') == config.project
            and labels.get('com.docker.compose.service') == 'api'
            and isinstance(state['Running'], bool)
        )
        if not valid:
            raise ValueError
        health = state.get('Health')
        health_status = health.get('Status') if isinstance(health, dict) else None
        return state['Running'], health_status
    except (KeyError, IndexError, TypeError, ValueError, json.JSONDecodeError) as error:
        raise RuntimeError('Care API container identity is not trusted') from error


def _api_running(runner, config):
    return _api_snapshot(runner, config)[0]


def _timer_active(runner, config):
    result = runner(
        ['systemctl', 'is-active', '--quiet', config.closure_timer],
        capture_output=True, text=True, timeout=5,
    )
    if result.returncode in (0, 3):
        return result.returncode == 0
    raise RuntimeError('Unable to read closure timer state')


def _service_state(runner, config):
    return _output(runner, [
        'systemctl', 'show', config.closure_service,
        '--property=ActiveState', '--value',
    ])


def _healthy(runner, config):
    running, health_status = _api_snapshot(runner, config)
    return running and health_status == 'healthy'


@contextmanager
def consistent_backup_window(config, runner=None, sleeper=time.sleep, monotonic=time.monotonic,
                             wait_seconds=110, health_seconds=90):
    """Open a bounded backup window and restore only states changed here.

    The API must already be running and trusted before this function changes
    anything. An externally stopped API must already have an inactive timer and
    an exited closure service; its stopped state is preserved through ``yield``.
    A restore security hold blocks all later API/timer starts, including holds
    created while the backup body is running.
    """
    runner = runner or subprocess.run
    _assert_no_hold(config)
    api_was_running, api_health = _api_snapshot(runner, config)
    if api_was_running and api_health != 'healthy':
        raise RuntimeError('Care API must be healthy before backup window')
    timer_was_active = _timer_active(runner, config)
    service_state = _service_state(runner, config)
    _assert_no_hold(config)

    if not api_was_running:
        if timer_was_active or service_state not in EXITED_STATES:
            raise RuntimeError('Externally stopped API requires a pre-quiesced closure worker')
        yield
        return

    timer_restore_needed = False
    api_restore_needed = False
    body_error = None
    try:
        if timer_was_active:
            timer_restore_needed = True
            _assert_no_hold(config)
            _run(runner, ['systemctl', 'stop', config.closure_timer])

        deadline = monotonic() + wait_seconds
        while True:
            _assert_no_hold(config)
            state = _service_state(runner, config)
            if state in EXITED_STATES:
                break
            if state not in BUSY_STATES:
                raise RuntimeError('Closure worker state is not trusted')
            if monotonic() >= deadline:
                raise RuntimeError('Closure worker did not exit before backup window')
            sleeper(1)

        _assert_no_hold(config)
        api_restore_needed = True
        _run(runner, ['docker', 'stop', config.api_container_id], timeout=60)
        api_running_after_stop, _ = _api_snapshot(runner, config)
        if api_running_after_stop:
            raise RuntimeError('Care API did not stop before backup window')
        yield
    except Exception as error:
        body_error = error
        raise
    finally:
        recovery_error = None
        if api_restore_needed:
            try:
                _assert_no_hold(config)
                api_running_before_start, api_health_before_start = _api_snapshot(runner, config)
                if api_running_before_start:
                    if api_health_before_start != 'healthy':
                        raise RuntimeError('Care API is not healthy before recovery')
                    if body_error is None:
                        raise RuntimeError('Care API state changed before recovery')
                else:
                    _run(runner, ['docker', 'start', config.api_container_id], timeout=60)
                    deadline = monotonic() + health_seconds
                    while True:
                        _assert_no_hold(config)
                        if _healthy(runner, config):
                            break
                        if monotonic() >= deadline:
                            raise RuntimeError('API did not become healthy after backup window')
                        sleeper(1)
            except Exception as error:
                recovery_error = error
        if timer_restore_needed and recovery_error is None:
            try:
                _assert_no_hold(config)
                _run(runner, ['systemctl', 'start', config.closure_timer])
            except Exception as error:
                recovery_error = error
        if recovery_error is not None:
            if body_error is not None:
                raise RuntimeError('Backup failed and API/timer recovery needs attention') from recovery_error
            raise recovery_error
