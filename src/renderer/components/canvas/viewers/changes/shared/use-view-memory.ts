/**
 * The tab's view memory as React state: reads come from `tab.view.changes`
 * (created on first use), writes go straight back to it and re-render this
 * viewer. The lifecycle never notifies about it, so other tabs are unaffected.
 */

import { useCallback, useReducer } from 'react'
import type { TabState } from '../../../../../services/canvas-lifecycle'
import type { ChangesViewMemory } from '../../../../../types/changes-view'
import { createViewMemory } from '../state/view-memory'

export function useViewMemory(tab: TabState): [ChangesViewMemory, (patch: Partial<ChangesViewMemory>) => void] {
  const memory = (tab.view.changes ??= createViewMemory())
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  const update = useCallback((patch: Partial<ChangesViewMemory>) => {
    Object.assign(memory, patch)
    rerender()
  }, [memory])
  return [memory, update]
}
