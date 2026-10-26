#!/usr/bin/env bash
# Exercise the built production image with a read-only rootfs and a writable SQLite volume.
set -euo pipefail
[[ "${CI:-}" == true ]] || { echo 'Run only on a disposable CI runner.' >&2; exit 2; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SMOKE_DIR="$(mktemp -d)"
cleanup() { docker rm -f rconsole-image-smoke >/dev/null 2>&1 || true; rm -rf "$SMOKE_DIR"; }
trap cleanup EXIT
# These are throwaway secrets; never pass a real deployment config into CI.
node --input-type=module - "$ROOT" "$SMOKE_DIR" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
const [root, dir] = process.argv.slice(2);
const c = JSON.parse(readFileSync(`${root}/config/rconsole.dev.json`, 'utf8'));
c.server.host = '0.0.0.0';
c.server.secureCookies = true;
c.server.publicUrl = 'https://localhost:4000';
c.server.extraAllowedOrigins = [];
delete c.auth.oidc;
c.databases = [];
writeFileSync(`${dir}/config.json`, JSON.stringify(c));
JS
chmod 755 "$SMOKE_DIR"; chmod 644 "$SMOKE_DIR/config.json"
docker run -d --name rconsole-image-smoke --read-only --tmpfs /data:uid=1000,gid=1000 \
  -p 127.0.0.1:4499:4000 \
  -e BOOTSTRAP_ADMIN_PASSWORD="$(openssl rand -hex 24)" -e TOTP_ENCRYPTION_KEY="$(openssl rand -hex 32)" \
  -v "$SMOKE_DIR/config.json:/etc/rconsole/config.json:ro" redis-console:ci >/dev/null
for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:4499/healthz >/dev/null; then
    # Download first: `curl | grep -q` fails under pipefail when grep exits before curl has written everything.
    curl -fsS -o "$SMOKE_DIR/index.html" http://127.0.0.1:4499/
    grep -q 'id="root"' "$SMOKE_DIR/index.html"
    # The notices ship in the image and are served with the SPA (v0.3 follow-up 2).
    curl -fsS -o "$SMOKE_DIR/notices.txt" http://127.0.0.1:4499/THIRD-PARTY-NOTICES.txt
    grep -q 'SIL Open Font License' "$SMOKE_DIR/notices.txt"
    docker exec rconsole-image-smoke sh -c 'test -s /app/THIRD-PARTY-NOTICES && test -s /app/LICENSE && test -s /app/NOTICE'
    cmp <(docker exec rconsole-image-smoke cat /app/THIRD-PARTY-NOTICES) "$ROOT/THIRD-PARTY-NOTICES"
    echo 'production image HTTP smoke passed'
    exit 0
  fi
  sleep 1
done
docker logs rconsole-image-smoke >&2
exit 1
