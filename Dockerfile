FROM node:22.23.1-bookworm-slim AS dependencies

WORKDIR /opt/cboard-api

RUN corepack enable && corepack prepare yarn@1.22.22 --activate

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production=true --non-interactive \
  && yarn cache clean

FROM node:22.23.1-bookworm-slim AS runtime

ENV NODE_ENV=production \
  PORT=10010

WORKDIR /opt/cboard-api

COPY --from=dependencies --chown=node:node /opt/cboard-api/node_modules ./node_modules
COPY --chown=node:node . .

USER node

EXPOSE 10010

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "require('http').get('http://127.0.0.1:10010/health', response => process.exit(response.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"]

CMD ["node", "app.js"]
