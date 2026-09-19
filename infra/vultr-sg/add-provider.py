#!/usr/bin/env python3
"""给 Memoh dev 环境加一个模型提供商（含它的模型）。

为什么要这个脚本：真实 API 场景要跨模型家族测。不同家族的流式行为不一样——
思考块的有无、增量粒度、工具调用的表达方式、错误码——这些差异只有真打过才知道，
而 iOS 端的状态机必须能处理全部。

密钥只从环境变量读、只写进服务器，**不打印**。

用法（在 vultr-sg 上）：
    MEMOH_PROVIDER_SPEC='{
      "name": "Kimi",
      "base_url": "https://api.kimi.com/coding/v1",
      "api_key": "…",
      "models": [
        {"id": "k3", "name": "Kimi K3", "compat": ["reasoning", "tool-call"]}
      ]
    }' python3 add-provider.py
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

BASE = Path('/opt/memoh-dev')
ENV_FILE = BASE / 'secrets' / 'memoh-dev.env'
API = 'http://127.0.0.1:18080'


def load_env(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    if not path.exists():
        return env
    for line in path.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        env[key] = value
    return env


def fail(message: str) -> None:
    print(f'错误：{message}', file=sys.stderr)
    raise SystemExit(1)


class Api:
    def __init__(self, token: str) -> None:
        self.token = token

    def call(self, method: str, path: str, body: object | None = None) -> object:
        data = None if body is None else json.dumps(body).encode('utf-8')
        request = urllib.request.Request(f'{API}{path}', data=data, method=method)
        request.add_header('Authorization', f'Bearer {self.token}')
        if data is not None:
            request.add_header('Content-Type', 'application/json')
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                payload = response.read().decode('utf-8')
        except urllib.error.HTTPError as error:
            detail = error.read().decode('utf-8', 'replace')
            fail(f'{method} {path} → HTTP {error.code}: {detail[:300]}')
        except Exception as error:  # noqa: BLE001 - 连不上也要给一句人话
            fail(f'{method} {path} 连不上：{error}')
        if payload == '':
            return None
        return json.loads(payload)


def as_items(response: object) -> list[dict]:
    """列表接口有的返回 {items:[...]}，有的直接返回 [...]。"""
    if isinstance(response, dict):
        items = response.get('items')
        if isinstance(items, list):
            return [item for item in items if isinstance(item, dict)]
        return []
    if isinstance(response, list):
        return [item for item in response if isinstance(item, dict)]
    return []


def main() -> int:
    raw = os.environ.get('MEMOH_PROVIDER_SPEC')
    if not raw:
        fail('需要环境变量 MEMOH_PROVIDER_SPEC（见本文件开头的用法）')
    spec = json.loads(raw)

    name = spec.get('name')
    base_url = spec.get('base_url')
    api_key = spec.get('api_key')
    models = spec.get('models') or []
    if not name or not base_url or not api_key:
        fail('spec 需要 name / base_url / api_key')
    if not models:
        fail('spec.models 不能为空')

    env = load_env(ENV_FILE)
    password = env.get('MEMOH_ADMIN_PASSWORD')
    if not password:
        fail(f'{ENV_FILE} 里没有 MEMOH_ADMIN_PASSWORD')

    login = Api('')
    token_response = login.call(
        'POST', '/auth/login', {'username': 'admin', 'password': password}
    )
    token = token_response.get('access_token') if isinstance(token_response, dict) else None
    if not token:
        fail('登录没有拿到 access_token')
    api = Api(token)

    # provider：同名即复用，但每次都把 base_url / api_key 更新一遍，
    # 避免用着上一次的旧凭据还以为是新的。
    provider_id = None
    for provider in as_items(api.call('GET', '/providers')):
        if provider.get('name') == name:
            provider_id = provider.get('id')
            break

    config = {'base_url': base_url, 'api_key': api_key}
    if provider_id is None:
        created = api.call(
            'POST',
            '/providers',
            {'name': name, 'client_type': 'openai-completions', 'config': config},
        )
        provider_id = created.get('id') if isinstance(created, dict) else None
        if not provider_id:
            fail('建 provider 没有返回 id')
        print(f'provider 新建：{name}')
    else:
        api.call('PUT', f'/providers/{provider_id}', {'config': config})
        print(f'provider 复用：{name}')

    # 模型：逐个建/更新，**必须显式 enable**。
    # 导入或新建的模型默认是 disabled，不启用的话 run 会在解析阶段就失败
    # （"chat model ... is disabled"），而那个错误看起来像模型不可用，不像配置没生效。
    existing = {
        model.get('model_id'): model
        for model in as_items(api.call('GET', f'/providers/{provider_id}/models'))
    }

    created_models: list[tuple[str, str]] = []
    for model in models:
        model_id = model.get('id')
        display = model.get('name') or model_id
        compat = model.get('compat') or []
        if not model_id:
            fail('模型项缺少 id')

        body: dict[str, object] = {
            'model_id': model_id,
            'name': display,
            'provider_id': provider_id,
            'type': 'chat',
            'enable': True,
        }
        if compat:
            body['config'] = {'compatibilities': compat}

        current = existing.get(model_id)
        if current is None:
            result = api.call('POST', '/models', body)
            uuid = result.get('id') if isinstance(result, dict) else None
            if not uuid:
                fail(f'建模型 {model_id} 没有返回 id')
        else:
            uuid = current.get('id')
            api.call('PUT', f'/models/{uuid}', body)

        created_models.append((model_id, str(uuid)))
        caps = f' caps={"+".join(compat)}' if compat else ''
        print(f'  模型 {model_id} → 已启用{caps}')

    # 记录 id 供后续脚本引用（含密钥的文件不在这里，这是纯 id）。
    ids_file = BASE / 'secrets' / 'dev-ids.env'
    lines = ids_file.read_text(encoding='utf-8').splitlines() if ids_file.exists() else []
    lines = [line for line in lines if not line.startswith('MEMOH_DEV_EXTRA_')]
    for index, (model_id, uuid) in enumerate(created_models):
        lines.append(f'MEMOH_DEV_EXTRA_MODEL_{index}_{model_id.replace("-", "_")}={uuid}')
    ids_file.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    os.chmod(ids_file, 0o600)

    print('\n完成。可用模型：')
    for model_id, uuid in created_models:
        print(f'  {model_id}\t{uuid}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
