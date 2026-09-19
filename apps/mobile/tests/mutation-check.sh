#!/usr/bin/env bash
#
# 失败路径测试的**反假绿**验证：故意把被测行为改坏一次，确认对应用例真的会红。
#
# 为什么需要它：本仓库出现过"测试通过但其实没验任何东西"（`set -e` 失效、场景只挡 POST
# 而实际走 PUT）。失败路径的断言尤其危险——`assert.rejects` 外面套一层 try/catch、或者
# 断言写在永远执行不到的分支里，都是**绿的**。所以每加一条失败路径断言，都要先把被盯的
# 行为弄坏一次，看到它红。
#
# ## 关键约定：改坏的是**服务器上的副本**，不是你的工作树
#
# 工作树里同时有多个 agent 在改 `src/**`。这里只把变异后的文件 rsync 到
# `vultr-sg:/srv/memoh-ios-js/work/`（跑门禁的那份快照），跑完立刻把干净文件传回去。
# **本地文件一个字节都不会被动。**
#
# 用法（在 apps/mobile 下）：
#     tests/mutation-check.sh --list          # 看全部变异
#     tests/mutation-check.sh <变异名>        # 跑一个
#     tests/mutation-check.sh --all           # 全跑
#
# 输出：`RED ✓`（用例真的红了，这条断言有效）/ `GREEN ✗`（没抓住 = 假绿，退出码 1），
# 并打印实际失败的那条断言。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # apps/mobile
REMOTE="${MEMOH_BUILD_HOST:-vultr-sg}"
# 跑门禁的那份快照。**可以用环境变量换一个**：这条脚本会往 $WW 里 rsync 变异后的文件、
# 跑完再传回干净的；多个 agent 同时用同一个目录时，别人的门禁可能正好读到你的变异版
# （症状是"别人的用例红在一个和我无关的文件上"）。和 `tools/run-logic-tests.sh` 的
# `MEMOH_KIT_TEST_DIR` 是同一条纪律。
WW="${MEMOH_JS_WORK:-/srv/memoh-ios-js/work}"
ST=/srv/memoh-ios-js/pnpm-store
IMAGE=node:22-bookworm-slim

