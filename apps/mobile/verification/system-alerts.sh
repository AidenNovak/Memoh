#!/bin/zsh
# 系统弹窗（权限框这类 SpringBoard 画的东西）的处理：**先减少它出现，再点掉它**。
#
# 被 `e2e/lib.sh`、`navigation/bots-run.sh` 共用（两边各有自己的 `launch()`，
# 处理弹窗这件事只有一份实现）。
#
# ## 为什么这两件事都要做
#
# 权限框由 SpringBoard 画，**不进 App 的无障碍树**（实测：Maestro 的 `tapOn: 'Allow'`
# 报 WARNED 而框还在，见 `verification/push/flows/01-enable-permission.yaml`）。
# 于是它有两个后果：
#
#   1. 它**没人点掉就一直留在屏幕上**，而且**跨重启存活**——一次没点掉的框会让后面
#      每一条 flow 在同一个位置失败，读起来像"一堆互不相关的回归"；
#   2. 它挡住的可能不止一个按钮：框是模态的，点在它上面等于点在它身上——flow 里那些
#      `tapOn` 会"点到了、但什么都没发生"。
#
# 处理分两层，顺序不能反：
#
#   A. **减少它出现**：`xcrun simctl privacy grant all` 把相机/麦克风/照片/位置/通讯录
#      这些一次给全，系统就不再问；通知不在 simctl 的服务清单里（见
#      `system_alerts_preset_permissions` 的注释），要预置只能靠 applesimutils，默认不动。
#   B. **出现了就点掉**：先截图 + OCR **看见**它，再按钮的实际位置去点。看不见就不点——
#      因为"盲点一下坐标"在没弹窗时就是点在 App 身上（可能点到按钮、翻走页面），
#      那会让"修干扰"变成"制造干扰"。
#
# 幂等由 B 的判据保证：**每一步都先看一眼当前这一屏**，没有框就一个动作都不做
# （返回 0，什么都不点）。所以 `launch()` 每条都用、连用两次、在没有弹窗的设备上跑，
# 行为都相同；有框时则是"点掉 → 复查没了 → 返回 0"。
#
# 依赖（由调用方导出）：`$UDID` `$BUNDLE`；证据落在 `$OUT`（没设就落 `/tmp`）。

# 这个文件自己在哪儿。**不能用 `$0`**：被 source 时 `$0` 是"调用方的文件名"
# （`e2e.sh` / `bots-run.sh`），拿它推路径会指到别的目录去。`${(%):-%x}` 才是
# "当前正在被读的这个文件"。
MOBILE_SYSTEM_ALERTS=$(cd "$(dirname "${(%):-%x}")" && pwd)

# ---------------------------------------------------------------- 权限预置

# 把 **simctl 能预置的**权限一次给全：这类弹窗从此不再出现。
#
# 为什么不是"预置所有权限"：`simctl privacy` 的服务清单里**没有 notifications**
# （Xcode 26.5 实测：`simctl privacy <udid> grant notifications <bundle>` 报
# `Operation not permitted / Failed to set access`）。通知授权只能靠 Maestro 自带的
# applesimutils（`--setPermissions "notifications=YES|NO"`），而它**默认不开**：
# 授权与拒绝都会让通知页里 "Turn on notifications" 那一行消失，而
# `verification/navigation/notifications-flow.yaml` 正断言那一行在——
# 用"预置通知权限"去修干扰，会把别人验好的绿改成红，那不是修。
# 需要时显式打开：`MEMOH_ALERT_PRESET_NOTIFICATIONS=allow|deny`。
system_alerts_preset_permissions() {
  local outcome
  if outcome=$(xcrun simctl privacy "$UDID" grant all "$BUNDLE" 2>&1); then
    echo "system-alerts: 已预置 simctl 能管的权限（camera/photos/microphone/location/…），弹窗会少一批"
  else
    # 不致命：预置只是"少弹一次"，点掉那一层（`system_alerts_dismiss`）才是兜底。
    echo "system-alerts: ⚠️ 预置权限失败（不影响后续点掉兜底）：$outcome" >&2
  fi

  local notifications="${MEMOH_ALERT_PRESET_NOTIFICATIONS:-}"
  [ -n "$notifications" ] || return 0
  local applesimutils="$HOME/.maestro/deps/applesimutils"
  if [ ! -x "$applesimutils" ]; then
    echo "system-alerts: ⚠️ 找不到 $applesimutils，通知权限没预置" >&2
    return 0
  fi
  case "$notifications" in
    allow) notifications=YES ;;
    deny) notifications=NO ;;
  esac
  # 这一步会重启 SpringBoard（applesimutils 自己做的），必须在 App 起来之前调用。
  if "$applesimutils" --byId "$UDID" --bundle "$BUNDLE" --setPermissions "notifications=$notifications" > /dev/null 2>&1; then
    echo "system-alerts: 通知权限预置为 $notifications"
  else
    echo 'system-alerts: ⚠️ 通知权限预置失败（会退回"看见才点"那一层）' >&2
  fi
}

