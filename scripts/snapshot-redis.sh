#!/usr/bin/env bash
# Take a replication snapshot of an explicitly selected Redis into the local snapshot sandbox.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
usage() { echo "Usage: $0 --host H --port P --password-env VAR [--user U] [--tls]" >&2; }
HOST= PORT= PASSWORD_ENV= USER_NAME= TLS=0
while (($#)); do
  case "$1" in
    --host|--port|--password-env|--user)
      [[ $# -ge 2 && -n "$2" ]] || { usage; exit 2; }
      case "$1" in
        --host) HOST="$2";; --port) PORT="$2";; --password-env) PASSWORD_ENV="$2";; --user) USER_NAME="$2";;
      esac
      shift 2;;
    --tls) TLS=1; shift;;
    -h|--help) usage; exit 0;;
    *) usage; exit 2;;
  esac
done
[[ -n "$HOST" && "$PORT" =~ ^[0-9]+$ && "$PASSWORD_ENV" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]] || { usage; exit 2; }
(( PORT > 0 && PORT <= 65535 )) || { usage; exit 2; }
: "${!PASSWORD_ENV:?Set the password environment variable before running this script}"
# Never put passwords in argv, output, or tracked files.
export REDISCLI_AUTH="${!PASSWORD_ENV}"
ARGS=(-h "$HOST" -p "$PORT")
[[ -z "$USER_NAME" ]] || ARGS+=(--user "$USER_NAME")
(( TLS == 0 )) || ARGS+=(--tls)
BACKUPS="$ROOT/infra/.generated/snapshots"
mkdir -p "$BACKUPS"
SNAP="$(mktemp "$BACKUPS/snapshot-$(date +%Y%m%d-%H%M%S)-XXXXXX")"
trap 'rm -f "$SNAP.partial"; [[ -s "$SNAP" ]] || rm -f "$SNAP"' EXIT
redis-cli "${ARGS[@]}" --rdb "$SNAP.partial"
mv "$SNAP.partial" "$SNAP"
chmod 600 "$SNAP"
cp "$SNAP" "$ROOT/infra/redis/seed-snapshot.rdb"
GEN="$ROOT/infra/.generated"
mkdir -p "$GEN/data-snapshot"; chmod 777 "$GEN/data-snapshot"
# Stop only this service before replacing its RDB so shutdown cannot overwrite the new snapshot.
COMPOSE=(docker compose -f "$ROOT/infra/docker-compose.yml" --env-file "$ROOT/.env")
"${COMPOSE[@]}" stop redis-snapshot
cp "$SNAP" "$GEN/data-snapshot/dump.rdb"
chmod 644 "$GEN/data-snapshot/dump.rdb"
"${COMPOSE[@]}" up -d --force-recreate --no-deps redis-snapshot
echo "Local snapshot refreshed; backup: $SNAP"
