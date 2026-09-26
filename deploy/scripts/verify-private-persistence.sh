#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${1:-${PROJECT_ROOT}/deploy/.env.private}"
COMPOSE_FILE="${PROJECT_ROOT}/deploy/docker-compose.production.yml"
PROJECT_NAME="cboard-api-private"
PROOF_VALUE="private-volume-$(date -u +%Y%m%dT%H%M%SZ)-$$"

source "${SCRIPT_DIR}/docker-runtime.sh"
resolve_docker_command

COMPOSE_COMMAND=(
  "${DOCKER_COMMAND[@]}" compose
  --project-name "${PROJECT_NAME}"
  --env-file "${ENV_FILE}"
  -f "${COMPOSE_FILE}"
)

cleanup() {
  "${COMPOSE_COMMAND[@]}" exec -T mongo sh -c \
    'mongosh --quiet --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --eval "db.getSiblingDB(\"cboard-private-deploy-proof\").dropDatabase()"' \
    >/dev/null 2>&1 || true
}
trap cleanup EXIT

"${COMPOSE_COMMAND[@]}" exec -T \
  --env "PRIVATE_DEPLOY_PROOF=${PROOF_VALUE}" mongo sh -c \
  'mongosh --quiet --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --eval "db.getSiblingDB(\"cboard-private-deploy-proof\").proof.updateOne({_id: \"volume\"}, {\$set: {value: process.env.PRIVATE_DEPLOY_PROOF}}, {upsert: true})"' \
  >/dev/null

"${COMPOSE_COMMAND[@]}" restart mongo
"${COMPOSE_COMMAND[@]}" up -d --wait --wait-timeout 120

READ_BACK="$(
  "${COMPOSE_COMMAND[@]}" exec -T mongo sh -c \
    'mongosh --quiet --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --eval "print(db.getSiblingDB(\"cboard-private-deploy-proof\").proof.findOne({_id: \"volume\"}).value)"'
)"
READ_BACK="${READ_BACK//$'\r'/}"

if [[ "${READ_BACK}" != "${PROOF_VALUE}" ]]; then
  echo "Private MongoDB persistence proof did not survive restart." >&2
  exit 1
fi

cleanup
trap - EXIT
"${SCRIPT_DIR}/health-check-private.sh" "${ENV_FILE}"
echo "Private MongoDB persistence proof passed and test data was removed."
