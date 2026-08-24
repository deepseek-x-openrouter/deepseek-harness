import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PREVIEW_MIME,
  PREVIEW_PROJECTION_KEY,
  guardRelPath,
  mutationTarget,
  previewProjectionDefinition as unit,
  scanHtml,
  servePreviewFile,
  servePreviewManifest,
} from '../preview.js'
import { previewHandler } from '../routes.js'

function call(callId, name, args) {
  return { type: 'tool/call', seq: 1, time: 1, data: { turn: 2, step: 0, callId, name, arguments: JSON.stringify(args) } }
}

function result(callId, { isError = false, error, turn = 2 } = {}) {
  const data = {
    turn,
    step: 0,
    message: { role: 'user', content: [{ type: 'tool-result', toolCallId: callId, content: [], isError }] },
  }
  if (error !== undefined) data.error = error
  return { type: 'tool/result', seq: 2, time: 2, data }
}

test('key, empty state, and wire view hides pending', () => {
  assert.equal(unit.key, PREVIEW_PROJECTION_KEY)
  const state = unit.init()
  assert.deepEqual(state, { rev: 0, files: {}, lastHtml: null, pending: {} })
  const view = unit.wire.view(state)
  assert.deepEqual(view, { rev: 0, files: {}, lastHtml: null })
  assert.equal(unit.stateSchema.parse(state), state)
  assert.equal(unit.wire.viewSchema.parse(view), view)
})

test('mutationTarget recognizes the fs mutation vocabulary', () => {
  assert.equal(mutationTarget('write', '{"file_path":"index.html","content":""}'), 'index.html')
  assert.equal(mutationTarget('edit', '{"file_path":"app.js","old_string":"a","new_string":"b"}'), 'app.js')
  assert.equal(mutationTarget('str_replace_editor', '{"command":"create","path":"x.html"}'), 'x.html')
  assert.equal(mutationTarget('str_replace_editor', '{"command":"view","path":"x.html"}'), null)
  assert.equal(mutationTarget('read', '{"file_path":"index.html"}'), null)
  assert.equal(mutationTarget('bash', '{"command":"touch y.html"}'), null)
  assert.equal(mutationTarget('write', 'not json'), null)
  assert.equal(mutationTarget('write', '{"file_path":""}'), null)
})

test('successful write commits: rev bump, file row, lastHtml', () => {
  const s0 = unit.init()
  const s1 = unit.apply(s0, call('c1', 'write', { file_path: 'index.html', content: 'x' }))
  assert.equal(s0.rev, 0)
  assert.deepEqual(s1.pending, { c1: 'index.html' })
  assert.equal(s1.rev, 0)
  const s2 = unit.apply(s1, result('c1'))
  assert.equal(s2.rev, 1)
  assert.deepEqual(s2.files, { 'index.html': { mutations: 1, lastTurn: 2 } })
  assert.equal(s2.lastHtml, 'index.html')
  assert.deepEqual(s2.pending, {})
  // Prior states never mutate.
  assert.deepEqual(s1.files, {})
  assert.deepEqual(s1.pending, { c1: 'index.html' })
})

test('non-HTML mutations bump rev without moving lastHtml', () => {
  let state = unit.init()
  state = unit.apply(state, call('c1', 'write', { file_path: 'index.html', content: '' }))
  state = unit.apply(state, result('c1'))
  state = unit.apply(state, call('c2', 'edit', { file_path: 'style.css', old_string: 'a', new_string: 'b' }))
  state = unit.apply(state, result('c2', { turn: 3 }))
  assert.equal(state.rev, 2)
  assert.equal(state.lastHtml, 'index.html')
  assert.deepEqual(state.files['style.css'], { mutations: 1, lastTurn: 3 })
})

