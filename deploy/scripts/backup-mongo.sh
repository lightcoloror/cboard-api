#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${1:-${PROJECT_ROOT}/deploy/.env.production}"
BACKUP_DIR="${BACKUP_DIR:-${PROJECT_ROOT}/deploy/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
COMPOSE_FILE="${PROJECT_ROOT}/deploy/docker-compose.production.yml"

if ! [[ "${RETENTION_DAYS}" =~ ^[0-9]+$ ]]; then
  echo "BACKUP_RETENTION_DAYS must be a non-negative integer." >&2
  exit 1
fi

umask 077
mkdir -p "${BACKUP_DIR}"
ARCHIVE="${BACKUP_DIR}/mongo-$(date -u +%Y%m%dT%H%M%SZ).archive.gz"

docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" \
  exec -T mongo sh -c \
  'mongodump --quiet --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --archive --gzip' \
  >"${ARCHIVE}"

if [[ ! -s "${ARCHIVE}" ]]; then
  rm -f "${ARCHIVE}"
  echo "MongoDB backup is empty." >&2
  exit 1
fi

find "${BACKUP_DIR}" -maxdepth 1 -type f -name 'mongo-*.archive.gz' \
  -mtime "+${RETENTION_DAYS}" -delete
echo "MongoDB backup created: ${ARCHIVE}"
