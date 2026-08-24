# dsh-preview

The workspace preview panel and the Codex subscription readout, as one
out-of-tree bundle. It owns no LLM route and no credential: everything it shows
is folded from what the session and its provider already produce.

It is the OpenRouter-free half of [Windrose](https://github.com/deepseek-x-openrouter/deepseek-openrouter-plugin),
extracted so a deployment can have the preview panel without an OpenRouter
adapter, catalog, or price oracle.

## What it adds

**The preview panel** occupies the frame's aside column: a collapsible,
drag-resizable panel right of the conversation holding a sandboxed iframe of
the session workspace's HTML. It reloads the moment the agent's edit lands.

The `workspacePreview` projection (`preview.js`) folds the session's own tool
log: a `tool/call` naming a file mutation (`write`/`edit` with `file_path`,
`str_replace_editor` with `path` on any command but `view`) parks its target,
and the paired successful `tool/result` commits it — bumping `rev`, which is
what remounts the iframe. Files created by terminal commands are invisible to
that fold, and the panel's Refresh button covers them.

The files themselves are served from `/dsh-preview/preview/<sessionId>/<path>`,
rooted at the session header's `cwd`. Any dot-leading segment (`.env`, `.git`)
is refused, traversal is refused after normalization, responses carry
`no-store` and `nosniff`, and no CORS header is ever added — the iframe's
sandbox gives it an opaque origin, so it can run scripts but cannot reach the
harness RPC plane or read sibling files.

**The Codex readout** takes the composer dock's seat while the session is on
the `openai-codex` route and reports what the ChatGPT subscription has left:
each plan limit window as a meter, weekly first, with the time until it resets.
Those numbers ride the responses the harness already receives — ChatGPT answers
every Codex generation with `x-codex-*` headers, which this fork republishes as
`llm-pi-ai/provider-response` — so the readout costs no extra request and no
credential of its own. It knows nothing until the first Codex reply of the
process, which the dock says rather than hides.

## Configuration

Both surfaces are on by default. In the profile's `cordis.patch.yml`:

```yaml
- id: dsh-preview
  config:
    preview: false          # switch the panel and its file surface off
    codex: false            # switch the subscription readout off
    # codex: { provider: openai-codex }   # or name another Codex route
```

## Requirements

The harness fork's `ui-layout` aside column (the panel's seat) and its
`llm-pi-ai/provider-response` event (the readout's data). Against upstream dsh
the panel has no column to occupy and the readout never receives anything.

## Tests

```sh
node --test tests/*.test.js
```
