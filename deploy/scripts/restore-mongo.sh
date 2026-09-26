#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${1:-${PROJECT_ROOT}/deploy/.env.production}"
ARCHIVE="${2:-}"
COMPOSE_FILE="${PROJECT_ROOT}/deploy/docker-compose.production.yml"

source "${SCRIPT_DIR}/docker-runtime.sh"

PROJECT_NAME="$(
  sed -n 's/^DEPLOYMENT_PROJECT_NAME=//p' "${ENV_FILE}" | tail -n 1 | tr -d '\r"'
)"
if ! [[ "${PROJECT_NAME}" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]]; then
  echo "DEPLOYMENT_PROJECT_NAME is missing or invalid." >&2
  exit 1
fi

if [[ "${PROJECT_NAME}" == cboard-care-* ]]; then
  echo 'Care requires a coordinated database, private media and separate key restore; database-only restore refused. Use the complete Care restore flow.' >&2
  exit 1
fi

resolve_docker_command

if [[ "${CONFIRM_RESTORE:-}" != "RESTORE" ]]; then
  echo "Restore refused. Set CONFIRM_RESTORE=RESTORE after reviewing the archive and target." >&2
  exit 1
fi
if [[ -z "${ARCHIVE}" || ! -s "${ARCHIVE}" ]]; then
  echo "Usage: CONFIRM_RESTORE=RESTORE $0 [env-file] <non-empty-archive>" >&2
  exit 1
fi

if ! API_CONTAINER_IDS="$("${DOCKER_COMMAND[@]}" compose --project-name "${PROJECT_NAME}" \
  --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" \
  ps --all --quiet api 2>&1)"; then
  echo "Unable to verify whether the API service is stopped; restore refused." >&2
  exit 1
fi
if [[ -n "${API_CONTAINER_IDS}" ]]; then
  mapfile -t API_CONTAINER_IDS < <(printf '%s\n' "${API_CONTAINER_IDS}" | sed '/^$/d')
  if ! API_CONTAINER_STATES="$("${DOCKER_COMMAND[@]}" inspect --format '{{.State.Status}}' "${API_CONTAINER_IDS[@]}" 2>&1)"; then
    echo "Unable to verify whether the API service is stopped; restore refused." >&2
    exit 1
  fi
  while IFS= read -r API_CONTAINER_STATE; do
    if [[ "${API_CONTAINER_STATE}" != "created" && "${API_CONTAINER_STATE}" != "exited" ]]; then
      echo "Restore refused while an API container is ${API_CONTAINER_STATE}. Stop it and retry; this script will not start it." >&2
      exit 1
    fi
  done <<< "${API_CONTAINER_STATES}"
fi

write_restore_security_hold "${PROJECT_NAME}"

"${DOCKER_COMMAND[@]}" compose --project-name "${PROJECT_NAME}" \
  --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" \
  exec -T mongo sh -c \
  'mongorestore --quiet --drop --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --archive --gzip' \
  <"${ARCHIVE}"

echo "MongoDB restore completed from: ${ARCHIVE}"
echo "The API must remain offline pending restore security review; deployment remains blocked."
