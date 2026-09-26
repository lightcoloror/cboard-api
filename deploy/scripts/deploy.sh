#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${1:-${PROJECT_ROOT}/deploy/.env.production}"
COMPOSE_FILE="${PROJECT_ROOT}/deploy/docker-compose.production.yml"

source "${SCRIPT_DIR}/docker-runtime.sh"
resolve_docker_command

run_deployment_check production "${ENV_FILE}"
PROJECT_NAME="$(
  sed -n 's/^DEPLOYMENT_PROJECT_NAME=//p' "${ENV_FILE}" | tail -n 1 | tr -d '\r"'
)"
if ! [[ "${PROJECT_NAME}" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]]; then
  echo "DEPLOYMENT_PROJECT_NAME is missing or invalid." >&2
  exit 1
fi
assert_restore_security_review_clear "${PROJECT_NAME}"
"${DOCKER_COMMAND[@]}" compose --project-name "${PROJECT_NAME}" --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" config --quiet
"${DOCKER_COMMAND[@]}" compose --project-name "${PROJECT_NAME}" --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" up -d --build
"${SCRIPT_DIR}/health-check.sh" "${ENV_FILE}"
