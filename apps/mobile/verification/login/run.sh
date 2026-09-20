#!/bin/zsh
# 登录页真动作验收：Cloud 三种占位入口 → 自部署地址/账号/密码 → 拒绝一次 → 登录成功。
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."

PORT="${MEMOH_UI_METRO_PORT:-8097}"
FIXTURE_PORT="${MEMOH_FIXTURE_PORT:-18099}"
export PATH="$HOME/.maestro/bin:$PATH"

source "$HERE/../device.sh"
require_leased_device

BUNDLE="${MEMOH_APP_BUNDLE_ID:-ai.memoh.ios}"
OUT="$HERE/out/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"
print -r -- "device=$UDID lease=${MEMOH_VERIFY_LEASE_TOKEN:-none}" >> "$OUT/device.txt"

if ! curl -s --max-time 5 "http://127.0.0.1:${PORT}/status" | grep -q packager-status:running; then
  echo "Metro 不在 ${PORT} 上跑" >&2
  exit 2
fi

FIXTURE_PID=""
if ! curl -s --max-time 2 "http://127.0.0.1:${FIXTURE_PORT}/bots" > /dev/null 2>&1; then
  node verification/fixture/server.mjs --port "$FIXTURE_PORT" > "$OUT/fixture.log" 2>&1 &
  FIXTURE_PID=$!
  for _ in $(seq 1 20); do
    curl -s --max-time 2 "http://127.0.0.1:${FIXTURE_PORT}/bots" > /dev/null 2>&1 && break
    sleep 0.5
  done
fi

cleanup() {
  if [ -n "$FIXTURE_PID" ]; then kill "$FIXTURE_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT

# 第一次提交固定回 401，第二次自动恢复正常；同一趟旅程就能看见错误和成功两条路。
curl -sS --max-time 5 -X POST -H 'Content-Type: application/json' \
  -d '{"mode":"reject","times":1}' \
  "http://127.0.0.1:${FIXTURE_PORT}/__auth-fault" > "$OUT/auth-fault.json"

# 不允许旧 seed 或旧 Keychain 跳过登录页。
CONTAINER=$(xcrun simctl get_app_container "$UDID" "$BUNDLE" data)
SEED="$CONTAINER/Documents/memoh-verify-seed.json"
SEED_BACKUP=""
if [ -f "$SEED" ]; then
  SEED_BACKUP="$OUT/seed-backup.json"
  mv "$SEED" "$SEED_BACKUP"
fi
restore_seed() {
  cleanup
  if [ -n "$SEED_BACKUP" ] && [ -f "$SEED_BACKUP" ]; then mv "$SEED_BACKUP" "$SEED"; fi
}
trap restore_seed EXIT

xcrun simctl keychain "$UDID" reset
xcrun simctl status_bar "$UDID" override \
  --time '09:41' --batteryState charged --batteryLevel 100 \
  --cellularMode active --cellularBars 4 --wifiMode active --wifiBars 3 2>/dev/null || true
xcrun simctl ui "$UDID" appearance light

xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null || true
sleep 1
xcrun simctl launch "$UDID" "$BUNDLE" \
  --initialUrl "http://127.0.0.1:${PORT}?disableOnboarding=1" \
  -expo.devlauncher.hasGrantedNetworkPermission YES \
  -EXDevMenuShowsAtLaunch NO -EXDevMenuIsOnboardingFinished YES \
  -EXDevMenuShowFloatingActionButton NO \
  -AppleLanguages '(en)' -AppleLocale en_US > /dev/null
sleep 16

maestro test --udid "$UDID" -e "FIXTURE_URL=http://127.0.0.1:${FIXTURE_PORT}" \
  --debug-output "$OUT/flow" --flatten-debug-output \
  "$HERE/flow.yaml"

echo
echo "证据：$OUT"
find "$OUT" -name '*.png' | sed 's|^|  |'
