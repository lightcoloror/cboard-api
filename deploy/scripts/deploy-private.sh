#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${1:-${PROJECT_ROOT}/deploy/.env.private}"
COMPOSE_FILE="${PROJECT_ROOT}/deploy/docker-compose.production.yml"
PROJECT_NAME="cboard-api-private"

source "${SCRIPT_DIR}/docker-runtime.sh"
resolve_docker_command

run_deployment_check private "${ENV_FILE}"
assert_restore_security_review_clear "${PROJECT_NAME}"
"${DOCKER_COMMAND[@]}" compose --project-name "${PROJECT_NAME}" \
  --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" config --quiet
"${DOCKER_COMMAND[@]}" compose --project-name "${PROJECT_NAME}" \
  --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" up -d --build \
  --wait --wait-timeout 180
"${SCRIPT_DIR}/health-check-private.sh" "${ENV_FILE}"
