"""Small, fail-closed integrity manifests for Care backups."""

import hashlib
import json
from pathlib import Path


_METADATA = frozenset({'integrity.json', 'receipt.json'})


def inventory(root):
    root = Path(root)
    if root.is_symlink() or not root.is_dir():
        raise ValueError('Backup root must be a regular directory')
    result = {}
    for item in sorted(root.rglob('*')):
        if item.is_symlink():
            raise ValueError('Backup must not contain symbolic links')
        if item.is_dir():
            continue
        if not item.is_file():
            raise ValueError('Backup must contain only regular files and directories')
        if item.parent == root and item.name in _METADATA:
            continue
        digest = hashlib.sha256()
        with item.open('rb') as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(chunk)
        result[item.relative_to(root).as_posix()] = {
            'bytes': item.stat().st_size,
            'sha256': digest.hexdigest(),
        }
    if not result:
        raise ValueError('Empty backup')
    return result


def write_manifest(root):
    root = Path(root)
    destination = root / 'integrity.json'
    if destination.exists() or destination.is_symlink():
        raise ValueError('Backup manifest already exists')
    data = {'version': 1, 'files': inventory(root)}
    destination.write_text(json.dumps(data, sort_keys=True), encoding='utf-8')
    destination.chmod(0o600)
    return len(data['files'])


def verify(root):
    root = Path(root)
    manifest = root / 'integrity.json'
    if manifest.is_symlink() or not manifest.is_file():
        raise ValueError('Backup manifest is missing')
    data = json.loads(manifest.read_text(encoding='utf-8'))
    if data.get('version') != 1 or data.get('files') != inventory(root):
        raise ValueError('Backup integrity mismatch')
    return len(data['files'])
