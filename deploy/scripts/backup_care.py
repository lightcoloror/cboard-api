"""Operator-owned, fixed-identity Care backup entry point.

The supported caller holds the host Care maintenance lock before invoking
``run_backup``.  This module has no CLI and never discovers a project or
container.  Every Docker identity is supplied by the caller and checked again
at each boundary where it matters.
"""

from contextlib import contextmanager
from dataclasses import dataclass
import datetime as _datetime
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
import uuid

from care_backup_integrity import verify, write_manifest
from care_backup_policy import assert_can_create_backup
from care_backup_quiesce import CareBackupQuiesceConfig, consistent_backup_window


PROJECT_PATTERN = re.compile(r'^cboard-care-[a-z0-9][a-z0-9_-]{0,49}$')
CONTAINER_ID_PATTERN = re.compile(r'^[0-9a-f]{64}$')
IMAGE_ID_PATTERN = re.compile(r'^sha256:[0-9a-f]{64}$')
MEDIA_DESTINATION = '/data/care-media'


@dataclass(frozen=True)
class CareBackupConfig:
    project: str
    api_container_id: str
    mongo_container_id: str
    media_volume: str
    environment_file: str
    mongo_key_file: str
    data_root: str
    key_root: str
    restore_hold_path: str

    def __post_init__(self):
        if not isinstance(self.project, str) or not PROJECT_PATTERN.fullmatch(self.project):
            raise ValueError('Care backup requires a dedicated cboard-care-* project')
        for field in ('api_container_id', 'mongo_container_id'):
            value = getattr(self, field)
            if not isinstance(value, str) or not CONTAINER_ID_PATTERN.fullmatch(value):
                raise ValueError(f'A fixed Care {field.replace("_container_id", "")} container id is required')
        if self.media_volume != f'{self.project}_care_media':
            raise ValueError('A fixed Care media volume name is required')
        if not isinstance(self.restore_hold_path, str) or not os.path.isabs(self.restore_hold_path):
            raise ValueError('An absolute restore security hold path is required')
        for field in ('environment_file', 'mongo_key_file', 'data_root', 'key_root'):
            value = getattr(self, field)
            if not isinstance(value, str) or not os.path.isabs(value):
                raise ValueError(f'{field} must be an absolute path')
        hold_name = self.restore_hold_path.replace('\\', '/').rsplit('/', 1)[-1]
        if hold_name != f'.restore-security-review-required.{self.project}':
            raise ValueError('Restore security hold path must match the Care project')


def _result_ok(result, action):
    if getattr(result, 'returncode', 1):
        raise RuntimeError(f'{action} failed')
    return result


def _run(runner, command, **kwargs):
    return _result_ok(runner(command, **kwargs), ' '.join(command))


def _output(runner, command, timeout=10):
    result = _run(runner, command, capture_output=True, text=True, timeout=timeout)
    return (getattr(result, 'stdout', '') or '').strip()


def _json_output(runner, command, action):
    try:
        return json.loads(_output(runner, command))
    except (TypeError, ValueError, json.JSONDecodeError) as error:
        raise RuntimeError(f'{action} returned invalid data') from error


def _regular_file(path, label):
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise RuntimeError(f'{label} must be a regular file')
    for parent in path.parents:
        if parent.exists() and parent.is_symlink():
            raise RuntimeError(f'{label} parent must not be a symbolic link')
    return path


def _regular_root(path, label):
    path = Path(path)
    if path.is_symlink():
        raise RuntimeError(f'{label} must not be a symbolic link')
    for parent in reversed(path.parents):
        if parent.exists() and parent.is_symlink():
            raise RuntimeError(f'{label} parent must not be a symbolic link')
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not path.is_dir():
        raise RuntimeError(f'{label} must be a directory')
    return path


