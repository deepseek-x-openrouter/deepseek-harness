# DeepSeek Harness in Docker

One container that serves this fork's web UI behind a password, runs the agent
on a ChatGPT (Codex) subscription, and ships the workspace preview panel. No
OpenRouter plugin is installed.

To pull the image instead of building it — and to fold this into a stack you
already run — skip to [Put it in another stack](#put-it-in-another-stack).

## Start it

```sh
cd docker
cp .env.example .env
$EDITOR .env                    # set WEB_PASSWORD
docker compose up -d --build
docker compose exec dsh dsh-login   # sign in to the ChatGPT subscription
```

Then open <http://localhost:8080> and sign in with `WEB_USER` / `WEB_PASSWORD`.

The first build compiles the whole monorepo and takes a while; later starts are
immediate. `docker compose logs -f` shows what the container did with the home
volume on start, including whether it is signed in yet.

## Signing in

No token ever passes through `.env`, the compose file, or the image. `dsh-login`
runs the pi-ai provider's own OAuth flow inside the container and pi-ai writes
the grant straight into `/data/.credentials.yaml` — the same writer that later
refreshes the access token and rotates the refresh token in place, so a signed-in
container stays signed in without anything from outside.

It offers ChatGPT's two methods. **Device code** is the one to pick: it prints a
URL and a code you type into a browser anywhere, so nothing has to reach a
callback port inside the container.

```
$ docker compose exec dsh dsh-login
Signing in to OpenAI Codex (oauth).

Select OpenAI Codex login method:
  1) Browser login (default)
  2) Device code login (headless)
choice [1]: 2

Enter this code on the verification page to finish signing in.
  https://auth.openai.com/codex/device
  code: XXXX-XXXXX
```

Reload the browser tab afterwards and the model menu offers the Codex models.
Signing in again later replaces the stored grant; the same command takes any
other pi-ai provider as an argument (`dsh-login anthropic`), though a provider
the container did not seed also needs its route added from Settings → Models.

Browser login works too, if you would rather use it: it waits on
`http://localhost:1455/auth/callback` inside the container, so publish that port
(`ports: - "127.0.0.1:1455:1455"`) before starting the flow.

## What is inside

| | |
|---|---|
| **The harness** | this checkout, built from source, so the fork's own changes are in it: no first-run testing notice, the aside column, the provider-first model menu, `--trust-remote-config`, and the `llm-pi-ai/provider-response` event |
| **The preview plugin** | [`plugin-preview/`](plugin-preview/README.md) — the workspace preview panel and the Codex limit readout, composed into the `web` profile as the bundle `dsh-preview` |
| **The gate** | Caddy, holding a bcrypt hash of `WEB_PASSWORD`, proxying to the harness on the loopback interface it shares with it |

The harness web server has no authentication of its own and refuses to bind
anything but loopback — its documented deployment is exactly this: loopback,
behind a proxy that authenticates every request. Both processes run in this
container, so nothing but the proxy can reach the harness. `TRUST_REMOTE_CONFIG`
(on by default) is what lets the browser change settings and credentials
through that gate; turn it off to pin the configuration plane back to loopback,
at the cost of the model menu and the theme switch not persisting.

**Anyone who gets past the password can run commands as the container's user.**
The password is the whole fence. Use a real one, and put TLS in front of the
container before publishing it beyond `127.0.0.1` (set `BIND_ADDR`, and name
the public authority in `PUBLIC_HOST` so the harness accepts pages served under
it).

## Who it runs as

The container runs as its own unprivileged account, `dsh`, uid **10001** — not
the base image's uid 1000, which on most hosts is a real person whose files,
sockets, and bind mounts would otherwise be within the agent's reach. The
installation under `/opt/dsh` stays root-owned, so the agent cannot rewrite the
harness it is running in, and nothing in the container is ever root.

That uid has to be able to write the two volumes:

- The **home volume** is created with the right ownership on first use. A
  volume left over from an image that ran as another user is not, and the
  container says so on start with the one command that fixes it.
- A **bind-mounted workspace** belongs to whoever owns it on the host. Either
  give it to 10001 (`sudo chown -R 10001:10001 <dir>`), or build the image
  under your own ids instead:

  ```sh
  UID=$(id -u) GID=$(id -g) docker compose up -d --build
  ```

  The second choice trades the separation back: the container then runs with
  exactly the reach of that account. It is the right one for a laptop working
  on your own files, the wrong one on a shared host.

## Where the state lives

| Path | Volume | Holds |
|---|---|---|
| `/data` | `dsh-home` | sessions, `settings.yaml`, `.credentials.yaml`, the profile |
| `/workspace` | `dsh-workspace`, or `WORKSPACE_DIR` | what the agent edits |

Point `WORKSPACE_DIR` at a host directory to work on real files:

```sh
WORKSPACE_DIR=/home/you/projects
```

On every start, `bootstrap.mjs` reconciles the home volume with the image: it
rewrites the profile's bundle list (adding `dsh-preview`, dropping any bundle
this image no longer installs), seeds `settings.yaml` if the volume has none,
and reports whether anyone has signed in yet. It never writes a credential and
never overwrites settings you have changed.

