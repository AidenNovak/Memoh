#!/usr/bin/env bash
# 从 dev 实例抓 `raw/` 夹具（服务端真发过的字节）。
#
# 为什么要有这个脚本：golden（`expected/`）是**生成**的，但 raw 不能生成——它必须是
# 服务端真的发过的形状。没有这一步，"重新抓一遍夹具"就变成靠记忆手抄，golden 会悄悄
# 变成"我们以为服务端会发什么"。
#
# ## 凭据怎么处理（铁律）
#
# 口令只在 **vultr-sg 上的进程内**读（`/opt/memoh-dev/secrets/memoh-dev.env`），
# 不经过本机命令行、不落盘、不打印；登录后拿到的 token 同样只活在服务器那个 python
# 进程里。响应体在写盘前会递归删掉 `access_token` / `api_key` / `authorization` 之类
# 的键——`/providers` 的 `config.api_key` 就是靠这一条挡掉的。
#
# ## 用法
#
#   bash tools/api-fixtures/capture-raw.sh          # 重抓全部夹具
#
# 抓完 raw 变了，必须重跑 `node --experimental-strip-types tools/gen-api-goldens.mjs`，
# 否则 expected 与 raw 不是一对。
#
# 会话与 schedule 的 id 是**动态发现**的（不写死）：bot 按名字 `ios-dev` 找，夹具用的
# 两个会话分别取"第一个含 user_input 块"和"第一个含 approval 块"的 chat 会话。这样
# 旧夹具被删掉之后重抓仍然抓得到，而不是报 id 不存在。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RAW_DIR="$REPO_ROOT/tools/api-fixtures/raw"
REMOTE_HOST="${MEMOH_CAPTURE_HOST:-vultr-sg}"
REMOTE_DIR="/tmp/memoh-9b1-fixtures"

mkdir -p "$RAW_DIR"

# 远端只做两件事：准备一个空目录、跑下面的 python。python 自己登录、自己抓、自己洗。
ssh -o ConnectTimeout=20 "$REMOTE_HOST" "REMOTE_DIR='$REMOTE_DIR' bash -s" <<'REMOTE_EOF'
set -euo pipefail

set -a
# shellcheck disable=SC1091
. /opt/memoh-dev/secrets/memoh-dev.env
set +a

rm -rf "$REMOTE_DIR"
mkdir -p "$REMOTE_DIR/raw"

export API_BASE="${MEMOH_CAPTURE_API:-http://127.0.0.1:18080}"
export BOT_NAME="${MEMOH_CAPTURE_BOT:-ios-dev}"

python3 - <<'PY'
import json, os, re, sys, urllib.error, urllib.parse, urllib.request

API = os.environ["API_BASE"]
OUT = os.environ["REMOTE_DIR"]
PASSWORD = os.environ["MEMOH_ADMIN_PASSWORD"]

# 这些键的值**一律不进夹具**：token、provider 的 api_key、authorization 头。
#
# 处理方式是**把值换成占位串，而不是删掉键**——这是踩出来的：删键会让夹具不再能用来
# 验证解码（`LoginResponse.access_token` 在 TS 里是非可选的，键一删，"非可选字段在真响应
# 里缺席"就成了假信号）。占位串不是凭据、也不由真值派生，同时保住"服务端发了这个键、
# 值是字符串"这两个事实。哪些键被换过会记进 `capture-meta.json`。
SECRET_KEYS = {
    "access_token", "refresh_token", "id_token", "api_key", "apikey",
    "authorization", "Authorization", "password", "secret", "client_secret",
    "private_key", "token",
}
REDACTED = "<redacted-by-capture>"

def scrub(value, redacted):
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            if k in SECRET_KEYS and isinstance(v, str):
                out[k] = REDACTED
                redacted.add(k)
            else:
                out[k] = scrub(v, redacted)
        return out
    if isinstance(value, list):
        return [scrub(v, redacted) for v in value]
    return value