test('failed results clear pending without committing', () => {
  let state = unit.init()
  state = unit.apply(state, call('c1', 'write', { file_path: 'a.html', content: '' }))
  const failedBlock = unit.apply(state, result('c1', { isError: true }))
  assert.equal(failedBlock.rev, 0)
  assert.deepEqual(failedBlock.files, {})
  assert.deepEqual(failedBlock.pending, {})
  const failedEvent = unit.apply(state, result('c1', { error: { name: 'E', code: 'X' } }))
  assert.equal(failedEvent.rev, 0)
  assert.deepEqual(failedEvent.pending, {})
})

test('uninteresting events return the same reference', () => {
  const state = unit.init()
  assert.equal(unit.apply(state, { type: 'assistant/message', seq: 0, time: 0, data: {} }), state)
  assert.equal(unit.apply(state, call('c1', 'read', { file_path: 'x' })), state)
  assert.equal(unit.apply(state, result('unmatched')), state)
  assert.equal(unit.apply(state, { type: 'tool/call', seq: 0, time: 0, data: { name: 'write', arguments: '{}' } }), state)
})

test('state schema accepts round-trips and rejects malformed rows', () => {
  let state = unit.init()
  state = unit.apply(state, call('c1', 'write', { file_path: 'index.html', content: '' }))
  state = unit.apply(state, result('c1'))
  assert.equal(unit.stateSchema.parse(JSON.parse(JSON.stringify(state))).rev, 1)
  assert.throws(() => unit.stateSchema.parse({ rev: -1, files: {}, lastHtml: null, pending: {} }), /rev/)
  assert.throws(() => unit.stateSchema.parse({ rev: 0, files: { a: { mutations: 'x', lastTurn: 0 } }, lastHtml: null, pending: {} }), /mutations/)
  assert.throws(() => unit.stateSchema.parse({ rev: 0, files: {}, lastHtml: null, pending: { c: '' } }), /pending/)
})

test('guardRelPath refuses traversal and dot segments', () => {
  assert.equal(guardRelPath(''), 'index.html')
  assert.equal(guardRelPath('a/b/c.html'), 'a/b/c.html')
  assert.equal(guardRelPath('a//b'), 'a/b')
  assert.equal(guardRelPath('../secret'), null)
  assert.equal(guardRelPath('a/../../b'), null)
  assert.equal(guardRelPath('.env'), null)
  assert.equal(guardRelPath('sub/.git/config'), null)
  assert.equal(guardRelPath('a\\b'), null)
  assert.equal(guardRelPath('a/\0'), null)
})

// --- file surface over a real temporary workspace ---

function fakeRes() {
  return {
    status: 0,
    headers: {},
    body: undefined,
    writeHead(status, headers) { this.status = status; this.headers = headers ?? {} },
    end(body) { this.body = body },
  }
}

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-preview-'))
  await writeFile(join(root, 'index.html'), '<h1>hi</h1>')
  await writeFile(join(root, 'app.js'), 'console.log(1)')
  await writeFile(join(root, '.env'), 'SECRET=1')
  await mkdir(join(root, 'sub'))
  await writeFile(join(root, 'sub', 'page.html'), '<p>sub</p>')
  await mkdir(join(root, 'node_modules'))
  await writeFile(join(root, 'node_modules', 'skip.html'), 'no')
  return root
}

