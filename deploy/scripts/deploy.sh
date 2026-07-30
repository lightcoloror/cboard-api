#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${1:-${PROJECT_ROOT}/deploy/.env.production}"
COMPOSE_FILE="${PROJECT_ROOT}/deploy/docker-compose.production.yml"

node "${PROJECT_ROOT}/scripts/checkProductionDeployment.js" "${ENV_FILE}"
docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" config --quiet
docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" up -d --build
"${SCRIPT_DIR}/health-check.sh" "${ENV_FILE}"
