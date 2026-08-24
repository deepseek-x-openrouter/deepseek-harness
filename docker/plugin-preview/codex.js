/**
 * Codex subscription limits — what the composer dock reports on a Codex route.
 *
 * A subscription route has no per-request price to show, so the dock reports
 * the plan's windows instead: percent used and time to reset.
 *
 * Those numbers ride the requests the harness already makes. ChatGPT answers
 * every Codex generation with its plan accounting in `x-codex-*` response
 * headers, which the harness fork's `llm-pi-ai/provider-response` event
 * republishes verbatim; this module is the consumer that understands that
 * route's vocabulary. Nothing here calls ChatGPT: the account endpoint that
 * serves the same numbers as JSON (`/backend-api/codex/usage`) answers a Node
 * client with a Cloudflare challenge, and the header path needs no second
 * request, no credential of its own, and updates every turn rather than on a
 * poll interval.
 *
 * The cost is that the readout knows nothing until this process has served one
 * Codex request, which is a fact the dock states rather than hides.
 *
 * @module dsh-preview/codex
 */

/** The provider route a Codex model is selected under. */
export const DEFAULT_CODEX_PROVIDER = 'openai-codex'

/** A window at least this long is the plan's weekly allowance. */
const WEEKLY_MINUTES = 6 * 24 * 60

/**
 * Read one `x-codex-*` header as a number.
 * @param {Record<string, string>} headers - the response headers.
 * @param {string} name - the header to read.
 * @returns {number | null} the value, or null when absent or unparsable.
 */
function num(headers, name) {
  const raw = headers[name]
  if (typeof raw !== 'string' || raw.trim().length === 0) return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

/** Read one `x-codex-*` header as a boolean; the backend spells them `True`/`False`. */
function bool(headers, name) {
  const raw = headers[name]
  return typeof raw === 'string' ? raw.trim().toLowerCase() === 'true' : null
}

/**
 * Human-scale name for a limit window, from its length in minutes.
 * @param {number} minutes - the window's length.
 * @returns {string} a compact label such as `5h` or `7d`.
 */
export function windowLabel(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return 'window'
  if (minutes % 1_440 === 0) return `${minutes / 1_440}d`
  if (minutes % 60 === 0) return `${minutes / 60}h`
  return `${Math.round(minutes)}m`
}

/**
 * One window's headers, or null when the plan does not use that window.
 *
 * A zero-length window is how an unused slot reports itself: a plan with no
 * short window answers `x-codex-secondary-window-minutes: 0` rather than
 * omitting the header.
 */
function summarizeWindow(headers, kind) {
  const minutes = num(headers, `x-codex-${kind}-window-minutes`)
  if (minutes === null || minutes <= 0) return null
  const resetAt = num(headers, `x-codex-${kind}-reset-at`)
  return {
    kind,
    label: windowLabel(minutes),
    minutes,
    weekly: minutes >= WEEKLY_MINUTES,
    usedPercent: num(headers, `x-codex-${kind}-used-percent`),
    resetAfterSeconds: num(headers, `x-codex-${kind}-reset-after-seconds`),
    // Reported in epoch seconds; the browser half works in milliseconds.
    resetAt: resetAt === null ? null : resetAt * 1000,
  }
}

/**
 * Trim one Codex response's headers to the plan accounting the dock renders,
 * or null when the response carries none.
 *
 * Which window holds the weekly allowance is a per-plan fact, not a fixed
 * slot: a plan may spend the primary window on it, or put a shorter window
 * there and the weekly one in secondary. Both are summarized and each states
 * its own length, so the reader names the weekly one by duration.
 * @param {Record<string, string>} headers - the provider response headers.
 * @returns {object | null} the display summary, or null when no window reported.
 */
export function summarizeCodexHeaders(headers) {
  if (headers === null || typeof headers !== 'object') return null
  const windows = [summarizeWindow(headers, 'primary'), summarizeWindow(headers, 'secondary')]
    .filter(window => window !== null)
  if (windows.length === 0) return null
  const plan = headers['x-codex-plan-type']
  const balance = num(headers, 'x-codex-credits-balance')
  const hasCredits = bool(headers, 'x-codex-credits-has-credits')
  return {
    available: true,
    plan: typeof plan === 'string' && plan.length > 0 ? plan : null,
    windows,
    weekly: windows.find(window => window.weekly) ?? null,
    credits: hasCredits === null && balance === null ? null : {
      hasCredits: hasCredits === true,
      unlimited: bool(headers, 'x-codex-credits-unlimited') === true,
      balance,
    },
  }
}

/**
 * Validated Codex options, or `false` when the readout is switched off.
 * @param {object|false|undefined} config - the plugin row's `codex` field.
 * @returns {object|false} the resolved options.
 */
export function resolveCodexOptions(config) {
  if (config === false) return false
  const raw = config ?? {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('dsh-preview: codex must be an object of Codex readout options, or false to switch it off')
  }
  const provider = raw.provider ?? DEFAULT_CODEX_PROVIDER
  if (typeof provider !== 'string' || provider.length === 0) {
    throw new Error('dsh-preview: codex.provider must be a non-empty route name')
  }
  return { provider }
}

/**
 * The plan accounting last seen on the Codex route, folded from provider
 * response headers.
 *
 * Only the latest snapshot is kept: every Codex response restates the whole
 * window state, so an older one is never the better answer.
 */
export class CodexLimits {
  #options
  #latest = null

  /** @param {{options: object}} deps - the resolved Codex options. */
  constructor(deps) {
    this.#options = deps.options
  }

  /** The route name whose selection this readout serves. */
  get provider() {
    return this.#options.provider
  }

  /**
   * Fold one `llm-pi-ai/provider-response` report.
   *
   * Responses from other routes are ignored, and so is a Codex response
   * carrying no window — an error the provider answered before reaching its
   * accounting must not erase what the last good response said.
   * @param {{provider: string, model: string, headers: Record<string, string>}} detail - the reported response.
   * @returns {boolean} whether the snapshot advanced.
   */
  observe(detail) {
    if (detail?.provider !== this.#options.provider) return false
    const summary = summarizeCodexHeaders(detail.headers)
    if (summary === null) return false
    this.#latest = { ...summary, model: detail.model, observedAt: Date.now() }
    return true
  }

  /**
   * The plan's limit windows as of the last Codex response.
   * @returns {object} the display summary, or why there is none.
   */
  snapshot() {
    return this.#latest ?? {
      available: false,
      reason: 'no-data',
      provider: this.#options.provider,
    }
  }
}
