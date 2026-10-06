/**
 * Changes view preferences — how diffs and the file list are shown on this
 * screen. Pure presentation, so they stay client-local (localStorage) rather
 * than in any space or repository data, like the team view preferences.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface ChangesViewPrefsState {
  /** Side by side when the canvas is wide enough; inline otherwise. */
  sideBySide: boolean
  collapseUnchanged: boolean
  /** File list shown beside the diffs on wide canvases (narrow ones open it as a drawer). */
  panelOpen: boolean
  /** Unset keeps the width-dependent default; a narrow canvas only clamps the display. */
  panelWidth?: number
  /** File list grouped by folder rather than flat. */
  tree: boolean
  hideGenerated: boolean

  setSideBySide: (on: boolean) => void
  setCollapseUnchanged: (on: boolean) => void
  setPanelOpen: (open: boolean) => void
  setPanelWidth: (width: number | undefined) => void
  setTree: (tree: boolean) => void
  setHideGenerated: (hide: boolean) => void
}

export const useChangesViewPrefs = create<ChangesViewPrefsState>()(
  persist(
    (set) => ({
      sideBySide: true,
      collapseUnchanged: true,
      panelOpen: true,
      tree: true,
      hideGenerated: true,
      setSideBySide: (sideBySide) => set({ sideBySide }),
      setCollapseUnchanged: (collapseUnchanged) => set({ collapseUnchanged }),
      setPanelOpen: (panelOpen) => set({ panelOpen }),
      setPanelWidth: (panelWidth) => set({ panelWidth }),
      setTree: (tree) => set({ tree }),
      setHideGenerated: (hideGenerated) => set({ hideGenerated }),
    }),
    { name: 'halo-changes-view-prefs', version: 1 }
  )
)
