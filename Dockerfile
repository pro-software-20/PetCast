FROM node:22-bookworm-slim AS build

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@12.14.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server ./server
COPY electron ./electron
COPY src ./src
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm run build:server

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    PROMPT_RATE_LIMIT_STATE_PATH=/data/rate-limits.json

WORKDIR /app
COPY --from=build --chown=node:node /app/dist-server ./dist-server
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 8787
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist-server/server/main.js"]
