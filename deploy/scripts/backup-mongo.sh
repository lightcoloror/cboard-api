#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${1:-${PROJECT_ROOT}/deploy/.env.production}"
BACKUP_DIR="${BACKUP_DIR:-${PROJECT_ROOT}/deploy/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
COMPOSE_FILE="${PROJECT_ROOT}/deploy/docker-compose.production.yml"

source "${SCRIPT_DIR}/docker-runtime.sh"
resolve_docker_command

PROJECT_NAME="$(
  sed -n 's/^DEPLOYMENT_PROJECT_NAME=//p' "${ENV_FILE}" | tail -n 1 | tr -d '\r"'
)"
if ! [[ "${PROJECT_NAME}" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]]; then
  echo "DEPLOYMENT_PROJECT_NAME is missing or invalid." >&2
  exit 1
fi

if [[ "${PROJECT_NAME}" == cboard-care-* ]]; then
  echo 'Care requires a coordinated database, private media and separate key backup; database-only backup refused.' >&2
  exit 1
fi

if ! [[ "${RETENTION_DAYS}" =~ ^[0-9]+$ ]]; then
  echo "BACKUP_RETENTION_DAYS must be a non-negative integer." >&2
  exit 1
fi

umask 077
mkdir -p "${BACKUP_DIR}"
PARTIAL="$(mktemp "${BACKUP_DIR}/.mongo-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")"
ARCHIVE="${BACKUP_DIR}/$(basename "${PARTIAL}" | sed 's/^\.//').archive.gz"
cleanup_partial_archive() {
  rm -f -- "${PARTIAL}"
}
trap cleanup_partial_archive EXIT

"${DOCKER_COMMAND[@]}" compose --project-name "${PROJECT_NAME}" \
  --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" \
  exec -T mongo sh -c \
  'mongodump --quiet --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --archive --gzip' \
  >"${PARTIAL}"

if [[ ! -s "${PARTIAL}" ]]; then
  echo "MongoDB backup is empty." >&2
  exit 1
fi

mv -- "${PARTIAL}" "${ARCHIVE}"
trap - EXIT

find "${BACKUP_DIR}" -maxdepth 1 -type f -name 'mongo-*.archive.gz' \
  -mtime "+${RETENTION_DAYS}" -delete
echo "MongoDB backup created: ${ARCHIVE}"
