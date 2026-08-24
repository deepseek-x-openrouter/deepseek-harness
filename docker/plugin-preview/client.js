/**
 * dsh-preview browser half, hand-written in the harness client-bundle wire
 * form: a classic script that registers a lazy CJS factory with the page
 * module loader; `require` resolves the platform module table only (react).
 * No build step — components are plain `React.createElement`.
 *
 * Surfaces: the workspace preview panel occupying the frame's aside column
 * (collapsible rail on the right, drag-resizable, live-reloading iframe), and
 * the composer input dock's Codex face — what the ChatGPT subscription has
 * left, shown only while the session is on the Codex route.
 */
window.__ModuleLoader__.load({
  id: 'dsh-preview',
  factory: function (require) {
    'use strict'
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo } = React

    // ── styles (injected at materialization, the client CSS convention) ────

    const CSS = `
.dp-dock { box-sizing: border-box; display: flex; align-items: center; gap: 10px;
  width: calc(100% - var(--dsh-composer-side-clearance, 0px) - var(--dsh-composer-side-clearance, 0px)
    - 4 * var(--dsh-composer-dock-inset, 0px));
  max-width: calc(var(--dsh-composer-card-max-width, 720px) - 4 * var(--dsh-composer-dock-inset, 0px));
  margin: 0 auto; height: 32px; padding: 4px 10px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25)); border-radius: 12px;
  background: var(--dsw-specific-tip, rgba(128,128,128,.06));
  font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); }
.dp-brand { font-weight: 600; color: var(--dsw-alias-label-tertiary, inherit); flex: none; }
.dp-spacer { flex: 1; }
.dp-muted { color: var(--dsw-alias-label-tertiary, inherit); }
.dp-num { font-variant-numeric: tabular-nums; }
.dp-btn { border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3)); border-radius: 8px;
  background: transparent; color: var(--dsw-alias-label-primary, inherit); font-size: 12px;
  padding: 2px 10px; cursor: pointer; }
.dp-btn:hover { background: rgba(128,128,128,.12); }
.dp-select { padding: 4px 6px; font-size: 12px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3));
  border-radius: 8px; background: transparent; color: inherit; }
.dp-select option { color: initial; }
.dp-check { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; cursor: pointer;
  color: var(--dsw-alias-label-secondary, inherit); }
.dp-aside { display: flex; flex-direction: column; height: 100%; min-width: 0; }
.dp-aside-bar { flex: none; display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  padding: 8px 10px; font-size: 12px; color: var(--dsw-alias-label-secondary, inherit);
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.2)); }
.dp-aside-bar .dp-select { max-width: 44%; text-overflow: ellipsis; }
.dp-frame-wrap { flex: 1; min-height: 0; position: relative; background: #fff; }
.dp-frame { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
.dp-aside-empty { flex: 1; display: flex; flex-direction: column; align-items: center;
  justify-content: center; gap: 10px; text-align: center; font-size: 13px; padding: 24px;
  color: var(--dsw-alias-label-tertiary, inherit); }
.dp-link { text-decoration: none; display: inline-flex; align-items: center; }
.dp-icon-btn { border: none; background: transparent; cursor: pointer; font-size: 13px;
  line-height: 1; padding: 4px 6px; border-radius: 6px; color: var(--dsw-alias-label-tertiary, inherit); }
.dp-icon-btn:hover { background: rgba(128,128,128,.12); color: var(--dsw-alias-label-primary, inherit); }
.dp-rail { height: 100%; width: 100%; display: flex; flex-direction: column; align-items: center;
  gap: 12px; padding: 12px 0; border: none; background: transparent; cursor: pointer;
  color: var(--dsw-alias-label-tertiary, inherit); }
.dp-rail:hover { background: rgba(128,128,128,.07); color: var(--dsw-alias-label-primary, inherit); }
.dp-rail-icon { font-size: 14px; }
.dp-rail-label { writing-mode: vertical-rl; font-size: 10.5px; letter-spacing: .14em;
  text-transform: uppercase; }
.dp-win { display: inline-flex; align-items: center; gap: 6px; color: var(--dsw-alias-label-secondary, inherit); }
.dp-win-hot { color: rgb(200,130,60); }
.dp-win-max { color: rgb(200,80,80); }
.dp-win-label { flex: none; }
.dp-meter { flex: none; position: relative; width: 60px; height: 6px; border-radius: 999px;
  background: rgba(128,128,128,.24); overflow: hidden; }
.dp-meter-fill { position: absolute; top: 0; bottom: 0; left: 0; border-radius: 999px;
  background: currentColor; transition: width .3s ease; }
`
    if (typeof document !== 'undefined'
      && document.querySelector('style[data-plugin-css="dsh-preview/panel"]') === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-preview'
      tag.dataset.pluginCss = 'dsh-preview/panel'
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // ── same-origin data layer (module-level TTL cache shared by sessions) ─

    // The Codex snapshot is a local read on the harness, not a provider call,
    // so its cache only has to collapse a burst of re-renders.
    const TTL = { health: 600_000, codex: 2_000 }
    const cache = new Map()

    function getJson(path, ttl) {
      const cell = cache.get(path)
      const now = Date.now()
      if (cell !== undefined && cell.value !== undefined && now - cell.at < ttl) {
        return Promise.resolve(cell.value)
      }
      if (cell !== undefined && cell.inflight !== undefined) return cell.inflight
      const inflight = fetch(path, { headers: { accept: 'application/json' } })
        .then(response => {
          if (!response.ok) throw new Error('HTTP ' + response.status)
          return response.json()
        })
        .then(value => {
          cache.set(path, { at: Date.now(), value })
          return value
        })
        .catch(error => {
          cache.delete(path)
          throw error
        })
      cache.set(path, { at: cell === undefined ? 0 : cell.at, value: cell?.value, inflight })
      return inflight
    }

    /** Async loader hook: {value, error, loading} refreshed when deps change. */
    function useAsync(loader, deps) {
      const [state, setState] = useState({ value: undefined, error: null, loading: true })
      useEffect(() => {
        let live = true
        setState(previous => ({ ...previous, loading: true }))
        loader().then(
          value => { if (live) setState({ value, error: null, loading: false }) },
          error => { if (live) setState({ value: undefined, error, loading: false }) },
        )
        return () => { live = false }
      }, deps) // eslint-disable-line react-hooks/exhaustive-deps
      return state
    }

    /** A counter that advances on an interval: a re-render, and a loader dep. */
    function useBeat(intervalMs) {
      const [beat, setBeat] = useState(0)
      useEffect(() => {
        const timer = setInterval(() => { setBeat(value => value + 1) }, intervalMs)
        return () => { clearInterval(timer) }
      }, [intervalMs])
      return beat
    }

    /** Coarse time-until, at the one or two units a glance can use. */
    function fmtUntil(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return 'now'
      const minutes = Math.floor(ms / 60_000)
      if (minutes < 60) return Math.max(minutes, 1) + 'm'
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return hours + 'h' + (minutes % 60 === 0 ? '' : ' ' + (minutes % 60) + 'm')
      return Math.floor(hours / 24) + 'd' + (hours % 24 === 0 ? '' : ' ' + (hours % 24) + 'h')
    }

    // ── the Codex face of the composer dock ────────────────────────────────

    /** What the reader can do about a Codex readout that cannot answer. */
    const UNAVAILABLE = {
      'no-data': 'limits arrive with the first Codex reply',
    }

    /** One limit window as a labelled meter; hot and spent read as colour. */
    function LimitMeter(props) {
      const win = props.window
      const percent = typeof win.usedPercent === 'number' ? Math.max(0, Math.min(100, win.usedPercent)) : null
      const tone = percent === null ? '' : percent >= 100 ? ' dp-win-max' : percent >= 80 ? ' dp-win-hot' : ''
      const resetIn = win.resetAt === null ? null : fmtUntil(win.resetAt - Date.now())
      return h('span', {
        className: 'dp-win' + tone,
        title: (win.weekly ? 'weekly' : win.label) + ' limit'
          + (percent === null ? '' : ' — ' + percent.toFixed(percent < 10 ? 1 : 0) + '% used')
          + (resetIn === null ? '' : ', resets in ' + resetIn),
      },
      h('span', { className: 'dp-win-label dp-muted' }, win.weekly ? 'weekly' : win.label),
      h('span', { className: 'dp-meter' },
        h('span', { className: 'dp-meter-fill', style: { width: (percent ?? 0) + '%' } })),
      h('span', { className: 'dp-num' }, percent === null ? '—' : percent.toFixed(percent < 10 ? 1 : 0) + '%'))
    }

    /**
     * What the ChatGPT subscription has left.
     *
     * A subscription route has no per-request price to report, so the readout
     * is the plan's limit windows — the weekly allowance first, since that is
     * the one that ends a working day — and the time until each resets.
     */
    function CodexDock(props) {
      // The snapshot advances when a Codex reply lands, so the end of a turn
      // is exactly when it is worth re-reading; the beat carries the rest —
      // a reset countdown that has to keep moving, and a turn served by
      // another window on the same account.
      const running = props.useSession(state => state.running)
      const beat = useBeat(30_000)
      const usage = useAsync(() => getJson('/dsh-preview/api/codex/usage', TTL.codex), [running, beat])
      const value = usage.value
      const windows = value?.available === true ? value.windows : []
      // Weekly first: the allowance a session is most likely to run out of.
      const ordered = [...windows].sort((a, b) => (b.weekly === true) - (a.weekly === true))
      const reset = value?.weekly?.resetAt ?? ordered[0]?.resetAt ?? null

      return h('div', { className: 'dp-dock' },
        h('span', { className: 'dp-brand' }, '✦ Codex'),
        value?.plan != null && h('span', { className: 'dp-muted' }, value.plan),
        h('span', { className: 'dp-spacer' }),
        usage.loading && usage.value === undefined && h('span', { className: 'dp-muted' }, 'reading limits…'),
        usage.error !== null && h('span', { className: 'dp-muted' }, 'limits unavailable'),
        value?.available === false && h('span', { className: 'dp-muted' },
          UNAVAILABLE[value.reason] ?? 'limits unavailable'),
        ordered.map(win => h(LimitMeter, { key: win.kind, window: win })),
        ordered.length > 0 && reset !== null && h('span', { className: 'dp-muted dp-num' },
          'resets in ' + fmtUntil(reset - Date.now())))
    }

    /**
     * The dock seat, which belongs to whichever route the session is on: the
     * Codex readout reports what a Codex turn is charged against, and says
     * nothing at all about a session on any other route.
     *
     * The provider comes from the shared session model directory, so the bar
     * follows the model selector without a round trip.
     */
    function Dock(props) {
      const health = useAsync(() => getJson('/dsh-preview/api/health', TTL.health), [])
      const provider = props.useModelDirectory(state => state.current?.provider ?? null)
      const dir = useMemo(() => props.directory(), []) // eslint-disable-line react-hooks/exhaustive-deps
      // The model seat loads the directory on mount, but the dock must not
      // depend on that seat being composed in to learn its own route.
      useEffect(() => { dir.load().catch(() => {}) }, [dir])

      if (provider === null || health.value === undefined) return null
      if (provider === health.value.codexProvider) return h(CodexDock, props)
      return null
    }

    // ── workspace preview panel (the frame's aside column) ─────────────────

    /** Workspace-relative form of a mutated path (absolute paths need root). */
    function relativize(path, root) {
      if (typeof path !== 'string' || path.length === 0) return null
      if (root && path.indexOf(root + '/') === 0) return path.slice(root.length + 1)
      return path.charAt(0) === '/' ? null : path
    }

    function previewUrl(sessionId, file, revKey, nonce) {
      return '/dsh-preview/preview/' + encodeURIComponent(sessionId) + '/'
        + file.split('/').map(encodeURIComponent).join('/')
        + '?rev=' + revKey + '&n=' + nonce
    }

    /**
     * The aside-column occupant: a collapsed rail (mirroring the sidebar's)
     * or the expanded preview panel — toolbar over a sandboxed iframe of the
     * session workspace's HTML, remounted whenever a successful agent edit
     * bumps the workspacePreview revision. Column width and the drag handle
     * belong to the frame; collapse/expand goes through ctx.layout.
     */
    function AsidePanel(props) {
      const sessionId = props.sessionId
      const projection = props.useProjection('workspacePreview')
      const rev = projection != null ? projection.rev : 0
      const [chosen, setChosen] = useState(null)
      const [follow, setFollow] = useState(true)
      const [nonce, setNonce] = useState(0)
      useEffect(() => { setChosen(null) }, [sessionId])
      // Uncached on purpose: the manifest must see files the moment a rev
      // lands (and the refresh button must be able to force it).
      const manifest = useAsync(
        () => fetch('/dsh-preview/api/preview?session=' + encodeURIComponent(sessionId), {
          headers: { accept: 'application/json' },
        }).then(response => {
          if (!response.ok) throw new Error('HTTP ' + response.status)
          return response.json()
        }),
        [sessionId, rev, nonce],
      )

      const root = manifest.value?.root ?? null
      const candidates = useMemo(() => {
        const seen = []
        const push = value => {
          if (value !== null && /\.html?$/i.test(value) && seen.indexOf(value) === -1) seen.push(value)
        }
        for (const path of manifest.value?.html ?? []) push(path)
        for (const path of Object.keys(projection != null ? projection.files : {})) push(relativize(path, root))
        return seen
      }, [manifest.value, projection, root])

      const auto = relativize(projection != null ? projection.lastHtml : null, root)
      const fallback = candidates.indexOf('index.html') !== -1 ? 'index.html' : candidates[0] ?? null
      const file = chosen !== null && candidates.indexOf(chosen) !== -1 ? chosen : auto ?? fallback
      const revKey = follow ? rev : 'pinned'

      if (props.collapsed) {
        return h('button', {
          className: 'dp-rail',
          onClick: () => props.toggleAside(),
          title: 'show workspace preview',
        },
        h('span', { className: 'dp-rail-icon' }, '◧'),
        h('span', { className: 'dp-rail-label' }, 'Preview'))
      }

      return h('div', { className: 'dp-aside' },
        h('div', { className: 'dp-aside-bar' },
          h('span', { className: 'dp-brand' }, '✦ Preview'),
          candidates.length > 0 && h('select', {
            className: 'dp-select', value: file ?? '',
            onChange: event => setChosen(event.target.value),
            title: root === null ? undefined : root + '/' + (file ?? ''),
          }, candidates.map(path => h('option', { key: path, value: path }, path))),
          h('button', {
            className: 'dp-btn',
            onClick: () => setNonce(value => value + 1),
            title: 'reload the page and rescan the workspace',
          }, 'Refresh'),
          h('label', { className: 'dp-check', title: 'reload automatically when the agent edits files' },
            h('input', { type: 'checkbox', checked: follow, onChange: event => setFollow(event.target.checked) }),
            'follow'),
          file !== null && h('a', {
            className: 'dp-btn dp-link',
            href: previewUrl(sessionId, file, revKey, nonce),
            target: '_blank',
            rel: 'noopener',
            title: 'open in a new tab',
          }, '↗'),
          h('span', { className: 'dp-spacer' }),
          h('span', { className: 'dp-muted dp-num', title: 'workspace edits observed this session' },
            'rev ' + rev),
          h('button', {
            className: 'dp-icon-btn',
            onClick: () => props.toggleAside(),
            title: 'hide preview (collapse to the rail)',
          }, '»')),
        file === null
          ? h('div', { className: 'dp-aside-empty' },
            manifest.loading
              ? h('span', null, 'scanning workspace…')
              : manifest.error !== null
                ? h('span', null, 'preview unavailable — ' + manifest.error.message
                  + ' (does this session have a workspace?)')
                : h('span', null, 'No HTML files in this workspace yet.'),
            h('span', null, 'Ask the agent to create an index.html, then this panel renders it live.'))
          : h('div', { className: 'dp-frame-wrap' },
            h('iframe', {
              key: previewUrl(sessionId, file, revKey, nonce),
              className: 'dp-frame',
              src: previewUrl(sessionId, file, revKey, nonce),
              // Opaque origin by design: scripts run, but the page cannot
              // reach the harness RPC plane or read sibling files via fetch.
              sandbox: 'allow-scripts allow-forms allow-modals allow-popups',
              title: 'workspace preview',
            })))
    }

    // ── plugin body ────────────────────────────────────────────────────────

    /** Services the browser plugin needs before it applies. */
    exports.inject = ['slots', 'modelDirectories']

    /**
     * Claim the aside column for the preview panel, and the dock seat for the
     * Codex readout.
     * @param {object} ctx - client root context.
     */
    exports.apply = function apply(ctx) {
      // The workspace preview claims the frame's aside column: a collapsed
      // rail or an expanded, drag-resizable panel right of the conversation
      // (and of tool details), mirroring the sidebar. Width, drag, and
      // concession belong to ui-layout; collapse/expand round-trips through
      // ctx.layout so the frame and the rail stay one source of truth.
      ctx.slots.inject('aside', () => ctx.slots.register({
        name: 'aside',
        inject: () => ({
          toggleAside: () => ctx.get('layout').toggleAside(),
        }),
      }, AsidePanel))
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: 'dsh-preview',
        order: 20,
        inject: sessionId => ({
          directory: () => ctx.modelDirectories.directoryFor(sessionId),
          // The renderer binds a `hooks` entry to a `use<Name>` selector prop,
          // which is what makes the dock's face follow the model selector.
          hooks: { modelDirectory: ctx.modelDirectories.directoryFor(sessionId).store },
        }),
      }, Dock))
    }

    return module.exports
  },
})
