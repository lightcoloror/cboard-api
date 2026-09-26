#!/usr/bin/env bash
set -euo pipefail

# Read an exact allow-list of fields without printing the full environment.
# Host Node is preferred. The fallback is deliberately offline, read-only and
# cache-only; an explicit digest may select a locally cached API image.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
source "${SCRIPT_DIR}/docker-runtime.sh"
ENV_FILE="${1:?Pass an environment file}"
FIELDS="${2:?Pass a comma-separated allow-list of fields}"
MODE="${3:-json}"

[[ "${ENV_FILE}" == /* && -f "${ENV_FILE}" && ! -L "${ENV_FILE}" ]] || {
  echo 'Environment file must be an absolute regular file.' >&2; exit 1;
}
case "${MODE}" in
  json) OUTPUT_MODE=(--json) ;;
  lines) OUTPUT_MODE=() ;;
  *) echo 'Output mode must be json or lines.' >&2; exit 1 ;;
esac

if command -v node >/dev/null 2>&1; then
  exec node "${PROJECT_ROOT}/scripts/readDeploymentEnvironment.js" \
    --env-file "${ENV_FILE}" --fields "${FIELDS}" "${OUTPUT_MODE[@]}"
fi

if [[ -n "${CARE_NODE_IMAGE:-}" ]]; then
  [[ "${CARE_NODE_IMAGE}" =~ ^sha256:[0-9a-f]{64}$ ]] || {
    echo 'CARE_NODE_IMAGE must be an explicit sha256 digest.' >&2; exit 1;
  }
  NODE_IMAGE="${CARE_NODE_IMAGE}"
else
  NODE_IMAGE='node:22.23.1-bookworm-slim'
fi
resolve_docker_command || { echo 'Node or Docker is required to read deployment environment.' >&2; exit 1; }

"${DOCKER_COMMAND[@]}" run --rm --pull=never --network none --read-only --cap-drop=ALL \
  --memory=128m --pids-limit=32 --entrypoint node \
  --security-opt no-new-privileges --user 0 \
  --volume "${PROJECT_ROOT}:/workspace:ro" \
  --volume "${ENV_FILE}:/run/deployment.env:ro" \
  --workdir /workspace "${NODE_IMAGE}" \
  scripts/readDeploymentEnvironment.js \
  --env-file /run/deployment.env --fields "${FIELDS}" "${OUTPUT_MODE[@]}"
