/**
 * The plugin's HTTP surface: same-origin JSON under `/dsh-preview/api/*` plus
 * the workspace file surface under `/dsh-preview/preview/*`, registered on the
 * harness webserver. Every route is a read-only GET; the webserver sits behind
 * whatever gate fronts the deployment (the container's own basic-auth proxy),
 * and nothing here mutates state.
 * @module dsh-preview/routes
 */

import { PREVIEW_FILE_PREFIX, servePreviewFile, servePreviewManifest } from './preview.js'

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
  res.end(JSON.stringify(body))
}

/**
 * Build the node http handler for the plugin's route prefix.
 * @param {{
 *   version: string,
 *   options: object,
 *   codex: object | null,
 *   preview: {resolveRoot: (sessionId: string) => Promise<string | null>},
 * }} deps - plugin-owned collaborators.
 * @returns {(req: object, res: object) => Promise<void>} node http handler.
 */
export function previewHandler(deps) {
  return async function handle(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      json(res, 405, { error: 'GET only' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://dsh-preview')
    let pathname
    try {
      pathname = decodeURIComponent(url.pathname)
    } catch {
      json(res, 400, { error: 'malformed path' })
      return
    }
    try {
      if (pathname.startsWith(PREVIEW_FILE_PREFIX)) {
        await servePreviewFile(deps.preview, req, res, pathname)
        return
      }
      switch (url.pathname) {
        case '/dsh-preview/api/health': {
          json(res, 200, {
            ok: true,
            name: 'dsh-preview',
            version: deps.version,
            preview: deps.options.preview === true,
            // The route the dock reports subscription limits for; null when
            // the Codex readout is switched off.
            codexProvider: deps.codex?.provider ?? null,
          })
          return
        }
        case '/dsh-preview/api/preview': {
          await servePreviewManifest(deps.preview, res, url)
          return
        }
        case '/dsh-preview/api/codex/usage': {
          if (deps.codex === null || deps.codex === undefined) {
            json(res, 404, { error: 'the codex readout is switched off' })
            return
          }
          json(res, 200, deps.codex.snapshot())
          return
        }
        default:
          json(res, 404, { error: 'unknown dsh-preview route' })
      }
    } catch (error) {
      json(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}
