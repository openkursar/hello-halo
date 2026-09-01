/**
 * Task Panel Store - visibility of the rail-triggered task panel
 *
 * The panel itself (components/layout/TaskPanel.tsx) renders PulseList;
 * this store only tracks whether it's open, toggled from NavRail/
 * NarrowNavSheet's "Tasks" entry.
 */

import { create } from 'zustand'

interface TaskPanelState {
  isOpen: boolean
  toggle: () => void
  close: () => void
}

export const useTaskPanelStore = create<TaskPanelState>((set) => ({
  isOpen: false,
  toggle: () => set((state) => ({ isOpen: !state.isOpen })),
  close: () => set({ isOpen: false }),
}))