# 变异表：名字 | 源文件（相对 apps/mobile）| 要跑的测试文件 | 替换对（Python 列表，每对
# `(原文, 新文)`；**每一对的原文都必须命中**，否则这条变异直接报错退出——今天两次假绿都
# 出在"以为改到了、其实没改"，所以这里不给自己留"悄悄只改了一半"的余地）。
#
# 只替换第一处（`str.replace(..., 1)`）是有意的：锚点写在意图的位置上，别处不受影响。
#
# ⚠️ 锚点与替换文里**不能出现 `|`**：这张表是 `cut -d'|'` 切的，多一个竖线就会把表达式
# 截断（Python 那边报 `unterminated string literal`）。要盯带 `||` 的条件就换个不含竖线的
# 锚点（2026-09-17 实测踩过一次）。
mutations() {
  cat <<'TABLE'
heartbeat-deadline-pushed|src/api/realtime.ts|tests/realtime-failure.test.mjs|[("    if (this.livenessTimer !== null) return;\n", "    this.stopLivenessTimer();\n")]
heartbeat-false-positive|src/api/realtime.ts|tests/realtime-failure.test.mjs|[("      if (this.lastInboundAt >= probeAt) return; // 有回音，链路活着\n", "")]
heartbeat-guess-without-subscription|src/api/realtime.ts|tests/realtime-failure.test.mjs|[("    if (sessions.length === 0) return;\n", "")]
reconnect-replays-delivered-frames|src/api/realtime.ts|tests/realtime-failure.test.mjs|[("  private outbox: ClientFrame[] = [];", "  private outbox: ClientFrame[] = [];\n  private delivered: ClientFrame[] = [];"), ("    try {\n      socket.send(JSON.stringify(frame));\n    } catch (error) {", "    this.delivered.push(frame);\n    try {\n      socket.send(JSON.stringify(frame));\n    } catch (error) {"), ("      for (const sessionId of this.subscriptions.keys()) this.subscribe(sessionId);\n      this.flushOutbox();", "      for (const sessionId of this.subscriptions.keys()) this.subscribe(sessionId);\n      for (const f of this.delivered) socket.send(JSON.stringify(f));\n      this.flushOutbox();")]
reconnect-double-books-sent-frames|src/api/realtime.ts|tests/realtime-failure.test.mjs|[("    try {\n      socket.send(JSON.stringify(frame));\n    } catch (error) {", "    this.outbox.push(frame);\n    this.notifyPending();\n    try {\n      socket.send(JSON.stringify(frame));\n    } catch (error) {")]
snapshot-keeps-delta-leftovers|src/features/chat/reducer.ts|tests/reducer-failure.test.mjs|[("  const base: ChatState = {\n    ...initialChatState,", "  const base: ChatState = {\n    ...state,")]
terminal-frame-rebuilds-state|src/features/chat/reducer.ts|tests/reducer-failure.test.mjs|[("  let next: ChatState = { ...state, epoch, seq, pendingSend: false };", "  let next: ChatState = { ...initialChatState, epoch, seq, pendingSend: false };")]
history-clears-optimistic|src/features/chat/reducer.ts|tests/reducer-failure.test.mjs|[("    ...coverOptimistic(state, null, turns),", "    optimistic: [],")]
covered-run-rendered-twice|src/features/chat/reducer.ts|tests/duplicate-turn.test.mjs|[("  const blocks = represented ? {} : runBlocks;\n  const order = represented ? [] : runOrder;", "  const blocks = runBlocks;\n  const order = runOrder;")]
history-clears-unrepresented-run|src/features/chat/reducer.ts|tests/duplicate-turn.test.mjs|[("    ...(represented ? { liveUserTurns: [], blocks: {}, order: [], streams: {}, progress: {} } : {}),", "    liveUserTurns: [],\n    blocks: {},\n    order: [],\n    streams: {},\n    progress: {},")]
terminal-run-dropped-without-history|src/features/chat/reducer.ts|tests/duplicate-turn.test.mjs|[("  if (historyShowsTurn(history, turnId)) return true;\n  if (active) return false;", "  if (active) return false;\n  return turnId !== null;")]
fallback-message-goes-to-screen|src/features/errors/present.ts|tests/client-failure.test.mjs|[("  if (/^HTTP \\d+$/.test(message)) return undefined;\n", "")]
queue-poll-interval-wrong|src/features/session/coordinator.ts|tests/session-coordinator.test.mjs|[("export const QUEUE_POLL_INTERVAL_MS = 10_000;", "export const QUEUE_POLL_INTERVAL_MS = 1_000;")]
queue-poll-ignores-empty-queue|src/features/session/coordinator.ts|tests/session-coordinator.test.mjs|[("    if (view.pendingItems === 0) {", "    if (view.pendingItems < 0) {")]
orphan-poll-ignores-lease|src/features/session/coordinator.ts|tests/session-coordinator.test.mjs|[("    if (!view.abandoned) {\n      note('orphan-poll', 'skip-live-run', view.currentSessionId);\n      return;\n    }\n", "")]
run-edge-repeats|src/features/session/coordinator.ts|tests/session-coordinator.test.mjs|[("    const wasRunning = prevRunning.get(sessionId) === true;", "    const wasRunning = true;")]
stop-keeps-timers|src/features/session/coordinator.ts|tests/session-coordinator.test.mjs|[("      for (const handle of handles) timers.clearInterval(handle);\n      handles = [];\n", "      handles = [];\n")]
sourcelabel-keeps-empty-part|src/features/session/sourceLabel.ts|tests/sourcelabel.test.mjs|[("    (part): part is string => typeof part === 'string' && part.trim() !== '',\n", "    (part): part is string => part !== undefined,\n")]
retry-whitelist-always-true|src/features/chat/pending.ts|tests/pending-retry.test.mjs|[("  return RETRYABLE_REJECTION_CODES.has(code.trim());", "  return true;")]
history-paging-drops-newer|src/features/chat/reducer.ts|tests/history-paging.test.mjs|[("    history: mergeTurns(page, state.history),", "    history: page,")]
history-paging-ignores-empty-page|src/features/chat/reducer.ts|tests/history-paging.test.mjs|[("  const existingKeys = state.history.map((turn) => turn.key);\n", "  const existingKeys: string[] = [];\n")]
session-page-replaces|src/features/session/paging.ts|tests/session-paging.test.mjs|[("  return uniqueSessions([...current, ...page]);", "  return page;")]
sessions-cursor-not-sent|src/api/client.ts|tests/paging-roundtrip.test.mjs|[("      query: { limit: options.limit, cursor: options.cursor },", "      query: { limit: options.limit },")]
messages-before-not-sent|src/api/client.ts|tests/paging-roundtrip.test.mjs|[("        before_message_id: options.beforeMessageId,", "        before_message_id: undefined,")]
schedule-keyboard-never-scrolls|src/features/schedule/keyboard.ts|tests/schedule-keyboard.test.mjs|[("  if (overflow <= 0) return 0;\n  return overflow;", "  return 0;")]
schedule-command-loses-focus|src/screens/ScheduleEditScreen.tsx|tests/schedule-keyboard.test.mjs|[("            onFocus={onFieldFocus}\n", "")]
bot-settings-save-bar-removed|src/screens/BotSettingsScreen.tsx|tests/bot-settings-unsaved.test.mjs|[("testID=\"bot-settings-save-bar\"", "testID=\"bot-settings-save-bar-gone\"")]
bot-settings-save-says-done|src/screens/BotSettingsScreen.tsx|tests/bot-settings-unsaved.test.mjs|[("{saving ? t('botSettings.saving') : t('botSettings.save')}", "{saving ? t('botSettings.saving') : t('common.done')}")]
bot-settings-leave-skips-guard|src/screens/BotSettingsScreen.tsx|tests/bot-settings-unsaved.test.mjs|[("    if (!dirty) return true;", "    return true;")]
bot-settings-save-failure-still-leaves|src/screens/BotSettingsScreen.tsx|tests/bot-settings-unsaved.test.mjs|[("            if (saved) leave();", "            leave();")]
back-button-prints-route-name|src/app/preview.tsx|tests/navigation-copy.test.mjs|[("        options={{ headerShown: true, title, headerBackButtonDisplayMode: 'minimal' }}", "        options={{ headerShown: true, title, headerBackTitle: '(tabs)' }}")]
login-hint-dropped|src/screens/LoginScreen.tsx|tests/navigation-copy.test.mjs|[("{t('login.server.hint')}", "{''}")]
bot-checks-internal-identifiers-on-screen|src/features/bots/checks.ts|tests/bot-checks.test.mjs|[("    title: t(key),\n", "    title: (check.summary ?? '') + ' ' + (check.detail ?? ''),\n")]
bot-checks-expanded-by-default|src/features/bots/checks.ts|tests/bot-checks.test.mjs|[("    lines: expanded ? checks.map((check) => lineFor(check, t)) : [],", "    lines: checks.map((check) => lineFor(check, t)),")]
bot-checks-technical-details-dropped|src/features/bots/checks.ts|tests/bot-checks.test.mjs|[("  const parts = [check.id.trim(), check.status.trim()];", "  const parts: string[] = [];")]
bot-create-avatar-not-wired|src/screens/BotCreateScreen.tsx|tests/settings-and-avatar.test.mjs|[("            onPress={pickAvatar}\n", "            onPress={() => undefined}\n")]
bot-create-avatar-says-url|src/screens/BotCreateScreen.tsx|tests/settings-and-avatar.test.mjs|[("            title={t('avatar.row')}\n", "            title={t('bots.field.displayName')}\n")]
composer-stop-becomes-send|src/features/chat/queue.ts|tests/chat-acceptance.test.mjs|[("  if (input.running) return 'stop';\n", "  if (input.running) return 'send';\n")]
pending-offline-says-awaiting|src/features/chat/pending.ts|tests/pending-send.test.mjs|[("      phase: 'queued',", "      phase: 'awaiting',")]
route-replace-not-guarded-by-new|src/features/chat/route.ts|tests/chat-route.test.mjs|[("  if (!input.isNew) return null;\n", "")]
approval-key-drops-approval-id|src/features/chat/presentation.ts|tests/chat-route.test.mjs|[("  return `${input.sessionId}:${input.approvalId}`;", "  return `${input.sessionId}`;")]
composer-glyph-ignores-action|src/features/chat/composer.ts|tests/chat-copy.test.mjs|[("    glyph: action === 'stop' ? '■' : '↑',", "    glyph: '↑',")]
run-failure-announced-when-not-errored|src/features/chat/copy.ts|tests/chat-copy.test.mjs|[("  if (input.runStatus !== 'errored') return null;", "  if (input.runStatus === null) return null;")]
TABLE
}

