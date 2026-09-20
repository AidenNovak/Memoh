#!/bin/zsh
# 设备纪律：**规范设备写进脚本，不靠自动发现；拿不到就明确失败，并说清谁占着**。
#
# 被 `files/run.sh`、`onboarding/run.sh`、`push/push-run.sh` 共用（以前 e2e / navigation
# 各抄了一份"从 `simctl list` 里挑一台名字里有 Verify 的"——那是这套纪律烂掉的地方；
# 那两个 harness 已于 2026-09-19 删除）。
#
# ## 为什么"自动发现"必须去掉
#
# 自动发现在**同名设备**下必然出错，而且错得没有声音：
#
#   * 现在池子里两台设备都叫 `Memoh push acceptance Verify`（`simctl list` 里一字不差）；
#   * `"Verify" in device["name"]` 这种匹配还会**匹配到别人的设备**——
#     实测：本机自动发现挑中的是 `Memoh presentation scenes Verify`（别人的），
#     而 E2E 自己的那台 `Memoh e2e verify` 因为小写 v 反而匹配不上；
#   * 后果是已经出过三次的事故：脚本把 flow 发到了别人的设备上、录制互相打断、
#     "脚本明明跑绿了但测的不是这次要测的东西"。
#
# 所以这里只有一条路：**设备来自租约**（`pnpm verify:simulator` 导出的
# `MEMOH_VERIFY_UDID` + `MEMOH_VERIFY_LEASE_TOKEN`）。拿不到就失败——**不换一台继续跑**。
# 换一台继续跑是这套纪律里最坏的一种"成功"：绿的是一条没人要求的结论。
#
# 依赖调用方已导出 `$OUT`（证据目录，可空）。

# 这个文件（以及 `system-alerts.sh`、`lib.sh`）用 zsh 的 `${(%):-%x}` 找自己，bash 没有这个
# 语法。用 bash 跑会在下面那一行报一句 `bad substitution`——看不懂，也找不到原因
# （shebang 管不了"被 source"的情形：sourcing 的 shell 说了算）。所以先说清楚。
if [ -n "${BASH_VERSION:-}" ]; then
  echo "✗ 这些验收脚本要在 zsh 里跑（bash 会把 \${(%):-%x} 报成 bad substitution）。" >&2
  echo "  例：zsh apps/mobile/verification/files/run.sh" >&2
  exit 2
fi

MOBILE_VERIFY_ROOT=$(cd "$(dirname "${(%):-%x}")/.." && pwd)

# 说清"该怎么拿设备"——失败信息里必须有这一步，否则下一个人唯一的出路还是绕开。
device_lease_instructions() {
  cat <<'TEXT'
  正确做法（一次租一台，租约会自动分配并锁定一台空闲设备）：
      pnpm verify:simulator --name native -- pnpm verify:native
      pnpm verify:simulator --name files -- zsh verification/files/run.sh
      pnpm verify:simulator --name 'session actions' -- zsh verification/session-actions/run.sh
  看一眼谁占着哪台：
      pnpm verify:simulator --list
TEXT
}

# 有没有别人正在驱动这台设备（租约之外的第二种证据）。
#
# 租约只能约束**用租约的人**。有人把 UDID 写死、直接 `maestro --udid <id>` 时，
# 我们这边"租约在我手上"是真的，但设备仍然被别人同时用着——那会让两个结论都不可信。
# 所以除了租约，再看一眼"有没有别的进程正在驱动它"，有就把 pid 说出来。
device_contention_evidence() {
  local udid="$1"
  local evidence=""
  local recorder maestro_processes
  recorder=$(pgrep -f "simctl io ${udid} recordVideo" 2>/dev/null || true)
  [ -n "$recorder" ] && evidence="${evidence}录屏进程 $recorder；"
  maestro_processes=$(pgrep -f "maestro .*--udid ${udid}" 2>/dev/null || true)
  [ -n "$maestro_processes" ] && evidence="${evidence}Maestro 进程 $maestro_processes；"
  [ -n "$evidence" ] && print -r -- "$evidence"
  return 0
}

