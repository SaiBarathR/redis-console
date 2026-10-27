#!/usr/bin/env bash
# Generate only the graph sandbox files; never modifies other sandbox files or starts containers.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GEN="$ROOT/infra/.generated"
set -a; source "$ROOT/.env"; set +a
mkdir -p "$GEN"
sha() { printf '%s' "$1" | shasum -a 256 | cut -d' ' -f1; }
sed -e "s/__DEFAULT_HASH__/$(sha "$SANDBOX_REDIS_DEFAULT_PASSWORD")/" \
    -e "s/__VIEWER_HASH__/$(sha "$SANDBOX_REDIS_VIEWER_PASSWORD")/" \
    -e "s/__OPERATOR_HASH__/$(sha "$SANDBOX_REDIS_OPERATOR_PASSWORD")/" \
    -e "s/__ADMIN_HASH__/$(sha "$SANDBOX_REDIS_ADMIN_PASSWORD")/" \
    "$ROOT/infra/redis/users-graph.acl.template" > "$GEN/users-graph.acl"
cp "$ROOT/infra/redis/redis-graph.conf.template" "$GEN/redis-graph.conf"
chmod 644 "$GEN/users-graph.acl" "$GEN/redis-graph.conf"
