#!/bin/zsh
# 长会话电池：**同一台设备、同一个窗口**里把三档"转录长度"跑齐。
#
#   ① 噪声地板（静止）
#   ② 短：`probe-stream`（8 轮历史 ≈17 行）
#   ③ 长：`probe-stream-long`（50 轮 ≈101 行）
#   ④ 更长：`probe-stream-long-300`（300 轮 ≈600 行）
#
# ## 为什么要有这一条（而不是直接扩 run-battery.sh）
#
# `run-battery.sh` 那四组是"几何判据 + 掉帧对照"，场景长度是固定的（8 轮历史）。
# 这一条量的是**另一个问题**：每次追加的主线程单价随转录长度怎么变
# （`measure.py` 的 `append_cost`；靶子是 `NativeMessageList.apply` 的变更集合）。
# 三个长度档必须落在同一个负载窗口里，所以要在同一次调用里跑完。
#
# ## 改前/改后的配对：`--pair`
#
# 同一份 App 二进制里用 `--deep-compare` 切"变更集合走深比较（改前）还是走哈希（改后）"，
# 加了 `--pair` 之后**每个长度档都是 hash→deep 挨着跑**——两个数字同二进制、同窗口，
# 差值才能归因到那一行代码。在两个 build 之间比不行：中间会插进别人的改动与另一个负载窗口。
#
# 用法：run-battery-long.sh <udid> <out-dir> <label-prefix> [--pair] [measure.py 的附加参数…]
set -eu
UDID="$1"; OUT="$2"; PREFIX="$3"; shift 3
PAIR=no
if [ "${1:-}" = "--pair" ]; then PAIR=yes; shift; fi
# 剩下的都转发给 measure.py（`--metro-port` / `--timeout` / `--window-seconds`…）。
# ⚠️ 必须显式转发：踩过一次——脚本自己收下了参数却忘了往 run_one 里传，于是整轮跑在
# **默认的 8097**（另一个 agent 那个 Metro，它可能供着旧 bundle），场景找不到、一轮全废。
EXTRA=("$@")
HERE=$(cd "$(dirname "$0")" && pwd)
APP="${FRAME_PROBE_APP:-$HERE/../../apps/mobile/verification/.artifacts/derived-data/Build/Products/Debug-iphonesimulator/Memoh.app}"
# `FRAME_PROBE_NO_REINSTALL=1`：**每轮不重装**（设备上已经有这个 App、也不想丢掉已缓存的
# JS bundle）。满载时每轮 uninstall+install 一次 285MB 的 App 要 2–3 分钟，而重装的目的是修
# CoreSimulator 的瞬态故障——设备已经好好的时候它是纯开销。装一次交给外面的租约包（见
# `run-battery-long-leased.sh`）。
APP_ARGS=("--app" "$APP")
if [ "${FRAME_PROBE_NO_REINSTALL:-no}" = 1 ]; then APP_ARGS=(); fi
# `FRAME_PROBE_LONG_SKIP_FLOOR=1`：不跑噪声地板（设备紧的时候用；地板那格的数字就来自别的窗口，
# 引用时必须写明）。
SKIP_FLOOR="${FRAME_PROBE_LONG_SKIP_FLOOR:-no}"

# `FRAME_PROBE_LONG_NO_GESTURE=1`：不跑 `read.yaml`——只量**追加的单价**，不量 A/C 两条几何
# （那两条要"读者离开底部"的手势）。设备很挤时 Maestro 的 runner 冷启动就要几分钟，
# 而它换来的只是 A/C；这一趟若只问"单价随长度怎么变"，就别把它拖进来。
NO_GESTURE="${FRAME_PROBE_LONG_NO_GESTURE:-no}"

mkdir -p "$OUT"
echo "load before: $(uptime)" | tee -a "$OUT/battery.log"
echo "app: ${APP_ARGS[*]:-（不重装）}" | tee -a "$OUT/battery.log"
echo "pair: $PAIR；跳地板: $SKIP_FLOOR；无手势: $NO_GESTURE；附加参数: ${EXTRA[*]:-无}" | tee -a "$OUT/battery.log"

# 不作数就重跑（原因总是外部的：别的 agent 改 JS 触发热重载、CoreSimulator 瞬态、
# 手势落在流式之后）。重跑三次仍不作数就照实写进结果。
measure() {
  local target="$1"; shift
  local attempt=1
  while [ $attempt -le 3 ]; do
    python3 "$HERE/measure.py" "${APP_ARGS[@]}" "$@" 2>&1 | tee -a "$OUT/battery.log"
    if python3 - "$target/result.json" <<'PY'
import json, sys, pathlib
p = pathlib.Path(sys.argv[1])
exit_code = 0 if p.exists() and json.loads(p.read_text()).get('valid') else 1
raise SystemExit(exit_code)
PY
    then return 0; fi
    echo "↻ $target 不作数（第 $attempt 次），重跑" | tee -a "$OUT/battery.log"
    attempt=$((attempt + 1))
  done
}

# 一轮"某场景 × 某变更集合"。附加参数一并转发（见文件头的警告）。
run_one() {
  local dir="$1" label="$2" scene="$3"; shift 3
  local gesture=(--maestro "$HERE/flows/read.yaml" --expect-reading)
  if [ "$NO_GESTURE" = 1 ]; then gesture=(); fi
  measure "$OUT/$dir" --udid "$UDID" --out "$OUT/$dir" --label "$PREFIX-$label" \
    --scene "$scene" "${gesture[@]}" --hold 3 "$@" "${EXTRA[@]}"
}

if [ "$SKIP_FLOOR" != "1" ]; then
  measure "$OUT/floor" --udid "$UDID" --out "$OUT/floor" --label "$PREFIX-floor" \
    --scene chat-tools --hold 3 "${EXTRA[@]}"
fi

# 长度档。默认三档都跑；设备紧张时可以只跑其中几档
# （`FRAME_PROBE_LONG_SCENES='probe-stream-long-300'`）——**别只跑一档还叫它"曲线"**。
SCENES="${FRAME_PROBE_LONG_SCENES:-probe-stream probe-stream-long probe-stream-long-300}"

for scene in ${=SCENES}; do
  case "$scene" in
    probe-stream) slug=stream ;;
    probe-stream-long) slug=long ;;
    probe-stream-long-300) slug=long-300 ;;
  esac
  run_one "$slug" "$slug" "$scene"
  if [ "$PAIR" = yes ]; then
    run_one "$slug-deep" "$slug-deep" "$scene" --deep-compare
  fi
done

echo "load after: $(uptime)" | tee -a "$OUT/battery.log"
python3 "$HERE/compare.py" "$OUT"/*/result.json 2>&1 | tee -a "$OUT/battery.log"
