#!/usr/bin/env bash
set -euo pipefail

# Run one bounded closure batch in the already-running Care API container.
# This wrapper never builds, starts, or recreates a service.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${1:?Pass an explicit Care environment file}"
[[ -f "${ENV_FILE}" ]] || { echo 'Care environment file is required.' >&2; exit 1; }

source "${SCRIPT_DIR}/docker-runtime.sh"

PROJECT_NAME="$(read_deployment_value "${ENV_FILE}" DEPLOYMENT_PROJECT_NAME)"
if ! [[ "${PROJECT_NAME}" =~ ^cboard-care-[a-z0-9][a-z0-9_-]{0,49}$ ]]; then
  echo 'Use a dedicated cboard-care-* project.' >&2
  exit 1
fi
if [[ "$(read_deployment_value "${ENV_FILE}" CARE_CLOSURE_WORKER_ENABLED)" != true ]]; then
  echo 'CARE_CLOSURE_WORKER_ENABLED must be true for a closure batch.' >&2
  exit 1
fi

assert_restore_security_review_clear "${PROJECT_NAME}"
acquire_care_maintenance_lock "${PROJECT_NAME}" shared
assert_restore_security_review_clear "${PROJECT_NAME}"
resolve_docker_command

API_IDS="$("${DOCKER_COMMAND[@]}" ps \
  --filter "label=com.docker.compose.project=${PROJECT_NAME}" \
  --filter 'label=com.docker.compose.service=api' \
  --format '{{.ID}}')"
if [[ -z "${API_IDS}" ]]; then
  echo 'No running Care API container found.' >&2
  exit 1
fi
mapfile -t API_ID_ARRAY <<< "${API_IDS}"
if [[ "${#API_ID_ARRAY[@]}" != 1 || -z "${API_ID_ARRAY[0]}" ]]; then
  echo 'Expected exactly one running Care API container.' >&2
  exit 1
fi
API_ID="${API_ID_ARRAY[0]}"

API_METADATA="$("${DOCKER_COMMAND[@]}" inspect --format '{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${API_ID}")"
IFS='|' read -r API_PROJECT API_SERVICE API_STATE API_HEALTH <<< "${API_METADATA}"
if [[ "${API_PROJECT}" != "${PROJECT_NAME}" || "${API_SERVICE}" != api ||
      "${API_STATE}" != running || "${API_HEALTH}" != healthy ]]; then
  echo 'Care API container identity or health is not verified.' >&2
  exit 1
fi

if ! "${DOCKER_COMMAND[@]}" exec "${API_ID}" sh -c \
  'command -v timeout >/dev/null 2>&1 && command -v flock >/dev/null 2>&1'; then
  echo 'Care API container lacks timeout or flock.' >&2
  exit 1
fi

# The lock lives on the API tmpfs. Non-blocking flock prevents overlapping
# batches; timeout preserves TERM/KILL exit codes for the operator/systemd.
"${DOCKER_COMMAND[@]}" exec "${API_ID}" sh -c \
  'flock -n /tmp/care-closure-worker.lock timeout --signal=TERM --kill-after=5s 90s node --max-old-space-size=128 /opt/cboard-api/scripts/runCareClosureWorker.js'
