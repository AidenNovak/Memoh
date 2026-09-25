#!/usr/bin/env bash
# 真联调：同一批端点、同一批参数，分别用 **TS 客户端** 与 **Swift 客户端** 打 dev 实例，
# 逐字段比规范化结果。
#
# ## 它证明什么（以及不证明什么）
#
# 契约测试与夹具都是"离线自洽"：它们证明客户端对**给定字节**的处理是对的，但字节是夹具
# 给的。这一层证明的是另一件事：**两个客户端对着同一台真服务器会得到同样的结果**——
# 包括真服务器才会给的形状（多出来的键、`omitempty` 缺掉的键、真实游标、真实错误页）。
#
# 比的是"规范化之后"的 JSON（§6 的语义）：键序无关、`1` 与 `1.0` 等价。
# 一处**已知且刻意**的不对称：Swift 的 typed 模型会**丢掉未建模的键**（§4 第 7 条：未知键
# 忽略），而 TS 是直通、会把它们留着。所以"TS 有、Swift 没有"只当**信息**列出（带条数），
# 不当差异——否则每个 typed 端点都会永远红。反过来"Swift 有、TS 没有"或"两边值不同"是**真差异**。
#
# ## 凭据（铁律）
#
# 口令只在 **vultr-sg 的进程内**读（`/opt/memoh-dev/secrets/memoh-dev.env`）；token 由那次
# ssh 直接吐进本脚本的一个 shell 变量，**不打印、不落文件、不进夹具、不进 git**。
# token 只以环境变量的形式交给两个子进程（node / 探针），不走命令行参数（argv 会进 `ps`）。
# 本脚本的输出只有：端点名、HTTP 状态、是否相同、差异摘要。
#
# ## 写操作
#
# 只有一处：`createDeleteSession`（建一个临时会话、取出 id、立刻删掉）。它跑在 ios-dev
# 这个 bot 上，不碰别的数据；id 不进对比（每次运行本来就不同），比的是"两边都能建、都能删"。
#
# ## 用法
#
#   bash tools/api-parity-live.sh
#
# 需要：本机到 vultr-sg 的隧道（`infra/local/memoh-tunnel.sh start`，脚本会自己确认）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="${MEMOH_PARITY_API:-http://127.0.0.1:18080}"
REMOTE_HOST="${MEMOH_PARITY_HOST:-vultr-sg}"
BOT_NAME="${MEMOH_PARITY_BOT:-ios-dev}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/memoh-parity.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

log() { printf '%s\n' "$*" >&2; }

# ---------------------------------------------------------------- 0. 隧道
if ! curl -s -o /dev/null -m 8 -w '' "$API/bots" 2>/dev/null; then
  log "dev 实例不可达（${API}），尝试起隧道…"
  bash "$ROOT/infra/local/memoh-tunnel.sh" start >&2
fi
code="$(curl -s -o /dev/null -m 8 -w '%{http_code}' "$API/bots" || true)"
case "$code" in
  2*|4*) : ;;
  *) log "dev 实例仍不可达（HTTP '$code'）：先跑 infra/local/memoh-tunnel.sh status"; exit 1 ;;
esac
log "dev 实例可达（未认证 /bots → ${code}）"

# ---------------------------------------------------------------- 1. 拿 token（只在进程内）
# 这次 ssh 的 stdout **只有 token 一行**：口令在远端读、登录也在远端做，
# 本地只接住结果，不打印、不落盘。
TOKEN="$(ssh -o ConnectTimeout=20 "$REMOTE_HOST" 'bash -s' <<'REMOTE'
set -euo pipefail
set -a
# shellcheck disable=SC1091
. /opt/memoh-dev/secrets/memoh-dev.env
set +a
API="${MEMOH_CAPTURE_API:-http://127.0.0.1:18080}"
printf '{"username":"admin","password":"%s"}' "$MEMOH_ADMIN_PASSWORD" \
  | curl -s -X POST "$API/auth/login" -H 'Content-Type: application/json' --data-binary @- \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])'