## Other settings

Everything is in `.env`; `.env.example` documents each one. The ones worth
knowing: `WEB_PORT` and `BIND_ADDR` (where it is published), `PUBLIC_HOST` (the
authorities the API fence accepts), `CODEX_MODEL` (what the first start writes
into `settings.yaml`; change it later from the model menu).

## Put it in another stack

Every push to `develop` publishes the image to this repository's GitHub
Packages registry (`.github/workflows/docker-image.yml`), so another stack
pulls it instead of building it:

```
ghcr.io/deepseek-x-openrouter/deepseek-harness:latest     # the develop branch
ghcr.io/deepseek-x-openrouter/deepseek-harness:develop
ghcr.io/deepseek-x-openrouter/deepseek-harness:sha-5b5e2de  # one exact commit
ghcr.io/deepseek-x-openrouter/deepseek-harness:0.1.1      # on a v* tag
```

Pin a `sha-` tag in anything you would rather not have move under you.

The package inherits the repository's visibility. While the repository is
private, hosts pulling it need a login first — a classic personal access token
with `read:packages`:

```sh
echo "$GHCR_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin
```

[`compose.ghcr.yml`](compose.ghcr.yml) is the whole deployment as one
pull-only file; it needs nothing from this repository but an `.env`. To fold
the service into a compose file you already have, copy this much:

```yaml
services:
  dsh:
    image: ghcr.io/deepseek-x-openrouter/deepseek-harness:latest
    restart: unless-stopped
    init: true
    environment:
      WEB_USER: dsh
      WEB_PASSWORD: ${DSH_WEB_PASSWORD:?}
      PUBLIC_HOST: dsh.example.com        # the name browsers use
    volumes:
      - dsh-home:/data
      - ./workspace:/workspace
volumes:
  dsh-home:
```

Three things decide whether it works in your stack:

**Reach.** The container listens on port 8080. A proxy in the same compose
project reaches it as `http://dsh:8080` over the shared network — drop the
`ports:` block entirely in that case, so nothing but the proxy can reach it.
Publish a port only when the proxy is outside Docker (then `127.0.0.1:8080:8080`
and point the proxy at that).

**Name.** The harness refuses API requests from a page served under a hostname
it was not told about, so `PUBLIC_HOST` must be the authority in the browser's
address bar — `dsh.example.com`, or `dsh.example.com:8443` if the port is
non-standard. Several names are comma separated. Your proxy must pass the
original `Host` header (nginx: `proxy_set_header Host $host;`), and must not
buffer responses — the session stream is one long-lived response
(nginx: `proxy_buffering off;`, and a `proxy_read_timeout` in hours).

**Auth.** The container's own password gate stays on: it is the fence that
makes `TRUST_REMOTE_CONFIG` (settings and credentials over the network) safe.
If your stack already authenticates, either let the two stack (your proxy
forwards the browser's `Authorization` header through) or terminate yours and
have it send `Authorization: Basic …` upstream. Set `TRUST_REMOTE_CONFIG=0` to
give up remote settings changes and keep the configuration plane on loopback.

Traefik, for a stack with its own TLS:

```yaml
    labels:
      - traefik.enable=true
      - traefik.http.routers.dsh.rule=Host(`dsh.example.com`)
      - traefik.http.routers.dsh.tls=true
      - traefik.http.services.dsh.loadbalancer.server.port=8080
```

nginx, for a proxy outside Docker:

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_buffering off;
    proxy_read_timeout 24h;
}
```

Once it is up, sign it in the same way as any other deployment —
`docker compose exec dsh dsh-login` (or `docker exec -it <container> dsh-login`)
— and the grant stays in the `dsh-home` volume from then on.

Upgrades are `docker compose pull && docker compose up -d`: the home volume
survives, and the container reconciles it with the new image on start.

## Without compose

```sh
docker build -f docker/Dockerfile \
  --build-arg DSH_CLIENT_COMMIT_HASH=$(git rev-parse HEAD) -t dsh-preview .

docker run -d --name dsh -p 127.0.0.1:8080:8080 \
  -e WEB_PASSWORD=... \
  -v dsh-home:/data -v dsh-workspace:/workspace dsh-preview

docker exec -it dsh dsh-login
```
