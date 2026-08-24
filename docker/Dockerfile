# syntax=docker/dockerfile:1.7
# DeepSeek Harness (this fork) as a single container: the harness on loopback,
# a password-gated proxy in front of it, the workspace preview plugin composed
# into the web profile, and no OpenRouter plugin.
#
# Build from the repository root:
#   docker build -f docker/Dockerfile -t dsh-preview .
# or let docker/docker-compose.yml do it.

FROM caddy:2-alpine AS caddy

FROM node:24-bookworm-slim AS build

# node-pty compiles from source; ripgrep and the landlock addon fetch their
# binaries during install.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate

WORKDIR /opt/dsh
COPY . .

# The client build stamps the commit it was built from and reads it from git,
# which the build context does not carry; the compose file passes the real one.
ARG DSH_CLIENT_COMMIT_HASH=0000000
ENV DSH_CLIENT_COMMIT_HASH=$DSH_CLIENT_COMMIT_HASH

RUN pnpm install --frozen-lockfile
RUN pnpm run build

FROM node:24-bookworm-slim AS runtime

# bash and git are the agent's own tools; curl serves the healthcheck.
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash git curl ca-certificates less \
    && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
# `dsh plugin` shells out to pnpm; a user adding a plugin by hand needs it.
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate

COPY --from=caddy /usr/bin/caddy /usr/bin/caddy
COPY --from=build /opt/dsh /opt/dsh
COPY docker/Caddyfile /etc/caddy/Caddyfile

RUN chmod +x /opt/dsh/docker/entrypoint.sh \
    && mkdir -p /data /workspace \
    && chown -R node:node /data /workspace

# The harness home is a volume: credentials, sessions, settings, and the
# profile all live there and outlive the image.
ENV DSH_HOME=/data \
    DSH_TELEMETRY_DISABLED=1 \
    WEB_PORT=8080 \
    HARNESS_PORT=3080

USER node
WORKDIR /workspace
EXPOSE 8080
VOLUME ["/data", "/workspace"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS -o /dev/null "http://127.0.0.1:${HARNESS_PORT}/" || exit 1

ENTRYPOINT ["/opt/dsh/docker/entrypoint.sh"]
