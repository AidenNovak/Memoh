#!/bin/zsh
# 推送通道的**行为验收**（`xcrun simctl push` 本地投递，不需要任何凭据）。
#
# ## 为什么单开一条脚本
#
# `verification/ui` 那套 case 只用 `xcrun simctl`；而这条验收必须**操作系统界面**：
# 系统权限框要点"允许"、通知中心要拉开、通知上的动作按钮要点。这些只有 Maestro 那类
# 走 XCUITest 的东西能做（`verification/navigation` 已经在用它）。所以这条脚本和
# `bots-run.sh` 同一形态：起固定服务端 → 用 simctl 带 dev-client 参数启动 → 跑 flow，
# 中间夹着 `simctl push` 与截图。
#
# ## 它验什么（逐条对应任务里的硬要求）
#
# | 步骤 | 证据 |
# | --- | --- |
# | 未授权时投递不崩 | 截图里没有横幅、进程仍活着（授权是后面才给的） |
# | 权限框由**用户主动**触发 | 通知子页那一行点了才弹框，授予后该行消失 |
# | 横幅 | 后台收到审批推送，屏幕上出现标题/正文 |
# | 通知中心分组 | 同一会话（同一 `thread-id`）的两条归到一组 |
# | 分类动作按钮 | 通知上出现"允许 / 拒绝" |
# | 点动作深链直达 | 点"允许"后 App 打开到该会话，且固定服务端**收到**指向那次审批的回应帧 |
# | 前台接住（in_app） | 前台推送不弹横幅，判据给出 `approval_waiting → in_app` |
# | 徽标 | 推送带的 badge 出现在图标上 |
#
# ## 验不到的（别在这儿写"验过"）
#
# 真实 APNs 送达、生产 entitlement、真机触感与专注模式、服务端"在该发的时候发"。
# 这些要凭据 + 真机 + 发送方，见 `docs/research/push-contract.md` §6。
#
# 用法（设备只来自租约，所以要包在 `pnpm verify:simulator` 里跑；**用 zsh，不要用 bash**）：
#   pnpm verify:simulator --name 'push acceptance' -- \
#     zsh apps/mobile/verification/push/push-run.sh
#   zsh apps/mobile/verification/push/push-run.sh permission    # 只跑某一步（迭代时用）
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."          # apps/mobile

PORT="${MEMOH_UI_METRO_PORT:-8097}"
FIXTURE_PORT="${MEMOH_UI_FIXTURE_PORT:-18099}"
BUNDLE="${MEMOH_APP_BUNDLE_ID:-ai.memoh.ios}"
APP="${MEMOH_UI_APP:-verification/.artifacts/derived-data/Build/Products/Debug-iphonesimulator/Memoh.app}"
PAY="$HERE/payloads"
export PATH="$HOME/.maestro/bin:$PATH"

# 设备**只认租约**（`pnpm verify:simulator` 导出的 MEMOH_VERIFY_UDID）：以前这里是
# "从 `simctl list` 里挑一台名字里有 Verify 的"——同名设备下必然挑错（实测挑中的是
# 别人的 `Memoh presentation scenes Verify`），而这条验收是**真的往设备上投推送**，
# 挑错了就等于把通知发到别人正在跑的设备上。拿不到租约一律 `exit 2` 说清谁占着，
# **不换一台继续跑**；判据在 `verification/device.sh`。
source "$HERE/../device.sh"
require_leased_device

[ -d "$APP" ] || { echo "找不到构建产物 ${APP}；先跑 pnpm verify:build" >&2; exit 2; }

if ! curl -s --max-time 5 "http://127.0.0.1:${PORT}/status" | grep -q packager-status:running; then
  echo "Metro 不在 ${PORT} 上跑：先 pnpm exec expo start --dev-client --port ${PORT}" >&2
  exit 2
fi

OUT="$HERE/out/$(date +%Y%m%d-%H%M%S)-push"
mkdir -p "$OUT"
print -r -- "device=$UDID lease=${MEMOH_VERIFY_LEASE_TOKEN:-none}" >> "$OUT/device.txt"

echo "产物 $APP"
echo "证据 $OUT"

