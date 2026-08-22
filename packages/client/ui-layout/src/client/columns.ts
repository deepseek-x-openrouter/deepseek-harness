/**
 * Pure concession-chain column solver for the AppFrame (sidebar | center |
 * details | aside). Chain order is fixed by contract: keep center >=
 * CENTER_MIN by shrinking details, then auto-closing it (derived widths —
 * preferred width preferences are never rewritten, so widening the window
 * restores them). Neither the sidebar nor an open aside concedes past its
 * preference: both render at their dragged width (the aside has no width
 * ceiling at all) and center absorbs any remaining deficit — down to zero —
 * as the last resort; only a preference wider than the whole non-sidebar
 * span trims the aside to what physically remains. Inputs are the layout store's plain width preferences (0 =
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
/** Aside drag clamp floor (no ceiling: the user may take as much as fits). */
export const ASIDE_MIN = 300
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
 * ASIDE_COLLAPSED = fixed rail, larger = open preference (uncapped).
 * @returns resolved widths; details 0 means visually closed (never
 * unmounted), a closed sidebar keeps its compact rail, an occupied aside
 * never resolves below its rail, and center may reach zero under a wide
 * aside preference.
 */
export function computeColumns(viewport: number, sidebar: number, details: number, aside = 0): Columns {
  // The sidebar is fixed at its preference (or the rail) — it never concedes.
  const s = sidebar === 0 ? SIDEBAR_COLLAPSED : clampWidth(sidebar, SIDEBAR_MIN, SIDEBAR_MAX)
  const d0 = details === 0 ? 0 : clampWidth(details, DETAILS_MIN, DETAILS_MAX)
  // No ceiling on an open aside: the dragged preference is honored as far as
  // the frame physically allows (the user chose that width deliberately).
  const a0 = aside === 0 ? 0 : aside <= ASIDE_COLLAPSED ? ASIDE_COLLAPSED : Math.max(ASIDE_MIN, Math.round(aside))

  // Step 1: everything fits at preferred widths.
  if (s + d0 + a0 + CENTER_MIN <= viewport) {
    return { sidebar: s, center: viewport - s - d0 - a0, details: d0, aside: a0 }
  }

  // Step 2: shrink details toward its minimum (aside untouched).
  const d1 = d0 === 0 ? 0 : Math.max(DETAILS_MIN, viewport - s - a0 - CENTER_MIN)
  if (s + d1 + a0 + CENTER_MIN <= viewport) return { sidebar: s, center: CENTER_MIN, details: d1, aside: a0 }

  // Step 3: auto-close details (derived). The aside then behaves like the
  // sidebar: it holds its dragged width and CENTER absorbs the deficit —
  // all the way to zero if the user asked for that much room.
  if (s + a0 <= viewport) return { sidebar: s, center: viewport - s - a0, details: 0, aside: a0 }

  // Step 4: the preference exceeds even the whole non-sidebar span — an open
  // aside fills what remains (never below its rail) and center reaches zero;
  // an absent aside stays absent while center absorbs the deficit.
  if (a0 === 0) return { sidebar: s, center: Math.max(0, viewport - s), details: 0, aside: 0 }
  return { sidebar: s, center: 0, details: 0, aside: Math.max(ASIDE_COLLAPSED, viewport - s) }
}
