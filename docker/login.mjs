/**
 * `dsh-login`: sign the container in to a pi-ai provider from its own
 * terminal, and leave the grant in the credential store the harness reads.
 *
 * The harness ships no login command and its web UI has no sign-in surface, so
 * this is the terminal half of one: the pi-ai plugin's own authorization flows,
 * driven against the same credential store the running harness has open. pi-ai
 * writes the record itself during the flow, which keeps it the single writer —
 * the same writer that later refreshes the access token and rotates the
 * refresh token in place.
 *
 * ChatGPT's device-code method is the one that suits a container: the code is
 * typed into a browser anywhere, so nothing has to reach a callback port here.
 *
 *   docker compose exec dsh dsh-login              # openai-codex
 *   docker compose exec dsh dsh-login anthropic    # any pi-ai provider
 *
 * @module docker/login
 */

import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const INSTALL = process.env.DSH_INSTALL ?? '/opt/dsh'
const HOME = process.env.DSH_HOME ?? '/data'
const CREDENTIALS = join(HOME, '.credentials.yaml')

// The workspace root resolves no package name of its own, so each import names
// a path; cordis resolves from a package that declares it as a peer.
const anchor = createRequire(`${INSTALL}/packages/credentials/authorization/package.json`)
const YAML = createRequire(`${INSTALL}/packages/credentials/credentials-local/package.json`)('yaml')

/** Import one workspace package by path. */
async function pkg(path) {
  return import(pathToFileURL(`${INSTALL}/packages/${path}`).href)
}

const provider = process.argv[2] ?? 'openai-codex'
const wanted = process.argv[3]

const { Context } = await import(pathToFileURL(anchor.resolve('@deepseek-ai/cordis')).href)
const { default: LocalCredentialProvider } = await pkg('credentials/credentials-local/src/index.ts')
const { default: AuthorizationService, AuthorizationDeclinedError } = await pkg('credentials/authorization/src/index.ts')
const { registerPiAiFlows } = await pkg('llm/llm-pi-ai/src/login.ts')
const { credentialStoreFrom, authContextFrom, recordKeyFor } = await pkg('llm/llm-pi-ai/src/auth.ts')

/**
 * Ask one question on the terminal.
 *
 * One interface per question rather than one for the run: a flow can ask again
 * after a long wait, and a readline held open across that wait is closed by
 * the first end of input it sees.
 * @param query - the line to print before reading.
 * @param secret - whether to keep the typed answer off the screen.
 * @returns what was typed, without its newline.
 * @throws {AuthorizationDeclinedError} when input ends without an answer.
 */
function ask(query, secret = false) {
  return new Promise((resolve, reject) => {
    let hide = false
    const screen = new Writable({
      write(chunk, encoding, done) {
        if (!hide) process.stdout.write(chunk, encoding)
        done()
      },
    })
    const rl = createInterface({ input: process.stdin, output: screen, terminal: true })
    rl.on('close', () => { reject(new AuthorizationDeclinedError('input ended')) })
    rl.question(query).then((answer) => {
      rl.removeAllListeners('close')
      rl.close()
      if (secret) process.stdout.write('\n')
      resolve(answer)
    }, reject)
    hide = secret
  })
}

/** The terminal half of one attempt: notices printed, questions asked. */
const interaction = {
  notify(notice) {
    process.stdout.write(`\n${notice.message}\n`)
    if (notice.url !== undefined) process.stdout.write(`  ${notice.url}\n`)
    if (notice.code !== undefined) process.stdout.write(`  code: ${notice.code}\n`)
  },
  async prompt(request) {
    if (request.kind === 'select') {
      process.stdout.write(`\n${request.message}\n`)
      request.options.forEach((option, index) => {
        process.stdout.write(`  ${index + 1}) ${option.label ?? option.id}\n`)
      })
      const answer = (await ask('choice [1]: ')).trim()
      const chosen = request.options[answer === '' ? 0 : Number(answer) - 1]
      if (chosen === undefined) throw new AuthorizationDeclinedError(`no option ${JSON.stringify(answer)}`)
      return chosen.id
    }
    const answer = (await ask(`\n${request.message}\n> `, request.kind === 'secret')).trim()
    if (answer.length === 0) throw new AuthorizationDeclinedError('nothing entered')
    return answer
  },
}

const ctx = new Context()
await ctx.plugin(LocalCredentialProvider, { path: CREDENTIALS, watch: false })
await ctx.plugin(AuthorizationService)
registerPiAiFlows(ctx, { credentials: credentialStoreFrom(ctx), authContext: authContextFrom(ctx) })

const key = recordKeyFor(provider)
const flow = ctx.authorization.describe(key)
if (flow === undefined) {
  process.stderr.write(`dsh-login: pi-ai ships no sign-in for provider "${provider}"\n`)
  process.exit(64)
}
const method = wanted ?? flow.methods[0].id
if (!flow.methods.some(candidate => candidate.id === method)) {
  process.stderr.write(`dsh-login: "${provider}" has no method "${method}"`
    + ` (it offers ${flow.methods.map(candidate => candidate.id).join(', ')})\n`)
  process.exit(64)
}

process.stdout.write(`Signing in to ${flow.label} (${method}).\n`)

const outcome = await ctx.authorization.begin({ key, method, interaction })

if (outcome.status !== 'authorized') {
  process.stderr.write(`\ndsh-login: sign-in ${outcome.status}\n`)
  process.exit(1)
}

/**
 * Whether settings already name this route. `llm-pi-ai` stays dormant until a
 * provider appears in its section, and the container seeds `openai-codex`
 * there on its first start — another provider has to be added from the UI's
 * Models page, which writes settings through the harness that owns the file.
 */
function routeIsNamed() {
  const path = join(HOME, 'settings.yaml')
  if (!existsSync(path)) return false
  const settings = YAML.parse(readFileSync(path, 'utf8')) ?? {}
  return settings['llm-pi-ai']?.providers?.[provider] !== undefined
}

process.stdout.write(`\nSigned in. The grant is in ${CREDENTIALS}.\n`)
process.stdout.write(routeIsNamed()
  ? 'Reload the browser tab; the model menu offers this provider now.\n'
  : `Add the "${provider}" route from Settings → Models to use it.\n`)
process.exit(0)
