import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CodexLimits, resolveCodexOptions, summarizeCodexHeaders, windowLabel } from '../codex.js'

/**
 * The `x-codex-*` headers a Plus plan on a weekly window answers with,
 * recorded from a live `POST /backend-api/codex/responses`.
 */
const HEADERS = {
  'x-codex-active-limit': 'premium',
  'x-codex-credits-balance': '0',
  'x-codex-credits-has-credits': 'False',
  'x-codex-credits-unlimited': 'False',
  'x-codex-plan-type': 'plus',
  'x-codex-primary-over-secondary-limit-percent': '0',
  'x-codex-primary-reset-after-seconds': '356914',
  'x-codex-primary-reset-at': '1787804959',
  'x-codex-primary-used-percent': '12.5',
  'x-codex-primary-window-minutes': '10080',
  'x-codex-secondary-reset-after-seconds': '0',
  'x-codex-secondary-reset-at': '',
  'x-codex-secondary-used-percent': '0',
  'x-codex-secondary-window-minutes': '0',
  'content-type': 'text/event-stream',
}

function limits(provider = 'openai-codex') {
  return new CodexLimits({ options: resolveCodexOptions({ provider }) })
}

test('window labels read at human scale', () => {
  assert.equal(windowLabel(10_080), '7d')
  assert.equal(windowLabel(300), '5h')
  assert.equal(windowLabel(90), '90m')
  assert.equal(windowLabel(0), 'window')
  assert.equal(windowLabel(Number.NaN), 'window')
})

test('a weekly primary window summarizes as the weekly allowance', () => {
  const summary = summarizeCodexHeaders(HEADERS)
  assert.equal(summary.available, true)
  assert.equal(summary.plan, 'plus')
  assert.deepEqual(summary.windows, [{
    kind: 'primary',
    label: '7d',
    minutes: 10_080,
    weekly: true,
    usedPercent: 12.5,
    resetAfterSeconds: 356_914,
    resetAt: 1_787_804_959_000,
  }])
  assert.equal(summary.weekly, summary.windows[0])
  // The backend spells its booleans Python-style.
  assert.deepEqual(summary.credits, { hasCredits: false, unlimited: false, balance: 0 })
})

test('a zero-length window is an unused slot, not a window', () => {
  const summary = summarizeCodexHeaders(HEADERS)
  assert.equal(summary.windows.some(window => window.kind === 'secondary'), false)
})

test('the weekly window is found by duration, not by slot', () => {
  const summary = summarizeCodexHeaders({
    'x-codex-plan-type': 'pro',
    'x-codex-primary-window-minutes': '300',
    'x-codex-primary-used-percent': '40',
    'x-codex-primary-reset-at': '1000',
    'x-codex-secondary-window-minutes': '10080',
    'x-codex-secondary-used-percent': '3',
    'x-codex-secondary-reset-at': '2000',
  })
  assert.deepEqual(summary.windows.map(window => window.label), ['5h', '7d'])
  assert.equal(summary.weekly.kind, 'secondary')
  assert.equal(summary.weekly.usedPercent, 3)
  assert.equal(summary.credits, null)
})

test('headers carrying no window summarize to nothing', () => {
  assert.equal(summarizeCodexHeaders({ 'content-type': 'text/event-stream' }), null)
  assert.equal(summarizeCodexHeaders({ 'x-codex-primary-window-minutes': 'not-a-number' }), null)
  assert.equal(summarizeCodexHeaders(null), null)
  assert.equal(summarizeCodexHeaders(undefined), null)
})

test('a window reporting no percent still renders as a window', () => {
  const summary = summarizeCodexHeaders({ 'x-codex-primary-window-minutes': '10080' })
  assert.equal(summary.windows[0].usedPercent, null)
  assert.equal(summary.windows[0].resetAt, null)
  assert.equal(summary.plan, null)
})

test('options validate and switch off', () => {
  assert.equal(resolveCodexOptions(false), false)
  assert.equal(resolveCodexOptions(undefined).provider, 'openai-codex')
  assert.equal(resolveCodexOptions({ provider: 'codex' }).provider, 'codex')
  assert.throws(() => resolveCodexOptions({ provider: '' }), /provider/)
  assert.throws(() => resolveCodexOptions([]), /codex must be an object/)
})

test('nothing observed yet reads as no data', () => {
  const unit = limits()
  assert.deepEqual(unit.snapshot(), { available: false, reason: 'no-data', provider: 'openai-codex' })
  assert.equal(unit.provider, 'openai-codex')
})

test('a Codex response advances the snapshot', () => {
  const unit = limits()
  assert.equal(unit.observe({ provider: 'openai-codex', model: 'gpt-5.6-terra', headers: HEADERS }), true)
  const snapshot = unit.snapshot()
  assert.equal(snapshot.available, true)
  assert.equal(snapshot.model, 'gpt-5.6-terra')
  assert.equal(snapshot.weekly.usedPercent, 12.5)
  assert.equal(typeof snapshot.observedAt, 'number')
})

test('another route\'s response is not this route\'s accounting', () => {
  const unit = limits()
  assert.equal(unit.observe({ provider: 'openrouter', model: 'z-ai/glm-5.2', headers: HEADERS }), false)
  assert.equal(unit.observe({ provider: undefined, model: 'x', headers: HEADERS }), false)
  assert.equal(unit.observe(undefined), false)
  assert.equal(unit.snapshot().available, false)
})

test('a response carrying no window leaves the last good one standing', () => {
  const unit = limits()
  unit.observe({ provider: 'openai-codex', model: 'gpt-5.6-terra', headers: HEADERS })
  assert.equal(unit.observe({ provider: 'openai-codex', model: 'gpt-5.6-terra', headers: {} }), false)
  assert.equal(unit.snapshot().weekly.usedPercent, 12.5)
})

test('the newest response wins outright', () => {
  const unit = limits()
  unit.observe({ provider: 'openai-codex', model: 'gpt-5.6-terra', headers: HEADERS })
  unit.observe({
    provider: 'openai-codex',
    model: 'gpt-5.6-luna',
    headers: { ...HEADERS, 'x-codex-primary-used-percent': '31', 'x-codex-secondary-window-minutes': '300', 'x-codex-secondary-used-percent': '4' },
  })
  const snapshot = unit.snapshot()
  assert.equal(snapshot.weekly.usedPercent, 31)
  assert.equal(snapshot.model, 'gpt-5.6-luna')
  assert.deepEqual(snapshot.windows.map(window => window.label), ['7d', '5h'])
})
