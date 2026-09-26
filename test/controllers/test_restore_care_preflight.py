import json
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPT_DIR = pathlib.Path(__file__).resolve().parents[2] / 'deploy' / 'scripts'
sys.path.insert(0, str(SCRIPT_DIR))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import backup_care
from care_backup_integrity import write_manifest
from restore_care_preflight import RestorePreflightError, preflight_existing_run
from test_care_backup import FakeRunner


class CareRestorePreflightTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temporary.name)
        self.data_root = self.root / 'data'
        self.key_root = self.root / 'keys'
        self.run = '20260920T010203Z-deadbeef'
        self.project = 'cboard-care-restore-test'
        self.data_run = self.data_root / self.run
        self.key_run = self.key_root / self.run
        (self.data_run / 'media').mkdir(parents=True)
        self.key_run.mkdir(parents=True)
        (self.data_run / 'mongo.archive.gz').write_bytes(b'synthetic mongo archive')
        (self.data_run / 'media' / 'encrypted-media.json').write_bytes(b'synthetic encrypted media')
        (self.key_run / 'deployment.env').write_text('synthetic deployment environment')
        (self.key_run / 'care-mongo-key').write_bytes(b'synthetic key')
        self.data_files = write_manifest(self.data_run)
        self.key_files = write_manifest(self.key_run)
        self.receipt = {
            'createdAt': self.run, 'scope': 'care', 'project': self.project,
            'apiContainerId': 'a' * 64, 'mongoContainerId': 'b' * 64,
            'apiImageId': 'sha256:' + 'c' * 64,
            'mongoImageId': 'sha256:' + 'd' * 64,
            'mediaVolume': f'{self.project}_care_media',
            'archiveBytes': (self.data_run / 'mongo.archive.gz').stat().st_size,
            'dataFiles': self.data_files, 'keyFiles': self.key_files,
            'integrityVersion': 1, 'consistency': 'api-and-closure-quiesced',
        }
        (self.data_run / 'receipt.json').write_text(json.dumps(self.receipt))

    def tearDown(self):
        self.temporary.cleanup()

    def test_complete_backup_returns_non_restoration_plan_without_docker(self):
        result = preflight_existing_run(self.data_root, self.key_root, self.run)
        self.assertEqual(result['status'], 'preflight_passed_not_restored')
        self.assertTrue(result['sourceReadOnly'])
        self.assertEqual(result['images']['api'], self.receipt['apiImageId'])
        self.assertEqual(result['isolationPlan']['network'], 'none')
        self.assertTrue(result['isolationPlan']['inputMountsReadOnly'])
        self.assertEqual(result['mediaVerification']['status'], 'planned')
        self.assertIn('No database was restored.', result['limitations'])

    def test_empty_media_directory_is_accepted_but_not_claimed_as_verified(self):
        (self.data_run / 'media' / 'encrypted-media.json').unlink()
        (self.data_run / 'integrity.json').unlink()
        self.data_files = write_manifest(self.data_run)
        self.receipt['dataFiles'] = self.data_files
        (self.data_run / 'receipt.json').write_text(json.dumps(self.receipt))
        result = preflight_existing_run(self.data_root, self.key_root, self.run)
        self.assertEqual(result['status'], 'preflight_passed_not_restored')
        self.assertEqual(result['mediaVerification']['status'], 'not_applicable_no_media')
        self.assertEqual(result['mediaVerification']['encryptedFiles'], 0)
        self.assertIn('no media', result['isolationPlan']['media'])

    def test_tampered_media_is_rejected(self):
        (self.data_run / 'media' / 'encrypted-media.json').write_bytes(b'tampered')
        with self.assertRaisesRegex(RestorePreflightError, 'integrity'):
            preflight_existing_run(self.data_root, self.key_root, self.run)

    def test_receipt_archive_size_mismatch_is_rejected(self):
        self.receipt['archiveBytes'] += 1
        (self.data_run / 'receipt.json').write_text(json.dumps(self.receipt))
        with self.assertRaisesRegex(RestorePreflightError, 'archive size'):
            preflight_existing_run(self.data_root, self.key_root, self.run)

    def test_rejects_wrong_receipt_image_and_separate_root(self):
        self.receipt['apiImageId'] = 'not-a-digest'
        (self.data_run / 'receipt.json').write_text(json.dumps(self.receipt))
        with self.assertRaisesRegex(RestorePreflightError, 'apiImageId'):
            preflight_existing_run(self.data_root, self.key_root, self.run)
        with self.assertRaisesRegex(RestorePreflightError, 'separate'):
            preflight_existing_run(self.data_root, self.data_root, self.run)

    def test_rejects_key_material_or_media_omission_and_run_escape(self):
        (self.key_run / 'care-mongo-key').unlink()
        with self.assertRaisesRegex(RestorePreflightError, 'integrity'):
            preflight_existing_run(self.data_root, self.key_root, self.run)
        with self.assertRaisesRegex(RestorePreflightError, 'run must match'):
            preflight_existing_run(self.data_root, self.key_root, '../other')

    def test_accepts_a_real_producer_fake_runner_output(self):
        producer_root = self.root / 'producer'
        environment = producer_root / 'deployment.env'
        mongo_key = producer_root / 'care-mongo.key'
        environment.parent.mkdir()
        project = 'cboard-care-producer-test'
        environment.write_text(
            f'DEPLOYMENT_PROJECT_NAME={project}\nCARE_MONGO_KEY_FILE={mongo_key}\n'
            'CARE_ENCRYPTION_ACTIVE_KEY=care-active-key\n'
            'CARE_ENCRYPTION_KEYS=["care-active-key"]\n'
            'MONGO_URL=mongodb://care-user:care-pass@mongo:27017/care?authSource=admin&replicaSet=care-rs\n'
        )
        mongo_key.write_bytes(b'synthetic key material')
        hold = producer_root / 'deploy' / f'.restore-security-review-required.{project}'
        hold.parent.mkdir()
        config = backup_care.CareBackupConfig(
            project=project, api_container_id='a' * 64, mongo_container_id='b' * 64,
            media_volume=f'{project}_care_media', environment_file=str(environment),
            mongo_key_file=str(mongo_key), data_root=str(producer_root / 'data'),
            key_root=str(producer_root / 'keys'), restore_hold_path=str(hold),
        )
        runner = FakeRunner(config)
        with patch('care_backup_policy.shutil.disk_usage', return_value=type('Usage', (), {'free': 10 * 1024 ** 3})()):
            receipt = backup_care.run_backup(config, runner=runner)
        result = preflight_existing_run(config.data_root, config.key_root, receipt['createdAt'])
        self.assertEqual(result['status'], 'preflight_passed_not_restored')
        self.assertEqual(result['images']['api'], receipt['apiImageId'])
        self.assertEqual(result['images']['mongo'], receipt['mongoImageId'])


if __name__ == '__main__':
    unittest.main()
