#!/usr/bin/env bash
# Memoh dev 环境 bootstrap（vultr-sg，与 meimaobing-alpha 生产完全隔离）
# 只绑定 127.0.0.1，公网不可达；iOS 模拟器经 SSH 隧道访问。
set -euo pipefail

BASE=/opt/memoh-dev
SRC="$BASE/src"
SECRETS="$BASE/secrets"
FORK_REPO="${MEMOH_FORK_REPO:-https://github.com/AidenNovak/Memoh.git}"

mkdir -p "$BASE" "$SECRETS"
chmod 700 "$BASE" "$SECRETS"

# 1) 拉取我们的 fork（不动上游）
if [ ! -d "$SRC/.git" ]; then
  git clone --depth 200 "$FORK_REPO" "$SRC"
else
  git -C "$SRC" fetch --depth 200 origin main
fi

if [ ! -f "$SECRETS/ios-push.env" ]; then
  umask 077
  cat > "$SECRETS/ios-push.env" <<'EOF'
MEMOH_BASE_URL=http://server:8080
MEMOH_TEAM_ID=00000000-0000-0000-0000-000000000001
APNS_KEY_PATH=/run/secrets/apns-auth-key.p8
APNS_KEY_ID=5N8C8XNJKB
APNS_TEAM_ID=7533A52C52
APNS_BUNDLE_ID=ai.memoh.ios
PUSH_LISTEN_ADDRESS=:8083
PUSH_POLL_SECONDS=3
EOF
  chmod 600 "$SECRETS/ios-push.env"
  echo "generated $SECRETS/ios-push.env"
fi
git -C "$SRC" log --oneline -1

gen() { openssl rand -hex "${1:-32}"; }

# 2) secrets（只落盘一次，绝不打印）
if [ ! -f "$SECRETS/memoh-dev.env" ]; then
  umask 077
  cat > "$SECRETS/memoh-dev.env" <<EOF
# Memoh dev — generated $(date -u +%Y-%m-%dT%H:%M:%SZ). DO NOT COMMIT.
POSTGRES_PASSWORD=$(gen 24)
MEMOH_INTERNAL_RPC_SHARED_SECRET=$(gen 32)
MEMOH_AGENT_CREDENTIALS_ENCRYPTION_KEY=$(gen 32)
MEMOH_JWT_SECRET=$(gen 32)
MEMOH_ADMIN_PASSWORD=$(gen 16)
MEMOH_SERVER_MEMORY_LIMIT=3g
MEMOH_SERVER_GOMEMLIMIT=2600MiB
EOF
  chmod 600 "$SECRETS/memoh-dev.env"
  echo "generated $SECRETS/memoh-dev.env"
else
  echo "reusing $SECRETS/memoh-dev.env"
fi

set -a
# shellcheck disable=SC1091
. "$SECRETS/memoh-dev.env"
set +a

# 3) config.toml（从上游模板派生，只改必须项）
CP="$BASE/config.toml"
if [ ! -f "$CP" ]; then
  cp "$SRC/conf/app.docker.toml" "$CP"
  python3 "$BASE/ops/set-config.py" "$CP" \
    admin password "$MEMOH_ADMIN_PASSWORD" \
    admin email "dev@memoh.local" \
    auth jwt_secret "$MEMOH_JWT_SECRET" \
    auth agent_credentials_encryption_key "$MEMOH_AGENT_CREDENTIALS_ENCRYPTION_KEY" \
    postgres password "$POSTGRES_PASSWORD" \
    pgvector password "$POSTGRES_PASSWORD"
  chmod 600 "$CP"
  echo "wrote $CP"
fi

IOS_PUSH_IMAGE="${MEMOH_IOS_PUSH_IMAGE:-memoh-ios-push:local}"
if ! docker image inspect "$IOS_PUSH_IMAGE" >/dev/null 2>&1; then
  BUILDER=/opt/meimaobing-alpha/scripts/build-limited.sh
  [ -x "$BUILDER" ] || { echo "missing limited image builder: $BUILDER" >&2; exit 1; }
  "$BUILDER" build "$SRC" "$SRC/infra/vultr-sg/ios-push.Dockerfile" "$IOS_PUSH_IMAGE"
fi

# 4) compose override：端口只绑本地 + 资源上限，保护同机生产
cat > "$BASE/docker-compose.override.yml" <<'YAML'
# Memoh dev override — 与生产 meimaobing-alpha 共存，限额运行。
services:
  postgres:
    cpus: 1.0
    mem_limit: 1g
  pgvector:
    cpus: 1.0
    mem_limit: 1g
  migrate:
    cpus: 1.0
    mem_limit: 1g
  server:
    cpus: 3.0
    mem_limit: ${MEMOH_SERVER_MEMORY_LIMIT:-3g}
    ports: !override
      - "127.0.0.1:18080:8080"
  channel:
    cpus: 1.0
    mem_limit: 768m
  web:
    cpus: 0.5
    mem_limit: 384m
    ports: !override
      - "127.0.0.1:18082:8082"
  ios-push:
    image: ${MEMOH_IOS_PUSH_IMAGE:-memoh-ios-push:local}
    pull_policy: never
    cpus: 0.5
    mem_limit: 192m
    read_only: true
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    env_file:
      - /opt/memoh-dev/secrets/ios-push.env
    environment:
      DATABASE_URL: "postgres://memoh:${POSTGRES_PASSWORD}@postgres:5432/memoh?sslmode=disable"
    volumes:
      - /opt/memoh-dev/secrets/apns-auth-key.p8:/run/secrets/apns-auth-key.p8:ro
      - /etc/localtime:/etc/localtime:ro
    ports:
      - "127.0.0.1:18083:8083"
    depends_on:
      postgres:
        condition: service_healthy
      server:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://127.0.0.1:8083/health"]
      interval: 30s
      timeout: 3s
      start_period: 5s
      retries: 3
    restart: unless-stopped
    networks:
      - memoh-network
YAML

echo "=== ready ==="
echo "src:     $SRC"
echo "config:  $CP"
echo "secrets: $SECRETS/memoh-dev.env"
