#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${1:-${PROJECT_ROOT}/deploy/.env.production}"
ARCHIVE="${2:-}"
COMPOSE_FILE="${PROJECT_ROOT}/deploy/docker-compose.production.yml"

if [[ "${CONFIRM_RESTORE:-}" != "RESTORE" ]]; then
  echo "Restore refused. Set CONFIRM_RESTORE=RESTORE after reviewing the archive and target." >&2
  exit 1
fi
if [[ -z "${ARCHIVE}" || ! -s "${ARCHIVE}" ]]; then
  echo "Usage: CONFIRM_RESTORE=RESTORE $0 [env-file] <non-empty-archive>" >&2
  exit 1
fi

cat "${ARCHIVE}" | docker compose \
  --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" \
  exec -T mongo sh -c \
  'mongorestore --quiet --drop --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --archive --gzip'

echo "MongoDB restore completed from: ${ARCHIVE}"
