#!/bin/zsh
# 文件视图的交互验收：固定服务端喂数据 → 真点预览三态与长按动作 → 截图。
#
# 为什么用固定服务端而不是 dev 栈：这一屏要验的是**三种预览分支**（文本 / 二进制 /
# 超大），dev 栈上不一定恰好有这三种文件，而且它的内容会变——截图就没法前后比较了。
# 固定服务端给一份写死的目录（`data/` 下有 notes.txt / bundle.tar.gz / huge.log）。
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."          # apps/mobile

PORT="${MEMOH_UI_METRO_PORT:-8097}"
FIXTURE_PORT="${MEMOH_FIXTURE_PORT:-18099}"
export PATH="$HOME/.maestro/bin:$PATH"

# 设备**只认租约**（`pnpm verify:simulator` 导出的 MEMOH_VERIFY_UDID）：以前这里是
# "从 `simctl list` 里挑一台名字里有 Verify 的"——在现在这台机器上（三台 `*Verify*`，
# 其中两台一字不差）必然会挑到**别人的设备**，实测挑中的是
# `Memoh presentation scenes Verify`。拿不到租约就明确失败，**不换一台继续跑**：
# 判据与"谁占着"怎么说清都在 `verification/device.sh`。
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

# 固定服务端：已经在跑就直接用（可能是别的会话开的），否则自己起一个。
FIXTURE_PID=""
if ! curl -s --max-time 2 "http://127.0.0.1:${FIXTURE_PORT}/bots" > /dev/null 2>&1; then
  node verification/fixture/server.mjs --port "$FIXTURE_PORT" > "$OUT/fixture.log" 2>&1 &
  FIXTURE_PID=$!
  for _ in $(seq 1 20); do
    curl -s --max-time 2 "http://127.0.0.1:${FIXTURE_PORT}/bots" > /dev/null 2>&1 && break
    sleep 0.5
  done
fi

echo "① 写种子（登录固定服务端 + 直接停在文件视图）"
CONTAINER=$(xcrun simctl get_app_container "$UDID" "$BUNDLE" data)
python3 - "$CONTAINER/Documents/memoh-verify-seed.json" "$FIXTURE_PORT" <<'PY'
import json, sys, pathlib
path, port = sys.argv[1], sys.argv[2]
pathlib.Path(path).write_text(json.dumps({
    'baseUrl': f'http://127.0.0.1:{port}', 'username': 'fixture', 'password': 'fixture',
    'scenario': 'route', 'path': '/?view=files',
}))
PY

echo "② 冷启动（带参数：不要开发菜单的悬浮按钮）"
xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null || true
sleep 1
xcrun simctl launch "$UDID" "$BUNDLE" \
  --initialUrl "http://127.0.0.1:${PORT}?disableOnboarding=1" \
  -expo.devlauncher.hasGrantedNetworkPermission YES \
  -EXDevMenuShowsAtLaunch NO -EXDevMenuIsOnboardingFinished YES \
  -EXDevMenuShowFloatingActionButton NO \
  -AppleLanguages '(en)' -AppleLocale en_US > /dev/null
sleep 14

echo "③ 真点：预览三态 + 长按动作清单"
maestro test --udid "$UDID" \
  --debug-output "$OUT/preview" --flatten-debug-output \
  "$HERE/interaction-flow.yaml"

# 自己起的固定服务端自己收掉；复用别人的就别动（杀别人的调试会话是最讨厌的行为）。
if [ -n "$FIXTURE_PID" ]; then
  kill "$FIXTURE_PID" 2>/dev/null || true
fi

echo
echo "证据：$OUT"
find "$OUT" -name '*.png' | sed 's|^|  |'
