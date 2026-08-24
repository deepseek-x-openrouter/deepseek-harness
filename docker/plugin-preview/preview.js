/**
 * Workspace preview: the `workspacePreview` session projection plus the
 * `/dsh-preview/preview/...` static file surface behind it.
 *
 * The projection folds `tool/call`/`tool/result` pairs from the session log
 * into a change counter (`rev`), a mutated-file table, and the last HTML file
 * written — the browser's Preview panel remounts its iframe when `rev` moves.
 * Mutations are recognized from the fs tools' own vocabulary (`write` and
 * `edit` with `file_path`, `str_replace_editor` with `path` on any command
 * but `view`), the same recognition the harness deliverables row documents;
 * files created by terminal commands are invisible to the fold and covered by
 * the panel's manual refresh instead.
 *
 * The file surface serves session-workspace files for the panel's sandboxed
 * iframe: the workspace root is the session header's `cwd` (resolved by the
 * caller through `sessionPersistence`), traversal is refused with the same
 * resolve+prefix guard the harness SPA server uses, and any dot segment
 * (`.env`, `.git`, …) is refused outright. Responses carry `no-store` and
 * `nosniff`; no CORS headers are ever added, so the sandboxed (opaque-origin)
 * iframe cannot read sibling responses via fetch.
 * @module dsh-preview/preview
 */

import { promises as fsPromises } from 'node:fs'
import { extname, isAbsolute, resolve, sep } from 'node:path'

/** The projection key the browser Preview tab reads. */
export const PREVIEW_PROJECTION_KEY = 'workspacePreview'

/** Persisted-cache invalidation version: bump on any state-field or fold change. */
const STATE_VERSION = 1

/** URL prefix of the preview file surface (under the plugin's route). */
export const PREVIEW_FILE_PREFIX = '/dsh-preview/preview/'

function fail(key, detail) {
  throw new Error(`workspacePreview state invalid at ${key}: ${detail}`)
}

function isCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** Shared validator core; `pending` exists in state but is not wired to the browser. */
function parsePreview(value, withPending) {
  if (typeof value !== 'object' || value === null) fail('$', 'not an object')
  if (!isCount(value.rev)) fail('rev', 'not a finite non-negative number')
  if (value.lastHtml !== null && typeof value.lastHtml !== 'string') fail('lastHtml', 'not a string or null')
  if (typeof value.files !== 'object' || value.files === null) fail('files', 'not an object')
  for (const [path, row] of Object.entries(value.files)) {
    if (typeof row !== 'object' || row === null) fail(`files.${path}`, 'not an object')
    if (!isCount(row.mutations)) fail(`files.${path}.mutations`, 'not a finite non-negative number')
    if (!isCount(row.lastTurn)) fail(`files.${path}.lastTurn`, 'not a finite non-negative number')
  }
  if (withPending) {
    if (typeof value.pending !== 'object' || value.pending === null) fail('pending', 'not an object')
    for (const [callId, path] of Object.entries(value.pending)) {
      if (typeof path !== 'string' || path.length === 0) fail(`pending.${callId}`, 'not a non-empty string')
    }
  }
  return value
}

const stateSchema = { parse: value => parsePreview(value, true) }
const viewSchema = { parse: value => parsePreview(value, false) }

/**
 * The file path a tool call would mutate, from the call's raw argument JSON —
 * or null for reads, other tools, and malformed arguments.
 * @param {string} name - tool name as logged.
 * @param {string} rawArguments - the unparsed argument JSON string.
 * @returns {string | null} the target path, or null when the call is not a
 * recognized file mutation.
 */
export function mutationTarget(name, rawArguments) {
  if (name !== 'write' && name !== 'edit' && name !== 'str_replace_editor') return null
  let args
  try {
    args = JSON.parse(rawArguments)
  } catch {
    // Model-produced JSON: an unparsable call will fail at the tool anyway.
    return null
  }
  if (typeof args !== 'object' || args === null) return null
  if (name === 'str_replace_editor') {
    if (args.command === 'view') return null
    return typeof args.path === 'string' && args.path.length > 0 ? args.path : null
  }
  return typeof args.file_path === 'string' && args.file_path.length > 0 ? args.file_path : null
}