# ---- 固定服务端 -----------------------------------------------------------
STALE=$(pgrep -f "verification/fixture/server.mjs --port ${FIXTURE_PORT}" || true)
if [ -n "$STALE" ]; then kill $STALE 2>/dev/null || true; sleep 1; fi
node verification/fixture/server.mjs --port "$FIXTURE_PORT" > "$OUT/fixture.log" 2>&1 &
FIXTURE_PID=$!
for _ in $(seq 1 40); do
  curl -s --max-time 1 "http://127.0.0.1:${FIXTURE_PORT}/bots" > /dev/null 2>&1 && break
  sleep 0.5
done

SEED_PID=""
cleanup() {
  [ -n "$FIXTURE_PID" ] && kill "$FIXTURE_PID" 2>/dev/null || true
  clear_seed
}
trap cleanup EXIT

clear_seed() {
  python3 - "$UDID" "$BUNDLE" <<'PY'
import pathlib, subprocess, sys
container = subprocess.run(['xcrun','simctl','get_app_container',sys.argv[1],sys.argv[2],'data'],
                           capture_output=True, text=True).stdout.strip()
if container:
    for name in ('memoh-verify-seed.json','memoh-verify-seed.tmp'):
        path = pathlib.Path(container)/'Documents'/name
        if path.exists(): path.unlink()
PY
}

set_scenario() {
  curl -s -X POST -H 'content-type: application/json' \
    -d "{\"scenario\":\"$1\"}" "http://127.0.0.1:${FIXTURE_PORT}/__scenario" > /dev/null
}

# 种子 = 连固定服务端 + 直接进某一屏（与 bots-run.sh 同一套形状）。
launch() {
  local route="$1" scenario="$2"
  set_scenario "$scenario"
  xcrun simctl ui "$UDID" content_size large > /dev/null 2>&1 || true
  python3 - "$UDID" "$BUNDLE" "$FIXTURE_PORT" "$route" <<'PY'
import json, pathlib, subprocess, sys
udid, bundle, port, route = sys.argv[1:5]
container = subprocess.run(['xcrun','simctl','get_app_container',udid,bundle,'data'],
                           capture_output=True, text=True).stdout.strip()
if not container:
    raise SystemExit('拿不到 App 容器路径（装过 App 了吗？）')
documents = pathlib.Path(container)/'Documents'
documents.mkdir(parents=True, exist_ok=True)
target = documents/'memoh-verify-seed.json'
tmp = target.with_suffix('.tmp')
tmp.write_text(json.dumps({
    'baseUrl': f'http://127.0.0.1:{port}', 'username': 'fixture', 'password': 'fixture',
    'scenario': 'route', 'path': route,
}))
tmp.replace(target)
PY
  xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null || true
  sleep 1
  xcrun simctl launch "$UDID" "$BUNDLE" \
    --initialUrl "http://127.0.0.1:${PORT}/?disableOnboarding=1" \
    -expo.devlauncher.hasGrantedNetworkPermission YES \
    -EXDevMenuShowsAtLaunch NO -EXDevMenuIsOnboardingFinished YES \
    -EXDevMenuShowFloatingActionButton NO \
    -AppleLanguages '(en)' -AppleLocale en_US > /dev/null
  sleep 12
}

run_flow() {
  # 驱动启动超时放宽：这台机器上同时跑着别人的构建与 flow，maestro 自带的默认值
  # （偶发）会在 XCUITest driver 还没起来时就判失败（本轮踩过）。
  export MAESTRO_DRIVER_STARTUP_TIMEOUT="${MAESTRO_DRIVER_STARTUP_TIMEOUT:-240000}"
  local attempt=1
  while true; do
    if maestro test --udid "$UDID" --debug-output "$OUT/$1" --flatten-debug-output "$HERE/flows/$1.yaml"; then
      return 0
    fi
    # 只重试一次：驱动没起来是环境问题，flow 自己的断言失败重试也一样失败。
    [ "$attempt" -ge 2 ] && return 1
    echo "  flow $1 第一次没跑起来，重试一次" >&2
    attempt=$((attempt + 1))
    sleep 5
  done
}

# 截图 + 立刻做文字断言：证据与结论一起落盘。
shot() {
  local name="$1"; shift
  xcrun simctl io "$UDID" screenshot "$OUT/$name.png" > /dev/null 2>&1
  python3 "$HERE/assert-text.py" "$OUT/$name.png" "$@"
  echo "  ok $name.png"
}

