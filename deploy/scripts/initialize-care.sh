#!/usr/bin/env bash
set -euo pipefail

# Fresh, isolated installation only. Never migrates or restarts an existing project.
# Leaves failed resources available for diagnosis; never deletes database volumes.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${1:?Pass an explicit Care environment file}"
if [[ "${2:-}" != '--initialize-empty' ]]; then
  echo 'Fresh Care initialization requires --initialize-empty.' >&2
  exit 1
fi
source "${SCRIPT_DIR}/docker-runtime.sh"
resolve_docker_command
run_deployment_check production "${ENV_FILE}"
PROJECT_NAME="$(read_deployment_value "${ENV_FILE}" DEPLOYMENT_PROJECT_NAME)"
if ! [[ "${PROJECT_NAME}" =~ ^cboard-care-[a-z0-9][a-z0-9_-]{0,49}$ ]]; then
  echo 'Use a dedicated cboard-care-* project.' >&2; exit 1
fi
for flag in CARE_COLLABORATION_ENABLED CARE_NEXT_ENABLED CARE_LIFECYCLE_TRANSACTIONS_ENABLED; do
  [[ "$(read_deployment_value "${ENV_FILE}" "${flag}")" == true ]] || { echo "${flag} must be true." >&2; exit 1; }
done
MONGO_URL="$(read_deployment_value "${ENV_FILE}" MONGO_URL)"
if ! printf '%s' "${MONGO_URL}" | python3 -c '
import sys
from urllib.parse import parse_qsl, urlsplit
try:
    query = parse_qsl(urlsplit(sys.stdin.read()).query, keep_blank_values=True)
    replicas = [value for key, value in query if key.lower() == "replicaset"]
    direct = [key for key, _ in query if key.lower() == "directconnection"]
    if len(replicas) != 1 or replicas[0] != "care-rs" or direct:
        raise ValueError
except Exception:
    raise SystemExit(1)
'; then
  echo 'Care initialization requires replicaSet=care-rs without directConnection.' >&2; exit 1;
fi
assert_restore_security_review_clear "${PROJECT_NAME}"
KEY_FILE="$(read_deployment_value "${ENV_FILE}" CARE_MONGO_KEY_FILE)"
if [[ "${KEY_FILE}" != /* || ! -f "${KEY_FILE}" || -L "${KEY_FILE}" ]]; then
  echo 'Provide a regular absolute CARE_MONGO_KEY_FILE.' >&2; exit 1
fi
if [[ "$(stat -c '%a' "${KEY_FILE}")" != 400 ]]; then
  echo 'The Mongo key file must have mode 0400.' >&2; exit 1
fi
EXISTING_CONTAINERS="$("${DOCKER_COMMAND[@]}" ps -aq --filter "label=com.docker.compose.project=${PROJECT_NAME}")"
EXISTING_VOLUMES="$("${DOCKER_COMMAND[@]}" volume ls -q --filter "label=com.docker.compose.project=${PROJECT_NAME}")"
if [[ -n "${EXISTING_CONTAINERS}" || -n "${EXISTING_VOLUMES}" ]]; then
  echo 'Existing project resources found; initialization refused.' >&2; exit 1
fi
# Compose may reuse same-name resources with missing labels. Successful list
# calls distinguish an empty result from daemon/permission errors (set -e).
NAMED_VOLUMES="$("${DOCKER_COMMAND[@]}" volume ls -q --filter "name=^${PROJECT_NAME}_")"
NAMED_NETWORKS="$("${DOCKER_COMMAND[@]}" network ls -q --filter "name=^${PROJECT_NAME}_")"
if [[ -n "${NAMED_VOLUMES}" ]]; then
  echo 'A target volume already exists; initialization refused.' >&2; exit 1
fi
if [[ -n "${NAMED_NETWORKS}" ]]; then
  echo 'A target network already exists; initialization refused.' >&2; exit 1
fi
compose() {
  "${DOCKER_COMMAND[@]}" compose --project-name "${PROJECT_NAME}" --env-file "${ENV_FILE}" \
    -f "${PROJECT_ROOT}/deploy/docker-compose.production.yml" \
    -f "${PROJECT_ROOT}/deploy/docker-compose.care.yml" "$@"
}
compose config --quiet
compose build api
# Derive the Mongo UID from the pinned image rather than assuming a host UID.
MONGO_UID="$(compose run --rm --no-deps --entrypoint id mongo -u mongodb)"
[[ "${MONGO_UID}" =~ ^[0-9]+$ && "$(stat -c '%u' "${KEY_FILE}")" == "${MONGO_UID}" ]] || {
  echo 'The Mongo key file owner must match the pinned image Mongo UID.' >&2; exit 1;
}
compose run --rm --no-deps --user 0 --cap-add CHOWN --entrypoint sh api -c \
  'chmod 700 /data/care-media && chown node:node /data/care-media'
compose up -d --no-deps mongo
mongo_js() {
  compose exec -T mongo sh -c \
    'mongosh --quiet --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --eval "$1"' sh "$1"
}
ready=false
for attempt in {1..60}; do
  if mongo_js 'quit(db.adminCommand({ping:1}).ok ? 0 : 1)' >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
[[ "${ready}" == true ]] || { echo 'Authenticated Mongo readiness timed out.' >&2; exit 1; }
mongo_js 'rs.initiate({_id:"care-rs",members:[{_id:0,host:"mongo:27017"}]})' >/dev/null
ready=false
for attempt in {1..60}; do
  if mongo_js 'quit(db.hello().isWritablePrimary ? 0 : 1)' >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
[[ "${ready}" == true ]] || { echo 'Mongo primary readiness timed out.' >&2; exit 1; }
mongo_js 'const name="care_deployment_probe_"+new ObjectId().toHexString();const s=db.getMongo().startSession();try{const d=s.getDatabase(name);d.probe.insertOne({_id:1});s.startTransaction();d.probe.insertOne({_id:2});s.abortTransaction();if(d.probe.countDocuments({_id:2})!==0)throw Error("abort failed");s.startTransaction();d.probe.insertOne({_id:3});s.commitTransaction();if(d.probe.countDocuments({_id:3})!==1)throw Error("commit failed")}finally{s.endSession();db.getSiblingDB(name).dropDatabase()}' >/dev/null
compose up -d --no-deps --wait --wait-timeout 90 api
echo 'Care database and internal API initialized. Caddy and closure scheduling have not been started.'
