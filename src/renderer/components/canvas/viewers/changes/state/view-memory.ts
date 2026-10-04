import type { ChangesViewMemory } from '../../../../../types/changes-view'

/** A new tab's memory: the "Changes" page of uncommitted changes, nothing folded or filtered. */
export function createViewMemory(): ChangesViewMemory {
  return {
    page: 'changes',
    scope: { kind: 'uncommitted' },
    filter: '',
    folded: [],
    loaded: [],
    forced: [],
    overviewScroll: 0,
    detail: null,
    commitMessage: '',
  }
}
