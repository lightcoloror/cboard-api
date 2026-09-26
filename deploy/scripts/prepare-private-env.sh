#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

source "${SCRIPT_DIR}/docker-runtime.sh"
resolve_docker_command

"${DOCKER_COMMAND[@]}" run --rm --network none \
  --user "$(id -u):$(id -g)" \
  --volume "${PROJECT_ROOT}:/workspace" \
  --workdir /workspace \
  node:22.23.1-bookworm-slim \
  node scripts/createPrivateEnvironment.js
