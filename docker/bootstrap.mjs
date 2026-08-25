/**
 * Container bootstrap: bring `$DSH_HOME` to the state this image promises,
 * without ever overwriting what the running harness owns.
 *
 * Three things are reconciled on every start, because the home is a mounted
 * volume that outlives the image:
 *
 * - **The profile.** Its bundle list must name the preview plugin and must not
 *   name a plugin that is no longer installed in the image, and the plugin
 *   itself is reachable through one symlink into the installation.
 * - **Settings.** Seeded once, on a home that has none, so the Codex route is
 *   named before anyone signs in to it.
 * - **The user-global `AGENTS.md`.** Seeded once, so every session knows which
 *   tools this image put on the agent's PATH.
 * - **`.pgpass`.** Rewritten from the configured `PGPASSWORD` on every start,
 *   because that variable cannot reach a process the agent spawns.
 *
 * No credential is ever written here. Signing in happens inside the container,
 * through `dsh-login`, and pi-ai stays the only writer of the record it later
 * refreshes.
 *
 * @module docker/bootstrap
 */

import { createRequire } from 'node:module'
import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// The installation is the only place a YAML parser is guaranteed to be, and
// the credential store's own copy is the one that has to agree with us.
const INSTALL = process.env.DSH_INSTALL ?? '/opt/dsh'
const require = createRequire(`${INSTALL}/packages/credentials/credentials-local/package.json`)
const YAML = require('yaml')

const HOME = process.env.DSH_HOME ?? '/data'
const PROFILE = process.env.DSH_PROFILE ?? 'web'
const PLUGIN_DIR = process.env.DSH_PREVIEW_PLUGIN ?? `${INSTALL}/docker/plugin-preview`
const PLUGIN_NAME = 'dsh-preview'
const WORKSPACE = '/workspace'
const CODEX_PROVIDER = 'openai-codex'
const CODEX_RECORD = `llm-pi-ai/${CODEX_PROVIDER}`

/** Bundle layers this image's profile composes, in order. */
const BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', PLUGIN_NAME]

/** Bundles this image does not ship; a reused home must not keep asking for them. */
const UNINSTALLED = ['dsh-windrose']

function log(message) {
  process.stdout.write(`bootstrap: ${message}\n`)
}

function readYaml(path) {
  if (!existsSync(path)) return undefined
  const text = readFileSync(path, 'utf8')
  return text.trim().length === 0 ? undefined : YAML.parse(text)
}

function writeYaml(path, value, mode) {
  writeFileSync(path, YAML.stringify(value), { mode })
  chmodSync(path, mode)
}

/** Ensure `link` is a symlink to `target`, replacing a wrong or dangling one. */
function ensureSymlink(link, target) {
  mkdirSync(dirname(link), { recursive: true })
  let stat
  try {
    stat = lstatSync(link)
  } catch {
    // Missing link (first start) — created below.
    stat = undefined
  }
  if (stat !== undefined) {
    if (stat.isSymbolicLink() && readlinkSync(link) === target) return
    unlinkSync(link)
  }
  symlinkSync(target, link)
}

/**
 * The profile directory: manifest, patch layer, pnpm settings, and the one
 * symlink that makes the out-of-tree plugin resolvable by name.
 */
function reconcileProfile() {
  const dir = join(HOME, 'profiles', PROFILE)
  mkdirSync(dir, { recursive: true })

  const manifestPath = join(dir, 'package.json')
  const manifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, 'utf8'))
    : { name: `dsh-profile-${PROFILE}`, private: true, dependencies: {} }
  const before = manifest.dsh?.profile?.bundles ?? []
  const dropped = before.filter(bundle => UNINSTALLED.includes(bundle))
  // The image's list is the authority: a home carried over from another image
  // may name bundles this one does not install, which would fail the boot.
  manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: BUNDLES } }
  // The plugin resolves through the symlink below, not through pnpm, so the
  // profile must not also declare it — nor keep a dependency on a bundle this
  // image dropped, which the next `dsh plugin` run would try to reinstall.
  for (const name of [PLUGIN_NAME, ...UNINSTALLED]) {
    if (manifest.dependencies?.[name] !== undefined) delete manifest.dependencies[name]
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, undefined, 2) + '\n')
  if (dropped.length > 0) log(`removed bundles this image does not install: ${dropped.join(', ')}`)

  const patchPath = join(dir, 'cordis.patch.yml')
  if (!existsSync(patchPath)) {
    writeFileSync(patchPath, '# Your patch layer for this dsh profile, applied after every bundle layer.\n[]\n')
  }
  const workspacePath = join(dir, 'pnpm-workspace.yaml')
  if (!existsSync(workspacePath)) {
    writeFileSync(workspacePath, 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  }
  ensureSymlink(join(dir, 'node_modules', PLUGIN_NAME), PLUGIN_DIR)
  log(`profile "${PROFILE}" composes ${BUNDLES.join(' + ')}`)
}

/**
 * Seed `settings.yaml` on a home that has none, so the first start already
 * talks to the Codex subscription. An existing file is the user's.
 */