REMOTE
)"
[ -n "$TOKEN" ] || { log "没拿到 token"; exit 1; }
log "已拿到 token（长度 ${#TOKEN}，不打印内容）"

# ---------------------------------------------------------------- 2. 发现 bot / 会话 / schedule
# 用 python 读环境变量里的 token（不走 argv），只输出**非机密**的 id。
export MEMOH_PARITY_TOKEN="$TOKEN"
read -r BOT_ID SESSION_ID SCHEDULE_ID <<EOF
$(MEMOH_API="$API" MEMOH_BOT_NAME="$BOT_NAME" python3 - <<'PY'
import json, os, urllib.request

api = os.environ["MEMOH_API"]
token = os.environ["MEMOH_PARITY_TOKEN"]

def get(path):
    req = urllib.request.Request(api + path, headers={"Authorization": "Bearer " + token})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)

bots = get("/bots")["items"]
bot = next((b for b in bots if b.get("name") == os.environ["MEMOH_BOT_NAME"]), None)
if bot is None:
    raise SystemExit("找不到 bot %r" % os.environ["MEMOH_BOT_NAME"])
bot_id = bot["id"]

# 取一个"有消息的 chat 会话"：比空会话能覆盖更多解码分支。
session_id = ""
for s in reversed(get("/bots/%s/sessions?types=chat&limit=60" % bot_id)["items"]):
    body = get("/bots/%s/messages?session_id=%s&limit=5" % (bot_id, s["id"]))
    if body.get("items"):
        session_id = s["id"]
        break
if not session_id:
    raise SystemExit("这个 bot 没有带消息的 chat 会话")

schedules = get("/bots/%s/schedule" % bot_id)["items"]
schedule_id = schedules[0]["id"] if schedules else ""

print(bot_id, session_id, schedule_id)
PY
)
EOF
[ -n "$BOT_ID" ] && [ -n "$SESSION_ID" ] || { log "发现 bot/会话失败"; exit 1; }
log "bot=$BOT_ID session=$SESSION_ID schedule=${SCHEDULE_ID:-（无）}"

# ---------------------------------------------------------------- 3. 调用清单（两边共用）
# 清单是**同一个 JSON**，两个客户端各读一遍。写死两份就会出现"TS 跑 A 清单、Swift 跑 B 清单"，
# 那是在比清单不是比客户端。
CALLS="$(MEMOH_BOT="$BOT_ID" MEMOH_SESSION="$SESSION_ID" MEMOH_SCHEDULE="$SCHEDULE_ID" python3 - <<'PY'
import json, os

bot = os.environ["MEMOH_BOT"]
session = os.environ["MEMOH_SESSION"]
schedule = os.environ["MEMOH_SCHEDULE"]

