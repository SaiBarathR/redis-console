#!/usr/bin/env bash
# Disposable Redis cluster + sentinel for testing the server's cluster/sentinel modes.
# Uses only ports 6420-6429 (host network; cluster bus ports pinned inside the range):
#   cluster nodes 6420 6421 6422 (bus 6423 6424 6425), sentinel master 6426, sentinel 6427,
#   TLS-only node 6428 (mutual TLS; certificates in $RC_TOPO_TLS_DIR, default /tmp/rc-topo-tls).
# Usage: scripts/topology.sh up|down   (requires RC_TOPO_PASSWORD in the environment)
set -euo pipefail
cmd="${1:-}"
names=(rcsrv-cl-0 rcsrv-cl-1 rcsrv-cl-2 rcsrv-sm-master rcsrv-sm-sentinel rcsrv-tls)
TLS_DIR="${RC_TOPO_TLS_DIR:-/tmp/rc-topo-tls}"
if [[ "$cmd" == "down" ]]; then
  docker rm -f "${names[@]}" >/dev/null 2>&1 || true
  rm -rf "$TLS_DIR"
  echo "topology removed"
  exit 0
fi
[[ "$cmd" == "up" ]] || { echo "usage: $0 up|down" >&2; exit 2; }
: "${RC_TOPO_PASSWORD:?set RC_TOPO_PASSWORD}"
P="$RC_TOPO_PASSWORD"
ACL='user default off
user rc-viewer on >$P ~* &* -@all +@read +@connection -@dangerous -keys +info +slowlog|get +memory|usage +command|docs +command|info +command|list +cluster|slots +cluster|shards +cluster|nodes +cluster|info +subscribe +psubscribe +ping
user rc-operator on >$P ~* &* -@all +@read +@write +@pubsub +@connection +@transaction -@dangerous -keys +info +slowlog|get +memory|usage +command|docs +command|info +command|list +cluster|slots +cluster|shards +cluster|nodes +cluster|info +ping
user rc-admin on >$P ~* &* +@all -@scripting -module -keys -flushall -shutdown -debug'
# $1 = container name, rest = redis-server args. The ACL file is written inside the container (password via env).
run_node() {
  local name="$1"; shift
  docker run -d --rm --name "$name" --network host -e P="$P" -e ACL="$ACL" redis:8 \
    sh -c 'printf "%s\n" "$ACL" | sed "s/\$P/$P/g" > /tmp/users.acl && exec redis-server "$@" --aclfile /tmp/users.acl' sh "$@" >/dev/null
}
for i in 0 1 2; do
  port=$((6420 + i)); bus=$((6423 + i))
  run_node "rcsrv-cl-$i" --port "$port" --cluster-enabled yes --cluster-port "$bus" --cluster-config-file "/tmp/nodes-$port.conf" \
    --save '' --appendonly no --bind 127.0.0.1 --masterauth "$P" --masteruser rc-admin
done
sleep 1
docker exec rcsrv-cl-0 redis-cli -p 6420 --user rc-admin --pass "$P" --no-auth-warning --cluster create \
  127.0.0.1:6420 127.0.0.1:6421 127.0.0.1:6422 --cluster-replicas 0 --cluster-yes >/dev/null
run_node rcsrv-sm-master --port 6426 --save '' --appendonly no --bind 127.0.0.1
docker run -d --rm --name rcsrv-sm-sentinel --network host -e P="$P" redis:8 sh -c \
  'printf "port 6427\nbind 127.0.0.1\nsentinel monitor mymaster 127.0.0.1 6426 1\nsentinel auth-user mymaster rc-admin\nsentinel auth-pass mymaster %s\n" "$P" > /tmp/s.conf && exec redis-sentinel /tmp/s.conf' >/dev/null
for _ in $(seq 1 30); do
  if docker exec rcsrv-cl-0 redis-cli -p 6420 --user rc-admin --pass "$P" --no-auth-warning cluster info 2>/dev/null | grep -q 'cluster_state:ok'; then break; fi
  sleep 0.5
done
# TLS node: throwaway CA, server cert (CN/SAN localhost + 127.0.0.1) and client cert.
mkdir -p "$TLS_DIR"
(
  cd "$TLS_DIR"
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=rc-topo-ca" -keyout ca.key -out ca.crt 2>/dev/null
  for who in server client; do
    openssl req -newkey rsa:2048 -nodes -subj "/CN=localhost" -keyout "$who.key" -out "$who.csr" 2>/dev/null
    printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\n' > "$who.ext"
    openssl x509 -req -in "$who.csr" -CA ca.crt -CAkey ca.key -CAcreateserial -days 2 -extfile "$who.ext" -out "$who.crt" 2>/dev/null
  done
  chmod 644 ./*.crt ./*.key
)
docker run -d --rm --name rcsrv-tls --network host -v "$TLS_DIR:/tls:ro" -e P="$P" -e ACL="$ACL" redis:8 \
  sh -c 'printf "%s\n" "$ACL" | sed "s/\$P/$P/g" > /tmp/users.acl && exec redis-server --port 0 --tls-port 6428 --bind 127.0.0.1 --save "" --appendonly no --tls-cert-file /tls/server.crt --tls-key-file /tls/server.key --tls-ca-cert-file /tls/ca.crt --tls-auth-clients yes --aclfile /tmp/users.acl' >/dev/null
echo "topology up: cluster 127.0.0.1:6420-6422, sentinel 127.0.0.1:6427 (master mymaster @ 6426), mTLS 127.0.0.1:6428 (certs in $TLS_DIR)"
