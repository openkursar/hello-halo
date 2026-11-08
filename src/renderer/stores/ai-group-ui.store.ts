/** A request to open a group's editor in Settings, left for the AI model section to pick up when it opens. */

import { create } from 'zustand'

interface GroupEditRequestState {
  groupId: string | null
  request: (groupId: string) => void
  clear: () => void
}

export const useGroupEditRequest = create<GroupEditRequestState>(set => ({
  groupId: null,
  request: groupId => set({ groupId }),
  clear: () => set({ groupId: null }),
}))