# ---------------------------------------------------------------- 截图 / 读字

system_alerts_evidence_dir() {
  echo "${MEMOH_ALERT_EVIDENCE_DIR:-${OUT:-/tmp}}"
}

system_alerts_textdump() {
  local binary="$MOBILE_SYSTEM_ALERTS/.artifacts/textdump"
  if [ ! -x "$binary" ]; then
    echo "system-alerts: 编译读字工具（textdump）…" >&2
    xcrun swiftc -O "$MOBILE_SYSTEM_ALERTS/ui/textdump.swift" -o "$binary" >&2 || return 1
  fi
  echo "$binary"
}

# 拍一张当前屏幕。`--type=png` 是必须的：默认那种格式 Vision 读不了。
system_alerts_screenshot() {
  rm -f "$1"
  xcrun simctl io "$UDID" screenshot --type=png "$1" > /dev/null 2>&1
  [ -s "$1" ]
}

system_alerts_decide() {
  # $1 = 截图；把决定打到 stdout（JSON）
  local dump
  dump=$(system_alerts_textdump) || return 1
  local ocr="$1.json"
  "$dump" "$1" > "$ocr" 2>/dev/null || return 1
  python3 "$MOBILE_SYSTEM_ALERTS/system-alerts.py" decide \
    --ocr "$ocr" --choice "${MEMOH_ALERT_CHOICE:-deny}"
}

# 既打到终端、也落进证据日志。
#
# 为什么要落盘：`launch()` 的输出是**跑的时候在屏幕上滚过去**的东西，而"这一屏有没有
# 弹窗、点了哪个按钮"正是事后唯一能复查的事实（一次验收之后要回答的是"它当时到底做没做"）。
# 只往终端打的话，去翻证据的人只能看到两张截图，看不出走了哪条分支。
system_alerts_say() {
  local dir line
  dir=$(system_alerts_evidence_dir)
  line="system-alerts: $(date '+%H:%M:%S') $*"
  print -r -- "$line"
  mkdir -p "$dir" && print -r -- "$line" >> "$dir/system-alerts.log"
}

# ---------------------------------------------------------------- 点掉它

