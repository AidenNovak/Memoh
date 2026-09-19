#!/bin/zsh
# 首启引导的真动作验收：翻页、跳过、以及「第二次启动不再出现」。
#
# 为什么不用 verification/ui 那套 driver：它只有 simctl，没有点击能力；而引导的
# 价值全在交互上。这里用 Maestro 真点（和 demo 录制同一套工具）。
# 断言的清单与理由见同目录 README.md。
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."

PORT="${MEMOH_UI_METRO_PORT:-8097}"
export PATH="$HOME/.maestro/bin:$PATH"

# 设备**只认租约**（`pnpm verify:simulator` 导出的 MEMOH_VERIFY_UDID）：以前这里是
# "从 `simctl list` 里挑一台名字里有 Verify 的"——同名设备下必然挑错（实测挑中的是
# 别人的 `Memoh presentation scenes Verify`）。拿不到租约一律 `exit 2` 说清谁占着，
# **不换一台继续跑**；判据在 `verification/device.sh`。
source "$HERE/../device.sh"
require_leased_device

BUNDLE="${MEMOH_APP_BUNDLE_ID:-ai.memoh.ios}"
OUT="$HERE/out/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"
print -r -- "device=$UDID lease=${MEMOH_VERIFY_LEASE_TOKEN:-none}" >> "$OUT/device.txt"

launch() {
  xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null || true
  sleep 1
  xcrun simctl launch "$UDID" "$BUNDLE" \
    --initialUrl "http://127.0.0.1:${PORT}?disableOnboarding=1" \
    -expo.devlauncher.hasGrantedNetworkPermission YES \
    -EXDevMenuShowsAtLaunch NO -EXDevMenuIsOnboardingFinished YES \
    -EXDevMenuShowFloatingActionButton NO \
    -AppleLanguages '(en)' -AppleLocale en_US > /dev/null
  # 等首帧画出来再开始断言。`simctl` 读不到界面，固定等待是这里唯一的手段；
  # 断言本身还有重试，所以这里只要"足够久"。
  sleep 16
}

# 有验收种子时 App 会按种子走、跳过引导——先把它移开，结束时放回去。
CONTAINER=$(xcrun simctl get_app_container "$UDID" "$BUNDLE" data)
SEED="$CONTAINER/Documents/memoh-verify-seed.json"
SEED_BACKUP=""
if [ -f "$SEED" ]; then
  SEED_BACKUP="$OUT/seed-backup.json"
  mv "$SEED" "$SEED_BACKUP"
  echo "① 移开验收种子（有种子就看不到引导）"
else
  echo "① 没有验收种子（本来就会走首启路径）"
fi
restore_seed() {
  if [ -n "$SEED_BACKUP" ] && [ -f "$SEED_BACKUP" ]; then mv "$SEED_BACKUP" "$SEED"; fi
}
trap restore_seed EXIT

echo "② 清钥匙串（全新安装：既没有凭据，也没有「看过引导」这条记忆）"
xcrun simctl keychain "$UDID" reset

echo "③ 状态栏与外观换成可读的样子（截图是要给人看的）"
xcrun simctl status_bar "$UDID" override \
  --time '09:41' --batteryState charged --batteryLevel 100 \
  --cellularMode active --cellularBars 4 --wifiMode active --wifiBars 3 2>/dev/null || true
xcrun simctl ui "$UDID" appearance light

echo "④ 第一趟：翻三页 → 开始使用 → 登录页"
launch
maestro test --udid "$UDID" \
  --debug-output "$OUT/first-run" --flatten-debug-output \
  "$HERE/flow-pages.yaml"

echo "⑤ 第二趟：引导不该再出现，直接到登录页"
launch
maestro test --udid "$UDID" \
  --debug-output "$OUT/second-run" --flatten-debug-output \
  "$HERE/flow-once.yaml"

echo
echo "证据：$OUT"
find "$OUT" -name '*.png' | sed 's|^|  |'
