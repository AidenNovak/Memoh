#!/usr/bin/env bash
# Memoh dev 的公网入口（vultr-sg）。
#
# ## 它解决什么
#
# dev 栈原本只绑 127.0.0.1，靠 SSH 隧道给模拟器用（见 infra/local/memoh-tunnel.sh）。
# 但 **TestFlight 装的包在真机上，隧道够不着它**——手机要能直连一个公网地址，
# 否则"发出去的包能用"这件事根本没法成立。
#
# ## 暴露了什么
#
# 只暴露 /opt/memoh-dev 这一个栈（与同机生产 meimaobing-alpha 完全隔离）。
# 服务端自己的鉴权不动：除 `/`、`/ping`、`/health`、`/auth/login`、`/runtimes/connect`
# 等少数端点外，一律要 JWT；`/runtimes/connect` 要 bearer runtime key，没 key 是 401。
# 这个脚本不引入任何绕过。
#
# ## 为什么不用 Cloudflare 代理
#
# 与 learn.yettodawn.com 保持一致：DNS-only（灰云）。开了代理之后 WebSocket 与
# 长连接的表现会多一层不透明，排查手机上"连不上"的问题时那层会很碍事。
#
# 用法（在 vultr-sg 上，root）：
#
#   ./memoh-public-ingress.sh install    # 装 vhost + 校验 + reload
#   ./memoh-public-ingress.sh verify     # HTTP 验收（不依赖浏览器）
#   ./memoh-public-ingress.sh status
#   ./memoh-public-ingress.sh uninstall  # 摘掉公网入口，回到只绑 127.0.0.1
#
# 前置：DNS 记录（A → 本机公网 IP，DNS-only）与证书已就位。证书用 DNS-01 签，
# 因为这个域名的 DNS 在 Cloudflare 而 80 端口不保证可达：
#
#   certbot certonly --non-interactive --agree-tos --register-unsafely-without-email \
#     --authenticator dns-cloudflare \
#     --dns-cloudflare-credentials /root/.secrets/certbot/cloudflare.ini \
#     --dns-cloudflare-propagation-seconds 25 \
#     --cert-name memoh.yetodawn.com \
#     -d memoh.yetodawn.com -d memoh.yettodawn.com
set -euo pipefail

HOST_PRIMARY=memoh.yetodawn.com
HOST_ALT=memoh.yettodawn.com
CERT_NAME=memoh.yetodawn.com
UPSTREAM_API=127.0.0.1:18080   # compose 里 server 绑的端口
UPSTREAM_WEB=127.0.0.1:18082   # compose 里 web 绑的端口
SITE=/etc/nginx/sites-available/memoh-dev-public
LINK=/etc/nginx/sites-enabled/memoh-dev-public

die() { echo "错误：$*" >&2; exit 1; }

need_root() { [ "$(id -u)" -eq 0 ] || die "要用 root 跑（nginx 配置在 /etc）"; }

render() {
  cat <<EOF
# Memoh dev 公网入口 —— 由 infra/vultr-sg/memoh-public-ingress.sh 安装，别手改。
#
# 443 由宿主 nginx 的 SNI 分流进来（nginx.conf 里 www.samsung.com → Xray REALITY，
# default → 127.0.0.1:9443），所以这里监听 9443 而不是 443。
#
# 只做反代，不做鉴权：Memoh 服务端自己认 JWT 与 runtime key（见脚本头注释）。

server {
    listen 80;
    listen [::]:80;
    server_name $HOST_PRIMARY $HOST_ALT;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/html;
        default_type "text/plain";
        try_files \$uri =404;
    }
    location / { return 308 https://\$host\$request_uri; }
}

server {
    # nginx 1.24（Ubuntu 24.04）：http2 只能写在 listen 上。
    listen 127.0.0.1:9443 ssl http2;
    listen [::1]:9443 ssl http2;
    server_name $HOST_PRIMARY $HOST_ALT;

    ssl_certificate     /etc/letsencrypt/live/$CERT_NAME/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$CERT_NAME/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;

    # 手机端上传附件（截图、文件）。默认 1m 太小。
    client_max_body_size 50m;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/html;
        default_type "text/plain";
        try_files \$uri =404;
    }

    # Web —— 桌面/网页端。iOS App 不需要，但公网地址能开出网页才好排查。
    location = / {
        proxy_pass http://$UPSTREAM_WEB;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 60s;
    }

    # API（含 WebSocket 实时通道）。
    #
    # 实时通道的长连接必须带 Upgrade/Connection 头，否则握手失败——那会表现成
    # "消息发出去但回复不出现"，很难从表面看出是 nginx 少了一行。
    location / {
        proxy_pass http://$UPSTREAM_API;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$memoh_dev_connection_upgrade;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }
}
EOF
}

