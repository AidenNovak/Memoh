#!/usr/bin/env bash
# 在 vultr-sg 的 Memoh dev 环境里准备好一个能跑起来的 bot：
#   bot → provider（DeepSeek）→ 导入模型 → 把模型挂到 bot 上
#
# 幂等：重复执行不会重复建。
# 密钥只从 /opt/memoh-dev/secrets/ 读，不打印、不入库。
set -euo pipefail

BASE=/opt/memoh-dev
ENV_FILE="$BASE/secrets/memoh-dev.env"
KEY_FILE="$BASE/secrets/provider.env"
API="http://127.0.0.1:18080"
BOT_NAME="${MEMOH_DEV_BOT_NAME:-ios-dev}"

[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
set +a

TOKEN=$(curl -s -X POST "$API/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"$MEMOH_ADMIN_PASSWORD\"}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')
AUTH="Authorization: Bearer $TOKEN"
JSON='Content-Type: application/json'

api() { # api <method> <path> [body]
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -s -X "$method" "$API$path" -H "$AUTH" -H "$JSON" -d "$body"
  else
    curl -s -X "$method" "$API$path" -H "$AUTH"
  fi
}

# ---------------------------------------------------------------- 模型提供商
if [ ! -f "$KEY_FILE" ]; then
  echo "缺少 $KEY_FILE。" >&2
  echo "写入形式（不要提交、不要打印）：" >&2
  echo "  MEMOH_DEV_PROVIDER_TEMPLATE=deepseek" >&2
  echo "  MEMOH_DEV_PROVIDER_API_KEY=<key>" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090
. "$KEY_FILE"
set +a

TEMPLATE_NAME="${MEMOH_DEV_PROVIDER_TEMPLATE:-deepseek}"
TEMPLATE_ID=$(api GET /provider-templates | python3 -c "
import json,sys
name='$TEMPLATE_NAME'.lower()
for t in json.load(sys.stdin):
    if name in (t.get('name') or '').lower() or name in (t.get('id') or '').lower():
        print(t['id']); break
")
[ -n "$TEMPLATE_ID" ] || { echo "找不到 provider 模板 $TEMPLATE_NAME" >&2; exit 1; }
echo "provider 模板：$TEMPLATE_NAME ($TEMPLATE_ID)"

EXISTING_PROVIDER=$(api GET /providers | python3 -c "
import json,sys
d=json.load(sys.stdin)
items = d.get('items', d) if isinstance(d, dict) else d
for p in items:
    if 'deepseek' in (p.get('name') or '').lower():
        print(p['id']); break
")

if [ -z "$EXISTING_PROVIDER" ]; then
  PROVIDER_ID=$(api POST /providers/from-template "{\"template_id\":\"$TEMPLATE_ID\"}" \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("id") or d.get("provider",{}).get("id",""))')
  [ -n "$PROVIDER_ID" ] || { echo "建 provider 失败" >&2; exit 1; }
  echo "新建 provider：$PROVIDER_ID"
  # 写 API key（单独一步，避免出现在日志里）
  api PUT "/providers/$PROVIDER_ID" "{\"config\":{\"api_key\":\"$MEMOH_DEV_PROVIDER_API_KEY\"}}" >/dev/null
else
  PROVIDER_ID="$EXISTING_PROVIDER"
  echo "复用 provider：$PROVIDER_ID"
fi

api POST "/providers/$PROVIDER_ID/import-models" >/dev/null || true
MODEL_COUNT=$(api GET "/providers/$PROVIDER_ID/models" | python3 -c "
import json,sys
d=json.load(sys.stdin)
items = d.get('items', d) if isinstance(d, dict) else d
print(len(items))
")
echo "已导入模型：$MODEL_COUNT 个"

MODEL_ID=$(api GET "/providers/$PROVIDER_ID/models" | python3 -c "
import json,sys
d=json.load(sys.stdin)
items = d.get('items', d) if isinstance(d, dict) else d
prefer = ['deepseek-v4-flash','deepseek-chat','deepseek-v4-pro']
by_id = {m.get('model_id') or m.get('external_id'): m for m in items}
for want in prefer:
    if by_id.get(want):
        m = by_id[want]
        print(m.get('id'), m.get('model_id'), m.get('name',''), sep='|')
        break
else:
    if items:
        m = items[0]
        print(m.get('id'), m.get('model_id'), m.get('name',''), sep='|')
")
[ -n "$MODEL_ID" ] || { echo "没有可用模型" >&2; exit 1; }
MODEL_UUID=$(echo "$MODEL_ID" | cut -d'|' -f1)
MODEL_SLUG=$(echo "$MODEL_ID" | cut -d'|' -f2)
MODEL_NAME=$(echo "$MODEL_ID" | cut -d'|' -f3)
echo "选用模型：$MODEL_SLUG ($MODEL_UUID)"

# 导入的模型默认是 disabled，必须显式启用——否则 run 会在解析阶段就报
# "chat model ... is disabled"。注意这个 PUT 需要完整字段，只传 enable 会被
# 校验拒绝（model_id / provider_id / type 都是必填）。
api PUT "/models/$MODEL_UUID" \
  "{\"model_id\":\"$MODEL_SLUG\",\"name\":\"$MODEL_NAME\",\"provider_id\":\"$PROVIDER_ID\",\"type\":\"chat\",\"enable\":true}" >/dev/null
echo "已启用模型"

# ---------------------------------------------------------------- bot
BOT_ID=$(api GET /bots | python3 -c "
import json,sys
for b in json.load(sys.stdin).get('items', []):
    if b.get('name') == '$BOT_NAME':
        print(b['id']); break
")

if [ -z "$BOT_ID" ]; then
  BOT_ID=$(api POST /bots "{\"name\":\"$BOT_NAME\",\"display_name\":\"iOS Dev\",\"timezone\":\"Asia/Shanghai\"}" \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("id") or d.get("bot",{}).get("id",""))')
  [ -n "$BOT_ID" ] || { echo "建 bot 失败" >&2; exit 1; }
  echo "新建 bot：$BOT_ID"
else
  echo "复用 bot：$BOT_ID"
fi

# bot 的默认对话模型放在 settings 里，不是 bot 记录上。
# 不设的话 run 会在解析阶段失败："chat model not configured"。
api PUT "/bots/$BOT_ID/settings" \
  "{\"chat_model_id\":\"$MODEL_UUID\",\"reasoning_effort\":\"disable\"}" >/dev/null
echo "已设置 bot 默认模型"

echo
echo "完成。写进 secrets 供后续脚本引用："
{
  echo "MEMOH_DEV_BOT_NAME=$BOT_NAME"
  echo "MEMOH_DEV_BOT_ID=$BOT_ID"
  echo "MEMOH_DEV_PROVIDER_ID=$PROVIDER_ID"
  echo "MEMOH_DEV_MODEL_ID=$MODEL_UUID"
} > "$BASE/secrets/dev-ids.env"
chmod 600 "$BASE/secrets/dev-ids.env"
cat "$BASE/secrets/dev-ids.env"
