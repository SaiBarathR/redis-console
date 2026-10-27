#!/usr/bin/env bash
# Creates local dev/test secrets (gitignored) and starts the sandbox containers.
# Idempotent: existing .env values are reused. Pass --reset-data to reload redis-main from the seed RDB.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GEN="$ROOT/infra/.generated"
ENV_FILE="$ROOT/.env"
mkdir -p "$GEN"

rand() { openssl rand -hex 24; }
touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
ensure() { grep -q "^$1=" "$ENV_FILE" || echo "$1=${2:-$(rand)}" >> "$ENV_FILE"; }
ensure SANDBOX_REDIS_DEFAULT_PASSWORD
ensure SANDBOX_REDIS_VIEWER_PASSWORD
ensure SANDBOX_REDIS_OPERATOR_PASSWORD
ensure SANDBOX_REDIS_ADMIN_PASSWORD
ensure OIDC_CLIENT_SECRET
ensure KC_ADMIN_PASSWORD
ensure KC_USER_PASSWORD
ensure BOOTSTRAP_ADMIN_PASSWORD
# Key material for TOTP seed encryption at rest (HKDF -> AES-256-GCM); dev uses the single-key form (key id "default").
# Replacing it makes the server refuse to start until TOTP is reset: pnpm --filter @rconsole/server admin reset-totp --all --yes
ensure TOTP_ENCRYPTION_KEY "$(openssl rand -hex 32)"
set -a; source "$ENV_FILE"; set +a

sha() { printf '%s' "$1" | shasum -a 256 | cut -d' ' -f1; }
sed -e "s/__DEFAULT_HASH__/$(sha "$SANDBOX_REDIS_DEFAULT_PASSWORD")/" \
    -e "s/__VIEWER_HASH__/$(sha "$SANDBOX_REDIS_VIEWER_PASSWORD")/" \
    -e "s/__OPERATOR_HASH__/$(sha "$SANDBOX_REDIS_OPERATOR_PASSWORD")/" \
    -e "s/__ADMIN_HASH__/$(sha "$SANDBOX_REDIS_ADMIN_PASSWORD")/" \
    "$ROOT/infra/redis/users.acl.template" > "$GEN/users.acl"
cp "$ROOT/infra/redis/redis.conf.template" "$GEN/redis-main.conf"
cp "$ROOT/infra/redis/redis.conf.template" "$GEN/redis-e2e.conf"
sed -e "s/__OIDC_CLIENT_SECRET__/$OIDC_CLIENT_SECRET/" -e "s/__KC_USER_PASSWORD__/$KC_USER_PASSWORD/g" \
    "$ROOT/infra/keycloak/realm-rconsole.template.json" > "$GEN/realm-rconsole.json"
chmod 644 "$GEN/users.acl" "$GEN"/*.conf "$GEN/realm-rconsole.json"

mkdir -p "$GEN/data-main"
if [[ "${1:-}" == "--reset-data" || ! -f "$GEN/data-main/dump.rdb" ]]; then
  if [[ -f "$ROOT/infra/redis/seed-main.rdb" ]]; then cp "$ROOT/infra/redis/seed-main.rdb" "$GEN/data-main/dump.rdb"; fi
fi
chmod 777 "$GEN/data-main"
mkdir -p "$GEN/data-snapshot"
if [[ "${1:-}" == "--reset-data" || ! -f "$GEN/data-snapshot/dump.rdb" ]]; then
  # The seed may be mode 600 (scripts/snapshot-redis.sh); the container's redis user must be able to read the copy.
  if [[ -f "$ROOT/infra/redis/seed-snapshot.rdb" ]]; then cp "$ROOT/infra/redis/seed-snapshot.rdb" "$GEN/data-snapshot/dump.rdb"; chmod 644 "$GEN/data-snapshot/dump.rdb"; fi
fi
chmod 777 "$GEN/data-snapshot"

bash "$ROOT/scripts/graph-sandbox-config.sh"

docker compose -f "$ROOT/infra/docker-compose.yml" --env-file "$ENV_FILE" up -d --force-recreate
echo "Sandbox up: redis-main 127.0.0.1:6410, redis-e2e 127.0.0.1:6411, redis-snapshot 127.0.0.1:6412, redis-graph 127.0.0.1:6413, keycloak http://localhost:8089"