function seedSettings() {
  const path = join(HOME, 'settings.yaml')
  if (existsSync(path)) return
  const model = process.env.CODEX_MODEL ?? 'gpt-5.3-codex-spark'
  writeYaml(path, {
    'agent-default-model': { provider: CODEX_PROVIDER, model },
    // The pi-ai route stays dormant until this section names it; SSE is the
    // transport that reports the plan's limit headers the dock reads.
    'llm-pi-ai': { providers: { [CODEX_PROVIDER]: { transport: 'sse' } } },
  }, 0o600)
  log(`seeded settings.yaml with the ${CODEX_PROVIDER} route (model ${model})`)
}

/**
 * Seed the user-global instruction file — `$DSH_HOME/AGENTS.md`, which the
 * harness loads into every session whatever workspace it opens — so the agent
 * knows what this image gives it. Absent only: once the file exists it is the
 * user's, and this is the file to edit to tell every session something.
 */
function seedAgentInstructions() {
  const path = join(HOME, 'AGENTS.md')
  if (existsSync(path)) return
  const seed = join(INSTALL, 'docker', 'agents.seed.md')
  if (!existsSync(seed)) return
  writeFileSync(path, readFileSync(seed, 'utf8'))
  log('seeded AGENTS.md — what this container holds, read by every session')
}

/**
 * Turn a `PGPASSWORD` from `db.env` into the passfile libpq reads, because the
 * variable itself cannot reach the agent: the harness scrubs credential-shaped
 * names (`/KEY|PASSWORD|SECRET|TOKEN/i`) from every process it spawns, so a
 * `psql` the agent runs would be prompted for a password it cannot supply.
 * `PGPASSFILE` survives that scrub, and every client here reads it — psql,
 * psycopg, and DuckDB's postgres extension all sit on libpq.
 *
 * Rewritten on every start so a changed password takes effect, and removed
 * when the password goes away.
 */
function reconcilePasswordFile() {
  const path = join(HOME, '.pgpass')
  const password = process.env.PGPASSWORD
  if (password === undefined || password === '') {
    if (existsSync(path)) {
      unlinkSync(path)
      log('removed .pgpass — no PGPASSWORD is configured')
    }
    return
  }
  // Colons and backslashes are the field separator and its escape.
  const escape = value => value.replace(/([\\:])/g, '\\$1')
  const field = value => (value === undefined || value === '' ? '*' : escape(value))
  const line = [
    field(process.env.PGHOST),
    field(process.env.PGPORT),
    field(process.env.PGDATABASE),
    field(process.env.PGUSER),
    escape(password),
  ].join(':')
  writeFileSync(path, `${line}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
  log(`wrote .pgpass for ${process.env.PGUSER ?? '*'}@${process.env.PGHOST ?? '*'} — psql, psycopg and DuckDB all read it`)
}

/**
 * Whether the credential store already holds a grant for the Codex route.
 * @returns true when someone has signed this container in.
 */
function hasCodexGrant() {
  const store = readYaml(join(HOME, '.credentials.yaml'))
  return store?.records?.[CODEX_RECORD] !== undefined
}

/**
 * Say who owns a path this container cannot write, and how to hand it over.
 * A volume from an image that ran as another user is the usual reason: Docker
 * only adopts the image's ownership onto an empty volume, so an existing one
 * keeps the uid that created it.
 * @param path - the directory that refused the write.
 */
function refuseOwnership(path) {
  let owner
  try {
    owner = statSync(path).uid
  } catch {
    // The stat can only fail if the path went away between the two calls,
    // which leaves the advice below correct anyway.
    owner = 'another user'
  }
  process.stderr.write(
    `bootstrap: ${path} belongs to uid ${owner}, and this container runs as uid ${process.getuid()}.\n`
    + `  Hand it over once, then start again:\n`
    + `    docker compose run --rm --user root dsh chown -R ${process.getuid()}:${process.getgid()} ${path}\n`
    + `  (a bind-mounted workspace is chowned on the host instead, or matched with\n`
    + `   --build-arg UID=$(id -u) --build-arg GID=$(id -g))\n`)
  process.exit(77)
}

// The credential store refuses a home whose files any group or other can read.
try {
  mkdirSync(HOME, { recursive: true, mode: 0o700 })
  chmodSync(HOME, 0o700)
} catch (error) {
  if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error
  refuseOwnership(HOME)
}
reconcileProfile()
seedSettings()
seedAgentInstructions()
reconcilePasswordFile()
// A bind-mounted workspace belongs to whoever owns it on the host, and the
// harness only meets that fact when a session first tries to write there.
try {
  accessSync(WORKSPACE, constants.W_OK)
} catch {
  log(`WARNING: ${WORKSPACE} is not writable by uid ${process.getuid()};`
    + ` chown it on the host, or build with --build-arg UID=$(id -u) --build-arg GID=$(id -g)`)
}
if (hasCodexGrant()) {
  log('the Codex route is signed in')
} else {
  log('no Codex sign-in yet — run: docker compose exec dsh dsh-login')
}
