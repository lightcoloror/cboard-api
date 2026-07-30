#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${1:-${PROJECT_ROOT}/deploy/.env.production}"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing environment file: ${ENV_FILE}" >&2
  exit 1
fi

API_DOMAIN="$(
  sed -n 's/^API_DOMAIN=//p' "${ENV_FILE}" | tail -n 1 | tr -d '\r"'
)"
if [[ -z "${API_DOMAIN}" ]]; then
  echo "API_DOMAIN is empty in ${ENV_FILE}" >&2
  exit 1
fi

for attempt in $(seq 1 30); do
  if curl --fail --silent --show-error \
    --connect-timeout 5 \
    --max-time 10 \
    "https://${API_DOMAIN}/health" >/dev/null; then
    echo "API health check passed: https://${API_DOMAIN}/health"
    exit 0
  fi
  echo "Waiting for API health check (${attempt}/30)..."
  sleep 5
done

echo "API health check failed after 150 seconds." >&2
exit 1
