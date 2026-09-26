import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / 'deploy' / 'scripts'))
from care_backup_integrity import write_manifest, verify


class BackupIntegrityTest(unittest.TestCase):
    def test_nested_metadata_names_are_checked(self):
        for name in ('receipt.json', 'integrity.json'):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                root = pathlib.Path(temporary)
                (root / 'media').mkdir()
                media = root / 'media' / name
                media.write_bytes(b'synthetic encrypted media')
                self.assertEqual(write_manifest(root), 1)
                self.assertEqual(verify(root), 1)
                media.write_bytes(b'corrupt')
                with self.assertRaises(ValueError):
                    verify(root)

    def test_root_receipt_can_be_published_after_manifest(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            (root / 'mongo.archive.gz').write_bytes(b'synthetic archive')
            write_manifest(root)
            (root / 'receipt.json').write_text('{}')
            self.assertEqual(verify(root), 1)
            (root / 'unexpected').write_bytes(b'extra')
            with self.assertRaises(ValueError):
                verify(root)

    def test_deleted_media_fails_verification(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            (root / 'mongo.archive.gz').write_bytes(b'synthetic archive')
            media = root / 'image.bin'
            media.write_bytes(b'synthetic encrypted media')
            write_manifest(root)
            media.unlink()
            with self.assertRaises(ValueError):
                verify(root)


if __name__ == '__main__':
    unittest.main()
