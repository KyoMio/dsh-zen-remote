# Zen Remote 网关服务端：多阶段构建。
#   builder：装全量依赖，tsc 编译后端 + vite 产出 dist/public 控制台；
#   runner：只装生产依赖（pg / ws），以非 root 用户跑
#   `node --experimental-sqlite dist/main.js`，数据落挂载卷 /data。
# 端口：19393/tcp（HTTP+WS+控制台）、19393/udp（STUN 主口）、19394/udp（STUN 辅口）。
FROM node:22-alpine AS builder
WORKDIR /app
# pnpm-workspace.yaml 必须随 manifest 一起进镜像：pnpm ≥10 的构建脚本裁决
# （allowBuilds）住在那里，少这一份 install 会因 ERR_PNPM_IGNORED_BUILDS 退出 1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && corepack prepare pnpm@11 --activate
RUN pnpm install --no-frozen-lockfile
COPY . .
RUN pnpm build

FROM node:22-alpine AS runner
ENV NODE_ENV=production \
    ZR_GATEWAY_DATA_DIR=/data
WORKDIR /app
RUN addgroup -S zr && adduser -S -G zr zr
COPY --from=builder /app/package.json /app/pnpm-lock.yaml ./
RUN corepack enable && corepack prepare pnpm@11 --activate \
    && pnpm install --prod --no-frozen-lockfile \
    && corepack disable
COPY --from=builder /app/dist ./dist
# /data 卷的属主必须在切到非 root 之前建好：匿名卷首挂时会原样拷贝这一层
# 的属主信息，否则 USER zr 写不了 master.key / gateway.sqlite（Linux 上必现）
RUN mkdir -p /data && chown -R zr:zr /data
VOLUME /data
EXPOSE 19393/tcp 19393/udp 19394/udp
USER zr
CMD ["node", "--experimental-sqlite", "dist/main.js"]
