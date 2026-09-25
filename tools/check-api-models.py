#!/usr/bin/env python3
"""Swift 模型 ↔ `spec/swagger.json` 一致性检查（9B-1 §7.2）。

## 它防的是哪一类事故

`avatar_url` 炸过一次：TS 里写的是 `avatar_url?: string`，Swift 若照"看着像必填"写成
`String`，服务端**省略这个键**时整次解码就失败——一条消息都渲染不出来，而错误信息
（"keyNotFound"）离真正的原因（"这个部署不发 avatar_url"）隔着一层。

所以这里做三件事，每一件都能单独抓住一类不一致：

1. **字段覆盖**：spec 里的属性，Swift 要么有、要么在带理由的 allowlist 里。
   （漏一个字段不会崩，但会让"服务端加了字段我们没跟上"静默通过。）
2. **必填性（spec → Swift）**：spec `required` 里的属性，Swift 必须非可选。
   （放宽成可选 = "服务端漏发必填字段"静默通过。）
3. **必填性（Swift → spec）**：Swift 非可选属性，必须在 spec `required` 里。

## 第 3 条为什么分两档

这份 spec 有 479 个 definition，**只有 42 个声明了 `required`**——响应模型基本不声明。
把第 3 条无条件拉满，等于要求 `Bot.id` / `Session.title` 这些"服务端必然给"的字段也全变
可选，于是正确实现会收获几十条红字、真正的问题被淹掉。所以：

- definition **声明了** `required` → 非可选却不在其中 = **错误**（spec 表了态，Swift 顶着来）；
- definition **没声明** `required` → 归入"无法判定"一节**只报告不失败**；
  想让它变成错误就加 `--strict-optionality`。

`avatar_url` 那一类真正靠得住的判据在**夹具层**（第 4 组检查）：夹具是服务端真发过的字节，
"非可选字段在真响应里缺席"是硬事实，没有解释空间。见下面的 `--check-fixtures`。

## 第 4 组：拿真响应当判据（默认开启）

对 `api-fixtures/manifest.json` 里每个夹具，按 `FIXTURE_SHAPES` 找到对象 → 检查 Swift 的
**非可选**字段是否在真响应里缺席。缺席就是"这份响应会让它解码失败"，直接报错。
这组检查只在夹具真存在时跑（`source: unavailable` 的端点自然跳过）。

## allowlist 的规矩

每条 allowlist 条目**必须写理由**（空理由直接判失败）。理由要能回答"为什么 spec 有这个字段、
Swift 没有是安全的"——写不出来就说明这是真问题，不该进 allowlist。
`("*", "TypeName")` 是"整个类型的 spec-only 字段都接受"的通配条目，用于**故意只建模 UI 子集**
的类型（如 `BotSettings`）；通配会打印它盖住了多少个字段，不静默。

## 用法

    python3 tools/check-api-models.py                 # 检查
    python3 tools/check-api-models.py --self-test     # 用内置样本自测（证明这套检查真的会响）
    python3 tools/check-api-models.py --strict-optionality
    python3 tools/check-api-models.py --models <path> --swagger <path> --raw-dir <path>

Swift 模型文件还不存在时：打印"未找到模型文件"并**以 0 退出**（A 侧还没落地不该让门禁红），
但会明确写出它在等哪个路径。文件存在而有不一致时：逐条打印 `文件:行`，非零退出。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
from typing import Any, Iterable

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

DEFAULT_MODELS = "apps/mobile/modules/memoh-kit/ios/API/MemohAPIModels.swift"
DEFAULT_SWAGGER = "spec/swagger.json"
DEFAULT_RAW_DIR = "tools/api-fixtures/raw"
DEFAULT_MANIFEST = "tools/api-fixtures/manifest.json"

# ---------------------------------------------------------------- 映射表
#
# Swift 类型名 → swagger definition 名。**显式写出来**，不做名字猜测：猜出来的映射
# 会在改名之后悄悄错位，而错位的检查比没有检查更坏（它给出的是"通过"）。
#
# 不在表里的 Swift 类型一律不检查（§7.2 第 4 条）：本片有不少"域形状"（如 `QueueItem`，
# camelCase + `kind`，是 `getSessionQueue` 规范化之后的产物，不是线上形状）和请求体
# 之外的内部类型，spec 覆盖不到它们，硬套只会得到假红。
MAPPING: dict[str, str] = {
    "LoginResponse": "handlers.LoginResponse",
    "RefreshResponse": "handlers.RefreshResponse",
    "Account": "accounts.Account",
    "Bot": "bots.Bot",
    "BotCreateRequest": "bots.CreateBotRequest",
    "ListBotsResponse": "bots.ListBotsResponse",
    "Session": "session.Session",
    "ListSessionsResponse": "handlers.listSessionsResponse",
    "UIAttachment": "conversation.UIAttachment",
    "UIToolApprovalOption": "conversation.UIToolApprovalOption",
    "UIToolApproval": "conversation.UIToolApproval",
    "UIQuestionOption": "userinput.UIOption",
    "UIQuestion": "userinput.UIQuestion",
    "UIAnswer": "userinput.UIAnswer",
    "UIUserInput": "conversation.UIUserInput",
    "UIExecutionLocation": "conversation.UIExecutionLocation",
    "UIReasoningTiming": "conversation.UIReasoningTiming",
    "UIMessage": "conversation.UIMessage",
    "UITurn": "conversation.UITurn",
    "UIMessageListResponse": "handlers.UIMessageListResponse",
    "FileEntry": "handlers.FSFileInfo",
    "ListFilesResponse": "handlers.FSListResponse",
    "BotCheck": "bots.BotCheck",
    "BotSettings": "settings.Settings",
    "ModelReasoning": "reasoning.Options",
    "ModelSummary": "models.GetResponse",
    "SkillSummary": "handlers.SkillItem",
    "ContainerStatus": "handlers.GetContainerResponse",
    "ContainerMetrics": "handlers.GetContainerMetricsResponse",
    "DisplayCapability": "handlers.displayInfoResponse",
    "ProviderSummary": "providers.GetResponse",
    "SessionStatus": "handlers.SessionInfoResponse",
    # 名字可用性：TS 侧是内联类型（`{available, reason}`），Swift 会起个具名类型。
    # 两个常见命名都挂着，找不到就跳过——不为了迁就猜测而放宽检查。
    "NameAvailability": "bots.NameAvailability",
    "BotNameAvailability": "bots.NameAvailability",
}

# 字符串枚举（§4 第 5 条要求带 `unknown` 兜底）。每个 spec 枚举值都要有对应 case，
# 否则服务端加了新类型，Swift 会把它当成未知——那是"设计上兜住了"，但漏掉**已知**值
# 就不一样了：那是客户端渲染不出来服务端正在发的东西。
ENUM_MAPPING: dict[str, str] = {
    "UIMessageType": "conversation.UIMessageType",
}

# ---------------------------------------------------------------- allowlist
#
# (Swift 类型名, spec 属性名) → 理由。理由必填，且必须回答"为什么这样是安全的"。
ALLOWLIST: dict[tuple[str, str], str] = {
    # --- UITurn：spec 有、TS 未建模（本片以 TS 为准，不发明界面用不到的字段） ---
    ("UITurn", "background_task"): "TS 的 UITurn 未建模（后台任务卡片是另一片的事）；解码层忽略未知键即可",
    ("UITurn", "external_message_id"): "TS 未建模：外部渠道消息 id，iOS 侧不展示也不回写",
    ("UITurn", "forward"): "TS 未建模：转发引用（渠道侧概念）",
    ("UITurn", "reply"): "TS 未建模：回复引用（渠道侧概念）",
    ("UITurn", "runtime_forkable"): "TS 未建模：分叉可用性是 9B-3 的判据，不是解码字段",
    ("UITurn", "skill_activation"): "TS 未建模：技能激活卡片没进 iOS 这一片",
    # --- UITurn.timestamp：spec required vs TS 可选，这是**真冲突**，以 TS 为准 ---
    ("UITurn", "timestamp"): (
        "spec 把 timestamp 列进 required，但 TS（types.ts 的 UITurn）写成 `timestamp?`，"
        "而 §4 第 2 条要求可选性与 TS 严格一致。实测夹具里每轮都带 timestamp，所以"
        "写成可选不会漏掉数据；写成非可选则在历史/投影缺该字段时整页解码失败。"
        "**这是 spec 与 TS 的冲突，本片以 TS 为准**，要改请连同 TS 一起改"
    ),
    # --- UIMessage：spec 有、TS 未建模 ---
    ("UIMessage", "background_task"): "TS 未建模（后台任务卡片是另一片的事）",
    ("UIMessage", "diff"): "TS 未建模：diff 卡片由 `tool` 块的 input/output 推导（见 types.ts 的 UIMessageType 注释）",
    ("UIMessage", "elapsed_time_seconds"): "TS 未建模：耗时由 reasoning_timing 表达",
    # --- 其余零散 ---
    ("UIAttachment", "base64"): "服务端内部字段（内联内容），TS 未建模；客户端走 url/path",
    ("UIAttachment", "storage_key"): "服务端内部字段（对象存储键），TS 未建模",
    ("UIQuestionOption", "label_key"): "给带文案表的客户端用的 key；本 App 直接渲染 label",
    ("ModelReasoning", "efforts_without_off"): "TS 未建模（界面只用 supported/can_disable/efforts/default_effort）",
    ("DisplayCapability", "prepare_system"): "TS 未建模：桌面准备用的系统标识，界面不显示",
    ("BotCreateRequest", "metadata"): "TS 的 BotCreateRequest 不建模 metadata（本 App 不写它）",
    ("BotCreateRequest", "wait_for_ready"): "**故意不发**：`createBot` 的注释说明了为什么（服务端会同步跑完整个容器生命周期），TS 类型里也没有这一项",
    ("ListFilesResponse", "path"): "TS 的 ListFilesResponse 只建模列表键（items?/entries?）；`path` 是回显，界面不用",
    # --- ContainerMetrics：**TS 类型与 spec 不一致**，fixture 站在 spec 一边 ---
    ("ContainerMetrics", "metrics"): (
        "⚠️ TS 的 ContainerMetrics 把 cpu/memory/storage 平铺在顶层，而 spec 把它们放在"
        "`metrics` 下；实测夹具（container-metrics.json）证明 **spec 是对的**。Swift 应按"
        "spec 建 `metrics` 这一层，不要照抄 TS 的平铺形状——这是 TS 类型写错、不是我们的选择"
    ),
    ("ContainerMetrics", "resource_limits"): "⚠️ 同上：TS 未建模 resource_limits（夹具里有）",
    ("ContainerMetrics", "sampled_at"): "⚠️ 同上：TS 未建模 sampled_at（夹具里有）",
    ("ContainerMetrics", "status"): "⚠️ 同上：TS 未建模 status（夹具里有；与顶层 supported 是两件事）",
    ("ContainerMetrics", "unsupported_reason"): "⚠️ 同上：TS 未建模 unsupported_reason",
    # --- 通配：故意只建模 UI 子集的类型 ---
    ("*", "BotSettings"): "TS 的 BotSettings 只建模界面用到的子集（模型/语言/时区/审批/压缩那几项）；其余是服务端设置项，本片不发明字段",
    ("*", "SkillSummary"): "TS 的 SkillSummary 只要 name/display_name/description/source_kind/state；其余是技能包管理字段（安装/编辑/注册表），iOS 侧不碰",
    ("*", "ProviderSummary"): "TS 的 ProviderSummary 只要 id/name/client_type/enable；config/icon/metadata/时间戳是管理面字段（且 config 里含密钥，夹具已删）",
    ("*", "ContainerStatus"): "TS 的 ContainerStatus 只要 container_id/status/namespace/container_path/image/task_running；其余是容器后端细节",
}

# ---------------------------------------------------------------- 夹具 → 类型
#
# 夹具名 → [(JSON 路径, Swift 类型名)]。路径里的 "[]" 表示"遍历这个数组"。
# 只有这里列出的位置会被第 4 组检查碰到——不做自动推断，避免把错误的形状套到类型上。
FIXTURE_SHAPES: dict[str, list[tuple[tuple[str, ...], str]]] = {
    "login": [((), "LoginResponse")],
    "me": [((), "Account")],
    "list-bots": [(("items", "[]"), "Bot")],
    "get-session": [((), "Session")],
    "list-sessions": [(("items", "[]"), "Session")],
    "list-messages-user-input": [
        (("items", "[]"), "UITurn"),
        (("items", "[]", "messages", "[]"), "UIMessage"),
    ],
    "list-messages-approval": [
        (("items", "[]"), "UITurn"),
        (("items", "[]", "messages", "[]"), "UIMessage"),
    ],
    "session-status": [((), "SessionStatus")],
    "bot-settings": [((), "BotSettings")],
    "get-container": [((), "ContainerStatus")],
    "container-metrics": [((), "ContainerMetrics")],
    "container-display": [((), "DisplayCapability")],
    "bot-checks": [(("items", "[]"), "BotCheck")],
    "skills-catalog": [(("skills", "[]"), "SkillSummary")],
    "list-files": [(("entries", "[]"), "FileEntry")],
    "models": [(("[]",), "ModelSummary")],
    "providers": [(("[]",), "ProviderSummary")],
    "name-availability-available": [((), "NameAvailability"), ((), "BotNameAvailability")],
    "name-availability-taken": [((), "NameAvailability"), ((), "BotNameAvailability")],
    "name-availability-invalid": [((), "NameAvailability"), ((), "BotNameAvailability")],
    "name-availability-reserved": [((), "NameAvailability"), ((), "BotNameAvailability")],
}


class Finding:
    """一条不一致。`severity` 只有 error / info 两种——info 不参与退出码。"""

    def __init__(self, severity: str, location: str, message: str):
        self.severity = severity
        self.location = location
        self.message = message

    def __str__(self) -> str:
        return "%s: %s" % (self.location, self.message)


# ---------------------------------------------------------------- Swift 解析
#
# 只做"够用的"解析：`public let x: T` 与 `CodingKeys` 的 `case x = "y"`。这不是编译器，
# 遇到看不懂的写法会**报出来**而不是静默跳过（静默跳过 = 检查假装通过）。

PROPERTY_RE = re.compile(r"^\s*(?:public\s+|internal\s+|private\s+|fileprivate\s+)?(?:let|var)\s+(\w+)\s*:\s*(.+?)\s*$")
DECL_RE = re.compile(r"^\s*(?:public\s+|internal\s+|private\s+|final\s+)*?(struct|enum|class)\s+(\w+)\s*[:{]")
CODINGKEYS_RE = re.compile(r"^\s*(?:public\s+|internal\s+)?enum\s+CodingKeys\s*:")
CASE_RE = re.compile(r"^\s*case\s+(.+?)\s*$")


def strip_comment(line: str) -> str:
    """去掉行尾 `//` 注释——但别碰字符串里的 `//`（wire 名里可能出现）。"""
    out, in_str = [], False
    i = 0
    while i < len(line):
        ch = line[i]
        if ch == '"':
            in_str = not in_str
        if not in_str and line.startswith("//", i):
            break
        out.append(ch)
        i += 1
    return "".join(out)


def is_optional_type(type_text: str) -> bool:
    t = type_text.strip()
    if t.endswith("?"):
        return True
    return t.startswith("Optional<")


class SwiftType:
    def __init__(self, name: str, kind: str, line: int):
        self.name = name
        self.kind = kind  # struct / enum / class
        self.line = line
        # 属性名 → (类型文本, 是否可选, 行号)
        self.props: dict[str, tuple[str, bool, int]] = {}
        # CodingKeys 的 swift 名 → (wire 名, 行号)
        self.coding_keys: dict[str, tuple[str, int]] = {}
        # 枚举 case 名 → 行号
        self.cases: dict[str, int] = {}
        self.unknown_lines: list[int] = []

    def wire_name(self, prop: str) -> str:
        return self.coding_keys.get(prop, (prop, 0))[0]

    def prop_line(self, prop: str) -> int:
        return self.props[prop][2]

    def key_line(self, prop: str) -> int:
        return self.coding_keys.get(prop, ("", self.prop_line(prop)))[1]


def parse_swift(source: str, filename: str) -> tuple[dict[str, SwiftType], list[Finding]]:
    types: dict[str, SwiftType] = {}
    problems: list[Finding] = []

    current: SwiftType | None = None
    in_coding_keys = False
    depth = 0  # 从当前声明开始的花括号深度

    for lineno, raw in enumerate(source.splitlines(), start=1):
        line = strip_comment(raw)
        if not line.strip():
            continue

        if current is None:
            m = DECL_RE.match(line)
            if m:
                name = m.group(2)
                if name in types:
                    problems.append(Finding("error", "%s:%d" % (filename, lineno),
                                            "类型 %s 重复声明" % name))
                current = SwiftType(name, m.group(1), lineno)
                types[name] = current
                depth = line.count("{") - line.count("}")
                in_coding_keys = False
            continue

        # 在某个类型内部
        if in_coding_keys:
            if line.strip().startswith("}"):
                in_coding_keys = False
                depth -= 1
                if depth <= 0:
                    current = None
                continue
            m = CASE_RE.match(line)
            if m:
                for piece in m.group(1).split(","):
                    piece = piece.strip()
                    if not piece:
                        continue
                    mm = re.match(r'^(\w+)(?:\s*=\s*"([^"]*)")?$', piece)
                    if not mm:
                        problems.append(Finding("error", "%s:%d" % (filename, lineno),
                                                "看不懂的 CodingKeys 写法：%r" % piece))
                        continue
                    current.coding_keys[mm.group(1)] = (mm.group(2) or mm.group(1), lineno)
            depth += line.count("{") - line.count("}")
            continue

        if CODINGKEYS_RE.match(line) and depth == 1:
            in_coding_keys = True
            depth += line.count("{") - line.count("}")
            continue

        if depth == 1:
            if current.kind == "enum":
                m = CASE_RE.match(line)
                if m:
                    for piece in m.group(1).split(","):
                        piece = piece.strip()
                        mm = re.match(r"^(\w+)(?:\(.*\))?$", piece)
                        if mm:
                            current.cases[mm.group(1)] = lineno
                            if mm.group(1) == "unknown":
                                current.unknown_lines.append(lineno)
            else:
                m = PROPERTY_RE.match(line)
                if m:
                    name, type_text = m.group(1), m.group(2)
                    # 带默认值的属性：`let x: Int = 0` → 取 `=` 之前的类型
                    type_text = type_text.split(" = ")[0].strip()
                    current.props[name] = (type_text, is_optional_type(type_text), lineno)

        depth += line.count("{") - line.count("}")
        if depth <= 0:
            current = None

    return types, problems


# ---------------------------------------------------------------- 检查
def resolve_ref(spec: dict, schema: dict) -> dict:
    """把 `$ref` / `allOf` 解到真正的 schema（`models.GetResponse.reasoning` 是 allOf）。"""
    if "$ref" in schema:
        ref = schema["$ref"].split("/")[-1]
        return spec["definitions"].get(ref, {})
    if "allOf" in schema and schema["allOf"]:
        return resolve_ref(spec, schema["allOf"][0])
    return schema


def check_type(spec: dict, swift: SwiftType, def_name: str, strict: bool,
               filename: str) -> list[Finding]:
    findings: list[Finding] = []
    definition = spec["definitions"].get(def_name)
    if definition is None:
        return [Finding("error", "%s:%d" % (filename, swift.line),
                        "映射表里的 definition %s 在 swagger 里不存在" % def_name)]

    props = definition.get("properties", {})
    required = set(definition.get("required") or [])
    wire_to_prop = {swift.wire_name(p): p for p in swift.props}

    # --- 规则 1：spec 的属性必须在 Swift 里，或在 allowlist 里 ---
    wildcard = ALLOWLIST.get(("*", swift.name))
    for spec_prop in sorted(props):
        if spec_prop in wire_to_prop:
            continue
        if (swift.name, spec_prop) in ALLOWLIST:
            continue
        if wildcard is not None:
            continue
        findings.append(Finding(
            "error", "%s:%d" % (filename, swift.line),
            "%s 缺 spec 属性 `%s`（spec: %s.%s）：要么补字段，要么在 ALLOWLIST 里写理由"
            % (swift.name, spec_prop, def_name, spec_prop)))

    # --- 规则 2：spec required 的属性，Swift 不许可选 ---
    for spec_prop in sorted(required):
        prop = wire_to_prop.get(spec_prop)
        if prop is None:
            continue  # 已被规则 1 报过
        if (swift.name, spec_prop) in ALLOWLIST:
            continue  # allowlist 里写着"spec 与 TS 冲突，以 TS 为准"的理由
        if swift.props[prop][1]:
            findings.append(Finding(
                "error", "%s:%d" % (filename, swift.key_line(prop)),
                "%s.%s 是可选，但 spec 把 `%s` 列进了 %s.required——放宽成可选会让"
                "\"服务端漏发必填字段\"静默通过" % (swift.name, prop, spec_prop, def_name)))

    # --- 规则 3：Swift 非可选属性必须在 spec required 里 ---
    for prop, (type_text, optional, lineno) in sorted(swift.props.items()):
        if optional:
            continue
        spec_prop = swift.wire_name(prop)
        if (swift.name, spec_prop) in ALLOWLIST:
            continue
        if spec_prop not in props:
            findings.append(Finding(
                "info", "%s:%d" % (filename, swift.key_line(prop)),
                "%s.%s 非可选，但 spec 里没有 `%s` 这个属性——无法判定必填性"
                % (swift.name, prop, spec_prop)))
            continue
        if spec_prop in required:
            continue
        if required:
            findings.append(Finding(
                "error", "%s:%d" % (filename, swift.key_line(prop)),
                "%s.%s 非可选，但 `%s` 不在 %s.required（该 definition 声明了 required，"
                "所以这是一条明确的矛盾）" % (swift.name, prop, spec_prop, def_name)))
        else:
            findings.append(Finding(
                "error" if strict else "info", "%s:%d" % (filename, swift.key_line(prop)),
                "%s.%s 非可选，但 %s 没声明 required（无法判定；加 --strict-optionality 可判错）"
                % (swift.name, prop, def_name)))

    return findings


def check_enum(spec: dict, swift: SwiftType, def_name: str, filename: str) -> list[Finding]:
    """枚举值覆盖。

    分两档，和规则 3 同样的理由：**有 `unknown` 兜底时缺 case 不会崩**（服务端发
    `command` / `status` 而 Swift 只认 6 种，值会落进 `.unknown`），所以那是"保真度缺口"
    而不是崩溃风险——报成 info，不判错。**没有兜底**才是真的会炸（解码失败 / 整条消息
    渲染不出来），报成 error。
    """
    findings: list[Finding] = []
    definition = spec["definitions"].get(def_name, {})
    values = definition.get("enum") or []
    if not values:
        findings.append(Finding("error", "%s:%d" % (filename, swift.line),
                                "映射表把 %s 当枚举，但 %s 不是字符串枚举" % (swift.name, def_name)))
        return findings
    has_fallback = bool(swift.unknown_lines)
    for value in values:
        if value in swift.cases:
            continue
        findings.append(Finding(
            "error" if not has_fallback else "info",
            "%s:%d" % (filename, swift.line),
            "%s 缺枚举 case `%s`（spec: %s.enum）%s"
            % (swift.name, value, def_name,
               "——没有 unknown 兜底，这个值会让整次解码失败" if not has_fallback
               else "——有 unknown 兜底不会崩，但服务端在发这个值，客户端只能把它当未知渲染")))
    if not has_fallback:
        findings.append(Finding(
            "error", "%s:%d" % (filename, swift.line),
            "%s 没有 `unknown` 兜底 case——服务端加新类型时整次解码会失败（§4 第 5 条）"
            % swift.name))
    return findings


def iter_objects(node: Any, path: tuple[str, ...]) -> Iterable[Any]:
    """按路径收集对象。`[]` 段表示遍历数组。"""
    if not path:
        yield node
        return
    head, rest = path[0], path[1:]
    if head == "[]":
        if isinstance(node, list):
            for item in node:
                yield from iter_objects(item, rest)
        return
    if isinstance(node, dict) and head in node:
        yield from iter_objects(node[head], rest)


def check_fixtures(types: dict[str, SwiftType], raw_dir: str, manifest_path: str,
                   filename: str) -> tuple[list[Finding], int]:
    """拿真响应当判据：Swift 的非可选字段，在真响应里必须真的存在。

    这一组是"avatar_url 那一类"最靠得住的守卫——夹具是服务端真发过的字节，
    "非可选字段缺席"没有解释空间（不像 spec，这份 spec 有 437 个 definition 根本没声明
    required）。

    被 capture 换成占位串的键仍然算存在（`<redacted-by-capture>`）：值不是真的，键是真的。
    """
    findings: list[Finding] = []
    if not os.path.isfile(manifest_path):
        return findings, 0
    manifest = json.load(open(manifest_path, encoding="utf-8"))
    checked = 0
    for entry in manifest:
        if entry.get("source") == "unavailable":
            continue
        raw_path = os.path.join(raw_dir, "%s.json" % entry["name"])
        if not os.path.isfile(raw_path):
            continue
        shapes = FIXTURE_SHAPES.get(entry["name"])
        if not shapes:
            continue
        data = json.load(open(raw_path, encoding="utf-8"))
        for path, type_name in shapes:
            swift = types.get(type_name)
            if swift is None or swift.kind != "struct":
                continue
            for obj in iter_objects(data, path):
                if not isinstance(obj, dict):
                    continue
                checked += 1
                for prop, (_, optional, lineno) in sorted(swift.props.items()):
                    if optional:
                        continue
                    wire = swift.wire_name(prop)
                    if wire not in obj:
                        findings.append(Finding(
                            "error", "%s:%d" % (filename, swift.key_line(prop)),
                            "%s.%s 非可选，但真响应 raw/%s.json 的这个位置**没有** `%s` 键"
                            "——这份响应会让它解码失败（就是 avatar_url 那一类）"
                            % (swift.name, prop, entry["name"], wire)))
    return findings, checked


# ---------------------------------------------------------------- 输出
def report(findings: list[Finding], models_path: str, fixture_objects: int,
           redactions: dict[str, list[str]]) -> int:
    errors = [f for f in findings if f.severity == "error"]
    infos = [f for f in findings if f.severity == "info"]

    if errors:
        print("不一致（%d 条）：" % len(errors))
        for f in errors:
            print("  %s" % f)
    if infos:
        print("\n无法判定（%d 条，不判错）：" % len(infos))
        for f in infos:
            print("  %s" % f)

    print("\n检查了 %s；夹具对象 %d 个" % (models_path, fixture_objects))
    print("allowlist 条目 %d 条（每条都有理由）" % len(ALLOWLIST))
    if redactions:
        print("夹具里被换成占位串的键（值不是真的，键是真的）：%s"
              % "; ".join("%s → %s" % (k, ", ".join(v)) for k, v in sorted(redactions.items())))
    if errors:
        print("结论：%d 条未解释的不一致" % len(errors))
        return 1
    print("结论：无不一致")
    return 0


# ---------------------------------------------------------------- 自测
SAMPLE_COMPLETE = '''
public struct Bot: Codable, Sendable {
  public let id: String
  public let name: String
  public let displayName: String?
  public let avatarUrl: String?
  public let timezone: String?
  public let isActive: Bool?
  public let status: String?
  public let ownerUserId: String?
  public let metadata: [String: MemohJSONValue]?
  public let createdAt: String?
  public let updatedAt: String?
  public let checkState: String?
  public let checkIssueCount: Int?
  public let currentUserPermissions: [String]?
  enum CodingKeys: String, CodingKey {
    case id, name, status, timezone, metadata
    case displayName = "display_name"
    case avatarUrl = "avatar_url"
    case isActive = "is_active"
    case ownerUserId = "owner_user_id"
    case createdAt = "created_at"
    case updatedAt = "updated_at"
    case checkState = "check_state"
    case checkIssueCount = "check_issue_count"
    case currentUserPermissions = "current_user_permissions"
  }
}

public struct UITurn: Codable, Sendable {
  public let turnId: String
  public let role: String
  public let timestamp: String
  public let turnPosition: Int?
  public let kind: String?
  public let messages: [UIMessage]?
  public let text: String?
  public let userMessageKind: String?
  public let attachments: [UIAttachment]?
  public let platform: String?
  public let senderDisplayName: String?
  public let senderAvatarUrl: String?
  public let senderUserId: String?
  public let id: String?
  public let backgroundTask: MemohJSONValue?
  public let externalMessageId: String?
  public let forward: MemohJSONValue?
  public let reply: MemohJSONValue?
  public let runtimeForkable: Bool?
  public let skillActivation: MemohJSONValue?
  enum CodingKeys: String, CodingKey {
    case role, kind, messages, text, platform, id, forward, reply, timestamp
    case turnId = "turn_id"
    case turnPosition = "turn_position"
    case userMessageKind = "user_message_kind"
    case attachments, senderDisplayName = "sender_display_name"
    case senderAvatarUrl = "sender_avatar_url"
    case senderUserId = "sender_user_id"
    case backgroundTask = "background_task"
    case externalMessageId = "external_message_id"
    case runtimeForkable = "runtime_forkable"
    case skillActivation = "skill_activation"
  }
}

public enum UIMessageType: Codable, Sendable {
  case text
  case reasoning
  case tool
  case attachments
  case error
  case command
  case status
  case notice
  case unknown(String)
}
'''

SAMPLE_TS_FAITHFUL = '''
public struct UITurn: Codable, Sendable {
  public let turnId: String
  public let role: String
  public let timestamp: String?
  public let turnPosition: Int?
  public let kind: String?
  public let messages: [UIMessage]?
  public let text: String?
  public let userMessageKind: String?
  public let attachments: [UIAttachment]?
  public let platform: String?
  public let senderDisplayName: String?
  public let senderAvatarUrl: String?
  public let senderUserId: String?
  public let id: String?
  enum CodingKeys: String, CodingKey {
    case role, kind, messages, text, platform, id, timestamp
    case turnId = "turn_id"
    case turnPosition = "turn_position"
    case userMessageKind = "user_message_kind"
    case attachments, senderDisplayName = "sender_display_name"
    case senderAvatarUrl = "sender_avatar_url"
    case senderUserId = "sender_user_id"
  }
}

public enum UIMessageType: Codable, Sendable {
  case text
  case reasoning
  case tool
  case attachments
  case error
  case command
  case status
  case notice
  case unknown(String)
}
'''

SAMPLE_ENUM_GAP = '''
public enum UIMessageType: Codable, Sendable {
  case text
  case reasoning
  case tool
  case attachments
  case error
  case notice
  case unknown(String)
}
'''

SAMPLE_BROKEN = '''
public struct Bot: Codable, Sendable {
  public let id: String
  public let name: String
  public let avatarUrl: String
  public let displayName: String?
  public let timezone: String?
  public let isActive: Bool?
  public let status: String?
  public let ownerUserId: String?
  public let metadata: [String: MemohJSONValue]?
  public let createdAt: String?
  public let updatedAt: String?
  public let checkState: String?
  public let checkIssueCount: Int?
  public let currentUserPermissions: [String]?
  enum CodingKeys: String, CodingKey {
    case id, name, status, timezone, metadata
    case displayName = "display_name"
    case avatarUrl = "avatar_url"
    case isActive = "is_active"
    case ownerUserId = "owner_user_id"
    case createdAt = "created_at"
    case updatedAt = "updated_at"
    case checkState = "check_state"
    case checkIssueCount = "check_issue_count"
    case currentUserPermissions = "current_user_permissions"
  }
}

public struct UITurn: Codable, Sendable {
  public let turnId: String
  public let role: String
  public let timestamp: String?
  public let turnPosition: Int
  public let id: String?
  enum CodingKeys: String, CodingKey {
    case role, id, timestamp
    case turnId = "turn_id"
    case turnPosition = "turn_position"
  }
}

public struct UIMessageListResponse: Codable, Sendable {
  public let items: [UITurn]?
}

public enum UIMessageType: Codable, Sendable {
  case text
  case reasoning
  case tool
  case unknown(String)
}
'''

# 自测期望：`(样本名, 源码, 期望退出码, 必须出现的 error 片段, 必须出现的 info 片段)`。
# 这些片段是"检查真的会响"的证据——只会说"通过"的检查等于没有检查。
SELF_TEST_CASES = [
    ("complete", SAMPLE_COMPLETE, 0, [], []),
    ("ts-faithful", SAMPLE_TS_FAITHFUL, 0, [], []),
    ("enum-gap", SAMPLE_ENUM_GAP, 0, [], [
        # 有 unknown 兜底 → 缺 case 是保真度缺口（info），不是崩溃风险
        "UIMessageType 缺枚举 case `command`",
        "UIMessageType 缺枚举 case `status`",
    ]),
    ("broken", SAMPLE_BROKEN, 1, [
        # 第 4 组（夹具判据）：真响应里没有 avatar_url，非可选就会解码失败
        "Bot.avatarUrl 非可选，但真响应 raw/list-bots.json 的这个位置**没有** `avatar_url` 键",
        # 规则 1：spec 有的字段 Swift 没有
        "UITurn 缺 spec 属性 `messages`",
        # 规则 3：definition 声明了 required，Swift 非可选却不在其中
        "UITurn.turnPosition 非可选，但 `turn_position` 不在 conversation.UITurn.required",
        # 规则 2：spec required 的字段被 Swift 放宽成可选
        "UIMessageListResponse.items 是可选，但 spec 把 `items` 列进了 handlers.UIMessageListResponse.required",
    ], []),
]


def self_test(spec: dict, raw_dir: str, manifest_path: str) -> int:
    failures = 0
    with tempfile.TemporaryDirectory() as tmp:
        for name, source, want_code, want_errors, want_infos in SELF_TEST_CASES:
            path = os.path.join(tmp, "%s.swift" % name)
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(source)
            types, parse_problems = parse_swift(source, path)
            findings = list(parse_problems)
            for type_name, swift in types.items():
                if type_name in MAPPING:
                    findings += check_type(spec, swift, MAPPING[type_name], False, path)
                if type_name in ENUM_MAPPING:
                    findings += check_enum(spec, swift, ENUM_MAPPING[type_name], path)
            fixture_findings, _ = check_fixtures(types, raw_dir, manifest_path, path)
            findings += fixture_findings
            errors = [f for f in findings if f.severity == "error"]
            infos = [f for f in findings if f.severity == "info"]
            got_code = 1 if errors else 0
            error_text = "\n".join(str(f) for f in errors)
            info_text = "\n".join(str(f) for f in infos)
            missing = [frag for frag in want_errors if frag not in error_text]
            missing += [frag for frag in want_infos if frag not in info_text]
            ok = got_code == want_code and not missing
            print("  %-12s 退出码 %d（期望 %d）错误 %d 条 / 无法判定 %d 条%s"
                  % (name, got_code, want_code, len(errors), len(infos),
                     "" if ok else "  ← 不符合期望"))
            for frag in missing:
                print("     缺少期望的片段：%s" % frag)
            if not ok:
                failures += 1
    if failures:
        print("\n自测失败：%d 个样本不符合期望" % failures)
        return 1
    print("\n自测通过：四份样本（完整 / TS 忠实镜像 / 有兜底的枚举缺口 / 故意写坏）都按预期响")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Swift 模型 ↔ swagger 一致性检查")
    parser.add_argument("--models", default=os.path.join(REPO_ROOT, DEFAULT_MODELS))
    parser.add_argument("--swagger", default=os.path.join(REPO_ROOT, DEFAULT_SWAGGER))
    parser.add_argument("--raw-dir", default=os.path.join(REPO_ROOT, DEFAULT_RAW_DIR))
    parser.add_argument("--manifest", default=os.path.join(REPO_ROOT, DEFAULT_MANIFEST))
    parser.add_argument("--strict-optionality", action="store_true",
                        help="definition 未声明 required 时，Swift 非可选也算错")
    parser.add_argument("--self-test", action="store_true",
                        help="用内置样本验证这套检查会响（不读真实模型文件）")
    args = parser.parse_args()

    spec = json.load(open(args.swagger, encoding="utf-8"))

    if args.self_test:
        print("自测：")
        return self_test(spec, args.raw_dir, args.manifest)

    if not os.path.isfile(args.models):
        print("未找到模型文件：%s" % os.path.relpath(args.models, REPO_ROOT))
        print("（A 侧的 Swift 模型还没落地。这一项现在不算失败——文件一出现，"
              "这个脚本就会逐条给出不一致清单。）")
        print("映射表里有 %d 个类型等着它：%s"
              % (len(MAPPING), ", ".join(sorted(set(MAPPING)))))
        return 0

    source = open(args.models, encoding="utf-8").read()
    types, findings = parse_swift(source, os.path.relpath(args.models, REPO_ROOT))
    if not types:
        print("模型文件里没解析出任何类型声明：%s" % args.models)
        return 1

    mapped = 0
    for type_name in sorted(types):
        swift = types[type_name]
        if type_name in MAPPING:
            mapped += 1
            findings += check_type(spec, swift, MAPPING[type_name], args.strict_optionality,
                                   os.path.relpath(args.models, REPO_ROOT))
        if type_name in ENUM_MAPPING:
            findings += check_enum(spec, swift, ENUM_MAPPING[type_name],
                                   os.path.relpath(args.models, REPO_ROOT))

    fixture_findings, fixture_objects = check_fixtures(
        types, args.raw_dir, args.manifest, os.path.relpath(args.models, REPO_ROOT))
    findings += fixture_findings

    unmapped = sorted(set(types) - set(MAPPING) - set(ENUM_MAPPING))
    if unmapped:
        print("未在映射表里（不检查）：%s\n" % ", ".join(unmapped))
    print("映射到 spec 的类型：%d / %d" % (mapped, len(MAPPING)))

    meta_path = os.path.join(os.path.dirname(args.raw_dir), "capture-meta.json")
    redactions = {}
    if os.path.isfile(meta_path):
        redactions = json.load(open(meta_path, encoding="utf-8")).get("redacted_values", {})

    return report(findings, os.path.relpath(args.models, REPO_ROOT), fixture_objects,
                  redactions)


if __name__ == "__main__":
    sys.exit(main())
