#!/usr/bin/env python3
"""App Store Connect API 小客户端（只用 stdlib + 系统 openssl）。

## 为什么手写

签名/上传不依赖 Xcode 账号，走 ASC API key。但 ASC 的 JWT 是 **ES256**，而：

- 这台机器没有 `pyjwt` / `cryptography` / `jsonwebtoken`；
- `openssl dgst -sha256 -sign` 对 EC 密钥输出的是 **DER** 编码的 `ECDSA-Sig-Value`，
  而 JWT 要的是 **raw r||s**（各 32 字节）——所以下面做了 DER→raw 的转换。

## 凭据从哪来（都不入库）

三个环境变量，值放在本机（例如 `~/.config/dim-api-keys.zsh`）：

    ASC_KEY_PATH    .p8 私钥路径（仓库外，权限 600）
    ASC_KEY_ID      key id（10 位）
    ASC_ISSUER_ID   issuer id（UUID）

没有就报错退出——不要为了跑通去登录 Xcode 账号或动别人的证书。

## 用法

    python3 tools/asc-api.py list                    # 只读：bundle id / app / 证书 / 描述文件
    python3 tools/asc-api.py builds                  # 只读：已有构建与处理状态
    python3 tools/asc-api.py next-build              # 只读：下一个可用构建号（最大值 +1）
    python3 tools/asc-api.py distribute <构建号> [测试员邮箱]   # 挂到内部测试组（幂等）
    python3 tools/asc-api.py create-cert <类型> <CSR 路径>
    python3 tools/asc-api.py make-profile <证书 id> [描述文件名字]
"""
import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

BASE = 'https://api.appstoreconnect.apple.com'
BUNDLE_ID = 'ai.memoh.ios'


def config():
    missing = [name for name in ('ASC_KEY_PATH', 'ASC_KEY_ID', 'ASC_ISSUER_ID')
               if not os.environ.get(name)]
    if missing:
        sys.exit('缺少环境变量：%s（见本文件头部说明）' % ', '.join(missing))
    return (os.path.expanduser(os.environ['ASC_KEY_PATH']),
            os.environ['ASC_KEY_ID'],
            os.environ['ASC_ISSUER_ID'])


def b64u(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b'=')


def der_to_raw(der):
    """ECDSA-Sig-Value(SEQUENCE{r INTEGER, s INTEGER}) → 64 字节 r||s。"""
    index = 0
    assert der[index] == 0x30, 'not a SEQUENCE'
    index += 1
    length = der[index]
    index += 1
    if length & 0x80:
        index += length & 0x7F
    assert der[index] == 0x02, 'no r'
    index += 1
    r_len = der[index]
    index += 1
    r = der[index:index + r_len]
    index += r_len
    assert der[index] == 0x02, 'no s'
    index += 1
    s_len = der[index]
    index += 1
    s = der[index:index + s_len]
    return r.lstrip(b'\x00').rjust(32, b'\x00') + s.lstrip(b'\x00').rjust(32, b'\x00')


def token():
    key_path, key_id, issuer = config()
    now = int(time.time())
    header = b64u(json.dumps({'alg': 'ES256', 'kid': key_id, 'typ': 'JWT'},
                             separators=(',', ':')).encode())
    payload = b64u(json.dumps({'iss': issuer, 'iat': now, 'exp': now + 900,
                               'aud': 'appstoreconnect-v1'}, separators=(',', ':')).encode())
    message = header + b'.' + payload
    der = subprocess.run(['openssl', 'dgst', '-sha256', '-sign', key_path],
                         input=message, capture_output=True, check=True).stdout
    return (message + b'.' + b64u(der_to_raw(der))).decode()


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(BASE + path, data=data, method=method, headers={
        'Authorization': 'Bearer ' + token(),
        'Content-Type': 'application/json',
    })
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            raw = response.read()
            return response.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode()[:600]


def get(path):
    return call('GET', path)


def app_id():
    status, payload = get('/v1/apps?filter[bundleId]=%s' % BUNDLE_ID)
    if status != 200 or not payload['data']:
        sys.exit('查不到 app 记录 %s（HTTP %s）' % (BUNDLE_ID, status))
    return payload['data'][0]['id']