cmd_install() {
  need_root
  [ -f "/etc/letsencrypt/live/$CERT_NAME/fullchain.pem" ] || die "证书不存在：$CERT_NAME（先按脚本头的 certbot 命令签）"
  mkdir -p /var/www/html

  [ -f "$SITE" ] && cp -a "$SITE" "$SITE.bak.$(date -u +%Y%m%dT%H%M%SZ)"
  render > "$SITE"
  ln -sfn "$SITE" "$LINK"

  # upgrade map 必须只定义一次：http 上下文里重名 map 会直接让 nginx 起不来。
  if ! grep -rqs 'memoh_dev_connection_upgrade' /etc/nginx/conf.d/; then
    cat > /etc/nginx/conf.d/memoh-dev-maps.conf <<'EOF'
# 由 infra/vultr-sg/memoh-public-ingress.sh 安装。
map $http_upgrade $memoh_dev_connection_upgrade {
    default upgrade;
    ''      close;
}
EOF
    echo "已写 /etc/nginx/conf.d/memoh-dev-maps.conf"
  fi

  nginx -t || die "nginx 配置校验失败——**没有 reload**，现网未受影响"
  systemctl reload nginx
  echo "已安装并 reload：$HOST_PRIMARY / $HOST_ALT"
}

cmd_verify() {
  local fail=0
  echo "=== 公网 HTTP 验收（$HOST_PRIMARY）==="

  printf '  未认证的 /bots（期望 401，说明鉴权在起作用）… '
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "https://$HOST_PRIMARY/bots" || true)
  echo "$code"; [ "$code" = 401 ] || { echo "    期望 401，实际 $code —— 暴露面可能比预期大"; fail=1; }

  printf '  /auth/login 可达（期望 400/401 而不是 5xx/连接失败）… '
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X POST \
    -H 'Content-Type: application/json' -d '{}' "https://$HOST_PRIMARY/auth/login" || true)
  echo "$code"; case "$code" in 4*) ;; *) echo "    期望 4xx，实际 $code"; fail=1;; esac

  printf '  TLS 证书主体 … '
  echo | openssl s_client -connect "$HOST_PRIMARY:443" -servername "$HOST_PRIMARY" 2>/dev/null \
    | openssl x509 -noout -subject -dates 2>/dev/null | tr '\n' ' ' || true
  echo

  printf '  备用域名（$HOST_ALT）… '
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "https://$HOST_ALT/bots" || true)
  echo "$code"; [ "$code" = 401 ] || { echo "    期望 401，实际 $code"; fail=1; }

  # 真实登录：证明不只是"端口开着"，而是这个栈真的能用。
  printf '  真实登录 admin（读服务端 secrets，不打印密码）… '
  local env_file=/opt/memoh-dev/secrets/memoh-dev.env
  if [ -f "$env_file" ]; then
    local pw body
    pw=$(grep -E '^MEMOH_ADMIN_PASSWORD=' "$env_file" | cut -d= -f2-)
    body=$(curl -s --max-time 25 -X POST -H 'Content-Type: application/json' \
      -d "{\"username\":\"admin\",\"password\":\"$pw\"}" "https://$HOST_PRIMARY/auth/login" || true)
    if printf '%s' "$body" | grep -q 'access_token'; then
      echo "拿到 token"
    else
      echo "失败：$(printf '%s' "$body" | head -c 160)"; fail=1
    fi
  else
    echo "跳过（没读到 $env_file）"
  fi

  [ "$fail" -eq 0 ] && echo "验收通过" || { echo "验收失败"; return 1; }
}

cmd_status() {
  echo "=== vhost ==="
  ls -l "$LINK" 2>/dev/null || echo "  未安装"
  echo "=== 监听 ==="
  ss -ltnp 2>/dev/null | grep -E ':9443' | head -3
  echo "=== 证书 ==="
  [ -f "/etc/letsencrypt/live/$CERT_NAME/fullchain.pem" ] \
    && openssl x509 -in "/etc/letsencrypt/live/$CERT_NAME/fullchain.pem" -noout -subject -dates \
    || echo "  无"
}

cmd_uninstall() {
  need_root
  rm -f "$LINK"
  rm -f "$SITE"
  rm -f /etc/nginx/conf.d/memoh-dev-maps.conf
  nginx -t && systemctl reload nginx && echo "已摘除公网入口（证书与 DNS 记录保留）"
}

case "${1:-}" in
  install) cmd_install ;;
  verify) cmd_verify ;;
  status) cmd_status ;;
  uninstall) cmd_uninstall ;;
  *) echo "用法：$0 {install|verify|status|uninstall}" >&2; exit 2 ;;
esac
