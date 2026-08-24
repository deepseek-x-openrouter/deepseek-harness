#!/usr/bin/env bash
# Container entrypoint: the authenticating proxy and the harness, in that order.
#
# The harness web server has no authentication of its own and refuses to bind
# anything but the loopback interface, which is exactly the deployment it
# documents: a loopback server behind a proxy that authenticates every request.
# Both processes live in this container, so the proxy reaches the harness over
# the loopback interface they share, and nothing else can.
set -euo pipefail

WEB_USER="${WEB_USER:-dsh}"
WEB_PORT="${WEB_PORT:-8080}"
HARNESS_PORT="${HARNESS_PORT:-3080}"

if [[ -z "${WEB_PASSWORD:-}" ]]; then
  echo "entrypoint: WEB_PASSWORD is required — set it in .env before 'docker compose up'" >&2
  exit 64
fi

# Caddy stores the hash, never the password; hashing here keeps the plaintext
# out of the config file and out of every log line that quotes it.
WEB_PASSWORD_HASH="$(caddy hash-password --plaintext "$WEB_PASSWORD")"
export WEB_USER WEB_PASSWORD_HASH WEB_PORT HARNESS_PORT
unset WEB_PASSWORD

node /opt/dsh/docker/bootstrap.mjs

caddy run --config /etc/caddy/Caddyfile --adapter caddyfile &
CADDY_PID=$!

# Every authority the browser may address this deployment by. The harness
# accepts loopback names on its own; anything else (a domain fronting this
# container) has to be named or the API fence refuses the page's requests.
trusted=()
IFS=',' read -ra hosts <<< "${PUBLIC_HOST:-localhost:$WEB_PORT}"
for host in "${hosts[@]}"; do
  host="$(echo "$host" | xargs)"
  [[ -n "$host" ]] && trusted+=(--trusted-host "$host")
done

# The configuration plane (settings, credentials, model discovery) is loopback
# only unless this flag opens it to trusted hosts. Without it the browser can
# talk to a session but cannot change a setting — the proxy above is the gate
# the flag's contract requires.
config_flag=()
[[ "${TRUST_REMOTE_CONFIG:-1}" == "1" ]] && config_flag+=(--trust-remote-config)

shutdown() {
  kill "$CADDY_PID" 2>/dev/null || true
}
trap shutdown EXIT

echo "entrypoint: serving on :$WEB_PORT as user '$WEB_USER' (harness on 127.0.0.1:$HARNESS_PORT)"

# The workspace picker opens on the home directory, and a session that lands
# anywhere but the mounted volume is lost with the container — so the harness
# gets the volume as its home. Caddy above keeps the image's own.
HOME=/workspace node /opt/dsh/apps/cli/lib/bin.js --profile "${DSH_PROFILE:-web}" \
  --host 127.0.0.1 \
  --port "$HARNESS_PORT" \
  --no-open \
  "${trusted[@]}" \
  "${config_flag[@]}" \
  "$@" &
DSH_PID=$!

# Either process exiting takes the container down: a dead proxy would expose
# nothing, and a dead harness would serve nothing.
wait -n "$CADDY_PID" "$DSH_PID"
exit $?
