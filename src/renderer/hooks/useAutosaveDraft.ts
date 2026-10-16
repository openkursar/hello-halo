/**
 * Draft of a text field that saves itself when it loses focus.
 *
 * It also saves when the field unmounts: closing the panel that holds it (a
 * press on a drawer's backdrop, Escape) removes the field before it ever loses
 * focus, and the edit would otherwise be dropped without a word.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

export function useAutosaveDraft(
  saved: string,
  save: (next: string) => Promise<boolean> | void,
  { allowEmpty = false }: { allowEmpty?: boolean } = {},
) {
  const [draft, setDraft] = useState(saved)
  // What was last handed to `save`: a blur followed by an unmount, before the
  // first save has come back as `saved`, must not send the same value twice.
  const sent = useRef(saved)
  useEffect(() => {
    sent.current = saved
    setDraft(saved)
  }, [saved])

  const commit = useCallback(() => {
    const next = draft.trim()
    if ((!next && !allowEmpty) || next === sent.current) return
    const previous = sent.current
    sent.current = next
    void Promise.resolve(save(next)).then(ok => {
      if (ok === false && sent.current === next) sent.current = previous
    })
  }, [draft, allowEmpty, save])

  const commitRef = useRef(commit)
  commitRef.current = commit
  useEffect(() => () => commitRef.current(), [])

  return [draft, setDraft, commit] as const
}
