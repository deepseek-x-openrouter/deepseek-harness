# syntax=docker/dockerfile:1.7
# DeepSeek Harness (this fork) as a single container: the harness on loopback,
# a password-gated proxy in front of it, the workspace preview plugin composed
# into the web profile, and no OpenRouter plugin.
#
# Build from the repository root:
#   docker build -f docker/Dockerfile -t dsh-preview .
# or let docker/docker-compose.yml do it.

FROM caddy:2-alpine AS caddy
# Copied rather than referenced in place so the published binary's
# cap_net_bind_service is left behind: nothing here binds a privileged port,
# and the capability would survive into a container that drops the rest.
RUN cp /usr/bin/caddy /caddy

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

COPY --from=caddy /caddy /usr/bin/caddy
COPY --from=build /opt/dsh /opt/dsh
COPY docker/Caddyfile /etc/caddy/Caddyfile

# The container's own account, deliberately not the base image's `node` (uid
# 1000): on most hosts uid 1000 is a real person, and a bind mount or a socket
# they own would be the agent's to write. 10001 belongs to nobody.
# Build with --build-arg UID=$(id -u) to match a bind-mounted workspace's owner
# instead, accepting that the container then runs with that account's reach.
ARG UID=10001
ARG GID=10001
RUN groupadd --gid "$GID" dsh \
    && useradd --uid "$UID" --gid "$GID" --create-home --home-dir /home/dsh --shell /bin/bash dsh \
    && chmod +x /opt/dsh/docker/entrypoint.sh \
    && mkdir -p /data /workspace \
    && chown -R dsh:dsh /data /workspace /home/dsh

# Signing in happens in here, never through the environment: `dsh-login` runs
# the pi-ai provider's own OAuth flow (ChatGPT's device code needs no callback
# port) and leaves the grant in the credential store the harness reads.
# The TypeScript loader resolves from the working directory, which is the
# workspace the user is standing in, so the command steps into the install.
RUN printf '#!/bin/sh\ncd /opt/dsh && exec node --import tsx/esm /opt/dsh/docker/login.mjs "$@"\n' \
      > /usr/local/bin/dsh-login \
    && chmod +x /usr/local/bin/dsh-login

# The harness home is a volume: credentials, sessions, settings, and the
# profile all live there and outlive the image.
ENV DSH_HOME=/data \
    DSH_TELEMETRY_DISABLED=1 \
    WEB_PORT=8080 \
    HARNESS_PORT=3080

USER dsh
WORKDIR /workspace
EXPOSE 8080
VOLUME ["/data", "/workspace"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS -o /dev/null "http://127.0.0.1:${HARNESS_PORT}/" || exit 1

ENTRYPOINT ["/opt/dsh/docker/entrypoint.sh"]