calls = [
    ("me", "me", {}),
    ("list-bots", "listBots", {}),
    # volatile：dev 实例上有一个每分钟建一条会话的定时任务，"最新 3 条"在两次调用之间
    # 本来就会变——那是服务端在动，不是客户端不一致。这类端点只比结构（键集/条数）。
    ("list-sessions", "listSessions", {"botId": bot, "limit": 3, "volatile": True}),
    ("get-session", "getSession", {"botId": bot, "sessionId": session}),
    ("list-messages", "listMessages", {"botId": bot, "sessionId": session, "limit": 200}),
    ("session-status", "getSessionStatus", {"botId": bot, "sessionId": session}),
    ("session-status-dynamic", "sessionStatus", {"botId": bot, "sessionId": session}),
    ("bot-settings", "getBotSettings", {"botId": bot}),
    ("get-container", "getContainer", {"botId": bot}),
    ("container-metrics", "getContainerMetrics", {"botId": bot, "volatile": True}),
    ("container-display", "getDisplay", {"botId": bot}),
    ("bot-checks", "listBotChecks", {"botId": bot, "volatile": True}),
    ("skills-catalog", "listSkills", {"botId": bot}),
    ("list-files", "listFiles", {"botId": bot, "path": "/"}),
    ("read-file", "readFile", {"botId": bot, "path": "/etc/hostname"}),
    ("stat-file", "statFile", {"botId": bot, "path": "/etc/hostname"}),
    # 404 那一支：两边对"文件不存在"的映射必须一致（客户端把它当"不存在"而不是"网络坏了"）
    ("stat-file-missing", "statFile", {"botId": bot, "path": "/no-such-path-9b1"}),
    ("models", "listModels", {}),
    ("providers", "listProviders", {}),
    ("schedule-list", "listSchedules", {"botId": bot}),
    # volatile：与 list-sessions 同一个原因——这份日志流就是那个"每分钟建一条会话"的定时
    # 任务产生的，"最新 2 条"在两次调用之间会翻页。实测踩过：一次跑出 TS 看到 `ok`/空
    # error_message、Swift 看到 `error`/402 余额不足且多一个 completed_at，重跑即一致
    # （两次调用之间换了一条日志，不是两个客户端不一致）。
    ("schedule-logs", "listScheduleLogs", {"botId": bot, "limit": 2, "volatile": True}),
    # 4 态名字可用性：`reason` 的取值与"可用时没有 reason"这件事都在这里
    ("name-avail-available", "checkBotNameAvailability", {"name": "root"}),
    ("name-avail-taken", "checkBotNameAvailability", {"name": "ios-dev"}),
    ("name-avail-invalid", "checkBotNameAvailability", {"name": "a"}),
    ("name-avail-reserved", "checkBotNameAvailability", {"name": "admin"}),
    # 这台部署没有 /queue 路由（上游镜像比源码旧），两边应当**一致地**报 404
    ("session-queue", "getSessionQueue", {"botId": bot, "sessionId": session}),
    # token-usage 缺 from/to 参数 → 400，同样是"错误映射一致性"的样本
    ("token-usage", "tokenUsage", {"botId": bot}),
]
if schedule:
    calls.append(("get-schedule", "getSchedule", {"botId": bot, "scheduleId": schedule}))
# 写路径唯一覆盖：建临时会话 → 取 id → 删掉（只回 id_found/deleted，id 不进对比）
calls.append(("create-delete-session", "createDeleteSession", {"botId": bot}))

print(json.dumps([{"name": n, "call": c, "args": a} for n, c, a in calls], ensure_ascii=False))
PY
)"
[ -n "$CALLS" ] || { log "调用清单生成失败"; exit 1; }

# ---------------------------------------------------------------- 4. TS 侧
cat > "$WORK/ts-runner.mjs" <<JS
import { MemohClient } from '$ROOT/apps/mobile/src/api/client.ts';
import { createdSessionId } from '$ROOT/apps/mobile/src/api/types.ts';

const calls = JSON.parse(process.env.MEMOH_CALLS);
const client = new MemohClient({
  baseUrl: process.env.MEMOH_BASE_URL,
  getToken: () => process.env.MEMOH_TOKEN,
});

// 与 tools/api-parity-probe.swift 的 dispatch 一一对应。
const dispatch = {
  me: () => client.me(),
  listBots: () => client.listBots(),
  listSessions: (a) => client.listSessions(a.botId, { limit: a.limit }),
  getSession: (a) => client.getSession(a.botId, a.sessionId),
  listMessages: (a) => client.listMessages(a.botId, a.sessionId, { limit: a.limit }),
  getSessionStatus: (a) => client.getSessionStatus(a.botId, a.sessionId),
  sessionStatus: (a) => client.sessionStatus(a.botId, a.sessionId),
  getBotSettings: (a) => client.getBotSettings(a.botId),
  getContainer: (a) => client.getContainer(a.botId),
  getContainerMetrics: (a) => client.getContainerMetrics(a.botId),
  getDisplay: (a) => client.getDisplay(a.botId),
  listBotChecks: (a) => client.listBotChecks(a.botId),
  listSkills: (a) => client.listSkills(a.botId),
  listFiles: (a) => client.listFiles(a.botId, a.path),
  readFile: (a) => client.readFile(a.botId, a.path),
  statFile: (a) => client.statFile(a.botId, a.path),
  listModels: () => client.listModels(),
  listProviders: () => client.listProviders(),
  listSchedules: (a) => client.listSchedules(a.botId),
  getSchedule: (a) => client.getSchedule(a.botId, a.scheduleId),
  listScheduleLogs: (a) => client.listScheduleLogs(a.botId, { limit: a.limit }),
  checkBotNameAvailability: (a) => client.checkBotNameAvailability(a.name),
  getSessionQueue: (a) => client.getSessionQueue(a.botId, a.sessionId),
  tokenUsage: (a) => client.tokenUsage(a.botId),
  createDeleteSession: async (a) => {
    const created = await client.createSession(a.botId, { title: '9B-1 联调临时会话（可删）' });
    const id = createdSessionId(created);
    if (!id) return { id_found: false, deleted: false };
    await client.deleteSession(a.botId, id);
    return { id_found: true, deleted: true };
  },
};