def _parse_env(runner, config):
    env_file = _regular_file(config.environment_file, 'Environment file')
    fields = {
        'project': 'DEPLOYMENT_PROJECT_NAME', 'key': 'CARE_MONGO_KEY_FILE',
        'active': 'CARE_ENCRYPTION_ACTIVE_KEY', 'keys': 'CARE_ENCRYPTION_KEYS',
        'mongoUrl': 'MONGO_URL',
    }
    reader = Path(__file__).with_name('read-deployment-env.sh')
    command = ['bash', str(reader), str(env_file), ','.join(fields.values()), 'json']
    selected = _json_output(runner, command, 'Environment parser')
    if not isinstance(selected, dict) or set(selected) != set(fields.values()):
        raise RuntimeError('Environment parser returned invalid fields')
    data = {alias: selected[field] for alias, field in fields.items()}
    if not isinstance(data, dict) or not isinstance(data.get('project'), str) or not isinstance(data.get('key'), str):
        raise RuntimeError('Environment parser returned invalid fields')
    if data['project'] != config.project:
        raise RuntimeError('Environment project does not match requested Care project')
    key_path = Path(config.mongo_key_file).expanduser()
    if not key_path.is_absolute():
        key_path = env_file.parent / key_path
    key_path = _regular_file(key_path.resolve(), 'Mongo key file')
    parsed_key = Path(data['key']).expanduser()
    if not parsed_key.is_absolute():
        parsed_key = (env_file.parent / parsed_key).resolve()
    if parsed_key != key_path.resolve():
        raise RuntimeError('Environment CARE_MONGO_KEY_FILE does not match requested key file')
    return env_file, key_path, data


def _labels(container, expected_project, expected_service, identity):
    try:
        labels = container['Config']['Labels']
        valid = (
            container.get('Id') == identity
            and labels.get('com.docker.compose.project') == expected_project
            and labels.get('com.docker.compose.service') == expected_service
        )
    except (KeyError, TypeError):
        valid = False
    if not valid:
        raise RuntimeError('Care container identity is not trusted')
    return container


def _inspect_container(runner, config, identity, service):
    containers = _json_output(runner, ['docker', 'inspect', identity], 'Docker inspect')
    if not isinstance(containers, list) or len(containers) != 1 or not isinstance(containers[0], dict):
        raise RuntimeError('Care container identity is not trusted')
    container = _labels(containers[0], config.project, service, identity)
    image_id = container.get('Image')
    if not isinstance(image_id, str) or not IMAGE_ID_PATTERN.fullmatch(image_id):
        raise RuntimeError('Care container image identity is not trusted')
    return container


def _inspect_media_volume(runner, config):
    volumes = _json_output(runner, ['docker', 'volume', 'inspect', config.media_volume], 'Docker volume inspect')
    if not isinstance(volumes, list) or len(volumes) != 1 or not isinstance(volumes[0], dict):
        raise RuntimeError('Care media volume identity is not trusted')
    volume = volumes[0]
    labels = volume.get('Labels')
    if not isinstance(labels, dict) or labels.get('com.docker.compose.project') != config.project or volume.get('Name') != config.media_volume:
        raise RuntimeError('Care media volume identity is not trusted')
    volume_key = labels.get('com.docker.compose.volume')
    if volume_key != 'care_media':
        raise RuntimeError('Care media volume key is not trusted')
    return volume


def _inspect_volume(runner, name, project, compose_key, action):
    volumes = _json_output(runner, ['docker', 'volume', 'inspect', name], action)
    if not isinstance(volumes, list) or len(volumes) != 1 or not isinstance(volumes[0], dict):
        raise RuntimeError(f'{action} identity is not trusted')
    labels = volumes[0].get('Labels')
    if not isinstance(labels, dict) or labels.get('com.docker.compose.project') != project or labels.get('com.docker.compose.volume') != compose_key:
        raise RuntimeError(f'{action} identity is not trusted')
    if volumes[0].get('Name') != name:
        raise RuntimeError(f'{action} identity is not trusted')
    return volumes[0]


def _container_env(container):
    values = container.get('Config', {}).get('Env')
    if not isinstance(values, list):
        raise RuntimeError('Care container environment is not trusted')
    result = {}
    for item in values:
        if not isinstance(item, str) or '=' not in item:
            raise RuntimeError('Care container environment is not trusted')
        key, value = item.split('=', 1)
        result[key] = value
    return result


def _validate_runtime_env(api, parsed_env):
    runtime = _container_env(api)
    for key, parsed_key in (
        ('CARE_ENCRYPTION_ACTIVE_KEY', 'active'),
        ('CARE_ENCRYPTION_KEYS', 'keys'),
        ('MONGO_URL', 'mongoUrl'),
    ):
        expected = parsed_env.get(parsed_key)
        if not isinstance(expected, str) or not expected or runtime.get(key) != expected:
            raise RuntimeError('Care API environment does not match the deployment environment')
    if runtime.get('CARE_MEDIA_ROOT') != MEDIA_DESTINATION:
        raise RuntimeError('Care API media root is not trusted')


