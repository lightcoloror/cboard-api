#!/usr/bin/env bash
set -euo pipefail

# Operator-owned backup of an existing Care project, never a deployment action.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${1:?Pass an explicit Care environment file}"
DATA_ROOT="${2:?Pass the data backup root}"
KEY_ROOT="${3:?Pass the separate key backup root}"
[[ "${ENV_FILE}" == /* && "${DATA_ROOT}" == /* && "${KEY_ROOT}" == /* ]] || {
  echo 'Care backup requires explicit absolute paths.' >&2; exit 1;
}
source "${SCRIPT_DIR}/docker-runtime.sh"
command -v python3 >/dev/null || {
  echo 'Python 3 is required for Care backup.' >&2; exit 1;
}
PROJECT_NAME="$(read_deployment_value "${ENV_FILE}" DEPLOYMENT_PROJECT_NAME)"
KEY_FILE="$(read_deployment_value "${ENV_FILE}" CARE_MONGO_KEY_FILE)"
acquire_care_maintenance_lock "${PROJECT_NAME}" exclusive
assert_restore_security_review_clear "${PROJECT_NAME}"
# Python uses the same direct Docker CLI; do not silently change privilege or context.
command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 || {
  echo 'Direct Docker access is required for Care backup.' >&2; exit 1;
}
# backup_care.py invokes the Docker CLI directly; do not silently substitute sudo.
DOCKER_COMMAND=(docker)
container_id() {
  local ids
  ids="$("${DOCKER_COMMAND[@]}" ps --all --no-trunc --quiet \
    --filter "label=com.docker.compose.project=${PROJECT_NAME}" \
    --filter "label=com.docker.compose.service=$1")"
  [[ "${ids}" =~ ^[0-9a-f]{64}$ ]] || {
    echo 'Exactly one existing container per Care service is required.' >&2; return 1;
  }
  printf '%s' "${ids}"
}
API_ID="$(container_id api)"
MONGO_ID="$(container_id mongo)"
umask 077
# This shell retains the maintenance-lock FD throughout the child operation.
python3 -c '
import json, sys
sys.path.insert(0, sys.argv[1])
from backup_care import CareBackupConfig, run_backup
config = CareBackupConfig(project=sys.argv[2], api_container_id=sys.argv[3],
    mongo_container_id=sys.argv[4], media_volume=sys.argv[2]+"_care_media",
    environment_file=sys.argv[5], mongo_key_file=sys.argv[6],
    data_root=sys.argv[7], key_root=sys.argv[8], restore_hold_path=sys.argv[9])
try:
    print(json.dumps(run_backup(config)))
except Exception:
    print("Care backup failed; inspect retained partial data and service state.", file=sys.stderr)
    sys.exit(1)
' "${SCRIPT_DIR}" "${PROJECT_NAME}" "${API_ID}" "${MONGO_ID}" \
  "${ENV_FILE}" "${KEY_FILE}" "${DATA_ROOT}" "${KEY_ROOT}" \
  "$(restore_security_hold_path "${PROJECT_NAME}")"
