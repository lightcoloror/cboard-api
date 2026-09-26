"""Retention and per-filesystem capacity checks for Care backups."""

from pathlib import Path
import shutil


MAX_RETAINED_RUNS = 60
RETAINED_RUN_WARNING = 50
MAX_RETAINED_BYTES = 2 * 1024 ** 3
MIN_FREE_BYTES = 2 * 1024 ** 3


def _regular_root(root):
    root = Path(root)
    if root.is_symlink():
        raise RuntimeError('Backup capacity cannot trust symbolic links')
    if not root.exists():
        root.mkdir(mode=0o700, parents=True)
    if not root.is_dir():
        raise RuntimeError('Backup root must be a directory')
    return root


def run_count(root):
    root = _regular_root(root)
    count = 0
    for item in root.iterdir():
        if item.is_symlink():
            raise RuntimeError('Backup capacity cannot trust symbolic links')
        count += item.is_dir()
    return count


def tree_bytes(root):
    root = _regular_root(root)
    total = 0
    for item in root.rglob('*'):
        if item.is_symlink():
            raise RuntimeError('Backup capacity cannot trust symbolic links')
        if item.is_file():
            total += item.stat().st_size
    return total


def capacity(root, incoming_bytes=0, free_bytes=None):
    root = _regular_root(root)
    if not isinstance(incoming_bytes, int) or incoming_bytes < 0:
        raise ValueError('Backup capacity estimate must be non-negative')
    retained = tree_bytes(root)
    free = shutil.disk_usage(root).free if free_bytes is None else free_bytes
    return {
        'retainedRuns': run_count(root),
        'retainedBytes': retained,
        'incomingBytes': incoming_bytes,
        'freeBytes': free,
        'maxRetainedRuns': MAX_RETAINED_RUNS,
        'retainedRunWarning': RETAINED_RUN_WARNING,
        'maxRetainedBytes': MAX_RETAINED_BYTES,
        'minFreeBytes': MIN_FREE_BYTES,
    }


def assert_can_create_backup(root, incoming_bytes=0, free_bytes=None):
    status = capacity(root, incoming_bytes=incoming_bytes, free_bytes=free_bytes)
    if status['retainedRuns'] >= MAX_RETAINED_RUNS:
        raise RuntimeError('Backup retention count limit reached; existing backups preserved')
    if status['retainedBytes'] + status['incomingBytes'] > MAX_RETAINED_BYTES:
        raise RuntimeError('Backup retained data limit reached; existing backups preserved')
    if status['freeBytes'] < MIN_FREE_BYTES + status['incomingBytes']:
        raise RuntimeError('Backup free-space reserve required; existing backups preserved')
    return status