def cmd_list():
    status, payload = get('/v1/bundleIds?limit=200')
    print('bundle IDs (HTTP %s):' % status,
          [b['attributes']['identifier'] for b in payload['data']] if status == 200 else payload)
    status, payload = get('/v1/apps?limit=200')
    print('apps (HTTP %s):' % status,
          [(a['attributes']['bundleId'], a['attributes']['name']) for a in payload['data']]
          if status == 200 else payload)
    status, payload = get('/v1/certificates?limit=50')
    print('certificates (HTTP %s):' % status,
          [(c['attributes']['certificateType'], c['id']) for c in payload['data']]
          if status == 200 else payload)
    status, payload = get('/v1/profiles?limit=50')
    print('profiles (HTTP %s):' % status,
          [(p['attributes']['name'], p['attributes']['profileState']) for p in payload['data']]
          if status == 200 else payload)


def cmd_builds():
    status, payload = get('/v1/builds?filter[app]=%s&limit=10&sort=-uploadedDate' % app_id())
    if status != 200:
        sys.exit('查构建失败：%s' % payload)
    for build in payload['data']:
        attrs = build['attributes']
        print('构建号=%s 状态=%s 上传=%s' % (attrs.get('version'), attrs.get('processingState'),
                                            attrs.get('uploadedDate')))


def cmd_next_build():
    """打印下一个可用的构建号（ASC 里已有构建号的最大值 +1）。

    为什么要有它：ASC 拒绝同版本重复构建号，而手工记号一定会忘。上传前用
    `MEMOH_BUILD_NUMBER=$(python3 tools/asc-api.py next-build)` 取号即可。
    """
    status, payload = get('/v1/builds?filter[app]=%s&limit=200&sort=-uploadedDate' % app_id())
    if status != 200:
        sys.exit('查构建失败：%s' % payload)
    numbers = [int(build['attributes']['version']) for build in payload['data']
               if str(build['attributes'].get('version', '')).isdigit()]
    print(max(numbers) + 1 if numbers else 1)


def cmd_distribute(build_number, tester_email=None):
    """把某个构建挂到内部测试组，并（可选）把测试员加进去。

    为什么要有它：TestFlight 分发是重复动作，而"哪个构建挂在哪个组、组里有谁"在 API 里
    分散在三处（builds / betaGroups / betaTesters），手工点容易漏。内部测试组里的测试员
    必须是**团队用户**（`/v1/users`），不是外部的 betaTester。
    """
    app = app_id()
    status, builds = get('/v1/builds?filter[app]=%s&limit=200&sort=-uploadedDate' % app)
    if status != 200:
        sys.exit('查构建失败：%s' % builds)
    target = [b for b in builds['data'] if b['attributes'].get('version') == str(build_number)]
    if not target:
        sys.exit('找不到构建号 %s' % build_number)
    build = target[0]
    print('构建 %s：%s' % (build_number, build['attributes'].get('processingState')))

    status, groups = get('/v1/betaGroups?filter[app]=%s&limit=50' % app)
    if status != 200:
        sys.exit('查测试组失败：%s' % groups)
    internal = [g for g in groups['data'] if g['attributes'].get('isInternalGroup')]
    if not internal:
        status, created = call('POST', '/v1/betaGroups', {
            'data': {'type': 'betaGroups',
                     'attributes': {'name': 'Internal Testers', 'isInternalGroup': True},
                     'relationships': {'app': {'data': {'type': 'apps', 'id': app}}}}})
        if status not in (200, 201):
            sys.exit('建内部测试组失败（HTTP %s）：%s' % (status, created))
        internal = [created['data']]
        print('新建内部测试组:', internal[0]['attributes']['name'])
    group = internal[0]
    print('内部测试组:', group['attributes']['name'], group['id'])

    status, payload = call('POST', '/v1/betaGroups/%s/relationships/builds' % group['id'],
                           {'data': [{'type': 'builds', 'id': build['id']}]})
    print('挂载构建：HTTP %s' % status, '' if status in (200, 204) else str(payload)[:300])

    if tester_email:
        status, payload = call('POST', '/v1/betaTesters', {
            'data': {'type': 'betaTesters',
                     'attributes': {'email': tester_email,
                                    'firstName': tester_email.split('@')[0],
                                    'lastName': 'tester'},
                     'relationships': {'betaGroups': {'data': [{'type': 'betaGroups',
                                                                'id': group['id']}]}}}})
        if status in (200, 201):
            print('测试员：%s state=%s' % (tester_email, payload['data']['attributes'].get('state')))
        elif status == 409:
            print('测试员 %s 已在账号里（HTTP 409），把它加进这个组' % tester_email)
            status, listing = get('/v1/betaTesters?filter[email]=%s' % tester_email)
            for tester in (listing.get('data') or []):
                status, payload = call('POST', '/v1/betaGroups/%s/relationships/betaTesters'
                                       % group['id'],
                                       {'data': [{'type': 'betaTesters', 'id': tester['id']}]})
                if status == 409:
                    print('  已在组里（HTTP 409），无需重复添加')
                else:
                    print('  加入组：HTTP %s' % status)
        else:
            print('加测试员失败（HTTP %s）：%s' % (status, str(payload)[:300]))


