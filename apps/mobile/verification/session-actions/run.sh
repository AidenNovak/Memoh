#!/bin/zsh
# 会话动作闭环：真实 UI 长按 → rename PATCH → 列表刷新 → fork POST → 新会话跳转。
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."

PORT="${MEMOH_UI_METRO_PORT:-8097}"
FIXTURE_PORT="${MEMOH_FIXTURE_PORT:-18099}"
BUNDLE="${MEMOH_APP_BUNDLE_ID:-ai.memoh.ios}"
OUT="$HERE/out/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"
export PATH="$HOME/.maestro/bin:$PATH"

source "$HERE/../device.sh"
require_leased_device

if ! curl -s --max-time 5 "http://127.0.0.1:${PORT}/status" | grep -q packager-status:running; then
  echo "Metro 不在 ${PORT} 上跑" >&2
  exit 2
fi

FIXTURE_PID=""
if ! curl -s --max-time 2 "http://127.0.0.1:${FIXTURE_PORT}/bots" >/dev/null 2>&1; then
  node verification/fixture/server.mjs --port "$FIXTURE_PORT" >"$OUT/fixture.log" 2>&1 &
  FIXTURE_PID=$!
  for _ in $(seq 1 20); do
    curl -s --max-time 2 "http://127.0.0.1:${FIXTURE_PORT}/bots" >/dev/null 2>&1 && break
    sleep 0.5
  done
fi
cleanup() {
  if [ -n "$FIXTURE_PID" ]; then kill "$FIXTURE_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT

curl -fsS -X POST -H 'Content-Type: application/json' -d '{"scenario":"default"}' \
  "http://127.0.0.1:${FIXTURE_PORT}/__scenario" >"$OUT/scenario.json"

CONTAINER=$(xcrun simctl get_app_container "$UDID" "$BUNDLE" data)
python3 - "$CONTAINER/Documents/memoh-verify-seed.json" "$FIXTURE_PORT" <<'PY'
import json, pathlib, sys
path, port = sys.argv[1], sys.argv[2]
pathlib.Path(path).write_text(json.dumps({
    'baseUrl': f'http://127.0.0.1:{port}',
    'username': 'fixture',
    'password': 'fixture',
    'scenario': 'route',
    'path': '/',
}))
PY

xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null || true
xcrun simctl launch "$UDID" "$BUNDLE" \
  --initialUrl "http://127.0.0.1:${PORT}?disableOnboarding=1" \
  -expo.devlauncher.hasGrantedNetworkPermission YES \
  -EXDevMenuShowsAtLaunch NO -EXDevMenuIsOnboardingFinished YES \
  -EXDevMenuShowFloatingActionButton NO \
  -AppleLanguages '(en)' -AppleLocale en_US >/dev/null
sleep 14

maestro test --udid "$UDID" --debug-output "$OUT/flow" --flatten-debug-output "$HERE/flow.yaml"

curl -fsS "http://127.0.0.1:${FIXTURE_PORT}/__session-action-log" >"$OUT/request-log.json"
node - "$OUT/request-log.json" <<'NODE'
const fs = require('node:fs');
const log = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const patch = log.patches?.[0];
const fork = log.forks?.[0];
if (patch?.session_id !== 'fixture-session-long-title' || patch?.body?.title !== 'Renamed session') {
  throw new Error(`rename 请求账不符：${JSON.stringify(log)}`);
}
if (
  fork?.source_session_id !== 'fixture-session-long-title' ||
  typeof fork?.body?.turn_id !== 'string' ||
  fork.body.turn_id === '' ||
  fork?.body?.title !== 'Renamed session (fork)' ||
  fork?.created_session_id !== 'fixture-session-created-1'
) {
  throw new Error(`fork 请求账不符：${JSON.stringify(log)}`);
}
NODE

echo "证据：$OUT"
find "$OUT" -name '*.png' | sed 's|^|  |'