def _validate_mongo_key_mount(mongo, key_file):
    mounts = mongo.get('Mounts')
    if not isinstance(mounts, list):
        raise RuntimeError('Care Mongo key mount is not trusted')
    matches = [mount for mount in mounts if isinstance(mount, dict) and mount.get('Destination') == '/run/secrets/care-mongo-key']
    if len(matches) != 1:
        raise RuntimeError('Care Mongo key mount is not trusted')
    mount = matches[0]
    source = mount.get('Source')
    if mount.get('Type') != 'bind' or not isinstance(source, str) or Path(source).resolve() != Path(key_file).resolve():
        raise RuntimeError('Care Mongo key mount is not trusted')


def _validate_mongo_data_mount(mongo, config):
    mounts = mongo.get('Mounts')
    if not isinstance(mounts, list):
        raise RuntimeError('Care Mongo data mount is not trusted')
    matches = [mount for mount in mounts if isinstance(mount, dict) and mount.get('Destination') == '/data/db']
    expected = f'{config.project}_mongo_data'
    if len(matches) != 1 or matches[0].get('Type') != 'volume' or matches[0].get('Name') != expected:
        raise RuntimeError('Care Mongo data mount is not trusted')


def _validate_media_mount(container, config):
    mounts = container.get('Mounts')
    if not isinstance(mounts, list):
        raise RuntimeError('Care API media mount is not trusted')
    matches = [mount for mount in mounts if isinstance(mount, dict) and mount.get('Destination') == MEDIA_DESTINATION]
    if len(matches) != 1:
        raise RuntimeError('Care API media mount is not trusted')
    mount = matches[0]
    if mount.get('Type') != 'volume' or mount.get('Name') != config.media_volume:
        raise RuntimeError('Care API media mount is not trusted')


def _media_bytes(runner, config):
    command = [
        'docker', 'exec', config.api_container_id, 'node', '-e',
        "const fs=require('fs');const p='/data/care-media';let n=0;const walk=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const q=d+'/'+e.name;if(e.isSymbolicLink())throw Error('symlink');if(e.isDirectory())walk(q);else if(e.isFile())n+=fs.statSync(q).size;else throw Error('unsupported') }};walk(p);process.stdout.write(String(n));",
    ]
    raw = _output(runner, command, timeout=30)
    if not raw.isdigit():
        raise RuntimeError('Care media size is not trusted')
    return int(raw)


def _hold_present(config):
    return os.path.lexists(config.restore_hold_path)


def _assert_no_hold(config):
    if _hold_present(config):
        raise RuntimeError('Restore security review hold is present')


def _new_run(root, stamp):
    destination = root / stamp
    if destination.exists() or destination.is_symlink():
        raise RuntimeError('Backup destination already exists')
    destination.mkdir(mode=0o700)
    return destination


def _dump_archive(runner, config, destination):
    archive = destination / 'mongo.archive.gz'
    partial = destination / 'mongo.archive.gz.partial'
    owned = False
    try:
        with partial.open('xb') as stream:
            owned = True
            partial.chmod(0o600)
            process = runner([
                'docker', 'exec', config.mongo_container_id, 'sh', '-c',
                'mongodump --quiet --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --archive --gzip',
            ], stdout=stream, stderr=subprocess.DEVNULL, timeout=90)
        if getattr(process, 'returncode', 1) or partial.stat().st_size < 100:
            raise RuntimeError('Care Mongo dump failed')
        partial.replace(archive)
        return archive.stat().st_size
    finally:
        # Keep failed partial output as operator evidence. A run without a
        # receipt is never considered a completed backup.
        pass


def _copy_media(runner, config, destination):
    media = destination / 'media'
    if media.exists() or media.is_symlink():
        raise RuntimeError('Backup media destination already exists')
    media.mkdir(mode=0o700)
    _run(runner, ['docker', 'cp', f'{config.api_container_id}:{MEDIA_DESTINATION}/.', str(media)], timeout=90)
    return media