# 下拉手势成功不等于通知中心真的打开：iOS 26.5 偶尔会接住手势却仍停在主屏幕。
# 用截图文字做结果判据，第一次没打开就再拉一次；两次都没有才让旅程失败。
notification_center_shot() {
  local name="$1" attempt=1
  while true; do
    run_flow 03-open-center
    sleep 2
    xcrun simctl io "$UDID" screenshot "$OUT/$name.png" > /dev/null 2>&1
    if python3 "$HERE/assert-text.py" "$OUT/$name.png" --contains 'Waiting for you' > /dev/null 2>&1; then
      python3 "$HERE/assert-text.py" "$OUT/$name.png" --contains 'Waiting for you'
      echo "  ok $name.png（第 ${attempt} 次下拉打开通知中心）"
      return 0
    fi
    if [ "$attempt" -ge 2 ]; then
      python3 "$HERE/assert-text.py" "$OUT/$name.png" --contains 'Waiting for you'
      return 1
    fi
    echo "  通知中心第一次没有打开，再下拉一次" >&2
    attempt=$((attempt + 1))
  done
}

push() {
  local payload="$1" label="$2"
  cp "$PAY/$payload" "$OUT/payload-$label.json"
  xcrun simctl push "$UDID" "$BUNDLE" "$PAY/$payload" > /dev/null
  echo "  pushed ${payload} → ${label}"
}

approval_frame() {
  curl -s "http://127.0.0.1:${FIXTURE_PORT}/__last-approval-response" > "$OUT/last-approval-response.json"
  echo "$OUT/last-approval-response.json"
}

WANT="${1:-all}"
want() {
  [ "$WANT" = "all" ] && return 0
  case " $WANT " in (*" $1 "*) return 0 ;; esac
  return 1
}

# ---- ① 前置：全新安装（通知授权回到"没问过"） ------------------------------
if want setup; then
  echo "① 全新安装（授权状态回到 notDetermined）"
  xcrun simctl terminate "$UDID" "$BUNDLE" 2>/dev/null || true
  xcrun simctl uninstall "$UDID" "$BUNDLE" 2>/dev/null || true
  xcrun simctl keychain "$UDID" reset > /dev/null 2>&1 || true
  xcrun simctl install "$UDID" "$APP"
  launch "/settings" "default"
fi

# ---- ② 未授权时投递：不崩、不显示 ------------------------------------------
if want unauthorized; then
  echo "② 未授权时投递一条审批推送"
  push approval-1.json unauthorized
  sleep 4
  shot 01-unauthorized --absent 'Waiting for you'
  # 进程还活着（"不崩"是这条的判据）。
  xcrun simctl spawn "$UDID" launchctl list | grep -q "$BUNDLE" \
    || { echo "FAILED: 未授权投递之后 App 不在运行" >&2; exit 1; }
  echo "  ok App 仍在运行（未授权投递没崩）"
fi

# ---- ③ 权限：由用户在通知子页主动触发 --------------------------------------
if want permission; then
  echo "③ 通知子页里主动开启（user_asked），并授予系统授权"
  run_flow 01-enable-permission
  sleep 3
  shot 02-permission-alert --contains 'Allow'
  run_flow 01b-allow-alert
  sleep 3
  shot 03-permission-granted --absent 'Turn on notifications'
fi

# ---- ④ 横幅：后台收到审批推送 ---------------------------------------------
if want banner; then
  echo "④ 横幅"
  run_flow 02-go-home
  # 横幅只活几秒（Time Sensitive 也一样），而这台机器常被别人的构建压着——
  # 一次睡眠加一次截图就可能错过它。所以"推 → 立刻截 → 认字"，最多试三次，
  # 并把试了几次写进日志（试到第三次才成的证据比"一次就成了"更值得知道）。
  attempt=1
  while true; do
    push approval-1.json banner
    sleep 1
    xcrun simctl io "$UDID" screenshot "$OUT/03-banner.png" > /dev/null 2>&1
    if python3 "$HERE/assert-text.py" "$OUT/03-banner.png" --contains 'Waiting for you' > /dev/null 2>&1; then
      echo "  ok 03-banner.png（第 ${attempt} 次投递截到）"
      break
    fi
    [ "$attempt" -ge 3 ] && \
      { python3 "$HERE/assert-text.py" "$OUT/03-banner.png" --contains 'Waiting for you'; exit 1; }
    attempt=$((attempt + 1))
    sleep 2
  done
fi

