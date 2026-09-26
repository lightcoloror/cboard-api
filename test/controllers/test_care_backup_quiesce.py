import json
import pathlib
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

SCRIPT_DIR = pathlib.Path(__file__).resolve().parents[2] / 'deploy' / 'scripts'
sys.path.insert(0, str(SCRIPT_DIR))
from care_backup_quiesce import CareBackupQuiesceConfig, consistent_backup_window


class FakeRunner:
    def __init__(self, config, api_running=True, timer_active=True, service_states=None,
                 health_states=None, failures=None, stop_does_not_stop=False):
        self.config = config
        self.api_running = api_running
        self.timer_active = timer_active
        self.service_states = list(service_states or ['inactive'])
        self.health_states = list(health_states or ['healthy'])
        self.failures = failures or {}
        self.stop_does_not_stop = stop_does_not_stop
        self.calls = []

    def __call__(self, command, **kwargs):
        self.calls.append(command)
        failure = self.failures.get(tuple(command))
        if failure:
            raise failure
        if command == ['docker', 'inspect', self.config.api_container_id]:
            payload = [{
                'Config': {'Labels': {
                    'com.docker.compose.project': self.config.project,
                    'com.docker.compose.service': 'api',
                }},
                'Id': self.config.api_container_id,
                'State': {
                    'Running': self.api_running,
                    'Health': {'Status': self.health_states.pop(0) if len(self.health_states) > 1 else self.health_states[0]},
                },
            }]
            return types.SimpleNamespace(returncode=0, stdout=json.dumps(payload))
        if command == ['docker', 'stop', self.config.api_container_id]:
            if not self.stop_does_not_stop:
                self.api_running = False
            return types.SimpleNamespace(returncode=0, stdout='')
        if command == ['docker', 'start', self.config.api_container_id]:
            self.api_running = True
            return types.SimpleNamespace(returncode=0, stdout='')
        if command[:3] == ['systemctl', 'is-active', '--quiet']:
            return types.SimpleNamespace(returncode=0 if self.timer_active else 3, stdout='')
        if command[:3] == ['systemctl', 'show', self.config.closure_service]:
            value = self.service_states.pop(0) if len(self.service_states) > 1 else self.service_states[0]
            return types.SimpleNamespace(returncode=0, stdout=value + '\n')
        return types.SimpleNamespace(returncode=0, stdout='')


class CareBackupQuiesceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.hold = pathlib.Path(self.temp.name) / 'deploy' / '.restore-security-review-required.cboard-care-test'
        self.hold.parent.mkdir()
        self.config = CareBackupQuiesceConfig(
            project='cboard-care-test',
            api_container_id='a' * 64,
            closure_timer='cboard-care-test-closure.timer',
            closure_service='cboard-care-test-closure.service',
            restore_hold_path=str(self.hold),
        )

    def tearDown(self):
        self.temp.cleanup()

    def test_config_is_explicit_immutable_and_project_scoped(self):
        container_id = 'a' * 64
        with self.assertRaisesRegex(ValueError, 'cboard-care'):
            CareBackupQuiesceConfig('cboard-api-private', container_id, 'cboard-api-private-closure.timer', 'cboard-api-private-closure.service', str(self.hold))
        with self.assertRaisesRegex(ValueError, 'fixed Care API'):
            CareBackupQuiesceConfig('cboard-care-test', 'api', 'cboard-care-test-closure.timer', 'cboard-care-test-closure.service', str(self.hold))
        with self.assertRaisesRegex(ValueError, 'project-bound'):
            CareBackupQuiesceConfig('cboard-care-test', container_id, 'other.timer', 'other.service', str(self.hold))
        with self.assertRaisesRegex(ValueError, 'hold path'):
            CareBackupQuiesceConfig('cboard-care-test', container_id, 'cboard-care-test-closure.timer', 'cboard-care-test-closure.service', 'relative-marker')
        with self.assertRaises(AttributeError):
            self.config.project = 'cboard-care-other'

    def test_waits_for_worker_stops_api_then_restores_api_health_before_timer(self):
        runner = FakeRunner(self.config, service_states=['active', 'active', 'inactive'])
        with self.assertRaisesRegex(ValueError, 'copy failed'):
            with consistent_backup_window(self.config, runner=runner, sleeper=lambda _: None):
                raise ValueError('copy failed')
        self.assertEqual(runner.calls, [
            ['docker', 'inspect', 'a' * 64],
            ['systemctl', 'is-active', '--quiet', 'cboard-care-test-closure.timer'],
            ['systemctl', 'show', 'cboard-care-test-closure.service', '--property=ActiveState', '--value'],
            ['systemctl', 'stop', 'cboard-care-test-closure.timer'],
            ['systemctl', 'show', 'cboard-care-test-closure.service', '--property=ActiveState', '--value'],
            ['systemctl', 'show', 'cboard-care-test-closure.service', '--property=ActiveState', '--value'],
            ['docker', 'stop', 'a' * 64],
            ['docker', 'inspect', 'a' * 64],
            ['docker', 'inspect', 'a' * 64],
            ['docker', 'start', 'a' * 64],
            ['docker', 'inspect', 'a' * 64],
            ['systemctl', 'start', 'cboard-care-test-closure.timer'],
        ])

    def test_externally_stopped_api_remains_stopped(self):
        runner = FakeRunner(self.config, api_running=False, timer_active=False, service_states=['inactive'])
        with consistent_backup_window(self.config, runner=runner):
            pass
        self.assertNotIn(['systemctl', 'start', 'cboard-care-test-closure.timer'], runner.calls)
        self.assertNotIn(['docker', 'stop', 'a' * 64], runner.calls)
        self.assertNotIn(['docker', 'start', 'a' * 64], runner.calls)

    def test_hold_appearing_during_body_blocks_api_and_timer_recovery(self):
        runner = FakeRunner(self.config, service_states=['inactive'])
        with self.assertRaisesRegex(RuntimeError, 'recovery is blocked'):
            with consistent_backup_window(self.config, runner=runner):
                self.hold.write_text('review required')
        self.assertNotIn(['systemctl', 'start', 'cboard-care-test-closure.timer'], runner.calls)
        self.assertNotIn(['docker', 'start', 'a' * 64], runner.calls)

    def test_worker_timeout_restores_timer_without_stopping_api(self):
        runner = FakeRunner(self.config, service_states=['active'])
        ticks = iter([0, 111])
        with self.assertRaisesRegex(RuntimeError, 'did not exit'):
            with consistent_backup_window(self.config, runner=runner, sleeper=lambda _: None,
                                          monotonic=lambda: next(ticks), wait_seconds=10):
                self.fail('window must not open')
        self.assertIn(['systemctl', 'start', 'cboard-care-test-closure.timer'], runner.calls)
        self.assertNotIn(['docker', 'stop', 'a' * 64], runner.calls)

    def test_unknown_worker_state_fails_closed_before_api_stop(self):
        runner = FakeRunner(self.config, service_states=['inactive', 'unknown'])
        with self.assertRaisesRegex(RuntimeError, 'not trusted'):
            with consistent_backup_window(self.config, runner=runner):
                self.fail('window must not open')
        self.assertNotIn(['docker', 'stop', 'a' * 64], runner.calls)

    def test_stop_success_is_verified_before_backup_body(self):
        runner = FakeRunner(self.config, service_states=['inactive'], stop_does_not_stop=True)
        with self.assertRaisesRegex(RuntimeError, 'did not stop'):
            with consistent_backup_window(self.config, runner=runner):
                self.fail('window must not open')
        self.assertNotIn(['docker', 'start', 'a' * 64], runner.calls)

    def test_stop_failure_with_unhealthy_running_api_does_not_restore_timer(self):
        runner = FakeRunner(self.config, service_states=['inactive'],
                            health_states=['healthy', 'unhealthy'], stop_does_not_stop=True)
        with self.assertRaisesRegex(RuntimeError, 'recovery needs attention'):
            with consistent_backup_window(self.config, runner=runner):
                self.fail('window must not open')
        self.assertNotIn(['systemctl', 'start', 'cboard-care-test-closure.timer'], runner.calls)
        self.assertNotIn(['docker', 'start', 'a' * 64], runner.calls)

    def test_timer_recovery_failure_is_reported_after_api_health(self):
        timer_start = ('systemctl', 'start', 'cboard-care-test-closure.timer')
        runner = FakeRunner(self.config, service_states=['inactive'], failures={
            timer_start: RuntimeError('timer start failed'),
        })
        with self.assertRaisesRegex(RuntimeError, 'timer start failed'):
            with consistent_backup_window(self.config, runner=runner):
                pass
        self.assertIn(['docker', 'start', 'a' * 64], runner.calls)


if __name__ == '__main__':
    unittest.main()
