# Installing Redis Console

This guide takes you from nothing to a hardened deployment on any server. For day-2 work (the full configuration
reference, secret rotation, restore, upgrades in detail, SIEM alerts) see [OPERATIONS.md](OPERATIONS.md). To find out
why the product works the way it does, see [DECISIONS.md](DECISIONS.md).

The steps in this guide were run on 2026-10-24 against commit `4875d5f` (the `v0.2` code plus documentation). [What was verified](#appendix-what-was-verified)
lists exactly what was run and what was only reviewed.

- [1. What you are deploying](#1-what-you-are-deploying)
- [2. Requirements](#2-requirements)
- [3. Get the image](#3-get-the-image)
- [4. Generate the secrets](#4-generate-the-secrets)
- [5. Create the Redis ACL users](#5-create-the-redis-acl-users)
- [6. Write the configuration](#6-write-the-configuration)
- [7. Run it](#7-run-it) (Docker, Docker Compose, Kubernetes, Node 24 with systemd)
- [8. Put a TLS reverse proxy in front](#8-put-a-tls-reverse-proxy-in-front)
- [9. Connect your identity provider](#9-connect-your-identity-provider)
- [10. Local accounts and TOTP](#10-local-accounts-and-totp)
- [11. First sign-in](#11-first-sign-in)
- [12. Health, backups, upgrades and logs](#12-health-backups-upgrades-and-logs)
- [13. Hardening checklist](#13-hardening-checklist)
- [14. Troubleshooting](#14-troubleshooting)

---

## 1. What you are deploying

One Node.js process serves the API and the built web app from **one origin**. It is the only component that holds
Redis credentials or talks to Redis. It keeps local users, sessions and the audit log in one SQLite file in its
**data directory**.

```
browser ──HTTPS──▶ reverse proxy (TLS) ──HTTP──▶ redis-console :4000 ──TLS──▶ Redis (one ACL user per role)
                                                   │
                                                   ├── /data/rconsole.sqlite  (users, sessions, audit)
                                                   └── HTTPS ──▶ OIDC issuer (optional)
```

- **Run exactly one replica per data directory.** SQLite, the rate limiters and the confirmation tokens are local to
  the process. High availability means "restart quickly" plus backups.
- The browser never chooses a Redis host. Databases exist only in the server configuration.
- With `NODE_ENV=production` (the image default), the server refuses to start on unsafe settings. It lists every
  problem and exits with status 78.

## 2. Requirements

| | |
|---|---|
| Runtime | Docker or another OCI runtime, Kubernetes, or Node.js **24.11 or later** on Linux. Building from source needs pnpm 11.7.0 (through corepack). |
| Memory and CPU | 256 MiB requested, 768 MiB limit and 1 CPU are the shipped defaults (the image sets `--max-old-space-size=512`). |
| Disk | A small persistent volume for the data directory (the Kubernetes example asks for 2 GiB). |
| Redis | Redis 6 or later (ACL users and RESP3). Developed and tested with Redis 8; also used read-only against a Redis 7.2 server. Modules (Search, JSON, TimeSeries, Bloom) are optional; Redis 8 includes them. Standalone, Cluster and Sentinel are supported. |
| TLS | A DNS name and a TLS-terminating reverse proxy or ingress. Production requires an `https://` public URL. |
| Sign-in | An OIDC identity provider (Keycloak, Entra ID, Okta, Google through a broker, …), local accounts with TOTP, or both. |
| Network | Outbound access from the server to Redis and the OIDC issuer only. Nothing else is contacted at runtime: there is no telemetry. |

## 3. Get the image

Each release is published to GitHub Container Registry for `linux/amd64` and `linux/arm64`, with an SBOM and a signed
build provenance attestation:

```bash
docker pull ghcr.io/saibarathr/redis-console:0.3.0
# optional: check that the image was built by this repository's release workflow
gh attestation verify oci://ghcr.io/saibarathr/redis-console:0.3.0 --repo SaiBarathR/redis-console
```

Tags: the exact version (`0.3.0`), the minor line (`0.3`) and `latest`. In production, pin the digest that
`docker pull` printed (`ghcr.io/saibarathr/redis-console@sha256:…`).

Or build it yourself from a checkout of the release tag:

```bash
git clone https://github.com/SaiBarathR/redis-console.git
cd redis-console
git checkout v0.3
docker build -t redis-console:0.3.0 .
```

The `Dockerfile` is multi-stage. The final stage is `node:24-slim` without npm, corepack or yarn. It runs as the
`node` user (uid 1000), works with a read-only root filesystem (only `/data` is written), has a `HEALTHCHECK` on
`/healthz`, and runs the TypeScript sources directly on Node's type stripping, so there is no transpiled bundle.
Image defaults: `NODE_ENV=production`, `RCONSOLE_CONFIG=/etc/rconsole/config.json`, `RCONSOLE_DATA_DIR=/data`,
`NODE_OPTIONS="--disable-proto=throw --max-old-space-size=512"`, port 4000. The licence (`/app/LICENSE`, `/app/NOTICE`)
and the notices of every third-party package and font it redistributes (`/app/THIRD-PARTY-NOTICES`) are in the image;
the app also serves the notices at `/THIRD-PARTY-NOTICES.txt`, linked from *Account → About*.

For reproducible builds, pin the base image by digest (`--build-arg NODE_IMAGE=node:24-slim@sha256:…`) and push the
result to your registry by digest.

## 4. Generate the secrets

Every secret in the configuration is a **reference**, never a value:

```json
{ "file": "/run/secrets/name" }   // read from a file; one trailing newline is removed
{ "env": "VARIABLE_NAME" }        // read from the environment
```

A plain string where a secret is expected stops the server. Secrets are read once at startup, so changing one means
a restart.

| Secret | Needed when | Generate with |
|---|---|---|
| `redis_viewer_password`, `redis_operator_password`, `redis_admin_password` | One per Redis ACL user you create (section 5). | `openssl rand -hex 24` |
| `totp_encryption_key` | Local accounts are enabled. At least 32 characters. **Keep it stable and back it up separately from the data directory** (section 10). | `openssl rand -hex 32` |
| `bootstrap_admin_password` | You want a first local admin. At least 12 characters. Used only when no local user exists yet. | `openssl rand -base64 24` |
| `oidc_client_secret` | OIDC is enabled. Comes from your identity provider. | (from the IdP) |
| Redis TLS material (`ca`, `cert`, `key`) | Your Redis uses a private CA or mutual TLS. PEM, as secret references. | (from your PKI) |

There is no session-signing secret. Session IDs are 256 random bits and only their SHA-256 is stored, so nothing
needs a server-wide key.

Example layout for Docker or systemd:

```bash
S=/etc/redis-console/secrets
sudo install -d -m 0750 "$S"
for s in redis_viewer_password redis_operator_password redis_admin_password; do
  openssl rand -hex 24 | tr -d '\n' | sudo tee "$S/$s" >/dev/null
done
openssl rand -hex 32 | tr -d '\n' | sudo tee "$S/totp_encryption_key" >/dev/null
openssl rand -base64 24 | tr -d '\n' | sudo tee "$S/bootstrap_admin_password" >/dev/null
sudo chown -R 1000:1000 "$S" && sudo chmod 0400 "$S"/*   # Docker: readable by the container user (uid 1000) only
```

For systemd (section 7.4) use `sudo chown -R root:rconsole "$S" && sudo chmod 0440 "$S"/*` instead.

Store a second copy of `totp_encryption_key` in your secret manager, apart from any backup of the data directory.

## 5. Create the Redis ACL users

The server checks every command against its own policy. It also connects to Redis as a **different ACL user for each
role**, so Redis enforces the same limits a second time, even if the application had a bug. Production databases
(`environment: "prod"`) must have their own ACL user for every role they allow (`maxRole`); the server refuses to start
otherwise.

Run these as an administrative Redis user (`redis-cli`, interactive). `#<sha256>` stores only the SHA-256 of the
password; compute it with `printf '%s' "$PASSWORD" | openssl dgst -sha256 | awk '{print $NF}'`.

```
ACL SETUSER rc-viewer on #<viewer-sha256> resetkeys ~* resetchannels &* -@all +@read +@connection -@dangerous -keys +info +slowlog|get +memory|usage +command|docs +command|info +command|count +command|list +pubsub|channels +pubsub|numsub +pubsub|numpat +subscribe +psubscribe +unsubscribe +punsubscribe +ssubscribe +sunsubscribe +ping +ft._list +ft.info +vcard +vdim +vemb +vgetattr +vinfo +vismember +vlinks +vrandmember +vrange +vsim

ACL SETUSER rc-operator on #<operator-sha256> resetkeys ~* resetchannels &* -@all +@read +@write +@pubsub +@connection +@transaction -@dangerous -@scripting -keys +info +slowlog|get +memory|usage +command|docs +command|info +command|count +command|list +ping +ft._list +ft.info +vcard +vdim +vemb +vgetattr +vinfo +vismember +vlinks +vrandmember +vrange +vsim +vadd +vrem +vsetattr

ACL SETUSER rc-admin on #<admin-sha256> resetkeys ~* resetchannels &* +@all -@scripting -module -keys -debug -shutdown -replicaof -slaveof -failover -migrate -sync -psync -flushall -save -bgrewriteaof -acl|setuser -acl|deluser -acl|save -acl|load -acl|dryrun -config|set -config|rewrite -config|resetstat -cluster|reset -cluster|failover
```

Then persist them: `ACL SAVE` if Redis uses an `aclfile`, otherwise `CONFIG REWRITE`. In an `aclfile` the same rules
start with `user` instead of `ACL SETUSER` (the sandbox uses `infra/redis/users.acl.template`). Managed services
(ElastiCache, Azure Cache, Redis Cloud, Memorystore) support ACL users, sometimes through their own "user group" or
"RBAC role" screens; recreate the same rules there.

What the rules do:

| Fragment | Why |
|---|---|
| `resetkeys ~*`, `resetchannels &*` | All keys and channels. **Narrow these** to the prefixes the console should see, for example `~app:cache:* ~app:session:*`. |
| `-@all` then `+@read` (viewer) | Start from nothing; allow read-only data commands (GET, HGETALL, SCAN, XRANGE, FT.SEARCH, …). |
| `+@write`, `+@pubsub` (operator) | Data changes and PUBLISH. |
| `+@transaction` (operator) | WATCH, MULTI, EXEC. The server uses them for **compare-and-set edits**: a value edit, rename or delete from the key inspector is checked against what the editor read, in one transaction. Without it those edits fail closed with 403 and a hint; other writes keep working. Users still cannot type MULTI/EXEC/WATCH in the console. |
| `+@connection`, `+ping` | AUTH, HELLO, CLIENT SETNAME and similar, which the client library needs. |
| `-@dangerous`, `-@scripting`, `-keys` | No FLUSHALL, CONFIG, DEBUG, MONITOR, KEYS, CLIENT KILL; no Lua or Functions (a script could bypass per-command rules). Placed after the `+` categories, so they win. |
| `+info +slowlog\|get +memory\|usage +command\|…` | Puts back the few introspection commands the dashboard, slow log, key sizes and autocomplete need. `cmd\|sub` allows one subcommand. |
| `+ft._list +ft.info` | Lets viewers and operators list and describe Search indexes (`FT._LIST` is in Redis's `@admin` category). Leave out if you don't use Search. |
| `+vcard +vdim … +vsim`, `+vadd +vrem +vsetattr` (operator) | Vector sets (Redis 8): their commands have no ACL category, so `+@read` and `+@write` do not include them. Viewers get the reads the vector-set inspector uses; operators also add, remove and set attributes. Leave out if you don't use vector sets. |
| `+subscribe +psubscribe …` (viewer) | Viewers can watch Pub/Sub but not publish. |
| `+@all -@scripting -module …` (admin) | Introspection and maintenance (CONFIG GET, CLIENT LIST/KILL, SLOWLOG RESET, FLUSHDB, MONITOR for the profiler, FT.CREATE/FT.DROPINDEX) without anything that escapes Redis or changes topology, persistence or ACLs. |

Arrays (Redis 8.8 and later, v0.4) need no extra grant: the AR* commands are in `@array` plus `@read` (ARGET,
ARSCAN, ARGREP, AROP, ARINFO, …) or `@write` (ARSET, ARINSERT, ARDEL, ARDELRANGE, ARRING, ARSEEK, ARMSET), and none
is in `@dangerous`, so viewers read arrays and operators change them with the lines above. The inspector's
compare-and-set edits and guarded appends use `+@transaction` like the other edits. To keep a tier away from arrays,
add `-@array` after its `+` categories.

Optional grants (verified on Redis 8):

- **Operators creating Search indexes** ("Make searchable", the index wizard): add `+ft.create` to `rc-operator`.
  Without it the wizard shows Redis's `NOPERM` and nothing is created. Dropping an index stays admin-only.
- **Explain** in the Search tool: add `+ft.explain +ft.explaincli` to viewer and operator. Profile works without it.
- **Cluster mode**: add `+cluster|slots +cluster|shards +cluster|nodes +cluster|info` to viewer and operator so the
  client can discover the topology (admin has them through `+@all`).

For a production database, configure only the tiers you need and cap the role with `maxRole`. A tier without
credentials cannot use that database at all (503); a role never falls back to another tier's user.

### Optional FalkorDB graph sandbox and ACLs

The development compose includes `redis-graph` on loopback port 6413, pinned to `falkordb/falkordb:6.0.3`.
`scripts/dev-setup.sh` generates its separate ACL/config files and starts it in CI. On a shared installation,
generate only those files with `bash scripts/graph-sandbox-config.sh`, then start only `redis-graph` with compose.
Never run the full setup merely to add this service to an existing shared sandbox: setup recreates all services.
The graph container uses a read-only root filesystem and ephemeral `/data` and `/tmp`; it bypasses the image's
launcher (which ignores the supplied command) and starts `redis-server` directly as uid 999 with our config.

Graph commands have **no ACL categories**. On FalkorDB, add these explicit grants to the respective tier's base
ACL (omit unrelated module grants, such as `+ft._list`, when that command is absent):

| Tier | Graph grants |
|---|---|
| viewer | `+graph.ro_query +graph.explain +graph.list +graph.info\|objectpool +graph.memory\|usage` |
| operator | The viewer grants plus `+graph.query +graph.profile` |
| admin | The operator grants plus `+graph.delete +graph.slowlog`; for CONFIG use `-graph.config +graph.config\|get` |

The graph sandbox admin starts with the usual restricted `+@all`, then explicitly removes `graph.udf`, `graph.bulk`,
`graph.restore`, `graph.debug`, `graph.effect`, `graph.record`, `graph.copy`, `graph.constraint` and `graph.config`,
adding back only `graph.config|get`. INFO and MEMORY grants are similarly restricted to ObjectPool and USAGE. Redis 8.10.2 accepts this first-argument ACL restriction but warns that it is
deprecated. Revalidate on upgrades; if it is removed, deny CONFIG entirely at the ACL and keep configuration
inspection outside the console. Never grant the whole command just to restore GET access.

The sandbox sets `TIMEOUT_DEFAULT 1000 TIMEOUT_MAX 1000 RESULTSET_SIZE 10000 MAX_QUEUED_QUERIES 25` on module load.
The legacy `TIMEOUT` setting cannot coexist with DEFAULT/MAX and does not bound write queries; use DEFAULT/MAX.
Configure equivalent engine bounds on deployed graph servers: closing a console socket alone does not cancel Redis
work. The application adds a positive timeout of at most 1000 ms to QUERY/RO_QUERY/EXPLAIN/PROFILE. The sandbox's
module cap also covers other clients. No graph importer, UDF, CSV loader or runtime network access is exposed by
the console. See [D21](DECISIONS.md#d21-falkordb-queries-are-bounded-and-cannot-run-host-io-or-user-code).

## 6. Write the configuration

One JSON file, validated strictly at startup: unknown fields, inline secrets, credentials in URLs and unsafe
production settings stop the server with a list of every problem. This is a complete, minimal production config
(OIDC plus local accounts, one production database); it passes the production checks as written:

```json
{
  "server": {
    "host": "0.0.0.0",
    "port": 4000,
    "publicUrl": "https://redis-console.example.com",
    "trustProxy": "172.18.0.1",
    "dataDir": "/data"
  },
  "auth": {
    "oidc": {
      "enabled": true,
      "issuer": "https://login.example.com/realms/company",
      "clientId": "redis-console",
      "clientSecret": { "file": "/run/secrets/oidc_client_secret" },
      "roleMapping": {
        "redis-console-admins": "admin",
        "redis-console-operators": "operator",
        "redis-console-viewers": "viewer"
      }
    },
    "local": {
      "enabled": true,
      "requireTotpForRoles": ["admin", "operator"],
      "bootstrapAdmin": { "username": "admin", "password": { "file": "/run/secrets/bootstrap_admin_password" } },
      "totpEncryptionKey": { "file": "/run/secrets/totp_encryption_key" }
    }
  },
  "databases": [
    {
      "id": "orders-prod",
      "name": "Orders (prod)",
      "environment": "prod",
      "maxRole": "operator",
      "url": "rediss://orders-redis.internal.example.com:6380",
      "tls": { "ca": { "file": "/run/secrets/redis_ca.pem" } },
      "credentials": {
        "viewer":   { "username": "rc-viewer",   "password": { "file": "/run/secrets/redis_viewer_password" } },
        "operator": { "username": "rc-operator", "password": { "file": "/run/secrets/redis_operator_password" } }
      }
    }
  ]
}
```

| Field | Why it is set this way |
|---|---|
| `server.host` `0.0.0.0` | Listen on all interfaces inside the container. On a plain host behind a local proxy, use `127.0.0.1`. |
| `server.publicUrl` | The exact origin users type, without a path. It is the only `Origin` accepted on state-changing requests, the cookie scope and the base of the OIDC redirect URI. Must be `https://` in production. |
| `server.trustProxy` | Who may supply `X-Forwarded-For` (section 8): the number of proxies in front (`1`) when nothing else can reach the port, or the proxy's address **as the server sees it**, as here. Never `true`. |
| `server.dataDir` | Where `rconsole.sqlite` lives (created with mode 0600 in a 0700 directory). `RCONSOLE_DATA_DIR` overrides it. |
| `secureCookies` (default `true`) | The cookie is `__Host-rc_session`: `Secure`, `HttpOnly`, `SameSite=Strict`. Required in production. |
| `auth.oidc.roleMapping` | Group → role. The highest matching role wins. **A user in no mapped group is refused.** |
| `auth.local.requireTotpForRoles` | Every role that can write should need TOTP. The default is `["admin"]`. |
| `databases[].environment` `prod` | Every write asks for the typed database name and a reason (audited); FLUSHDB and the profiler are refused. In production the database must use TLS and per-role ACL users. |
| `databases[].maxRole` `operator` | Effective role = min(user role, `maxRole`). Admins act as operators here, and no admin ACL user is needed. |
| `databases[].url` | `redis://` or `rediss://` host and port only: no user, password, path or query. Use `db` for the logical database. |
| `databases[].tls.ca` | Only for a private CA. Certificate verification cannot be turned off for prod databases or in production. |

Add `"readOnly": true` (with `"maxRole": "viewer"` and only a viewer ACL user) for databases that must never be written:
writes are then refused by the policy, by `readOnly` and by Redis. Cluster (`"mode": "cluster"`, `nodes`) and Sentinel
(`"mode": "sentinel"`, `sentinels`, `masterName`) are described in the
[configuration reference](OPERATIONS.md#2-configuration-reference), together with every limit under `policy` and the
reviewed exceptions in `acceptRisks`. More examples: `deploy/config.prod.example.json`, `deploy/k8s/configmap.yaml`.

## 7. Run it

### 7.1 Docker

```bash
docker volume create redis-console-data
docker run -d --name redis-console --restart unless-stopped \
  --read-only --tmpfs /tmp:size=16m,mode=1777 \
  --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges:true \
  --memory 768m --pids-limit 256 \
  -p 127.0.0.1:4000:4000 \
  -v /etc/redis-console/config.json:/etc/rconsole/config.json:ro \
  -v /etc/redis-console/secrets:/run/secrets:ro \
  -v redis-console-data:/data \
  ghcr.io/saibarathr/redis-console:0.3.0
docker logs redis-console     # "Redis Console listening on 0.0.0.0:4000 (public URL https://…)"
```

The port is published on `127.0.0.1` only; the reverse proxy (section 8) is the only way in.

### 7.2 Docker Compose

`deploy/docker-compose.example.yml` does the same with Docker secrets:

```bash
mkdir -p /srv/redis-console/secrets && cd /srv/redis-console
cp <checkout>/deploy/docker-compose.example.yml docker-compose.yml
cp <checkout>/deploy/config.prod.example.json config.prod.json    # then edit it (section 6)
# put one file per secret in ./secrets: oidc_client_secret, redis_viewer_password, redis_operator_password,
# redis_admin_password, bootstrap_admin_password, totp_encryption_key (section 4)
# image: is the published release; pin its digest, or use your own build
docker compose up -d
```

It runs read-only as uid 1000 with all capabilities dropped and `no-new-privileges`, mounts the secrets at
`/run/secrets/<name>` (which the config references), keeps `/data` in a named volume, limits memory to 768 MiB and
publishes `127.0.0.1:4000`. Every secret listed under `secrets:` must exist as a file, even if your config doesn't
use it (remove the entry instead). The example config sets `"trustProxy": 1`: one reverse proxy in front, which is the
only way in because the port is published on `127.0.0.1`. If other hosts or containers can reach port 4000, use the
proxy's address instead (section 8).

### 7.3 Kubernetes

`deploy/k8s/` is a kustomization:

| File | Contents |
|---|---|
| `namespace.yaml` | Namespace `rconsole` with the **restricted** Pod Security Standard enforced. |
| `configmap.yaml` | The config file; secrets are referenced as files under `/run/secrets/rconsole/`. |
| `secret.example.yaml` | The shape of the `rconsole-secrets` Secret. Not part of the kustomization: render it from your secret store (External Secrets, Vault CSI, Sealed Secrets). |
| `deployment.yaml` | One replica, `Recreate` strategy, uid/gid 1000, read-only root filesystem, all capabilities dropped, `RuntimeDefault` seccomp, no service account token, Secret mounted read-only with mode 0400, a PVC for `/data`, a memory-backed `/tmp`, liveness `/healthz`, readiness `/readyz`. Also the PVC and the Service. |
| `networkpolicy.yaml` | Default deny; ingress only from the `ingress-nginx` namespace; egress only to DNS, Redis (namespace `data`, ports 6379/6380) and HTTPS outside private ranges (the IdP), with the cloud metadata address excluded. |
| `ingress.yaml` | TLS ingress for ingress-nginx: proxy buffering off and a 960 s read timeout (Server-Sent Events), body limit 13 MB (just above the server's 12 MiB). |

```bash
kubectl create namespace rconsole --dry-run=client -o yaml | kubectl apply -f -   # or let the kustomization create it
kubectl -n rconsole create secret generic rconsole-secrets \
  --from-file=oidc_client_secret=… --from-file=redis_viewer_password=… --from-file=redis_operator_password=… \
  --from-file=redis_admin_password=… --from-file=bootstrap_admin_password=… --from-file=totp_encryption_key=…
# edit deploy/k8s/configmap.yaml (section 6), the image in deployment.yaml (pin by digest),
# the host in ingress.yaml, and the Redis/IdP rules in networkpolicy.yaml
kubectl apply -k deploy/k8s
kubectl -n rconsole rollout status deploy/rconsole
```

The ConfigMap sets `"trustProxy": 1`: the ingress controller is the one proxy in front, and the NetworkPolicy admits
only the `ingress-nginx` namespace, so no other client can reach the pod with its own `X-Forwarded-For`. If a load
balancer in front of the ingress controller also appends to the header, use `2`; or set the ingress controller pods'
CIDR (for example `"10.244.0.0/16"`). The `redis-ca` ConfigMap mounted at `/etc/rconsole/tls` is optional.

### 7.4 Node 24 with systemd

On a Linux host with Node.js 24.11 or later:

```bash
sudo useradd --system --home /var/lib/redis-console --shell /usr/sbin/nologin rconsole
sudo git clone https://github.com/SaiBarathR/redis-console.git /opt/redis-console
cd /opt/redis-console && sudo git checkout v0.3
sudo corepack enable && sudo corepack prepare pnpm@11.7.0 --activate
sudo pnpm install --frozen-lockfile
sudo pnpm --filter @rconsole/web build              # writes apps/web/dist, served by the server
sudo install -d -m 0750 -o root -g rconsole /etc/redis-console /etc/redis-console/secrets
# config: /etc/redis-console/config.json with "host": "127.0.0.1" and "dataDir": "/var/lib/redis-console"
# secrets: /etc/redis-console/secrets/*, owned root:rconsole, mode 0440
```

Run it from the checkout: the server imports `@rconsole/shared` through the workspace link and runs the TypeScript
sources directly. `/etc/systemd/system/redis-console.service`:

```ini
[Unit]
Description=Redis Console
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=rconsole
Group=rconsole
WorkingDirectory=/opt/redis-console
Environment=NODE_ENV=production
Environment=RCONSOLE_CONFIG=/etc/redis-console/config.json
Environment="NODE_OPTIONS=--disable-proto=throw --max-old-space-size=512"
# Only if the config uses { "env": … } references (KEY=value lines, mode 0400):
# EnvironmentFile=/etc/redis-console/secrets.env
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning apps/server/src/main.ts
Restart=on-failure
# 78 = invalid configuration: restarting will not help
RestartPreventExitStatus=78
StateDirectory=redis-console
StateDirectoryMode=0700
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
RestrictNamespaces=yes
LockPersonality=yes
CapabilityBoundingSet=
SystemCallArchitectures=native

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now redis-console
journalctl -u redis-console -f
```

Adjust the `node` path to your installation. Do not add `MemoryDenyWriteExecute=yes`: V8's JIT needs it off.

## 8. Put a TLS reverse proxy in front

The proxy must:

- terminate TLS (1.2 or later) for the `publicUrl` host and forward to port 4000;
- **not buffer** `text/event-stream` responses and keep them open for at least 16 minutes (live metrics, Pub/Sub,
  which closes after 15 minutes, and the profiler use Server-Sent Events);
- allow request bodies up to 13 MB (the server's limit is 12 MiB);
- leave `Origin`, the response headers (CSP with a per-request nonce, COOP, CORP, HSTS, …) and cookies alone, and add
  no CORS headers;
- set `X-Forwarded-For` to the client address. The server never needs request bodies logged, and it never puts Redis
  data in URLs, so default access logs are safe; don't turn on body logging in the proxy, WAF or APM agent.

### Setting `trustProxy`

`server.trustProxy` tells the server which peer may supply `X-Forwarded-For`. Get it right, or every user appears to
come from the proxy: the audit log loses client addresses, and everyone shares the per-address limits (10 sign-ins per
minute, 100 requests per second). There are two ways to set it:

- **A hop count**: the number of proxies in front of the server that add to `X-Forwarded-For` (`1` for one reverse
  proxy or ingress controller, `2` for a load balancer in front of it, at most 5 in production). The client address
  is that many entries from the right, as in Express and Fastify's documentation; anything a client wrote further left
  is ignored. A hop count cannot tell the proxy from a direct client, so use it **only when nothing but the proxy can
  reach the server's port**: the Docker examples publish `127.0.0.1:4000` only, and the Kubernetes NetworkPolicy
  admits only the ingress controller. The `deploy/` examples use `1`. Count exactly: one too few records a proxy's
  address for everyone, one too many lets clients choose their address again.
- **The proxy's address as the server sees it**: an IP, a narrow CIDR (IPv4 /8 or longer, IPv6 /16 or longer), or one
  of the aliases `loopback`, `linklocal`, `uniquelocal`. This is stricter: `X-Forwarded-For` from any other peer is
  ignored, so it is also safe when other hosts or containers can reach the port. For a proxy on the same host talking
  to `127.0.0.1:4000` without Docker in between, use `"loopback"`. To find the address: start with
  `"trustProxy": false`, sign in once through the proxy, and read the `ip` of the `auth.login` audit line
  (`docker logs redis-console | grep '"audit":true'`). That is the proxy as the server sees it, for example the Docker
  bridge gateway `172.18.0.1`.

`true` is refused in production: it lets any client choose its own address. Either way, check the result: sign in
through the proxy and the `auth.login` audit line shows your own address.

### Caddy

```caddyfile
redis-console.example.com {
	request_body {
		max_size 13MB
	}
	reverse_proxy 127.0.0.1:4000
}
```

Caddy obtains and renews the certificate itself, flushes Server-Sent Events immediately and replaces any
client-supplied `X-Forwarded-For` with the real client address.

### nginx

```nginx
server {
    listen 80;
    server_name redis-console.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    http2 on;
    server_name redis-console.example.com;

    ssl_certificate     /etc/ssl/redis-console/fullchain.pem;
    ssl_certificate_key /etc/ssl/redis-console/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    client_max_body_size 13m;               # the server's limit is 12 MiB

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Connection "";
        proxy_set_header X-Forwarded-For $remote_addr;    # overwrite, don't append
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;                 # Server-Sent Events
        proxy_read_timeout 960s;             # Pub/Sub streams last up to 15 minutes
    }
}
```

Don't add `add_header` lines for CSP, HSTS or framing: the server already sends them, with a fresh nonce per request.

## 9. Connect your identity provider

Register Redis Console as a **confidential web application** with the authorization code flow and PKCE:

| Setting | Value |
|---|---|
| Redirect URI | `<publicUrl>/api/v1/auth/oidc/callback`, e.g. `https://redis-console.example.com/api/v1/auth/oidc/callback` |
| Post-logout redirect URI (only with `"rpInitiatedLogout": true`) | `<publicUrl>/` |
| Scopes | `openid profile email` (`openid` is required) |
| Client authentication | Client secret (`client_secret_basic`) |
| Groups | A claim (default `groups`) in the ID token or userinfo, holding group names or IDs |

The server does code + PKCE (S256) + state + nonce, binds the flow to the browser with a 10-minute `rc_oidc` cookie,
and never gives tokens to the browser. Groups are read at sign-in only: someone removed from a group keeps their role
until their session ends, so consider `auth.oidc.sessionTtlMinutes` (for example 240). Create three groups (or app
roles), such as `redis-console-viewers`, `redis-console-operators` and `redis-console-admins`, and map them in
`roleMapping`.

### Keycloak

1. **Clients → Create client**, OpenID Connect. *Client authentication: On*. Standard flow only (turn off direct
   access grants and implicit flow). Valid redirect URI as above. **Advanced → Proof Key for Code Exchange Code
   Challenge Method: S256.**
2. **Client scopes → `<client>-dedicated` → Add mapper → By configuration → Group Membership.** Token claim name
   `groups`, *Full group path: Off* (a leading `/` is ignored anyway). Add to the ID token, the access token and userinfo.
3. Create the groups and add people.
4. `"issuer": "https://keycloak.example.com/realms/<realm>"`, `"groupsClaim": "groups"`, `roleMapping` by group name.

The development sandbox (`infra/keycloak/realm-rconsole.template.json`) is a working example.

### Microsoft Entra ID

1. **App registrations → New registration**, platform *Web*, redirect URI as above.
2. **Certificates & secrets → New client secret**; store it as `oidc_client_secret`.
3. **Token configuration → Add groups claim → Security groups**, ID token: *Group ID*. Entra sends group **object
   IDs**, so map those:
   ```json
   "issuer": "https://login.microsoftonline.com/<tenant-id>/v2.0",
   "groupsClaim": "groups",
   "roleMapping": { "<admins-group-object-id>": "admin", "<operators-group-object-id>": "operator", "<viewers-group-object-id>": "viewer" }
   ```
   Users in more than 200 groups get a "groups overage" claim instead of the list. Avoid it by assigning the groups
   to the application (*Enterprise applications → Properties → Assignment required*, and *Groups assigned to the
   application* in the token configuration), or use **app roles**: define `admin`, `operator`, `viewer`, assign groups
   to them, and set `"groupsClaim": "roles"`, `"roleMapping": { "admin": "admin", "operator": "operator", "viewer": "viewer" }`.

### Okta

1. **Applications → Create App Integration → OIDC → Web Application**, grant type *Authorization Code*, sign-in
   redirect URI as above, **Require PKCE** on.
2. **Sign On → OpenID Connect ID Token → Groups claim**: type *Filter*, name `groups`, *Starts with*
   `redis-console-` (with a custom authorization server, add a `groups` claim there instead).
3. `"issuer": "https://<org>.okta.com/oauth2/default"` (or `https://<org>.okta.com` for the org authorization
   server), `"groupsClaim": "groups"`, `roleMapping` by group name.

### Google

Google's ID tokens carry **no groups claim**. Two options:

- **One role for a whole Workspace domain.** Create an OAuth client (*Web application*, redirect URI as above) and
  set `"issuer": "https://accounts.google.com"`, `"groupsClaim": "hd"`, `"roleMapping": { "example.com": "viewer" }`.
  The hosted-domain claim is treated as a single group; personal Google accounts have no `hd` and are refused.
- **Per-group roles.** Put a broker in front that can read Google groups (Keycloak with Google as an identity
  provider, or Dex with its Google connector) and point Redis Console at the broker as above.

### Verify

Sign in with one user per group; the top bar shows the role. A user in no mapped group lands on
`/login?error=oidc_no_role` ("Your company account has no Redis Console role"). `auth.oidc` / `auth.login` events appear in the
audit log. `/readyz` reports `"oidc": "error"` once an OIDC discovery attempt has failed (discovery runs on first use;
readiness itself stays up, so local accounts keep working).

## 10. Local accounts and TOTP

Local accounts are for break-glass access, small teams and service owners outside the IdP.

- Passwords are hashed with argon2id (`node:crypto`). Unknown usernames take the same time as known ones; errors are
  generic. Five failures within 15 minutes lock an account for 15 minutes (`auth.local.lockout`; failed TOTP codes count too); sign-in is also limited per client
  address and globally.
- Roles listed in `requireTotpForRoles` must enroll an authenticator (RFC 6238, replay-protected) before they can do
  anything else. Set it to `["admin", "operator"]`.
- Admins manage accounts under **Admin → Users**. Resetting a password or TOTP, changing a role and disabling an
  account each revoke that user's sessions.

**TOTP seeds are encrypted at rest** with AES-256-GCM under a key derived (HKDF-SHA256) from
`auth.local.totpEncryptionKey`, with the user id bound in. Seeds stored in clear text by older versions are encrypted at
startup. **If any stored seed cannot be decrypted with the configured key, the server refuses to start** (exit status
78, "… local user(s) have a stored TOTP seed that no key of the TOTP key ring can decrypt …"). This is deliberate (see
[DECISIONS.md](DECISIONS.md#d07-oidc-plus-local-accounts-with-totp-seeds-encrypted-at-rest)): restore the right key,
or run `admin reset-totp` so the affected users re-enroll ([OPERATIONS.md § 6a](OPERATIONS.md#6a-totp-keys-and-recovery)). So keep the key
stable, and back it up apart from the data directory.

Companions that keep this operable:

- **Key ring:** `auth.local.totpEncryptionKeys: [{ "id": "2026-10", "secret": { "file": … } }, …]` plus
  `auth.local.totpPrimaryKeyId`. New seeds use the primary key; retired keys only decrypt, and seeds are re-encrypted to
  the primary key at startup, so rotating the key never forces re-enrollment. The single `totpEncryptionKey` keeps working
  as the key `default`. Rotation step by step: [OPERATIONS.md § 6a](OPERATIONS.md#6a-totp-keys-and-recovery).
- **Recovery codes:** every local user with TOTP gets ten single-use codes at enrollment (shown once, stored as argon2id
  hashes). *Use a recovery code* at sign-in accepts one; Account shows how many are left and generates a new set.
- **Break-glass CLI** on the server host, without HTTP: `node apps/server/src/cli/admin.ts status`,
  `reset-totp --user <name>`, `reset-totp --all --yes`, `rotate-totp-key` (in a container:
  `docker exec <container> node apps/server/src/cli/admin.ts …`). `status` and `reset-totp` need no key, so a lost key
  is always recoverable: reset, then the affected users re-enroll. Every action is audited.

## 11. First sign-in

1. Open `https://redis-console.example.com`. With local accounts and a `bootstrapAdmin`, the first start created that
   account (audit action `admin.user.bootstrap`). It is created only while no local user exists.
2. Sign in as `admin` with the bootstrap password. Every other API answers 403 until you have **changed the password**
   and then **enrolled TOTP** (scan the QR code, type the code).
3. Check **Databases**: every configured database should say *connected*. `status: error` usually means Redis refused
   the ACL user or TLS failed (section 14).
4. Create named accounts (or rely on OIDC), then remove `bootstrapAdmin` from the config and delete the
   `bootstrap_admin_password` secret.
5. Run `PING` in the Console, open the key browser, and check **Admin → Audit log** shows your actions with redacted
   arguments.

## 12. Health, backups, upgrades and logs

**Health.** `GET /healthz` is liveness (the process serves). `GET /readyz` is readiness: SQLite works and the server
isn't shutting down; it returns 503 otherwise. A Redis database being down never fails readiness: availability is
shown per database in the UI. On SIGTERM the server stops accepting connections, ends streams, closes Redis pools and
SQLite, and exits within 10 seconds.

**Backups.** Back up two things, separately:

1. The **data directory** (`rconsole.sqlite`: local users with password hashes and encrypted TOTP seeds, sessions,
   the audit log). It is safe to copy while running with SQLite's online backup. The image has no `sqlite3`, so use
   Node's:
   ```bash
   docker exec redis-console node -e "require('node:sqlite').backup(new (require('node:sqlite').DatabaseSync)('/data/rconsole.sqlite',{readOnly:true}),'/data/backup.sqlite').then(()=>console.log('ok'))"
   docker cp redis-console:/data/backup.sqlite ./rconsole-$(date +%F).sqlite && docker exec redis-console rm /data/backup.sqlite
   ```
   On a plain host: `sqlite3 /var/lib/redis-console/rconsole.sqlite ".backup '/backup/rconsole-$(date +%F).sqlite'"`.
   Encrypt backups: they contain password hashes and the audit trail.
2. The **keys**: `totp_encryption_key` (without it, enrolled users must re-enroll) and your other secrets, in your
   secret manager. Never store the TOTP key next to the data backup.

Redis data is not stored by Redis Console. Restore and Kubernetes snapshot notes: [OPERATIONS.md](OPERATIONS.md#7-backup-and-restore).

**Upgrades.** Read the release notes, back up the data directory, build or pull the new image (pinned by digest),
start it once against a **copy** of the data and the new config in staging (migrations run automatically at startup
and the config is validated strictly), then replace the running instance. Never run two instances on one data
directory (the Kubernetes example uses `Recreate`). Roll back with the old image and the backup. Details:
[OPERATIONS.md](OPERATIONS.md#8-upgrading).

**Logs.** JSON lines on stdout: operational logs (pino; `LOG_LEVEL`, default `info`) and **audit events** with
`"audit": true`. Neither contains Redis values, passwords, tokens, cookies or session IDs; audit arguments are
redacted (key names become `key#<sha256 prefix>`, values `<n bytes>`). Ship stdout with your log agent and route
`audit == true` to the SIEM. The SQLite copy (what *Admin → Audit log* shows) keeps 365 days by default
(`audit.retentionDays`; `0` keeps everything); the SIEM is the long-term record. Alert ideas and the event format:
[OPERATIONS.md](OPERATIONS.md#9-logs-audit-and-siem).

## 13. Hardening checklist

- [ ] `NODE_ENV=production`; `publicUrl` is `https://`; `secureCookies` is `true`; TLS 1.2+ at the proxy.
- [ ] `trustProxy` is the number of proxies in front (with the app port reachable only through them) or the proxy's address or a narrow CIDR, never `true`. The audit log shows real client addresses.
- [ ] Every secret is a `{file}` or `{env}` reference from a secret store, readable only by the service user.
- [ ] `totp_encryption_key` is random (32 bytes hex), stable, and backed up apart from the data directory.
- [ ] The bootstrap admin password has been changed, and `bootstrapAdmin` plus its secret removed.
- [ ] `requireTotpForRoles` covers every local role that can write.
- [ ] OIDC: each group tested; a user without a group is refused; `sessionTtlMinutes` chosen deliberately.
- [ ] One ACL user per role on every database; key and channel patterns narrowed where possible.
- [ ] Prod databases: `environment: "prod"`, `maxRole` as low as possible, `readOnly` where writes are never needed, `rediss://` with verification, `acceptRisks` empty or each entry reviewed and owned.
- [ ] Container: non-root, read-only root filesystem, all capabilities dropped, memory limit; the image pinned by digest.
- [ ] Network: the app port reachable only from the proxy; egress only to Redis and the IdP (NetworkPolicy or firewall).
- [ ] The proxy doesn't buffer Server-Sent Events, adds no CORS headers and doesn't log request bodies.
- [ ] Backups of the data directory are scheduled, encrypted and restore-tested; audit lines reach the SIEM; `audit.retentionDays` matches your retention policy.

## 14. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Container exits with status 78 and `refusing to start: Invalid configuration` | The config failed validation; every problem is listed. | Fix each line. Common ones: `publicUrl must be https`, `trustProxy=true`, a prod database without TLS (`rediss://`) or without per-role users, an inline secret, credentials in a URL. |
| `cannot read secret file …` / `environment variable … is not set` | Secret missing or not readable by uid 1000. | Check the mount and ownership (`chown 1000`, mode 0400). |
| Exits with status 78 and `have a stored TOTP seed that no key of the TOTP key ring can decrypt` | `totp_encryption_key` changed or lost. | Restore the previous key, or `admin reset-totp` the affected users ([OPERATIONS.md § 6a](OPERATIONS.md#6a-totp-keys-and-recovery)). |
| Exits with status 75 and `… is in use` or `cannot be checked from here` | Another server (or `admin rotate-totp-key`) owns the data directory (`server.lock`). | Stop the other one; never run two servers on one data directory. A stale lock is taken over automatically ([OPERATIONS.md § 1](OPERATIONS.md#1-runtime-facts)). |
| Sign-in or every write fails with 403 `csrf` | The browser's `Origin` isn't `publicUrl`: wrong scheme, host or port, or the proxy rewrites `Origin`. | Make `publicUrl` exactly the URL users open. |
| Signed in, but the next request is 401 | Cookie dropped: `secureCookies` over plain HTTP, or a path/host mismatch. | Serve over HTTPS on the `publicUrl` host. |
| Everyone shares one address in the audit log; sign-in is rate limited for everybody | `trustProxy` is `false`, its hop count is too small, or its address doesn't match the proxy. | See [Setting `trustProxy`](#setting-trustproxy). |
| The audit log shows client addresses that look made up | The hop count is larger than the proxy chain, or clients can reach the app port without the proxy. | Count the proxies exactly, close the port to everything but the proxy, or use the proxy's address. |
| Live metrics, Pub/Sub or the profiler never update | The proxy buffers `text/event-stream`. | `proxy_buffering off` (nginx), no buffering at the load balancer, read timeout ≥ 960 s. |
| A database shows `status: error` | Redis rejected the ACL user (`WRONGPASS`), TLS verification failed, or the network blocks it. | Check the credentials and CA; the server log has the Redis error code. |
| Value edits, renames or deletes in the key inspector give 403 with a hint about transactions | The operator ACL user lacks `+@transaction`. | Add it (section 5). |
| "Make searchable" or Explain answers `NOPERM` | The ACL user lacks `FT.CREATE` / `FT.EXPLAIN`. | Add the optional grants (section 5). |
| SSO returns to `/login?error=oidc_no_role` | No group of the user is in `roleMapping`, or the claim name is wrong. | Check `groupsClaim` and the IdP mapper (Entra: object IDs). |
| SSO returns to `/login?error=oidc_state` | The 10-minute flow cookie expired or the flow was replayed. | Start the sign-in again. |
| 429 with a message naming a limit | A per-user or server-wide budget was full. | Usually transient. Limits are in [OPERATIONS.md](OPERATIONS.md#policy). |
| 413 `too_large` naming `maxReadReplyBytes` | One Redis reply exceeded the wire cap (16 MiB by default). | Read less (ranges, `COUNT`), or raise the cap with the memory budget in mind. |

---

## Appendix: what was verified

Run on 2026-10-24 on macOS (Docker Desktop 29.8, Node 24.14 on the host) against commit `4875d5f`, with a sandbox
Redis 8 on port 6411 that has the three ACL users above. Ports 4900 (app) and 4943 (TLS proxy).

| Step | How it was verified |
|---|---|
| Image build (section 3) | `docker build` succeeded; image 271 MB, runs as uid 1000. |
| Fail-closed config (sections 6, 14) | With `NODE_ENV=production`, each of these exited with status 78 and the quoted message: no config file, `http://` publicUrl, `trustProxy: true`, a plaintext prod database, a prod database with only `default` credentials, a password in the URL, an inline secret. |
| Minimal production config (section 6) | The exact JSON above started in the container (readiness `ready`). |
| Docker run (7.1) | The `docker run` flags above (read-only, uid 1000, caps dropped, tmpfs, named volume, secrets mount), on a user-defined network. |
| Docker Compose (7.2) | `deploy/docker-compose.example.yml` with only the image and published port changed; healthy, bootstrap admin created; removed with `down -v`. |
| Kubernetes (7.3) | `kubectl kustomize deploy/k8s` renders Namespace, ConfigMap, Deployment, PVC, Service, two NetworkPolicies and Ingress. **Not applied to a cluster.** |
| Node 24 (7.4) | `pnpm install --frozen-lockfile`, `pnpm --filter @rconsole/web build`, then `NODE_ENV=production node --env-file=… --disable-warning=ExperimentalWarning apps/server/src/main.ts` behind nginx, with `{env}` and `{file}` secrets and `trustProxy: "loopback"`. **The systemd unit itself was not run** (no systemd on the test host). |
| Caddy and nginx (8) | Both in containers on 4943 in front of the app: `/healthz`, `/readyz`, HSTS and the full CSP through the proxy; Server-Sent Events arrived every 2 s through nginx with `proxy_buffering off`. Caddy used `tls internal` instead of ACME. |
| `trustProxy` (8) | A hop count `1` made the audit log show the proxy's address for every client. The proxy's IP (and `loopback` for the host run) recorded the real client; a spoofed `X-Forwarded-For` sent directly to the app was ignored. **Fixed in v0.3** (`b48d04c`) and re-run with nginx in front: a hop count `1` records the real client, also when the client sends its own `X-Forwarded-For` through the proxy ([qa/v03-follow-ups.md](qa/v03-follow-ups.md)). |
| First sign-in (11) | Through the proxy: foreign `Origin` → 403 `csrf`; bootstrap login sets `__Host-rc_session` (HttpOnly, Secure, SameSite=Strict); APIs answer 403 `password_change_required`; password change rotates the session; TOTP enroll + confirm; database `connected`; `PING`; `SET`; `KEYS *` → 403 `command_blocked`; `DEL` → 428, then 200 with the token; audit entries with redacted arguments; logout → 401. In Chromium through the proxy: sign-in with TOTP, key browser and Console, **no CSP or Trusted Types violations, no page errors**. |
| ACL users (5) | The three `ACL SETUSER` lines on a throwaway Redis 8: viewer reads (incl. FT.SEARCH, FT.PROFILE, `MEMORY USAGE … SAMPLES 5`) but cannot write, WATCH, FT.CREATE or FT.EXPLAIN; operator writes, WATCHes, publishes, creates stream groups, JSON and TimeSeries keys but not FT.CREATE/FT.DROPINDEX, CONFIG or KEYS; admin runs CONFIG GET, CLIENT LIST, FT.CREATE, FT.DROPINDEX but not KEYS, FLUSHALL or EVAL. The optional `+ft.create` and `+ft.explain +ft.explaincli` grants work as described. The `#<sha256>` form authenticates. |
| TOTP key (10) | Starting with a different `totp_encryption_key` exits with status 1 and the quoted message; after clearing the seeds as in OPERATIONS.md the server starts. |
| Backups (12) | The `node:sqlite` online backup inside the read-only container produced a copy that passes `PRAGMA integrity_check`. |
| Health (12) | `/healthz` → `{"status":"ok"}`, `/readyz` → `{"status":"ready",…}`; the container `HEALTHCHECK` reports healthy. |
| Development quick start (README) | Server on the generic sandbox config (port overridden to 4900): SPA served, Keycloak `viewer1` and `operator1` get their roles on all sandbox databases, `nogroup1` is refused. |

**Not verified here:** OIDC in production mode (the sandbox Keycloak is plain HTTP, which production refuses; OIDC is
covered by the end-to-end suite in development mode), Entra ID, Okta and Google, TLS to Redis in production (covered
by the mutual-TLS topology tests), cluster and Sentinel deployments (topology tests only), a real Kubernetes cluster,
systemd, and ACME certificates.
