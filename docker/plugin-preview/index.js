/**
 * dsh-preview — the workspace preview panel, as a standalone bundle.
 *
 * Two surfaces, both read-only:
 *
 * - The **preview panel**, which occupies the frame's aside column and renders
 *   the HTML the agent is writing in the session's workspace, reloading the
 *   moment a successful edit lands. Host-side that is one session projection
 *   (`workspacePreview`, folded from the session's own tool-call log) plus a
 *   guarded static file surface rooted at the session's `cwd`.
 * - The **Codex readout** in the composer dock, which reports what a ChatGPT
 *   subscription has left: the plan's limit windows, folded from the `x-codex-*`
 *   headers the harness fork republishes as `llm-pi-ai/provider-response`.
 *
 * The plugin owns no provider and no credential: it reads what the session and
 * its LLM route already produce.
 * @module dsh-preview
 */

import { createRequire } from 'node:module'
import { CodexLimits, resolveCodexOptions } from './codex.js'
import { previewProjectionDefinition } from './preview.js'
import { previewHandler } from './routes.js'

const { version } = createRequire(import.meta.url)('./package.json')

/** Stable Cordis plugin name. */
export const name = 'dshPreview'

/** The route prefix both surfaces live under. */
const ROUTE_PREFIX = '/dsh-preview'

/** How long a session-root miss suppresses another header listing. */
const MISS_BACKOFF_MS = 3_000

/**
 * The one explicit resolve step from raw row config to validated options.
 * Misconfiguration fails loud at plugin load.
 * @param {object} [config] - raw config from the composition row.
 * @returns {{preview: boolean, codex: {provider: string} | false}} validated options.
 */
export function resolveOptions(config = {}) {
  // The workspace preview panel (projection + file surface); `false` opts it off.
  const preview = config.preview ?? true
  if (typeof preview !== 'boolean') {
    throw new Error('dsh-preview: preview must be a boolean')
  }
  return { preview, codex: resolveCodexOptions(config.codex) }
}

/**
 * Plugin body: register the projection, the Codex fold, and the HTTP surface.
 * Every registration is an effect and disposes with the fiber.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} [config] - row config; every field is optional.
 */
export function apply(ctx, config) {
  const options = resolveOptions(config)

  // The fold reaches the browser through the generic projection rail. Waiting
  // on the service (not ctx.get) keeps registration correct regardless of
  // composition order; headless assemblies without the registry never enter.
  if (options.preview) {
    ctx.inject(['sessionProjections'], (ictx) => {
      ictx.sessionProjections.register(previewProjectionDefinition)
    })
  }

  // Session → workspace root for the file surface. A header's cwd is
  // immutable, so hits cache forever; a miss re-lists at most every few
  // seconds so a hammering client cannot turn header listing into a hot loop.
  const cwdCache = new Map()
  let lastMissListAt = 0
  const resolvePreviewRoot = async (sessionId) => {
    if (!options.preview) return null
    const hit = cwdCache.get(sessionId)
    if (hit !== undefined) return hit
    const persistence = ctx.get('sessionPersistence')
    if (persistence === undefined) return null
    const now = Date.now()
    if (now - lastMissListAt < MISS_BACKOFF_MS) return null
    const headers = await persistence.list()
    for (const header of headers) {
      if (typeof header.cwd === 'string' && header.cwd.length > 0) cwdCache.set(header.id, header.cwd)
    }
    const found = cwdCache.get(sessionId)
    if (found === undefined) lastMissListAt = now
    return found ?? null
  }

  // The Codex readout folds the plan accounting ChatGPT puts on every Codex
  // response, republished by the harness fork's `llm-pi-ai` bridge. Listening
  // costs nothing when no Codex route is mounted: the event never fires.
  const codex = options.codex === false ? null : new CodexLimits({ options: options.codex })
  if (codex !== null) {
    ctx.on('llm-pi-ai/provider-response', (detail) => { codex.observe(detail) })
  }

  // Web assemblies only: no webServer means no browser to serve.
  ctx.inject(['webServer'], (ictx) => {
    ictx.effect(
      () => ictx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: previewHandler({
          version,
          options,
          codex,
          preview: { resolveRoot: resolvePreviewRoot },
        }),
      }),
      'dsh-preview: http surface',
    )
  })
}
