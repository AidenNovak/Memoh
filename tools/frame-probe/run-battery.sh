#!/bin/zsh
# 一次量完一轮的四组（尺子的"电池"）：
#   ① 噪声地板（静止列表）② 流式基准 + 反复往上划 ③ 重载对照 ④ 探针自校准（注入 stall）
#
# ## 为什么要一次跑完
#
# 本机 load 在几百上下浮动。要判"改前 vs 改后"，两轮必须落在**同一个负载窗口**里，
# 所以组内不做别的事、也不改源码（改 JS 会被 Metro 热重载，把界面抽走——本轮真实踩到过，
# 表现是探针记下的 `host_gone`）。
#
# 用法：run-battery.sh <udid> <out-dir> <label-prefix>
set -eu
UDID="$1"; OUT="$2"; PREFIX="$3"
HERE=$(cd "$(dirname "$0")" && pwd)
APP="${FRAME_PROBE_APP:-$HERE/../../apps/mobile/verification/.artifacts/derived-data/Build/Products/Debug-iphonesimulator/Memoh.app}"

mkdir -p "$OUT"
echo "load before: $(uptime)" | tee -a "$OUT/battery.log"
echo "app: $APP" | tee -a "$OUT/battery.log"

# 一轮里某个场景"不作数"（探针没 attach、手势没落到流式里）时**重跑它**。
# 为什么重跑而不是接受：不作数的原因是**外部**的（别的 agent 改 JS 触发 Metro 热重载、
# CoreSimulator 瞬态、手势落在流式之后），不是被测代码。但"不作数"绝不能当通过——
# 重跑两次还是不作数就照实写进结果。
measure() {
  local target="$1"; shift
  local attempt=1
  while [ $attempt -le 3 ]; do
    python3 "$HERE/measure.py" --app "$APP" "$@" 2>&1 | tee -a "$OUT/battery.log"
    if python3 - "$target/result.json" <<'PY'
import json, sys, pathlib
p = pathlib.Path(sys.argv[1])
sys.exit(0 if p.exists() and json.loads(p.read_text()).get('valid') else 1)
PY
    then return 0; fi
    echo "↻ $target 不作数（第 $attempt 次），重跑" | tee -a "$OUT/battery.log"
    attempt=$((attempt + 1))
  done
}

measure "$OUT/floor" --udid "$UDID" --out "$OUT/floor" \
  --label "$PREFIX-floor" --scene chat-tools --hold 3

measure "$OUT/stream" --udid "$UDID" --out "$OUT/stream" \
  --label "$PREFIX-stream" --scene probe-stream --maestro "$HERE/flows/read.yaml" --expect-reading --hold 3

measure "$OUT/heavy" --udid "$UDID" --out "$OUT/heavy" \
  --label "$PREFIX-heavy" --scene probe-stream-heavy --maestro "$HERE/flows/read.yaml" --expect-reading --hold 3

measure "$OUT/stall" --udid "$UDID" --out "$OUT/stall" \
  --label "$PREFIX-stall-control" --scene probe-stream --stall-ms 25 --hold 3

echo "load after: $(uptime)" | tee -a "$OUT/battery.log"
python3 "$HERE/compare.py" --control "$OUT/floor/result.json" \
  "$OUT/stream/result.json" "$OUT/heavy/result.json" "$OUT/stall/result.json" \
  2>&1 | tee -a "$OUT/battery.log"
