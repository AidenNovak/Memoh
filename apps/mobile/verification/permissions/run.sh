#!/bin/zsh
# chat-only 权限闭环：入口收窄 → REST 历史可读 → 不建 WebSocket → 不碰 403 表面。
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."

PORT="${MEMOH_UI_METRO_PORT:-8097}"
FIXTURE_PORT="${MEMOH_FIXTURE_PORT:-18101}"
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

node verification/fixture/server.mjs --port "$FIXTURE_PORT" >"$OUT/fixture.log" 2>&1 &
FIXTURE_PID=$!
cleanup() {
  kill "$FIXTURE_PID" 2>/dev/null || true
}
trap cleanup EXIT
for _ in $(seq 1 20); do
  curl -s --max-time 2 "http://127.0.0.1:${FIXTURE_PORT}/bots" >/dev/null 2>&1 && break
  sleep 0.5
done

curl -fsS -X POST -H 'Content-Type: application/json' -d '{"scenario":"chat-only"}' \
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
    # 故意要求直达 schedule：权限回来后必须收敛到 sessions，不能闪进 403 页面。
    'path': '/?view=schedule',
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

# 再走一次绕过 hub 的直接深链：编辑页自己也必须挡住，不能靠“入口藏了”侥幸不发 403。
python3 - "$CONTAINER/Documents/memoh-verify-seed.json" "$FIXTURE_PORT" <<'PY'
import json, pathlib, sys
path, port = sys.argv[1], sys.argv[2]
pathlib.Path(path).write_text(json.dumps({
    'baseUrl': f'http://127.0.0.1:{port}',
    'username': 'fixture',
    'password': 'fixture',
    'scenario': 'route',
    'path': '/schedule/edit?scheduleId=fixture-schedule-daily',
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

maestro test --udid "$UDID" --debug-output "$OUT/schedule-flow" \
  --flatten-debug-output "$HERE/schedule-flow.yaml"

curl -fsS "http://127.0.0.1:${FIXTURE_PORT}/__ws-log" >"$OUT/ws-log.json"
node - "$OUT/ws-log.json" <<'NODE'
const fs = require('node:fs');
const log = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (log.connections !== 0 || log.attempts?.length !== 0) {
  throw new Error(`chat-only 不应尝试 WebSocket：${JSON.stringify(log)}`);
}
NODE

if rg -q 'GET /bots/.+/(schedule|container/fs)' "$OUT/fixture.log"; then
  echo 'chat-only 界面请求了未授权的 schedule/files 端点：' >&2
  rg 'GET /bots/.+/(schedule|container/fs)' "$OUT/fixture.log" >&2
  exit 1
fi

echo "证据：$OUT"
find "$OUT" -name '*.png' | sed 's|^|  |'