test('servePreviewFile serves files with preview headers and refuses escapes', async () => {
  const root = await workspace()
  try {
    const deps = { resolveRoot: async id => (id === 's1' ? root : null) }
    const ok = fakeRes()
    await servePreviewFile(deps, { method: 'GET' }, ok, '/dsh-preview/preview/s1/index.html')
    assert.equal(ok.status, 200)
    assert.equal(ok.headers['content-type'], PREVIEW_MIME['.html'])
    assert.equal(ok.headers['cache-control'], 'no-store')
    assert.equal(ok.headers['x-content-type-options'], 'nosniff')
    assert.equal(String(ok.body), '<h1>hi</h1>')

    const dir = fakeRes()
    await servePreviewFile(deps, { method: 'GET' }, dir, '/dsh-preview/preview/s1/')
    assert.equal(dir.status, 200)
    assert.equal(String(dir.body), '<h1>hi</h1>')

    const js = fakeRes()
    await servePreviewFile(deps, { method: 'GET' }, js, '/dsh-preview/preview/s1/app.js')
    assert.equal(js.headers['content-type'], PREVIEW_MIME['.js'])

    const head = fakeRes()
    await servePreviewFile(deps, { method: 'HEAD' }, head, '/dsh-preview/preview/s1/index.html')
    assert.equal(head.status, 200)
    assert.equal(head.body, undefined)

    const dot = fakeRes()
    await servePreviewFile(deps, { method: 'GET' }, dot, '/dsh-preview/preview/s1/.env')
    assert.equal(dot.status, 403)

    const traversal = fakeRes()
    await servePreviewFile(deps, { method: 'GET' }, traversal, '/dsh-preview/preview/s1/../outside')
    assert.equal(traversal.status, 403)

    const missing = fakeRes()
    await servePreviewFile(deps, { method: 'GET' }, missing, '/dsh-preview/preview/s1/nope.html')
    assert.equal(missing.status, 404)

    const unknown = fakeRes()
    await servePreviewFile(deps, { method: 'GET' }, unknown, '/dsh-preview/preview/other/index.html')
    assert.equal(unknown.status, 404)

    const noSession = fakeRes()
    await servePreviewFile(deps, { method: 'GET' }, noSession, '/dsh-preview/preview/')
    assert.equal(noSession.status, 404)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('scanHtml lists html shallow-first, skipping dot and node_modules', async () => {
  const root = await workspace()
  try {
    assert.deepEqual(await scanHtml(root), ['index.html', 'sub/page.html'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('servePreviewManifest returns root and files, 400/404 on bad input', async () => {
  const root = await workspace()
  try {
    const deps = { resolveRoot: async id => (id === 's1' ? root : null) }
    const ok = fakeRes()
    await servePreviewManifest(deps, ok, new URL('http://x/dsh-preview/api/preview?session=s1'))
    assert.equal(ok.status, 200)
    assert.deepEqual(JSON.parse(ok.body), { root, html: ['index.html', 'sub/page.html'] })

    const missing = fakeRes()
    await servePreviewManifest(deps, missing, new URL('http://x/dsh-preview/api/preview'))
    assert.equal(missing.status, 400)

    const unknown = fakeRes()
    await servePreviewManifest(deps, unknown, new URL('http://x/dsh-preview/api/preview?session=zz'))
    assert.equal(unknown.status, 404)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('previewHandler dispatches the preview routes and keeps health flag', async () => {
  const root = await workspace()
  try {
    const handler = previewHandler({
      version: '0.0.0',
      options: { preview: true },
      codex: null,
      preview: { resolveRoot: async id => (id === 's1' ? root : null) },
    })
    const file = fakeRes()
    await handler({ method: 'GET', url: '/dsh-preview/preview/s1/sub/page.html' }, file)
    assert.equal(file.status, 200)
    assert.equal(String(file.body), '<p>sub</p>')

    const manifest = fakeRes()
    await handler({ method: 'GET', url: '/dsh-preview/api/preview?session=s1' }, manifest)
    assert.equal(manifest.status, 200)
    assert.equal(JSON.parse(manifest.body).root, root)

    // WHATWG URL parsing resolves %2e%2e dot segments before dispatch, so an
    // encoded traversal leaves the preview prefix and dies as an unknown
    // route; the 403 guard covers paths that arrive decoded.
    const encoded = fakeRes()
    await handler({ method: 'GET', url: '/dsh-preview/preview/s1/%2e%2e/outside' }, encoded)
    assert.equal(encoded.status, 404)

    const health = fakeRes()
    await handler({ method: 'GET', url: '/dsh-preview/api/health' }, health)
    assert.equal(JSON.parse(health.body).preview, true)

    const post = fakeRes()
    await handler({ method: 'POST', url: '/dsh-preview/preview/s1/index.html' }, post)
    assert.equal(post.status, 405)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
