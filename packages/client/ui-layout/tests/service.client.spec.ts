/**
 * LayoutController behavior: the cross-plugin panel-action face. Geometry
 * lives in the entry store (layout-store.spec.ts) — here we assert the
 * delegation contract: attachPanels wiring, the panel actions forwarding, the
 * unwired fail-loud, re-attach overwriting a stale action set, and aside
 * occupancy buffering across attach.
 */
import { describe, expect, it, vi } from 'vitest'
import { LayoutController } from '@deepseek-ai/dsh-client-ui-layout/src/client/service.ts'
import type { PanelActions } from '@deepseek-ai/dsh-client-ui-layout/src/client/service.ts'

function fakePanels(): PanelActions {
  return {
    setSidebar: vi.fn(),
    setDetails: vi.fn(),
    setAside: vi.fn(),
    toggleSidebar: vi.fn(),
    toggleAside: vi.fn(),
    setAsideOccupied: vi.fn(),
    setNarrow: vi.fn(),
    openDetails: vi.fn(),
    closeDetails: vi.fn(),
  }
}

describe('LayoutController', () => {
  it('forwards the panel actions to the attached set', () => {
    const service = new LayoutController()
    const panels = fakePanels()
    service.attachPanels(panels)

    service.toggleSidebar()
    service.toggleAside()
    service.openDetails()
    service.closeDetails()

    expect(panels.toggleSidebar).toHaveBeenCalledTimes(1)
    expect(panels.toggleAside).toHaveBeenCalledTimes(1)
    expect(panels.openDetails).toHaveBeenCalledTimes(1)
    expect(panels.closeDetails).toHaveBeenCalledTimes(1)
    expect(panels.setSidebar).not.toHaveBeenCalled()
    expect(panels.setDetails).not.toHaveBeenCalled()
    expect(panels.setAside).not.toHaveBeenCalled()
  })

  it('fails loud before the root entry wired its actions', () => {
    const service = new LayoutController()
    expect(() => { service.toggleSidebar() }).toThrow(/panel actions not wired/)
    expect(() => { service.toggleAside() }).toThrow(/panel actions not wired/)
    expect(() => { service.openDetails() }).toThrow(/panel actions not wired/)
    expect(() => { service.closeDetails() }).toThrow(/panel actions not wired/)
  })

  it('re-attach overwrites the stale action set (entry re-register)', () => {
    const service = new LayoutController()
    const stale = fakePanels()
    const fresh = fakePanels()
    service.attachPanels(stale)
    service.attachPanels(fresh)

    service.toggleSidebar()

    expect(stale.toggleSidebar).not.toHaveBeenCalled()
    expect(fresh.toggleSidebar).toHaveBeenCalledTimes(1)
  })

  it('buffers aside occupancy before attach and replays it on every attach', () => {
    const service = new LayoutController()
    // Pre-attach: safe no-throw, value retained.
    service.setAsideOccupied(true)

    const panels = fakePanels()
    service.attachPanels(panels)
    expect(panels.setAsideOccupied).toHaveBeenCalledWith(true)

    // Live updates forward directly; a re-attach replays the latest value.
    service.setAsideOccupied(false)
    expect(panels.setAsideOccupied).toHaveBeenLastCalledWith(false)
    const fresh = fakePanels()
    service.attachPanels(fresh)
    expect(fresh.setAsideOccupied).toHaveBeenCalledWith(false)
  })
})