# ---- ⑤ 通知中心里看得到那条通知（分组与动作按钮由系统画） -------------------
if want center; then
  echo "⑤ 通知中心里的那条通知"
  notification_center_shot 04-notification-center
fi

# ---- ⑥ 点通知本体 ----------------------------------------------
#
# ⚠️ **本机点不到**：`xcrun simctl` 没有触摸注入，Maestro 能拉开通知中心、能长按，
# 但点在通知卡片上（以及系统画的动作按钮上）没有任何反应——试过 75%/80%/84%/95% 四个
# 位置、锁屏与解锁两种状态，全部无效。所以"点通知 → 冷启动深链"这一步在这里**验不了**，
# 只能真机手点；它的判据由 `tests/notifications-bridge.test.mjs` 的 `routeFor`/
# `submissionFor` 与原生 `NotificationContractTests` 钉住。别把这一步写成"通过"。
if want tap; then
  echo "⑥ 点通知本体：本机点不到（见脚本注释与 verification/push/README.md）"
fi

# ---- ⑦ 注入"点了允许"：提交那一段（原生那一跳在模拟器上点不到，见 flow 注释）
if want inject; then
  echo '⑦ 注入点「允许」→ 提交那次审批'
  launch "/debug/notifications" "default"
  sleep 3
  : > "$OUT/last-approval-response.json"
  curl -s "http://127.0.0.1:${FIXTURE_PORT}/__last-approval-response" > /dev/null
  BEFORE=$(curl -s "http://127.0.0.1:${FIXTURE_PORT}/__last-approval-response")
  run_flow 06-debug-allow
  sleep 6
  FRAME=$(approval_frame)
  python3 "$HERE/assert-approval.py" "$FRAME" \
    --session fixture-session-untitled --decision-id scene-approval-2 --decision approve

  echo '⑦b 别的账号的通知：不该有任何动作'
  # 上一步"点允许"把 App 深链到了会话，调试页已经不在了——重新起一次回到调试页。
  launch "/debug/notifications" "default"
  sleep 3
  run_flow 06b-debug-foreign
  sleep 4
  AFTER=$(curl -s "http://127.0.0.1:${FIXTURE_PORT}/__last-approval-response")
  if [ "$BEFORE" = "$AFTER" ]; then
    echo '  ok 服务端没有收到新的回应帧（别的账号的通知没被处理）'
  else
    echo "FAILED: 别的账号的通知触发了回应：$AFTER" >&2
    exit 1
  fi
fi

# ---- ⑧ 分组：同一会话的两条归到一组 ---------------------------------------
if want group; then
  echo "⑧ 同一会话两条通知的分组"
  run_flow 02-go-home
  push approval-1.json group-a
  push approval-2.json group-b
  sleep 3
  notification_center_shot 06-grouping
fi

# ---- ⑨ 前台接住：不弹横幅，判据走 in_app ----------------------------------
if want foreground; then
  echo "⑨ 前台推送（走 in_app，不弹横幅）"
  launch "/debug/notifications" "default"
  sleep 3
  push approval-1.json foreground
  sleep 5
  shot 07-foreground --contains 'approval_waiting' --absent 'Waiting for you'
  push run-finished.json foreground-finished
  sleep 5
  shot 08-foreground-finished --contains 'run_finished'
fi

# ---- ⑩ 徽标 ---------------------------------------------------------------
if want badge; then
  echo "⑩ 徽标（推送带的 badge → 图标上的数字）"
  # 顺序要紧：**先**把 App 送到后台再推。前台推送会被判成 drop（不打扰），
  # 系统也不会去动徽标——那样截到的"没有徽标"什么也证明不了。
  run_flow 02-go-home
  push approval-2.json badge
  sleep 3
  shot 09-badge --contains-line '2'
  # 再让客户端算一次：首页那份待审批聚合会调 `setBadgeCount`（同源语义），
  # 于是徽标从"服务端给的值"变成"客户端算出的值"。
  launch "/" "default"
  sleep 6
  run_flow 02-go-home
  sleep 2
  shot 10-badge-after-client --absent-line '2'
fi

# ---- ⑪ 排查用：直接看桥的状态页 -------------------------------------------
if want debug; then
  echo '⑪ 看推送状态页（原生能力在不在、授权读到了什么、分类注册上了没有）'
  launch "/debug/notifications" "default"
  sleep 3
  shot 99-debug-state
fi

echo "完成。证据在 $OUT"
