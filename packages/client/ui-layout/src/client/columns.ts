/**
 * Pure concession-chain column solver for the AppFrame (sidebar | center |
 * details | aside). Chain order is fixed by contract: keep center >=
 * CENTER_MIN by shrinking details, then auto-closing it, then shrinking an
 * open aside toward its minimum, then dropping the aside to its collapsed
 * rail (all derived widths — preferred width preferences are never
 * rewritten, so widening the window restores them). The sidebar never
 * concedes: its rendered width is always the drag preference (or the
 * collapsed rail), and center absorbs any remaining deficit as the last
 * resort. Inputs are the layout store's plain width preferences (0 =
 * closed); a closed sidebar resolves to the fixed SIDEBAR_COLLAPSED control
 * rail while closed details resolve to zero width. The aside input is the
 * frame-resolved target: 0 = column absent (no occupant or no session),
 * ASIDE_COLLAPSED = the fixed rail, anything larger = open preference.
 * The SIDEBAR_AUTO_COLLAPSE breakpoint is consumed by AppFrame, which decides
 * the effective sidebar preference before solving; the solver itself stays
 * breakpoint-free.
 */

/** Resolved widths for one frame; center may drop below CENTER_MIN only at the final fallback. */
export interface Columns { sidebar: number; center: number; details: number; aside: number }

// Contract-frozen geometry: the three-column concession chain's fixed points.
/** Center column floor; only the final fallback may go below it. */
export const CENTER_MIN = 640
/** Sidebar drag clamp floor. */
export const SIDEBAR_MIN = 264
/** Sidebar drag clamp ceiling. */
export const SIDEBAR_MAX = 420
/** Sidebar width before any user drag. */
export const SIDEBAR_DEFAULT = 280
/** Closed-sidebar rail: a 24px icon column between 16px horizontal paddings. */
export const SIDEBAR_COLLAPSED = 56
/** Viewport width below which the sidebar auto-collapses to the rail (deepsuite
 * LG breakpoint); a manual toggle below it re-expands over the squeezed center
 * (stores.ts narrowExpanded). */
export const SIDEBAR_AUTO_COLLAPSE = 1024
/** Details drag clamp floor. */
export const DETAILS_MIN = 300
/** Details drag clamp ceiling. */
export const DETAILS_MAX = 520
/** Details width before any user drag. */
export const DETAILS_DEFAULT = 360
/** Aside drag clamp floor. */
export const ASIDE_MIN = 300
/** Aside drag clamp ceiling. */
export const ASIDE_MAX = 760
/** Aside width before any user drag. */
export const ASIDE_DEFAULT = 420
/** Collapsed-aside rail: a slim control strip mirroring the sidebar's rail idea. */
export const ASIDE_COLLAPSED = 40

/**
 * Clamp a panel width into its contract range.
 * @param px - requested width.
 * @param min - range lower bound.
 * @param max - range upper bound.
 * @returns the clamped width.
 */
export function clampWidth(px: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(px)))
}

/**
 * Solve the column widths for one viewport frame. Pure: no hysteresis —
 * the output is a function of (viewport, preferences) only, so recovery on
 * re-widening is automatic. Preferences re-clamp here because they cross the
 * store boundary and callers may still supply stale ranges.
 * @param viewport - available frame width in px.
 * @param sidebar - sidebar width preference in px (0 = closed).
 * @param details - details width preference in px (0 = closed).
 * @param aside - frame-resolved aside target in px: 0 = column absent,
 * ASIDE_COLLAPSED = fixed rail, larger = open preference.
 * @returns resolved widths; details 0 means visually closed (never
 * unmounted), a closed sidebar keeps its compact rail, and an occupied aside
 * never resolves below its rail.
 */
export function computeColumns(viewport: number, sidebar: number, details: number, aside = 0): Columns {
  // The sidebar is fixed at its preference (or the rail) — it never concedes.
  const s = sidebar === 0 ? SIDEBAR_COLLAPSED : clampWidth(sidebar, SIDEBAR_MIN, SIDEBAR_MAX)
  const d0 = details === 0 ? 0 : clampWidth(details, DETAILS_MIN, DETAILS_MAX)
  const a0 = aside === 0 ? 0 : aside <= ASIDE_COLLAPSED ? ASIDE_COLLAPSED : clampWidth(aside, ASIDE_MIN, ASIDE_MAX)

  // Step 1: everything fits at preferred widths.
  if (s + d0 + a0 + CENTER_MIN <= viewport) {
    return { sidebar: s, center: viewport - s - d0 - a0, details: d0, aside: a0 }
  }

  // Step 2: shrink details toward its minimum (aside untouched).
  const d1 = d0 === 0 ? 0 : Math.max(DETAILS_MIN, viewport - s - a0 - CENTER_MIN)
  if (s + d1 + a0 + CENTER_MIN <= viewport) return { sidebar: s, center: CENTER_MIN, details: d1, aside: a0 }

  // Step 3: auto-close details (derived); shrink an open aside toward its
  // minimum — never past its preference (closing details may free more room
  // than the aside asked for). A rail (or absent) aside is fixed like the
  // sidebar.
  const a1 = a0 <= ASIDE_COLLAPSED ? a0 : Math.min(a0, Math.max(ASIDE_MIN, viewport - s - CENTER_MIN))
  if (s + a1 + CENTER_MIN <= viewport) return { sidebar: s, center: viewport - s - a1, details: 0, aside: a1 }

  // Step 4: an open aside falls to its rail (derived — preferences
  // untouched); center absorbs any remaining deficit (may drop below
  // CENTER_MIN).
  const a2 = a0 === 0 ? 0 : ASIDE_COLLAPSED
  return { sidebar: s, center: Math.max(0, viewport - s - a2), details: 0, aside: a2 }
}