/**
 * The projection unit for `ctx.sessionProjections.register`. Pure immutable
 * fold: uninteresting events return the same state reference (the registry's
 * change feed gates on `Object.is`). A `tool/call` naming a file mutation
 * parks the target under its callId; the paired successful `tool/result`
 * commits it (rev bump, file row, `lastHtml` when it ends in .html/.htm), a
 * failed or missing result just clears the parking.
 */
export const previewProjectionDefinition = {
  key: PREVIEW_PROJECTION_KEY,
  stateVersion: STATE_VERSION,
  stateSchema,
  init: () => ({ rev: 0, files: {}, lastHtml: null, pending: {} }),
  apply: (state, event) => {
    if (event.type === 'tool/call') {
      const data = event.data ?? {}
      if (typeof data.callId !== 'string') return state
      const target = mutationTarget(data.name, data.arguments)
      if (target === null) return state
      return { ...state, pending: { ...state.pending, [data.callId]: target } }
    }
    if (event.type !== 'tool/result') return state
    const block = event.data?.message?.content?.[0]
    const callId = block?.toolCallId
    if (typeof callId !== 'string' || !(callId in state.pending)) return state
    const target = state.pending[callId]
    const pending = { ...state.pending }
    delete pending[callId]
    if (event.data.error !== undefined || block.isError === true) return { ...state, pending }
    const previous = state.files[target] ?? { mutations: 0, lastTurn: 0 }
    const turn = isCount(event.data.turn) ? event.data.turn : previous.lastTurn
    return {
      rev: state.rev + 1,
      files: { ...state.files, [target]: { mutations: previous.mutations + 1, lastTurn: turn } },
      lastHtml: /\.html?$/i.test(target) ? target : state.lastHtml,
      pending,
    }
  },
  wire: {
    viewSchema,
    view: state => ({ rev: state.rev, files: state.files, lastHtml: state.lastHtml }),
  },
}

/** Extension → content-type for workspace files (unknowns ship as octet-stream). */
export const PREVIEW_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
}

/**
 * Normalize a workspace-relative URL remainder into a safe relative path.
 * Refuses empty/`.`/`..` segments, any dot-leading segment (credentials and
 * VCS internals), backslashes, and NUL — returning null; an empty remainder
 * means the workspace root and maps to `index.html`.
 * @param {string} raw - decoded path remainder after the session segment.
 * @returns {string | null} a clean `a/b/c` relative path, or null when refused.
 */
export function guardRelPath(raw) {
  if (raw.includes('\\') || raw.includes('\0')) return null
  const segments = raw.split('/').filter(segment => segment.length > 0)
  if (segments.length === 0) return 'index.html'
  for (const segment of segments) {
    if (segment.startsWith('.')) return null
  }
  return segments.join('/')
}

const MISS_CODES = new Set(['ENOENT', 'ENOTDIR', 'EISDIR'])

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
  res.end(JSON.stringify(body))
}

/**
 * Serve one preview file request: `/dsh-preview/preview/<sessionId>/<path…>`.
 * @param {{resolveRoot: (sessionId: string) => Promise<string | null>, fs?: object}} deps -
 * session→workspace resolution (null = unknown session or preview disabled)
 * and an optional fs override for tests.
 * @param {object} req - node http request (GET/HEAD already enforced upstream).
 * @param {object} res - node http response.
 * @param {string} pathname - full decoded URL pathname.
 */
