import json
import pathlib
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


SCRIPT_DIR = pathlib.Path(__file__).resolve().parents[2] / 'deploy' / 'scripts'
sys.path.insert(0, str(SCRIPT_DIR))
import backup_care
from backup_care import CareBackupConfig, run_backup


class FakeRunner:
    def __init__(self, config, env_project=None, env_key=None, dump_ok=True, media_mount=None, media_root='/data/care-media'):
        self.config = config
        self.env_project = env_project or config.project
        self.env_key = env_key or config.mongo_key_file
        self.dump_ok = dump_ok
        self.media_mount = media_mount or config.media_volume
        self.media_root = media_root
        self.api_running = True
        self.timer_active = True
        self.service_states = ['inactive']
        self.calls = []
        self.api_image_id = 'sha256:' + 'c' * 64
        self.mongo_image_id = 'sha256:' + 'd' * 64

    def __call__(self, command, **kwargs):
        self.calls.append(command)
        if command[0] == 'bash' and command[1].endswith('read-deployment-env.sh'):
            return types.SimpleNamespace(
                returncode=0,
                stdout=json.dumps({'DEPLOYMENT_PROJECT_NAME': self.env_project, 'CARE_MONGO_KEY_FILE': self.env_key,
                                   'CARE_ENCRYPTION_ACTIVE_KEY': 'care-active-key',
                                   'CARE_ENCRYPTION_KEYS': '["care-active-key"]',
                                   'MONGO_URL': 'mongodb://care-user:care-pass@mongo:27017/care?authSource=admin&replicaSet=care-rs'}),
            )
        if command[:3] == ['docker', 'inspect', self.config.api_container_id]:
            return types.SimpleNamespace(returncode=0, stdout=json.dumps([{
                'Id': self.config.api_container_id,
                'Image': self.api_image_id,
                'Config': {'Labels': {
                    'com.docker.compose.project': self.config.project,
                    'com.docker.compose.service': 'api',
                }, 'Env': [
                    'CARE_ENCRYPTION_ACTIVE_KEY=care-active-key',
                    'CARE_ENCRYPTION_KEYS=["care-active-key"]',
                    'MONGO_URL=mongodb://care-user:care-pass@mongo:27017/care?authSource=admin&replicaSet=care-rs',
                    f'CARE_MEDIA_ROOT={self.media_root}',
                ]},
                'State': {'Running': self.api_running, 'Health': {'Status': 'healthy'}},
                'Mounts': [{'Type': 'volume', 'Name': self.media_mount, 'Destination': '/data/care-media'}],
            }]))
        if command[:3] == ['docker', 'inspect', self.config.mongo_container_id]:
            return types.SimpleNamespace(returncode=0, stdout=json.dumps([{
                'Id': self.config.mongo_container_id,
                'Image': self.mongo_image_id,
                'Config': {'Labels': {
                    'com.docker.compose.project': self.config.project,
                    'com.docker.compose.service': 'mongo',
                }},
                'State': {'Running': True},
                'Mounts': [
                    {'Type': 'bind', 'Source': self.config.mongo_key_file, 'Destination': '/run/secrets/care-mongo-key'},
                    {'Type': 'volume', 'Name': f'{self.config.project}_mongo_data', 'Destination': '/data/db'},
                ],
            }]))
        if command[:4] == ['docker', 'volume', 'inspect', self.config.media_volume]:
            return types.SimpleNamespace(returncode=0, stdout=json.dumps([{
                'Name': self.config.media_volume,
                'Labels': {
                    'com.docker.compose.project': self.config.project,
                    'com.docker.compose.volume': 'care_media',
                },
            }]))
        if command[:4] == ['docker', 'volume', 'inspect', f'{self.config.project}_mongo_data']:
            return types.SimpleNamespace(returncode=0, stdout=json.dumps([{
                'Name': f'{self.config.project}_mongo_data',
                'Labels': {
                    'com.docker.compose.project': self.config.project,
                    'com.docker.compose.volume': 'mongo_data',
                },
            }]))
        if command[:3] == ['docker', 'exec', self.config.api_container_id]:
            return types.SimpleNamespace(returncode=0, stdout='10')
        if command[:3] == ['docker', 'exec', self.config.mongo_container_id]:
            if kwargs.get('stdout') is not None and self.dump_ok:
                kwargs['stdout'].write(b'x' * 128)
            return types.SimpleNamespace(returncode=0 if self.dump_ok else 1, stdout='')
        if command[:2] == ['docker', 'cp']:
            target = pathlib.Path(command[-1])
            (target / 'image.bin').write_bytes(b'image')
            return types.SimpleNamespace(returncode=0, stdout='')
        if command == ['docker', 'stop', self.config.api_container_id]:
            self.api_running = False
            return types.SimpleNamespace(returncode=0, stdout='')
        if command == ['docker', 'start', self.config.api_container_id]:
            self.api_running = True
            return types.SimpleNamespace(returncode=0, stdout='')
        if command[:3] == ['systemctl', 'is-active', '--quiet']:
            return types.SimpleNamespace(returncode=0 if self.timer_active else 3, stdout='')
        if command[:3] == ['systemctl', 'show', self.config.project + '-closure.service']:
            return types.SimpleNamespace(returncode=0, stdout='inactive\n')
        if command == ['systemctl', 'stop', self.config.project + '-closure.timer']:
            self.timer_active = False
            return types.SimpleNamespace(returncode=0, stdout='')
        if command == ['systemctl', 'start', self.config.project + '-closure.timer']:
            self.timer_active = True
            return types.SimpleNamespace(returncode=0, stdout='')
        return types.SimpleNamespace(returncode=0, stdout='')


class CareBackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = pathlib.Path(self.temp.name)
        self.project = 'cboard-care-test'
        self.api_id = 'a' * 64
        self.mongo_id = 'b' * 64
        self.env_file = root / 'deployment.env'
        self.key_file = root / 'care-mongo.key'
        self.env_file.write_text(
            f'DEPLOYMENT_PROJECT_NAME={self.project}\nCARE_MONGO_KEY_FILE={self.key_file}\n'
            'CARE_ENCRYPTION_ACTIVE_KEY=care-active-key\n'
            'CARE_ENCRYPTION_KEYS=["care-active-key"]\n'
            'MONGO_URL=mongodb://care-user:care-pass@mongo:27017/care?authSource=admin&replicaSet=care-rs\n'
        )
        self.key_file.write_bytes(b'key-material')
        self.hold = root / 'deploy' / f'.restore-security-review-required.{self.project}'
        self.hold.parent.mkdir()
        self.config = CareBackupConfig(
            project=self.project,
            api_container_id=self.api_id,
            mongo_container_id=self.mongo_id,
            media_volume=f'{self.project}_care_media',
            environment_file=str(self.env_file),
            mongo_key_file=str(self.key_file),
            data_root=str(root / 'data-backups'),
            key_root=str(root / 'key-backups'),
            restore_hold_path=str(self.hold),
        )

    def tearDown(self):
        self.temp.cleanup()

    def _run(self, runner):
        with patch('care_backup_policy.shutil.disk_usage', return_value=types.SimpleNamespace(free=10 * 1024 ** 3)):
            return run_backup(self.config, runner=runner)

    def test_success_validates_fixed_identities_and_separate_key_manifest(self):
        runner = FakeRunner(self.config)
        receipt = self._run(runner)
        data_root = pathlib.Path(self.config.data_root)
        key_root = pathlib.Path(self.config.key_root)
        runs = list(data_root.iterdir())
        self.assertEqual(len(runs), 1)
        key_run = key_root / runs[0].name
        self.assertTrue((runs[0] / 'mongo.archive.gz').is_file())
        self.assertTrue((runs[0] / 'media' / 'image.bin').is_file())
        self.assertTrue((key_run / 'deployment.env').is_file())
        self.assertTrue((key_run / 'care-mongo-key').is_file())
        self.assertTrue((runs[0] / 'integrity.json').is_file())
        self.assertTrue((key_run / 'integrity.json').is_file())
        self.assertEqual(receipt['project'], self.project)
        self.assertEqual(receipt['apiImageId'], runner.api_image_id)
        self.assertEqual(receipt['mongoImageId'], runner.mongo_image_id)
        self.assertNotIn('key-material', json.dumps(receipt))
        self.assertIn(['docker', 'stop', self.api_id], runner.calls)
        self.assertIn(['docker', 'start', self.api_id], runner.calls)
        self.assertIn(['docker', 'cp', f'{self.api_id}:/data/care-media/.', str(runs[0] / 'media')], runner.calls)

    def test_environment_project_mismatch_fails_before_quiesce(self):
        runner = FakeRunner(self.config, env_project='cboard-care-other')
        with self.assertRaisesRegex(RuntimeError, 'does not match'):
            self._run(runner)
        self.assertNotIn(['docker', 'stop', self.api_id], runner.calls)

    def test_invalid_inspected_image_digest_fails_before_backup_directory_or_quiesce(self):
        runner = FakeRunner(self.config)
        runner.api_image_id = 'sha256:not-a-digest'
        with self.assertRaisesRegex(RuntimeError, 'image identity'):
            self._run(runner)
        self.assertFalse(pathlib.Path(self.config.data_root).exists())
        self.assertFalse(pathlib.Path(self.config.key_root).exists())
        self.assertFalse(any(c[:2] in (['docker', 'stop'], ['systemctl', 'stop']) for c in runner.calls))

    def test_runtime_key_and_mongo_mount_mismatches_fail_before_service_changes(self):
        for mismatch in ('keyring', 'mongo-volume', 'mongo-key'):
            with self.subTest(mismatch=mismatch):
                fake = FakeRunner(self.config)
                def runner(command, **kwargs):
                    result = fake(command, **kwargs)
                    if command[:2] == ['docker', 'inspect']:
                        payload = json.loads(result.stdout)
                        if command[2] == self.api_id and mismatch == 'keyring':
                            payload[0]['Config']['Env'][1] = 'CARE_ENCRYPTION_KEYS=wrong'
                        if command[2] == self.mongo_id:
                            if mismatch == 'mongo-volume':
                                payload[0]['Mounts'][1]['Name'] = 'other-project_mongo_data'
                            if mismatch == 'mongo-key':
                                payload[0]['Mounts'][0]['Source'] = str(self.env_file)
                        result.stdout = json.dumps(payload)
                    return result
                with self.assertRaises(RuntimeError):
                    self._run(runner)
                self.assertFalse(any(c[:2] in (['docker', 'stop'], ['systemctl', 'stop']) for c in fake.calls))

    def test_media_copy_failure_preserves_partial_without_success_receipt(self):
        fake = FakeRunner(self.config)
        def runner(command, **kwargs):
            result = fake(command, **kwargs)
            if command[:2] == ['docker', 'cp']:
                result.returncode = 1
            return result
        with self.assertRaises(RuntimeError):
            self._run(runner)
        runs = list(pathlib.Path(self.config.data_root).iterdir())
        self.assertEqual(len(runs), 1)
        self.assertFalse((runs[0] / 'receipt.json').exists())
        self.assertTrue((runs[0] / 'mongo.archive.gz').exists())
        self.assertIn(['docker', 'start', self.api_id], fake.calls)

    def test_media_mount_mismatch_fails_before_quiesce(self):
        runner = FakeRunner(self.config, media_mount='wrong_volume')
        with self.assertRaisesRegex(RuntimeError, 'media mount'):
            self._run(runner)
        self.assertNotIn(['docker', 'stop', self.api_id], runner.calls)

    def test_media_root_mismatch_fails_before_quiesce(self):
        runner = FakeRunner(self.config, media_root='/wrong-care-media')
        with self.assertRaisesRegex(RuntimeError, 'media root'):
            self._run(runner)
        self.assertNotIn(['docker', 'stop', self.api_id], runner.calls)

    def test_dump_failure_preserves_unpublished_evidence_and_restores_window(self):
        old = pathlib.Path(self.config.data_root) / 'old-run'
        old.mkdir(parents=True)
        (old / 'keep.txt').write_text('keep')
        runner = FakeRunner(self.config, dump_ok=False)
        with self.assertRaisesRegex(RuntimeError, 'Mongo dump'):
            self._run(runner)
        self.assertTrue((old / 'keep.txt').is_file())
        data_runs = list(pathlib.Path(self.config.data_root).iterdir())
        self.assertEqual(len(data_runs), 2)
        failed_run = next(item for item in data_runs if item != old)
        self.assertTrue((failed_run / 'mongo.archive.gz.partial').is_file())
        key_runs = list(pathlib.Path(self.config.key_root).iterdir())
        self.assertEqual(len(key_runs), 1)
        self.assertFalse((key_runs[0] / 'receipt.json').exists())
        self.assertIn(['docker', 'start', self.api_id], runner.calls)
        self.assertIn(['systemctl', 'start', self.project + '-closure.timer'], runner.calls)

    def test_initial_restore_hold_blocks_without_docker_changes(self):
        self.hold.write_text('review')
        runner = FakeRunner(self.config)
        with self.assertRaisesRegex(RuntimeError, 'hold'):
            self._run(runner)
        self.assertEqual(runner.calls, [])

    def test_receipt_publish_failure_leaves_partial_without_formal_receipt(self):
        runner = FakeRunner(self.config)
        with patch('backup_care.os.link', side_effect=OSError('publish failed')):
            with self.assertRaisesRegex(OSError, 'publish failed'):
                self._run(runner)
        run = next(pathlib.Path(self.config.data_root).iterdir())
        self.assertFalse((run / 'receipt.json').exists())
        self.assertTrue((run / 'receipt.json.partial').is_file())

    def test_invalid_fixed_identity_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'fixed Care api'):
            CareBackupConfig(
                self.project, 'api', self.mongo_id, self.config.media_volume,
                self.config.environment_file, self.config.mongo_key_file,
                self.config.data_root, self.config.key_root, self.config.restore_hold_path,
            )


if __name__ == '__main__':
    unittest.main()
