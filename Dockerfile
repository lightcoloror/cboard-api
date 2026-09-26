FROM node:22.23.1-bookworm-slim AS dependencies

WORKDIR /opt/cboard-api

ARG DEBIAN_MIRROR=http://deb.debian.org/debian
ARG DEBIAN_SECURITY_MIRROR=http://deb.debian.org/debian-security

RUN sed -i \
    -e "s#http://deb.debian.org/debian-security#${DEBIAN_SECURITY_MIRROR}#g" \
    -e "s#http://deb.debian.org/debian#${DEBIAN_MIRROR}#g" \
    /etc/apt/sources.list.d/debian.sources \
  && apt-get -o Acquire::ForceIPv4=true \
    -o Acquire::http::Timeout=20 -o Acquire::Retries=2 update \
  && apt-get install -y --no-install-recommends \
    ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

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

# The bounded closure batch relies on these distribution utilities. Fail the
# image build if a future base image removes either runtime dependency.
RUN command -v timeout >/dev/null && command -v flock >/dev/null

USER node

EXPOSE 10010

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "require('http').get('http://127.0.0.1:10010/health', response => process.exit(response.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"]

CMD ["node", "app.js"]
