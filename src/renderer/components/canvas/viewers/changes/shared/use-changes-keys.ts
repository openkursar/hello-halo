/**
 * Keys of the changes view: F7 / Shift+F7 for the next / previous change,
 * `[` and `]` to walk a detail page, Esc to step back (close the drawer,
 * leave the detail page) before the canvas itself collapses.
 *
 * Listens on the document so the keys also work while nothing in the view has
 * focus, but only for keys aimed at the view or at no element at all; anything
 * a component already handled (a menu's Esc) is left alone.
 */

import { useEffect, useRef, type RefObject } from 'react'
import { useViewerResources } from '../../../viewer-resources'

interface ChangesKeyHandlers {
  onNavigate: (direction: 1 | -1) => void
  /**
   * Returns whether the view used the key. `typing` when it came from a text
   * field (the file filter, the commit message), which takes Esc only to close
   * the drawer it sits in or to give focus back to the view.
   */
  onEscape: (typing: boolean) => boolean
  /** Returns whether the view used the key. */
  onStep: (delta: number) => boolean
}

function isTextEntry(element: Element | null): boolean {
  if (!element) return false
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return true
  return (element as HTMLElement).isContentEditable && !element.closest('.cm-editor')
}

export function useChangesKeys(rootRef: RefObject<HTMLElement | null>, handlers: ChangesKeyHandlers): void {
  const resources = useViewerResources()
  const latest = useRef(handlers)
  latest.current = handlers

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return
      const root = rootRef.current
      const target = e.target instanceof Element ? e.target : null
      const ours = !target || target === document.body || (root?.contains(target) ?? false)
      if (!ours) return

      if (e.key === 'F7' && !e.altKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        latest.current.onNavigate(e.shiftKey ? -1 : 1)
        return
      }
      if (e.key === 'Escape') {
        if (latest.current.onEscape(isTextEntry(target))) {
          e.preventDefault()
          e.stopPropagation()
        }
        return
      }
      if (isTextEntry(target)) return
      if ((e.key === '[' || e.key === ']') && !e.altKey && !e.metaKey && !e.ctrlKey) {
        if (target?.closest('.cm-editor')) return
        if (latest.current.onStep(e.key === '[' ? -1 : 1)) e.preventDefault()
      }
    }
    const scope = resources.scope()
    document.addEventListener('keydown', onKeyDown)
    scope.add(() => document.removeEventListener('keydown', onKeyDown))
    return () => scope.dispose()
  }, [rootRef, resources])
}