def _copy_key_material(env_file, key_file, destination):
    if destination.is_symlink() or not destination.is_dir():
        raise RuntimeError('Key backup destination must be the new run directory')
    for source, name in ((env_file, 'deployment.env'), (key_file, 'care-mongo-key')):
        target = destination / name
        if target.exists() or target.is_symlink():
            raise RuntimeError('Key backup destination already exists')
        shutil.copyfile(_regular_file(source, 'Backup key source'), target)
        target.chmod(0o600)


def _stamp():
    return _datetime.datetime.now(_datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:8]


def run_backup(config, runner=None):
    """Run one fixed-identity backup under the caller's maintenance lock."""
    if not isinstance(config, CareBackupConfig):
        raise TypeError('CareBackupConfig is required')
    runner = runner or subprocess.run
    _assert_no_hold(config)
    env_file, key_file, parsed_env = _parse_env(runner, config)
    api = _inspect_container(runner, config, config.api_container_id, 'api')
    mongo = _inspect_container(runner, config, config.mongo_container_id, 'mongo')
    _inspect_media_volume(runner, config)
    _validate_media_mount(api, config)
    _validate_runtime_env(api, parsed_env)
    _validate_mongo_key_mount(mongo, key_file)
    _inspect_volume(runner, f'{config.project}_mongo_data', config.project, 'mongo_data', 'Care Mongo data volume')
    _validate_mongo_data_mount(mongo, config)
    if not isinstance(mongo.get('State', {}).get('Running'), bool) or not mongo['State']['Running']:
        raise RuntimeError('Care Mongo container must be running')
    media_bytes = _media_bytes(runner, config)
    data_root = _regular_root(config.data_root, 'Data backup root').resolve()
    key_root = _regular_root(config.key_root, 'Key backup root').resolve()
    if data_root == key_root or data_root in key_root.parents or key_root in data_root.parents:
        raise RuntimeError('Data and key backup roots must be separate directories')
    key_bytes = env_file.stat().st_size + key_file.stat().st_size
    data_capacity = assert_can_create_backup(data_root, incoming_bytes=media_bytes)
    key_capacity = assert_can_create_backup(key_root, incoming_bytes=key_bytes)
    stamp = _stamp()
    data_run = _new_run(data_root, stamp)
    key_run = _new_run(key_root, stamp)
    quiesce = CareBackupQuiesceConfig(
        project=config.project,
        api_container_id=config.api_container_id,
        closure_timer=f'{config.project}-closure.timer',
        closure_service=f'{config.project}-closure.service',
        restore_hold_path=config.restore_hold_path,
    )
    archive_bytes = 0
    try:
        with consistent_backup_window(runner=runner, config=quiesce):
            _assert_no_hold(config)
            archive_bytes = _dump_archive(runner, config, data_run)
            _copy_media(runner, config, data_run)
            _copy_key_material(env_file, key_file, key_run)
            write_manifest(data_run)
            write_manifest(key_run)
            verify(data_run)
            verify(key_run)
            _assert_no_hold(config)
    except Exception:
        # Preserve this unpublished run and any partial dump for operator review.
        raise
    receipt = {
        'createdAt': stamp,
        'scope': 'care',
        'project': config.project,
        'apiContainerId': config.api_container_id,
        'mongoContainerId': config.mongo_container_id,
        'apiImageId': api['Image'],
        'mongoImageId': mongo['Image'],
        'mediaVolume': config.media_volume,
        'archiveBytes': archive_bytes,
        'dataFiles': verify(data_run),
        'keyFiles': verify(key_run),
        'integrityVersion': 1,
        'consistency': 'api-and-closure-quiesced',
        'capacityPreflight': {'data': data_capacity, 'key': key_capacity},
    }
    receipt_path = data_run / 'receipt.json'
    receipt_partial = data_run / 'receipt.json.partial'
    if receipt_path.exists() or receipt_path.is_symlink() or receipt_partial.exists() or receipt_partial.is_symlink():
        raise RuntimeError('Backup receipt destination already exists')
    with receipt_partial.open('x', encoding='utf-8') as stream:
        stream.write(json.dumps(receipt, sort_keys=True))
        stream.flush()
        os.fsync(stream.fileno())
    receipt_partial.chmod(0o600)
    # A hard link publishes without replacing a file created by another actor.
    os.link(receipt_partial, receipt_path)
    receipt_partial.unlink()
    return receipt
