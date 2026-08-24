#!/usr/bin/env bash
# Copy this machine's Codex CLI login into docker/.env.
#
# The container needs the ChatGPT OAuth grant the Codex CLI already holds; this
# reads it and rewrites the three CODEX_* lines in .env, leaving everything
# else in the file untouched. Run `codex login` first if there is no login yet.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
auth="${CODEX_AUTH_FILE:-${CODEX_HOME:-$HOME/.codex}/auth.json}"
env_file="$here/.env"

[[ -f "$auth" ]] || { echo "no Codex login at $auth — run 'codex login' first" >&2; exit 66; }
[[ -f "$env_file" ]] || cp "$here/.env.example" "$env_file"

read -r access refresh account < <(node -e '
  const auth = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
  const t = auth.tokens ?? {}
  if (typeof t.access_token !== "string" || typeof t.refresh_token !== "string") {
    console.error("that auth.json carries no ChatGPT tokens")
    process.exit(65)
  }
  console.log(t.access_token, t.refresh_token, t.account_id ?? "")
' "$auth")

python3 - "$env_file" "$access" "$refresh" "$account" <<'PY'
import re, sys
path, access, refresh, account = sys.argv[1:5]
text = open(path).read()
for key, value in (('CODEX_ACCESS_TOKEN', access), ('CODEX_REFRESH_TOKEN', refresh), ('CODEX_ACCOUNT_ID', account)):
    line = f'{key}={value}'
    text, count = re.subn(rf'(?m)^{key}=.*$', lambda _: line, text)
    if count == 0:
        text = text.rstrip('\n') + '\n' + line + '\n'
open(path, 'w').write(text)
PY

chmod 600 "$env_file"
echo "wrote the Codex grant into $env_file"
echo "if the container already ran, set CODEX_SEED=force for one start to replace its stored grant"
