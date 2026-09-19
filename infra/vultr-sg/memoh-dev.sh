#!/usr/bin/env bash
# Memoh dev 环境运维入口（vultr-sg）。
# 用法: memoh-dev.sh <up|down|ps|logs|restart|psql|web|health|config|src>
set -euo pipefail

BASE=/opt/memoh-dev
SRC="$BASE/src"
ENV_FILE="$BASE/secrets/memoh-dev.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "missing $ENV_FILE — run ops/bootstrap.sh first" >&2
  exit 1
fi

compose() {
  docker compose \
    --project-name memoh-dev \
    --project-directory "$SRC" \
    --env-file "$ENV_FILE" \
    -f "$SRC/docker-compose.yml" \
    -f "$BASE/docker-compose.override.yml" \
    "$@"
}

# compose 的 ${VAR} 插值读的是 shell 环境或 --env-file；GOMEMLIMIT 等由
# override 里的 ${...} 引用，必须导出。
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
export MEMOH_CONFIG="$BASE/config.toml"

cmd="${1:-help}"
shift || true

case "$cmd" in
  up)       compose up -d "$@" ;;
  down)     compose down "$@" ;;
  ps)       compose ps ;;
  logs)     compose logs --tail=120 "$@" ;;
  restart)  compose restart "$@" ;;
  pull)     compose pull && compose up -d ;;
  config)   compose config ;;
  health)
    echo "--- containers ---"
    compose ps
    echo "--- server /health via web proxy ---"
    curl -s -m 10 -o /dev/null -w "web:%{http_code}\n" http://127.0.0.1:18082/ || true
    curl -s -m 10 -o /dev/null -w "api:%{http_code}\n" http://127.0.0.1:18080/health || true
    echo "--- resources ---"
    docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}' \
      $(docker ps --filter "name=memoh-dev" --format '{{.Names}}' | head -10) 2>/dev/null || true
    ;;
  psql)
    compose exec -T postgres psql -U memoh -d memoh -P pager=off "$@"
    ;;
  src)      echo "$SRC" ;;
  web-log)  compose logs --tail=200 web ;;
  server-log) compose logs --tail=300 server ;;
  *)        sed -n '2,3p' "$0" ;;
esac