def request(method, path, body=None, token=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(API + path, data=data, method=method)
    req.add_header("Accept", "application/json")
    if body is not None:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, resp.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

def get(path, token):
    return request("GET", path, token=token)

status, body = request("POST", "/auth/login", {"username": "admin", "password": PASSWORD})
if status != 200:
    sys.exit("登录失败：HTTP %d %s" % (status, body[:200]))
token = json.loads(body)["access_token"]

written = {}
redactions = {}

def save(name, path, method="GET", body=None, expect=(200,)):
    """抓一个端点落盘。非期望状态码直接失败——夹具里混进错误页比缺夹具更坏。"""
    status, raw = request(method, path, body=body, token=token)
    if status not in expect:
        sys.exit("端点 %s %s 返回 %d（期望 %s）：%s"
                 % (method, path, status, expect, raw[:200]))
    redacted = set()
    parsed = scrub(json.loads(raw), redacted)
    with open(os.path.join(OUT, "raw", name + ".json"), "w") as fh:
        json.dump(parsed, fh, ensure_ascii=False, indent=2, sort_keys=True)
        fh.write("\n")
    written[name] = {"path": "%s %s" % (method, path), "status": status}
    if redacted:
        redactions[name] = sorted(redacted)
    print("  %-28s %s %s%s" % (name, method, path,
                               "  [已替换占位串: %s]" % ", ".join(sorted(redacted)) if redacted else ""))

def get_json(path, token):
    status, body = get(path, token)
    if status != 200:
        sys.exit("发现阶段失败：GET %s → %d %s" % (path, status, body[:200]))
    return json.loads(body)

# ------------------------------------------------------------------ 基本发现
bots = get_json("/bots", token)["items"]
bot = next((b for b in bots if b.get("name") == os.environ["BOT_NAME"]), None)
if bot is None:
    sys.exit("找不到 bot %r（现有：%s）" % (os.environ["BOT_NAME"], [b.get("name") for b in bots]))
bot_id = bot["id"]

# 两个会话：一个含 user_input 块、一个含 approval 块。找最老的那批里第一个命中的，
# 避免每次重抓换会话（列表按 updated_at 倒序，所以从尾部往前找更稳）。
sessions = get_json("/bots/%s/sessions?types=chat&limit=60" % bot_id, token)["items"]
user_input_session = approval_session = None
for s in reversed(sessions):
    st, body = get("/bots/%s/messages?session_id=%s&limit=300" % (bot_id, s["id"]), token)
    if st != 200:
        continue
    for turn in json.loads(body).get("items") or []:
        for part in turn.get("messages") or []:
            if "user_input" in part and user_input_session is None:
                user_input_session = s["id"]
            if "approval" in part and approval_session is None:
                approval_session = s["id"]
    if user_input_session and approval_session:
        break
if not user_input_session or not approval_session:
    sys.exit("没找到带 user_input / approval 块的会话（%s / %s）" % (user_input_session, approval_session))

schedules = get_json("/bots/%s/schedule" % bot_id, token)["items"]
if not schedules:
    sys.exit("这个 bot 没有 schedule，get-schedule 夹具抓不到")
schedule_id = schedules[0]["id"]

print("bot=%s user_input_session=%s approval_session=%s schedule=%s"
      % (bot_id, user_input_session, approval_session, schedule_id))

# ------------------------------------------------------------------ 落盘
print("写入 %s：" % OUT)
save("login", "/auth/login", method="POST",
     body={"username": "admin", "password": PASSWORD})

save("me", "/users/me")
save("list-bots", "/bots")
save("list-sessions", "/bots/%s/sessions?limit=3" % bot_id)
save("get-session", "/bots/%s/sessions/%s" % (bot_id, user_input_session))
save("list-messages-user-input",
     "/bots/%s/messages?session_id=%s&limit=300" % (bot_id, user_input_session))
save("list-messages-approval",
     "/bots/%s/messages?session_id=%s&limit=300" % (bot_id, approval_session))
save("session-status", "/bots/%s/sessions/%s/status" % (bot_id, user_input_session))
save("bot-settings", "/bots/%s/settings" % bot_id)
save("get-container", "/bots/%s/container" % bot_id)
save("container-metrics", "/bots/%s/container/metrics" % bot_id)
save("container-display", "/bots/%s/container/display" % bot_id)
save("bot-checks", "/bots/%s/checks" % bot_id)
save("skills-catalog", "/bots/%s/skills/catalog" % bot_id)
save("list-files", "/bots/%s/container/fs/list?path=%%2F" % bot_id)
save("read-file", "/bots/%s/container/fs/read?path=%%2Fetc%%2Fhostname" % bot_id)
save("stat-file", "/bots/%s/container/fs?path=%%2Fetc%%2Fhostname" % bot_id)
save("models", "/models")
save("providers", "/providers")
save("schedule-list", "/bots/%s/schedule" % bot_id)
save("get-schedule", "/bots/%s/schedule/%s" % (bot_id, schedule_id))
save("schedule-logs", "/bots/%s/schedule/logs?limit=2" % bot_id)

# 名字可用性的 4 态：available / taken / invalid / reserved。
# `root` 那一份是重点——**服务端只在不可用时才给 `reason`**，可用时整个键不出现。
for name, fixture in (("root", "name-availability-available"),
                      ("ios-dev", "name-availability-taken"),
                      ("a", "name-availability-invalid"),
                      ("admin", "name-availability-reserved")):
    save(fixture, "/bots/name-availability?name=" + urllib.parse.quote(name))

with open(os.path.join(OUT, "capture-meta.json"), "w") as fh:
    json.dump({"api": API, "bot_id": bot_id,
               "user_input_session": user_input_session,
               "approval_session": approval_session,
               "schedule_id": schedule_id,
               "redacted_values": redactions,
               "redacted_placeholder": REDACTED,
               "endpoints": written}, fh, ensure_ascii=False, indent=2, sort_keys=True)
    fh.write("\n")
print("\n共 %d 个夹具" % len(written))
PY
REMOTE_EOF

# 用 tar 走 stdout 回传：不建额外的 ssh 通道、不写中间文件。
# 远端目录的形状就是本地 `tools/api-fixtures/` 的形状（raw/ 与 capture-meta.json），
# 所以直接解到这个目录下即可。
FIXTURES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ssh -o ConnectTimeout=20 "$REMOTE_HOST" "tar -C '$REMOTE_DIR' -cf - ." | tar -xf - -C "$FIXTURES_DIR"
ssh -o ConnectTimeout=20 "$REMOTE_HOST" "rm -rf '$REMOTE_DIR'"

echo
echo "raw 已更新：$(ls "$RAW_DIR"/*.json | wc -l | tr -d ' ') 个文件"
echo "下一步：node --experimental-strip-types tools/gen-api-goldens.mjs"