# 点掉当前屏幕上的系统弹窗。**幂等**：没有弹窗时一个动作都不做。
#
# 返回 0 = 屏幕上现在没有系统弹窗（本来就没有，或者刚点掉并且复查过了）；
# 返回 1 = 有框但处理不掉（点不动 / 点了还在）。后者**必须当失败**：
# 让流程带着一个模态框往下跑，红的是被测对象，而真正的原因没人看得见。
system_alerts_dismiss() {
  local dir attempts=0 limit=${MEMOH_ALERT_MAX:-2}
  dir=$(system_alerts_evidence_dir)
  mkdir -p "$dir"
  local log="$dir/system-alerts.log"
  # 每次调用的证据文件名都带上这次的时间戳。
  #
  # 为什么不能固定叫 `system-alert-1-before.png`：`launch()` **每条 flow 都会调一次**，
  # 固定名字会把上一次的覆盖掉——而"上一次那个框长什么样"正是出了事之后最想回看的东西
  # （本轮验收里就发生过：第二次 launch 的"没有弹窗"那一帧把第一次带弹窗的那一帧盖了）。
  local stamp
  stamp=$(date '+%H%M%S')

  while [ "$attempts" -lt "$limit" ]; do
    attempts=$((attempts + 1))
    local before="$dir/system-alert-${stamp}-$attempts-before.png"
    if ! system_alerts_screenshot "$before"; then
      echo "system-alerts: ✗ 截不了屏（$UDID），没法判断有没有弹窗" >&2
      return 1
    fi
    local decision
    decision=$(system_alerts_decide "$before") || {
      echo "system-alerts: ✗ 读不出这一屏的文字（$before.json）" >&2
      return 1
    }
    local kind button x y
    kind=$(python3 -c 'import json,sys;print(json.loads(sys.stdin.read())["kind"] or "")' <<< "$decision")
    if [ -z "$kind" ]; then
      # 走到这里说明**当前这一屏没有系统框**：一个动作都没做，这正是幂等的那一半。
      system_alerts_say "这一屏没有系统弹窗（第 ${attempts} 次，什么都没点）"
      return 0
    fi
    button=$(python3 -c 'import json,sys;print(json.loads(sys.stdin.read())["button"] or "")' <<< "$decision")
    x=$(python3 -c 'import json,sys;print(json.loads(sys.stdin.read())["x"])' <<< "$decision")
    y=$(python3 -c 'import json,sys;print(json.loads(sys.stdin.read())["y"])' <<< "$decision")
    if [ -z "$button" ]; then
      # 认出了系统框却读不到按钮：**不猜着点**。点偏在有框时是点框、没框时是点 App，
      # 而这里连"框上有哪些按钮"都没读到，说明这一屏已经不是我们认识的那个框了。
      echo "system-alerts: ✗ 认出系统框（$kind）但读不到按钮，没有点（证据：$before）" >&2
      return 1
    fi

    system_alerts_say "发现系统框（$kind）→ 点「$button」(${x}%, ${y}%)"
    local flow="$dir/system-alert-${stamp}-$attempts-tap.yaml"
    cat > "$flow" <<YAML
# 由 system-alerts.sh 生成：点在**读出来的**按钮位置上（不是写死的坐标）。
#
# 坐标是**整数百分比**：Maestro 把百分号前那段按整数解析，写 59.31% 会在点击那一刻抛
# NumberFormatException（2026-09-16 实测：那之前"看见才点"这条路一直没真的点出去过）。
#
# ⚠️ 这个 heredoc 没有引号，所以里面的反引号与 $ 都会被展开：这个注释原来用反引号包住
# 上面那两处，结果 zsh 真去执行了它们（打出两句 command not found）。要写字面量就别用反引号。
appId: ${BUNDLE}
---
- tapOn:
    point: "${x}%,${y}%"
YAML
    if ! maestro test --udid "$UDID" --debug-output "$dir/system-alert-${stamp}-$attempts-tap" \
        --flatten-debug-output "$flow" >> "$log" 2>&1; then
      echo "system-alerts: ✗ 点「$button」那一下没打出去（Maestro 的输出：$log）" >&2
      return 1
    fi
    sleep 1

    # 复查：**必须再截一次图确认它没了**。"点了"不等于"点掉了"——
    # 点偏一点、或者框换了位置，都会让下一次 flow 莫名其妙地红。
    local after="$dir/system-alert-${stamp}-$attempts-after.png"
    system_alerts_screenshot "$after" || true
    local left
    left=$(system_alerts_decide "$after" 2>/dev/null |
      python3 -c 'import json,sys;print(json.loads(sys.stdin.read())["kind"] or "")' 2>/dev/null)
    if [ -z "$left" ]; then
      system_alerts_say "✓ 点掉了（$kind → $button），复查这一屏已经干净（证据：$before / $after）"
      return 0
    fi
    echo "system-alerts: 点了「$button」，但 $left 框还在（第 ${attempts} 次）" >&2
  done

  echo "system-alerts: ✗ 试了 ${limit} 次仍然有系统弹窗挡着，中止这条流程。" >&2
  echo "  证据：$(system_alerts_evidence_dir)/system-alert-*-before.png" >&2
  echo "  多半是按钮文案与 system-alerts.py 的表对不上（新系统 / 非英文界面）：" >&2
  echo "  看一眼那张截图，把新文案加进 DENY_BUTTONS / ALLOW_BUTTONS。" >&2
  return 1
}