export async function servePreviewFile(deps, req, res, pathname) {
  const fs = deps.fs ?? fsPromises
  const remainder = pathname.slice(PREVIEW_FILE_PREFIX.length)
  const slash = remainder.indexOf('/')
  const sessionId = slash === -1 ? remainder : remainder.slice(0, slash)
  if (sessionId.length === 0) {
    json(res, 404, { error: 'missing session id' })
    return
  }
  const root = await deps.resolveRoot(sessionId)
  if (root === null || !isAbsolute(root)) {
    json(res, 404, { error: 'unknown session or preview disabled' })
    return
  }
  const rel = guardRelPath(slash === -1 ? '' : remainder.slice(slash + 1))
  if (rel === null) {
    json(res, 403, { error: 'path refused' })
    return
  }
  // Same guard as the harness SPA server: the resolved target must stay under
  // the root even after normalization (defense in depth behind the segment
  // filter above).
  let target = resolve(root, rel)
  if (target !== root && !target.startsWith(root + sep)) {
    json(res, 403, { error: 'path refused' })
    return
  }
  let body
  try {
    const stats = await fs.stat(target)
    if (stats.isDirectory()) target = resolve(target, 'index.html')
    body = await fs.readFile(target)
  } catch (error) {
    if (MISS_CODES.has(error?.code)) {
      json(res, 404, { error: 'not found' })
      return
    }
    throw error
  }
  res.writeHead(200, {
    'content-type': PREVIEW_MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
    // The agent rewrites these files constantly; nothing here may cache. The
    // absent CORS headers are deliberate: the sandboxed iframe's opaque origin
    // must not be able to read sibling files via fetch.
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}

const SCAN_DIR_LIMIT = 400
const SCAN_FILE_LIMIT = 4000
const SCAN_DEPTH = 4

/**
 * List previewable HTML files under a workspace root: breadth-first to
 * {@link SCAN_DEPTH}, skipping dot entries and `node_modules`, capped at
 * {@link SCAN_DIR_LIMIT} directories / {@link SCAN_FILE_LIMIT} files so a
 * huge workspace cannot stall the request. Sorted shallow-first with
 * `index.html` leading its directory.
 * @param {string} root - absolute workspace root.
 * @param {object} [fs] - fs override for tests.
 * @returns {Promise<string[]>} workspace-relative HTML paths.
 */
export async function scanHtml(root, fs = fsPromises) {
  const found = []
  const queue = [{ dir: root, rel: '', depth: 0 }]
  let dirs = 0
  let files = 0
  while (queue.length > 0 && dirs < SCAN_DIR_LIMIT) {
    const { dir, rel, depth } = queue.shift()
    dirs += 1
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      // A vanished or unreadable directory contributes nothing.
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const entryRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) {
        if (depth + 1 <= SCAN_DEPTH) queue.push({ dir: resolve(dir, entry.name), rel: entryRel, depth: depth + 1 })
        continue
      }
      files += 1
      if (files > SCAN_FILE_LIMIT) return sortHtml(found)
      if (/\.html?$/i.test(entry.name)) found.push(entryRel)
    }
  }
  return sortHtml(found)
}

/** Shallow paths first, `index.html` before its siblings, then lexicographic. */
function sortHtml(paths) {
  return [...paths].sort((left, right) => {
    const leftDepth = left.split('/').length
    const rightDepth = right.split('/').length
    if (leftDepth !== rightDepth) return leftDepth - rightDepth
    const leftIndex = /(^|\/)index\.html?$/i.test(left) ? 0 : 1
    const rightIndex = /(^|\/)index\.html?$/i.test(right) ? 0 : 1
    if (leftIndex !== rightIndex) return leftIndex - rightIndex
    return left < right ? -1 : left > right ? 1 : 0
  })
}

/**
 * Serve the preview manifest: `GET /dsh-preview/api/preview?session=` →
 * `{root, html}` for the panel's file picker.
 * @param {{resolveRoot: (sessionId: string) => Promise<string | null>, fs?: object}} deps -
 * as for {@link servePreviewFile}.
 * @param {object} res - node http response.
 * @param {URL} url - parsed request URL.
 */
export async function servePreviewManifest(deps, res, url) {
  const sessionId = url.searchParams.get('session')
  if (sessionId === null || sessionId.length === 0) {
    json(res, 400, { error: 'session is required' })
    return
  }
  const root = await deps.resolveRoot(sessionId)
  if (root === null || !isAbsolute(root)) {
    json(res, 404, { error: 'unknown session or preview disabled' })
    return
  }
  json(res, 200, { root, html: await scanHtml(root, deps.fs ?? fsPromises) })
}
