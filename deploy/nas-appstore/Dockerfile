# 空间桌面 · NAS 部署镜像
#
# 同源架构：静态前端、极空间接口、独立商店接口都从 space-proxy 的一个端口出去。
# 必须同源的原因：极空间 5055 的 /v2/ 等路由由 nginx 的 auth.lua 保护，只认 cookie，
# 且拒绝时不带 CORS 头——浏览器跨源直连既发不出 cookie 也读不到响应。
FROM alpine:3.20
RUN adduser -D -u 10001 space
COPY --chmod=0555 space-proxy /usr/local/bin/space-proxy
COPY --chmod=0555 space-gateway /usr/local/bin/space-gateway
COPY --chmod=0555 entrypoint.sh /usr/local/bin/entrypoint.sh
COPY web/ /web/
RUN chmod +x /usr/local/bin/entrypoint.sh
EXPOSE 18436
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:18436/healthz >/dev/null 2>&1 || exit 1
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