docker() {
  # `< /dev/null` 不是装饰：`ssh` 会读 stdin，而 `--all` 的循环正是从 stdin 喂变异名的
  # ——不挡住的话第一条跑完就把剩下的变异名全吃掉（本轮踩过一次）。
  ssh -n "$REMOTE" "docker run --rm --cpus=4 --memory=6g --memory-swap=6g --pids-limit=2048 \
    -v $WW:/work -v $ST:/store -e PNPM_HOME=/store/pnpm-home -w /work/apps/mobile \
    $IMAGE $*"
}

run_one() {
  local name="$1"
  local row src_rel test_rel expr clean work out code
  row="$(mutations | grep -F "$name|" || true)"
  if [[ -z "$row" ]]; then echo "没有这个变异：$name" >&2; return 2; fi
  src_rel="$(echo "$row" | cut -d'|' -f2)"
  test_rel="$(echo "$row" | cut -d'|' -f3)"
  expr="$(echo "$row" | cut -d'|' -f4)"

  work="$(mktemp -d)"
  clean="$work/clean"
  cp "$ROOT/$src_rel" "$clean"
  # 变异只发生在临时副本上：本地文件保持原样。每一对替换都必须命中。
  python3 - "$clean" "$expr" <<'PY'
import ast, pathlib, sys

path = pathlib.Path(sys.argv[1])
src = path.read_text()
pairs = ast.literal_eval(sys.argv[2])
for old, new in pairs:
    if old not in src:
        sys.exit('锚点没命中，这条变异不算数：' + repr(old[:70]))
    src = src.replace(old, new, 1)
path.write_text(src)
PY

  rsync -az "$clean" "$REMOTE:$WW/apps/mobile/$src_rel"
  # 变异必须**真的到了服务器**才谈得上"跑了变异版"——今天的假绿都出在"以为改到了，其实没改"。
  local local_sum remote_sum
  local_sum="$(md5 -q "$clean" 2>/dev/null || md5sum "$clean" | cut -d' ' -f1)"
  remote_sum="$(ssh -n "$REMOTE" "md5sum $WW/apps/mobile/$src_rel" | cut -d' ' -f1)"
  if [[ "$local_sum" != "$remote_sum" ]]; then
    echo "变异没有同步到服务器（本地 $local_sum / 服务器 $remote_sum）—— 结论不算数"
    rsync -az "$ROOT/$src_rel" "$REMOTE:$WW/apps/mobile/$src_rel"
    return 3
  fi
  set +e
  out="$(docker node --experimental-strip-types --experimental-test-module-mocks --test "$test_rel" 2>&1)"
  code=$?
  set -e
  rsync -az "$ROOT/$src_rel" "$REMOTE:$WW/apps/mobile/$src_rel"   # 立刻把干净文件传回服务器
  rm -rf "$work"

  echo "$out" | grep -E '^# (tests|pass|fail)' || true
  if [[ $code -ne 0 ]]; then
    echo "--- 红在这条用例上："
    echo "$out" | grep -E '^not ok' | head -5
    echo "$out" | grep -E 'AssertionError|Error \[' | head -6
    echo "RED ✓  $name"
    return 0
  fi
  echo "GREEN ✗ $name —— 变异没被抓住，这条用例是假绿"
  return 1
}

case "${1:-}" in
  --list) mutations | cut -d'|' -f1 ;;
  --all)  fail=0
          while read -r n; do run_one "$n" || fail=1; echo; done < <(mutations | cut -d'|' -f1)
          exit "$fail" ;;
  "")     echo "用法：tests/mutation-check.sh <变异名>（--list / --all）" >&2; exit 2 ;;
  *)      run_one "$1" ;;
esac
