#!/bin/zsh
# 重复 key 回归探针：新建会话 → 发一句，看屏幕上还会不会出现
# 「Encountered two children with the same key」。
#
# ## 为什么需要它
#
# 那条警告**用户看得见**：开发构建里它是屏幕底部的一条 LogBox 横幅，压在输入框上。
# 成因是一段"先查再写"的异步流程（`ensureSessionInList`）在开发构建里被调用了两次，
# 而写入是无条件的——第二次就把同一个会话又 prepend 了一遍。详见
# `docs/research/verified-behaviour.md` 第 20 条。
#
# 纯逻辑测试能钉住不变量（`tests/sessionlist.test.mjs`），但钉不住"这条路径真的会
# 被走两次"——那要靠真机/模拟器上的这一趟。修复前它在 4 次里复现 3 次，所以这个
# 探针是有意义的回归网，不是摆设。
#
# ## 前置
#
#   1. 开发栈可达：`bash infra/local/memoh-tunnel.sh start`
#   2. Metro 在跑，且**日志落在 $MEMOH_PROBE_METRO_LOG**：
#        cd apps/mobile && pnpm exec expo start --dev-client --host lan --port 8097 \
#          > /tmp/memoh-metro.log 2>&1
#      （日志里能看到 ` WARN ` / ` ERROR ` 行——App 的 console 会打到 Metro 这边。）
#   3. 模拟器上装好 Debug App，**并且已经登录**（`apps/mobile/verification/demo/prepare.sh`
#      会写验收种子完成登录）。
#   4. Maestro 在 PATH 里（`$HOME/.maestro/bin`）。
#
# ## 用法
#
#   zsh tools/dupkey-probe.sh            # 跑一轮
#   zsh tools/dupkey-probe.sh 3          # 跑三轮（复现类问题一轮不够）
#
# 退出码 0 = 没出现重复 key；1 = 出现了（附原始日志行）。
set -u

# 用 `$0` 找自己（不依赖"从哪个目录调的"），下面 device.sh 也按仓库相对路径找。
# 这里刻意不用 `${(%):-%x}`：那个语法在 bash 里会报 `bad substitution`，而这条命令是
# 人随手敲的（`zsh tools/dupkey-probe.sh`），报错看不懂就没人查了。
ROOT=$(cd "$(dirname "$0")/.." && pwd)

ROUNDS="${1:-1}"
# 设备**只认租约**（`pnpm verify:simulator` 导出的 MEMOH_VERIFY_UDID）：以前这里是
# "从 `simctl list` 里挑一台名字里有 Verify 的"——同名设备下必然挑错（实测挑中的是
# 别人的 `Memoh presentation scenes Verify`）。拿不到租约一律 `exit 2` 说清谁占着，
# **不换一台继续跑**；判据在 `apps/mobile/verification/device.sh`。
source "$ROOT/apps/mobile/verification/device.sh"
require_leased_device

PORT="${MEMOH_METRO_PORT:-8097}"
LOG="${MEMOH_PROBE_METRO_LOG:-/tmp/memoh-metro.log}"
BUNDLE="${MEMOH_APP_BUNDLE_ID:-ai.memoh.ios}"
[ -f "$LOG" ] || { echo "没有 Metro 日志 $LOG（见脚本头的前置）" >&2; exit 2; }

FLOW=$(mktemp -t dupkey-probe.XXXXXX).yaml
cat > "$FLOW" <<'YAML'
appId: ai.memoh.ios
---
- assertVisible: 'Sessions'
- tapOn: 'New Session'
- waitForAnimationToEnd:
    timeout: 4000
- tapOn: 'Message'
- waitForAnimationToEnd:
    timeout: 1500
- inputText: 'DUPKEY probe'
- waitForAnimationToEnd:
    timeout: 2000
- tapOn: 'Send'
- waitForAnimationToEnd:
    timeout: 8000
YAML

failures=0
for round in $(seq 1 "$ROUNDS"); do
  before=$(grep -ac "" "$LOG")
  xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null
  sleep 1
  # 冷启动：新会话这次的 effect 与启动时的列表刷新叠在一起，正是复现窗口。
  xcrun simctl launch "$UDID" "$BUNDLE" \
    --initialUrl "http://127.0.0.1:${PORT}?disableOnboarding=1" \
    -expo.devlauncher.hasGrantedNetworkPermission YES \
    -EXDevMenuShowsAtLaunch NO -EXDevMenuIsOnboardingFinished YES \
    -EXDevMenuShowFloatingActionButton NO \
    -AppleLanguages '(en)' -AppleLocale en_US > /dev/null

  maestro test --udid "$UDID" "$FLOW" > /dev/null 2>&1

  hits=$(tail -n +$((before + 1)) "$LOG" | grep -ac "same key")
  if [ "$hits" -eq 0 ]; then
    echo "第 $round 轮：没有重复 key"
  else
    failures=$((failures + 1))
    echo "第 $round 轮：出现 $hits 次重复 key ⬇️" >&2
    tail -n +$((before + 1)) "$LOG" | grep -a "same key" | cut -c1-200 >&2
  fi
done

rm -f "$FLOW"
if [ "$failures" -gt 0 ]; then
  echo "$failures/$ROUNDS 轮出现重复 key —— 见 apps/mobile/src/features/session/sessionList.ts 的写入规则" >&2
  exit 1
fi
echo "全部 ${ROUNDS} 轮干净"