for (const call of calls) {
  const line = { name: call.name, args: call.args ?? {} };
  try {
    const result = await dispatch[call.call](call.args ?? {});
    line.ok = true;
    line.result = result === undefined ? null : result;
  } catch (error) {
    line.ok = false;
    line.error = {
      status: typeof error?.status === 'number' ? error.status : null,
      code: error?.code ?? null,
      message: String(error?.message ?? error),
    };
  }
  process.stdout.write(JSON.stringify(line) + '\n');
}
JS

log "TS 侧：node --experimental-strip-types …"
if ! MEMOH_BASE_URL="$API" MEMOH_TOKEN="$TOKEN" MEMOH_CALLS="$CALLS" \
     node --experimental-strip-types "$WORK/ts-runner.mjs" > "$WORK/ts.ndjson" 2> "$WORK/ts.err"; then
  log "TS 侧失败："; tail -20 "$WORK/ts.err" >&2; exit 1
fi
log "TS 侧完成：$(wc -l < "$WORK/ts.ndjson" | tr -d ' ') 条"

# ---------------------------------------------------------------- 5. Swift 侧
log "编译 Swift 探针（Foundation-only，macOS SDK，不需要 Xcode）…"
swiftc -parse-as-library -O \
  "$ROOT"/apps/mobile/modules/memoh-kit/ios/API/*.swift \
  "$ROOT/tools/api-parity-probe.swift" \
  -o "$WORK/probe"
MEMOH_BASE_URL="$API" MEMOH_TOKEN="$TOKEN" MEMOH_CALLS="$CALLS" \
  "$WORK/probe" > "$WORK/swift.ndjson"
log "Swift 侧完成：$(wc -l < "$WORK/swift.ndjson" | tr -d ' ') 条"

# ---------------------------------------------------------------- 6. 比对
MEMOH_TS="$WORK/ts.ndjson" MEMOH_SWIFT="$WORK/swift.ndjson" python3 - <<'PY'
import json, os, sys

def load(path):
    out = {}
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if not line:
            continue
        item = json.loads(line)
        out[item["name"]] = item
    return out

ts = load(os.environ["MEMOH_TS"])
swift = load(os.environ["MEMOH_SWIFT"])

def num_eq(a, b):
    if isinstance(a, bool) or isinstance(b, bool):
        return a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return float(a) == float(b)
    return None

def compare_structure(a, b, path, diffs, dropped):
    """易变端点只比结构：键集与数组长度。值（时间戳、CPU 百分比、延迟）本来就会变。"""
    if isinstance(a, dict) and isinstance(b, dict):
        for key in sorted(set(a) | set(b)):
            here = "%s.%s" % (path, key) if path else key
            if key not in b:
                dropped.append(here)
            elif key not in a:
                diffs.append("%s：Swift 多出字段" % here)
            else:
                compare_structure(a[key], b[key], here, diffs, dropped)
        return
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            diffs.append("%s：数组长度 %d vs %d" % (path, len(a), len(b)))
            return
        for i, (x, y) in enumerate(zip(a, b)):
            compare_structure(x, y, "%s[%d]" % (path, i), diffs, dropped)
        return
    # 标量不比：volatile 端点的值由服务端现算


def compare(a, b, path, diffs, dropped):
    """比 TS(a) 与 Swift(b)。diffs = 真差异；dropped = Swift typed 解码丢掉的未知键。"""
    if isinstance(a, dict) and isinstance(b, dict):
        for key in sorted(set(a) | set(b)):
            here = "%s.%s" % (path, key) if path else key
            if key not in b:
                dropped.append(here)
            elif key not in a:
                diffs.append("%s：Swift 多出字段" % here)
            else:
                compare(a[key], b[key], here, diffs, dropped)
        return
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            diffs.append("%s：数组长度 %d vs %d" % (path, len(a), len(b)))
            return
        for i, (x, y) in enumerate(zip(a, b)):
            compare(x, y, "%s[%d]" % (path, i), diffs, dropped)
        return
    if num_eq(a, b):
        return
    if a != b:
        diffs.append("%s：TS=%r Swift=%r" % (path, a, b))

rows = []
fail = 0
for name in list(ts) + [n for n in swift if n not in ts]:
    t, s = ts.get(name), swift.get(name)
    if t is None or s is None:
        rows.append((name, "-", "-", "NO", "一边没有这个端点"))
        fail = 1
        continue
    if t["ok"] and s["ok"]:
        diffs, dropped = [], []
        volatile = bool((t.get("args") or {}).get("volatile"))
        if volatile:
            compare_structure(t.get("result"), s.get("result"), "", diffs, dropped)
        else:
            compare(t.get("result"), s.get("result"), "", diffs, dropped)
        status = "200"
        if diffs:
            rows.append((name, status, status, "NO", "; ".join(diffs[:3])))
            fail = 1
        else:
            notes = []
            if volatile:
                notes.append("volatile：只比结构（键集/条数）")
            if dropped:
                notes.append("Swift 未建模键 %d 个（如 %s）" % (len(dropped), ", ".join(dropped[:3])))
            rows.append((name, status, status, "yes", "；".join(notes)))
    elif not t["ok"] and not s["ok"]:
        ts_status = t["error"].get("status")
        sw_status = s["error"].get("status")
        if ts_status != sw_status:
            rows.append((name, str(ts_status), str(sw_status), "NO",
                         "错误状态不同：TS=%r Swift=%r" % (t["error"], s["error"])))
            fail = 1
        else:
            note = "两边一致地失败（HTTP %s）" % ts_status
            if (t["error"].get("code") or None) != (s["error"].get("code") or None):
                note += "；code 不同：TS=%r Swift=%r" % (t["error"].get("code"), s["error"].get("code"))
            rows.append((name, str(ts_status), str(sw_status), "yes", note))
    else:
        rows.append((name,
                     str(t["error"].get("status")) if not t["ok"] else "200",
                     str(s["error"].get("status")) if not s["ok"] else "200",
                     "NO",
                     "一边成功一边失败：TS=%s Swift=%s"
                     % (t.get("error", {}).get("message", "ok"), s.get("error", {}).get("message", "ok"))))
        fail = 1

width = max(len(r[0]) for r in rows) + 1
print()
print("%-*s %-7s %-7s %-9s %s" % (width, "端点", "TS", "Swift", "TS==Swift", "差异摘要"))
print("%s %s %s %s %s" % ("-" * width, "-" * 7, "-" * 7, "-" * 9, "-" * 40))
for name, a, b, same, note in rows:
    print("%-*s %-7s %-7s %-9s %s" % (width, name, a, b, same, note))

total = len(rows)
same_count = sum(1 for r in rows if r[3] == "yes")
print("\n%d/%d 个端点 TS 与 Swift 一致" % (same_count, total))
if fail:
    print("结论：有差异（见上表）")
    sys.exit(1)
print("结论：无差异")
PY
status=$?
log "（探针二进制与中间文件在 ${WORK}，随脚本退出一起删掉）"
exit $status