# 校验并导出 `$UDID`。失败一律 `exit 2`（= 没能开始验，不是"验了没过"）。
require_leased_device() {
  local leased="${MEMOH_VERIFY_UDID:-}"
  local override="${MEMOH_PROBE_UDID:-}"
  local forced="${MEMOH_VERIFY_LEASE_FORCE:-}"

  if [ -z "$leased" ]; then
    echo "✗ 没有设备租约：这个套件不再自己挑设备（自动发现在同名设备下必然出错）。" >&2
    if [ -n "$override" ]; then
      echo "  你只给了 MEMOH_PROBE_UDID（$override）。**光有 UDID 不算租约**——" >&2
      echo "  写死 UDID 正是这台机器上出过三次事故的那个做法。" >&2
    fi
    device_lease_instructions >&2
    exit 2
  fi

  # 租约这一关：`--check-lease` 会去看锁文件**有没有人真持着**，以及那个人是不是
  # 这次运行。只看环境变量是不够的（别人把自己的 shell 也导出同一个变量就长一样）。
  #
  # ⚠️ 这一行必须是 `... || code=$?`，**不能**写成两行（`x=$(...)` 然后 `code=$?`）：
  # `--check-lease` 的退出码本身就是判据（0/3/4），而赋值语句的退出码就是命令替换的退出码。
  # 两行写法在 `set -e` 下会在**它返回非 0 的那一刻**直接掐掉整个脚本——**一句话都不打印**
  # 就 exit 3（3 还正好撞上"固定服务端死了"那个退出码）。也就是说：最该拦住人的那两种情形
  # （写死 UDID、设备被别人占着）反而变成了静默的、看不懂的退出码。
  # 2026-09-16 验收时实测抓到：`MEMOH_VERIFY_UDID=<别人的设备>` 跑出来的正是"无输出 + exit 3"。
  local output code=0
  output=$(python3 "$MOBILE_VERIFY_ROOT/verification/simulator.py" --check-lease "$leased" 2>&1) || code=$?
  case "$code" in
    0) ;;
    *)
      if [ -n "$forced" ]; then
        echo "⚠️ 设备租约这一关没过（$output），但 MEMOH_VERIFY_LEASE_FORCE=$forced 让我继续。" >&2
        echo "  这条记录会留在证据里：这次的结论是**在别人的租约外面**跑出来的。" >&2
      else
        if [ "$code" = 3 ]; then
          echo "✗ ${leased} 上没有租约（没人持着它的租约锁）：这个 UDID 是被人手写进来的。" >&2
        else
          echo "✗ ${leased} 被别人的租约占着，我不会用它跑（也不会换一台偷偷继续）。" >&2
          echo "  $output" >&2
        fi
        device_lease_instructions >&2
        echo "  确认那台设备确实空闲、你就是要手动用它：MEMOH_VERIFY_LEASE_FORCE=1（会在证据里留警告）。" >&2
        exit 2
      fi
      ;;
  esac

  if [ -n "$override" ] && [ "$override" != "$leased" ]; then
    if [ -n "$forced" ]; then
      echo "⚠️ MEMOH_PROBE_UDID（$override）与租约里的设备（$leased）不是同一台；按 FORCE 用它。" >&2
      leased="$override"
    else
      echo "✗ MEMOH_PROBE_UDID（$override）与租约里的设备（$leased）不是同一台。" >&2
      echo '  指向两台设备只会让「谁在用哪台」变成猜；要么去掉 MEMOH_PROBE_UDID（用租约里的），' >&2
      echo "  要么用 MEMOH_VERIFY_LEASE_FORCE=1 明确表示你在手动指定。" >&2
      exit 2
    fi
  fi

  # 第二关：租约在手上，但设备可能正被别人（不用租约的人）驱动着。
  local contention
  contention=$(device_contention_evidence "$leased")
  if [ -n "$contention" ]; then
    if [ -n "$forced" ]; then
      echo "⚠️ 这台设备上还有别的进程：$contention（FORCE，继续）" >&2
    else
      echo "✗ 租约在我手上，但${leased}上还有别的进程正在用它：" >&2
      echo "  $contention" >&2
      echo "  这说明有人没走租约（写死了 UDID）。两个人用一台设备时两边的结论都不成立，" >&2
      echo "  所以我停下来而不是接着跑。等它结束，或者删掉那几个进程（kill <pid>）再跑。" >&2
      exit 2
    fi
  fi

  UDID="$leased"
  export UDID
  local describe
  describe=$(python3 "$MOBILE_VERIFY_ROOT/verification/simulator.py" --list 2>/dev/null |
    grep -F "$UDID" | head -1)
  echo "① 设备（来自租约）：${describe:-$UDID}"
  [ -n "${OUT:-}" ] && print -r -- "device=$UDID lease=${MEMOH_VERIFY_LEASE_TOKEN:-none}" >> "$OUT/device.txt"
  return 0
}