def cmd_create_cert(kind, csr_path):
    with open(csr_path) as handle:
        csr = handle.read()
    status, payload = call('POST', '/v1/certificates', {
        'data': {'type': 'certificates',
                 'attributes': {'certificateType': kind, 'csrContent': csr}}})
    if status not in (200, 201):
        sys.exit('建证书失败（HTTP %s）：%s' % (status, payload))
    out = os.path.join(os.path.dirname(os.path.abspath(csr_path)), 'dist.cer.b64')
    with open(out, 'w') as handle:
        handle.write(payload['data']['attributes']['certificateContent'])
    print('证书 id:', payload['data']['id'])
    print('证书内容（base64 DER）:', out)


def cmd_make_profile(cert_id, name='Memoh iOS App Store (mini)'):
    status, payload = get('/v1/bundleIds?limit=200')
    if status != 200:
        sys.exit('列 bundleId 失败：%s' % payload)
    target = [b for b in payload['data'] if b['attributes']['identifier'] == BUNDLE_ID]
    if not target:
        sys.exit('没有 %s 的 bundleId' % BUNDLE_ID)
    status, payload = call('POST', '/v1/profiles', {
        'data': {'type': 'profiles',
                 'attributes': {'name': name, 'profileType': 'IOS_APP_STORE'},
                 'relationships': {
                     'bundleId': {'data': {'type': 'bundleIds', 'id': target[0]['id']}},
                     'certificates': {'data': [{'type': 'certificates', 'id': cert_id}]}}}})
    if status not in (200, 201):
        sys.exit('建描述文件失败（HTTP %s）：%s' % (status, payload))
    attrs = payload['data']['attributes']
    out_dir = os.path.expanduser('~/Library/MobileDevice/Provisioning Profiles')
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, attrs['uuid'] + '.mobileprovision')
    with open(path, 'wb') as handle:
        handle.write(base64.b64decode(attrs['profileContent']))
    print('描述文件:', attrs['name'], attrs['uuid'])
    print('装到:', path)


def main(argv):
    command = argv[0] if argv else 'list'
    if command == 'list':
        cmd_list()
    elif command == 'builds':
        cmd_builds()
    elif command == 'next-build':
        cmd_next_build()
    elif command == 'distribute':
        if len(argv) < 2:
            sys.exit('用法：distribute <构建号> [测试员邮箱]')
        cmd_distribute(argv[1], argv[2] if len(argv) > 2 else None)
    elif command == 'create-cert':
        if len(argv) < 3:
            sys.exit('用法：create-cert <DISTRIBUTION|IOS_DISTRIBUTION|DEVELOPMENT> <CSR 路径>')
        cmd_create_cert(argv[1], argv[2])
    elif command == 'make-profile':
        if len(argv) < 2:
            sys.exit('用法：make-profile <证书 id> [描述文件名字]')
        cmd_make_profile(argv[1], argv[2] if len(argv) > 2 else 'Memoh iOS App Store (mini)')
    else:
        sys.exit(__doc__)


if __name__ == '__main__':
    main(sys.argv[1:])
