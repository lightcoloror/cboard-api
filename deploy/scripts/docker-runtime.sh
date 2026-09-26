#!/usr/bin/env bash

resolve_docker_command() {
  if docker info >/dev/null 2>&1; then
    DOCKER_COMMAND=(docker)
  elif sudo -n docker info >/dev/null 2>&1; then
    DOCKER_COMMAND=(sudo docker)
  else
    echo "Docker is unavailable or requires interactive privilege escalation." >&2
    return 1
  fi
}

run_deployment_check() {
  local profile="$1"
  local environment_file="$2"
  local checker_args=()

  if [[ "${profile}" == "private" ]]; then
    checker_args+=(--private)
  fi

  if command -v node >/dev/null 2>&1; then
    node "${PROJECT_ROOT}/scripts/checkProductionDeployment.js" \
      "${checker_args[@]}" "${environment_file}"
    return
  fi

  local node_image="node:22.23.1-bookworm-slim"
  if [[ -n "${CARE_NODE_IMAGE:-}" ]]; then
    [[ "${CARE_NODE_IMAGE}" =~ ^sha256:[0-9a-f]{64}$ ]] || {
      echo 'CARE_NODE_IMAGE must be an explicit sha256 image ID.' >&2
      return 1
    }
    node_image="${CARE_NODE_IMAGE}"
  fi

  "${DOCKER_COMMAND[@]}" run --rm --pull=never --network none --read-only \
    --cap-drop=ALL --security-opt no-new-privileges --user 0 \
    --memory=128m --pids-limit=32 --entrypoint node \
    --volume "${PROJECT_ROOT}:/workspace:ro" \
    --volume "${environment_file}:/run/deployment.env:ro" \
    --workdir /workspace \
    "${node_image}" scripts/checkProductionDeployment.js \
    "${checker_args[@]}" /run/deployment.env
}

read_deployment_value() {
  local environment_file="$1"
  local field="$2"
  local line
  [[ "${field}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || {
    echo 'Deployment environment field name is invalid.' >&2
    return 1
  }
  line="$(bash "${PROJECT_ROOT}/deploy/scripts/read-deployment-env.sh" \
    "${environment_file}" "${field}" lines)" || return 1
  [[ "${line}" == "${field}="* ]] || {
    echo 'Deployment environment field was not returned exactly.' >&2
    return 1
  }
  printf '%s' "${line#${field}=}"
}

restore_security_hold_path() {
  local project="$1"
  if ! [[ "${project}" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]]; then
    echo "Invalid restore security review project." >&2
    return 1
  fi
  printf '%s/deploy/.restore-security-review-required.%s' "${PROJECT_ROOT}" "${project}"
}

write_restore_security_hold() {
  local project="$1"
  local marker
  marker="$(restore_security_hold_path "${project}")" || return 1
  if [[ -e "${marker}" || -L "${marker}" ]]; then
    if [[ -f "${marker}" && ! -L "${marker}" ]]; then
      return 0
    fi
    echo "Restore review marker is not a regular file; restore refused." >&2
    return 1
  fi
  # Create before database writes. A crash or failed restore must retain the hold.
  # noclobber refuses concurrent creation and never follows an existing symlink.
  (
    umask 077
    set -o noclobber
    printf 'project=%s\ncreatedAt=%s\nstatus=security-review-required\n' \
      "${project}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"${marker}"
  )
}

assert_restore_security_review_clear() {
  local marker
  marker="$(restore_security_hold_path "$1")" || return 1
  if [[ -e "${marker}" || -L "${marker}" ]]; then
    echo "Restore security review required. Keep the API offline until account, revocation and closure state is reconciled: ${marker}" >&2
    return 1
  fi
}

# Supported Care maintenance entrypoints share this persistent lock inode.
# Keep it in the trusted checkout; never unlink it while processes may hold it.
acquire_care_maintenance_lock() {
  local project="$1" mode="$2" lock
  if ! [[ "${project}" =~ ^cboard-care-[a-z0-9][a-z0-9_-]{0,49}$ ]] ||
      ! [[ "${mode}" == shared || "${mode}" == exclusive ]]; then
    echo 'Invalid Care maintenance lock request.' >&2; return 1
  fi
  command -v flock >/dev/null 2>&1 || { echo 'Host flock is required.' >&2; return 1; }
  lock="${PROJECT_ROOT}/deploy/.care-maintenance.${project}.lock"
  if [[ ! -e "${lock}" && ! -L "${lock}" ]]; then
    (umask 077; set -o noclobber; : >"${lock}") 2>/dev/null || true
  fi
  if [[ ! -f "${lock}" || -L "${lock}" ]]; then
    echo 'Care maintenance lock must be a regular file.' >&2; return 1
  fi
  exec {CARE_MAINTENANCE_LOCK_FD}<"${lock}" || return 1
  local option=--shared
  [[ "${mode}" == exclusive ]] && option=--exclusive
  if ! flock --nonblock "${option}" "${CARE_MAINTENANCE_LOCK_FD}"; then
    echo 'Care maintenance is busy; no service changes were made.' >&2
    exec {CARE_MAINTENANCE_LOCK_FD}<&-
    return 1
  fi
}
