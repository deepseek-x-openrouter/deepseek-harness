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

# Ubuntu 26.04 LTS for its Python 3.14 and a current userland, with Node taken
# from nodejs.org rather than the distribution: this image tracks the current
# Node line, which no distribution package carries.
FROM ubuntu:26.04 AS base
ARG TARGETARCH
ARG NODE_VERSION=26.7.0
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils libatomic1 \
    && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) node_arch=x64 ;; \
      arm64) node_arch=arm64 ;; \
      *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
      | tar -xJ --strip-components=1 -C /usr/local \
        --exclude='*/CHANGELOG.md' --exclude='*/LICENSE' --exclude='*/README.md'; \
    node --version
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
# Corepack is no longer part of the Node distribution, so pnpm is installed
# outright — at the version this workspace's lockfile was written by.
RUN npm install -g --no-fund --no-audit pnpm@11.7.0 && pnpm --version

# Single-file tools that ship as a release download rather than a distribution
# package. Fetched in their own stage so the runtime layer stays free of the
# archives, and so a version bump here does not rebuild anything else.
FROM ubuntu:26.04 AS tools
ARG TARGETARCH
ARG BUN_VERSION=1.4.0
ARG DUCKDB_VERSION=1.5.5
ARG UV_VERSION=0.12.5
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates unzip \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /tools
RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) bun_arch=x64;      duck_arch=amd64; uv_arch=x86_64  ;; \
      arm64) bun_arch=aarch64;  duck_arch=arm64; uv_arch=aarch64 ;; \
      *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o bun.zip \
      "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${bun_arch}.zip"; \
    unzip -q bun.zip && mv "bun-linux-${bun_arch}/bun" /tools/bun; \
    curl -fsSL -o duckdb.zip \
      "https://github.com/duckdb/duckdb/releases/download/v${DUCKDB_VERSION}/duckdb_cli-linux-${duck_arch}.zip"; \
    unzip -q duckdb.zip -d /tools; \
    curl -fsSL "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${uv_arch}-unknown-linux-gnu.tar.gz" \
      | tar -xz --strip-components=1 -C /tools; \
    chmod +x /tools/bun /tools/duckdb /tools/uv /tools/uvx; \
    rm -f bun.zip duckdb.zip

FROM base AS build

# node-pty compiles from source; ripgrep and the landlock addon fetch their
# binaries during install.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/dsh
COPY . .

# The client build stamps the commit it was built from and reads it from git,
# which the build context does not carry; the compose file passes the real one.
ARG DSH_CLIENT_COMMIT_HASH=0000000
ENV DSH_CLIENT_COMMIT_HASH=$DSH_CLIENT_COMMIT_HASH

RUN pnpm install --frozen-lockfile
RUN pnpm run build

FROM base AS runtime

# What the agent gets to work with. bash and git are its own tools, curl
# serves the healthcheck, and the rest is the toolbox any shell task reaches
# for — search, archives, a compiler, a SQL engine, the network probes.
# pnpm comes from the base stage: `dsh plugin` shells out to it.
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash git less \
      ripgrep fd-find jq sqlite3 tree file bc time \
      wget rsync unzip zip bzip2 gzip tar zstd \
      procps psmisc htop tmux vim-tiny nano \
      openssh-client dnsutils iputils-ping netcat-openbsd socat \
      build-essential pkg-config \
      python3 python3-venv python3-dev \
    && ln -s "$(command -v fdfind)" /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/*

# Bun as a second JS runtime (and a fast package manager), DuckDB as the
# column store the data work runs on, uv as the Python installer.
COPY --from=tools /tools/bun /tools/duckdb /tools/uv /tools/uvx /usr/local/bin/

# The container's own account, deliberately not the base image's `node` (uid
# 1000): on most hosts uid 1000 is a real person, and a bind mount or a socket
# they own would be the agent's to write. 10001 belongs to nobody.
# Build with --build-arg UID=$(id -u) to match a bind-mounted workspace's owner
# instead, accepting that the container then runs with that account's reach.
ARG UID=10001
ARG GID=10001
RUN groupadd --gid "$GID" dsh \
    && useradd --uid "$UID" --gid "$GID" --create-home --home-dir /home/dsh --shell /bin/bash dsh \
    && mkdir -p /data /workspace \
    && chown -R dsh:dsh /data /workspace /home/dsh

# The Python toolbox lives in a virtualenv rather than in Debian's Python,
# which is externally managed and refuses installs. The venv belongs to the
# container's user, so the agent can add a package to it at run time; the
# `python3` on PATH is that venv's.
ENV VIRTUAL_ENV=/opt/venv PATH=/opt/venv/bin:/usr/local/bin:$PATH \
    UV_LINK_MODE=copy \
    MPLBACKEND=Agg
COPY docker/requirements.txt /opt/requirements.txt
RUN --mount=type=cache,target=/root/.cache/uv \
    python3 -m venv "$VIRTUAL_ENV" \
    && uv pip install --python "$VIRTUAL_ENV/bin/python" -r /opt/requirements.txt \
    && chown -R dsh:dsh "$VIRTUAL_ENV"

COPY --from=caddy /caddy /usr/bin/caddy
COPY --from=build /opt/dsh /opt/dsh
COPY docker/Caddyfile /etc/caddy/Caddyfile
RUN chmod +x /opt/dsh/docker/entrypoint.sh

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

# Global installs have to land somewhere this user owns, or `npm i -g`,
# `bun add -g` and `uv tool install` all fail on a root-owned prefix. Each
# lands on PATH, so a tool the agent installs is callable in the next command.
ENV BUN_INSTALL=/home/dsh/.bun \
    NPM_CONFIG_PREFIX=/home/dsh/.npm-global \
    UV_TOOL_BIN_DIR=/home/dsh/.local/bin \
    PATH=/home/dsh/.bun/bin:/home/dsh/.npm-global/bin:/home/dsh/.local/bin:$PATH
RUN mkdir -p /home/dsh/.bun/bin /home/dsh/.npm-global/bin /home/dsh/.local/bin /home/dsh/.cache \
    && chown -R dsh:dsh /home/dsh

# A login shell (`bash -l`, and every `docker compose exec … bash -l`) rebuilds
# PATH from /etc/profile, which would drop everything the ENV above put on it.
RUN printf '%s\n' \
      'PATH=/home/dsh/.bun/bin:/home/dsh/.npm-global/bin:/home/dsh/.local/bin:/opt/venv/bin:/pnpm:$PATH' \
      'export PATH VIRTUAL_ENV=/opt/venv' \
      > /etc/profile.d/10-dsh-path.sh

USER dsh
WORKDIR /workspace
EXPOSE 8080
VOLUME ["/data", "/workspace"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS -o /dev/null "http://127.0.0.1:${HARNESS_PORT}/" || exit 1

ENTRYPOINT ["/opt/dsh/docker/entrypoint.sh"]
