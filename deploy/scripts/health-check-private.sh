#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${1:-${PROJECT_ROOT}/deploy/.env.private}"
COMPOSE_FILE="${PROJECT_ROOT}/deploy/docker-compose.production.yml"
PROJECT_NAME="cboard-api-private"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing environment file: ${ENV_FILE}" >&2
  exit 1
fi

read_env_value() {
  sed -n "s/^$1=//p" "${ENV_FILE}" | tail -n 1 | tr -d '\r"'
}

BIND_ADDRESS="$(read_env_value BIND_ADDRESS)"
HTTP_PORT="$(read_env_value HTTP_PORT)"
HTTPS_PORT="$(read_env_value HTTPS_PORT)"

if [[ "${BIND_ADDRESS}" != "127.0.0.1" ]]; then
  echo "Private health check refused a non-loopback bind address." >&2
  exit 1
fi

source "${SCRIPT_DIR}/docker-runtime.sh"
resolve_docker_command

for attempt in $(seq 1 30); do
  if curl --fail --silent --show-error --insecure \
    --connect-timeout 5 --max-time 10 \
    --resolve "localhost:${HTTPS_PORT}:127.0.0.1" \
    "https://localhost:${HTTPS_PORT}/health" >/dev/null; then
    published_http="$("${DOCKER_COMMAND[@]}" compose \
      --project-name "${PROJECT_NAME}" --env-file "${ENV_FILE}" \
      -f "${COMPOSE_FILE}" port caddy 80)"
    published_https="$("${DOCKER_COMMAND[@]}" compose \
      --project-name "${PROJECT_NAME}" --env-file "${ENV_FILE}" \
      -f "${COMPOSE_FILE}" port caddy 443)"
    if [[ "${published_http}" != "127.0.0.1:${HTTP_PORT}" || \
          "${published_https}" != "127.0.0.1:${HTTPS_PORT}" ]]; then
      echo "Private deployment published an unexpected host address." >&2
      exit 1
    fi
    echo "Private API health check passed on loopback HTTPS port ${HTTPS_PORT}."
    exit 0
  fi
  echo "Waiting for private API health check (${attempt}/30)..."
  sleep 5
done

echo "Private API health check failed after 150 seconds." >&2
exit 1
