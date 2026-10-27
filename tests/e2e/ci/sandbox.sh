#!/usr/bin/env bash
# CI-only sandbox bootstrap: disposable Redis 8 instances, Keycloak, generated secrets.
set -euo pipefail
[[ "${CI:-}" == true ]] || { echo 'This bootstrap is for disposable CI runners only.' >&2; exit 2; }
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
bash "$ROOT/scripts/dev-setup.sh"
set -a; source "$ROOT/.env"; set +a
for v in SANDBOX_REDIS_DEFAULT_PASSWORD SANDBOX_REDIS_VIEWER_PASSWORD SANDBOX_REDIS_OPERATOR_PASSWORD SANDBOX_REDIS_ADMIN_PASSWORD \
         OIDC_CLIENT_SECRET KC_ADMIN_PASSWORD KC_USER_PASSWORD BOOTSTRAP_ADMIN_PASSWORD TOTP_ENCRYPTION_KEY; do
  echo "::add-mask::${!v}"
done
# Unit/integration remote tests read this local stand-in; no external data is required.
printf '\nRC_TEST_REMOTE_HOST=127.0.0.1\nRC_TEST_REMOTE_PORT=6410\nRC_TEST_REMOTE_PASSWORD_ENV=SANDBOX_REDIS_DEFAULT_PASSWORD\n' >> "$ROOT/.env"
export REDISCLI_AUTH="$SANDBOX_REDIS_DEFAULT_PASSWORD"
for _ in $(seq 1 60); do
  if docker compose -f "$ROOT/infra/docker-compose.yml" --env-file "$ROOT/.env" exec -T -e REDISCLI_AUTH redis-main redis-cli PING | grep -q PONG; then break; fi
  sleep 1
done
# Graph integration/e2e is mandatory in CI. The pinned module must have loaded with its configured ACLs.
for _ in $(seq 1 60); do
  if docker compose -f "$ROOT/infra/docker-compose.yml" --env-file "$ROOT/.env" exec -T -e REDISCLI_AUTH redis-graph redis-cli PING | grep -q PONG; then break; fi
  sleep 1
done
docker compose -f "$ROOT/infra/docker-compose.yml" --env-file "$ROOT/.env" exec -T -e REDISCLI_AUTH redis-graph redis-cli GRAPH.CONFIG GET TIMEOUT_MAX | grep -q 1000
docker compose -f "$ROOT/infra/docker-compose.yml" --env-file "$ROOT/.env" exec -T -e REDISCLI_AUTH redis-main redis-cli MSET example:one first example:two second >/dev/null
for _ in $(seq 1 90); do
  curl -fsS http://localhost:8089/realms/rconsole/.well-known/openid-configuration >/dev/null 2>&1 && { echo 'sandbox ready'; exit 0; }
  sleep 2
done
echo 'Keycloak did not become ready' >&2; exit 1
