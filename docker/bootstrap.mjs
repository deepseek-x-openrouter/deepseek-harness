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
 * - **Settings.** Seeded once, on a home that has none, so a first start has a
 *   working Codex route instead of an empty model menu.
 * - **The Codex grant.** Seeded from the environment only when the credential
 *   store has none: pi-ai rotates the refresh token in place, so a stored
 *   grant is always newer than the one this container was handed.
 *
 * @module docker/bootstrap
 */

import { createRequire } from 'node:module'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
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

/** The `exp` claim of a JWT, in epoch milliseconds, or null. */
function expiryFromJwt(token) {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return typeof claims.exp === 'number' ? claims.exp * 1000 : null
  } catch {
    // A token this process cannot read is still a token the provider may
    // accept; the grant just carries no expiry hint.
    return null
  }
}

/**
 * The Codex OAuth grant offered by this container's environment: either a
 * mounted Codex CLI `auth.json` or the three explicit variables.
 * @returns {object | null} the pi-ai credential payload, or null when none is offered.
 */
function offeredGrant() {
  const authPath = process.env.CODEX_AUTH_JSON
  if (authPath !== undefined && authPath.trim().length > 0) {
    if (!existsSync(authPath)) throw new Error(`CODEX_AUTH_JSON points at ${authPath}, which does not exist`)
    const tokens = JSON.parse(readFileSync(authPath, 'utf8')).tokens ?? {}
    if (typeof tokens.access_token !== 'string' || typeof tokens.refresh_token !== 'string') {
      throw new Error(`${authPath} carries no ChatGPT tokens; sign in with the Codex CLI first`)
    }
    return {
      type: 'oauth',
      access: tokens.access_token,
      refresh: tokens.refresh_token,
      expires: expiryFromJwt(tokens.access_token) ?? Date.now(),
      ...typeof tokens.account_id === 'string' ? { accountId: tokens.account_id } : {},
    }
  }
  const access = process.env.CODEX_ACCESS_TOKEN
  const refresh = process.env.CODEX_REFRESH_TOKEN
  if (access === undefined || refresh === undefined || access.length === 0 || refresh.length === 0) return null
  const expires = process.env.CODEX_TOKEN_EXPIRES
  return {
    type: 'oauth',
    access,
    refresh,
    expires: expires === undefined ? expiryFromJwt(access) ?? Date.now() : Number(expires),
    ...process.env.CODEX_ACCOUNT_ID === undefined ? {} : { accountId: process.env.CODEX_ACCOUNT_ID },
  }
}

/**
 * Write the Codex grant into `.credentials.yaml` when the store has none.
 *
 * A stored grant is never replaced by default: pi-ai refreshes the access
 * token and rotates the refresh token in place, so what the volume holds is
 * newer than what the environment was given at `docker compose up`. Set
 * `CODEX_SEED=force` after a fresh `codex login` to overwrite it deliberately.
 */
function seedCredentials() {
  const path = join(HOME, '.credentials.yaml')
  const store = readYaml(path) ?? { version: 1 }
  if (store.version !== 1) throw new Error(`${path} is not a version 1 credential store`)
  const records = store.records ?? {}
  const force = process.env.CODEX_SEED === 'force'
  if (records[CODEX_RECORD] !== undefined && !force) {
    log('kept the stored Codex grant (set CODEX_SEED=force to replace it)')
    return
  }
  const grant = offeredGrant()
  if (grant === null) {
    if (records[CODEX_RECORD] === undefined) {
      log('no Codex credentials offered — mount CODEX_AUTH_JSON or set CODEX_ACCESS_TOKEN/CODEX_REFRESH_TOKEN')
    }
    return
  }
  store.records = { ...records, [CODEX_RECORD]: { kind: 'grant', payload: grant } }
  writeYaml(path, store, 0o600)
  log(`${force && records[CODEX_RECORD] !== undefined ? 'replaced' : 'seeded'} the Codex grant`
    + ` (expires ${new Date(grant.expires).toISOString()})`)
}

// The credential store refuses a home whose files any group or other can read.
mkdirSync(HOME, { recursive: true, mode: 0o700 })
chmodSync(HOME, 0o700)
reconcileProfile()
seedSettings()
seedCredentials()
