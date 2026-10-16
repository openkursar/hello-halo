import { useLayoutEffect, type RefObject } from 'react'
import { fitTextareaHeight } from '../utils/textarea-height'

/**
 * Keeps a textarea as tall as its text, up to `maxHeight` when given (CSS
 * max-height on the element works too). Runs before paint, so a change in
 * height never shows a frame late.
 *
 * @param ref       - Ref to the textarea element
 * @param value     - Current value (used as dependency to trigger recalculation)
 * @param maxHeight - Cap in px
 */
export function useAutoResize(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  maxHeight?: number
): void {
  useLayoutEffect(() => {
    const el = ref.current
    if (el) fitTextareaHeight(el, maxHeight)
  }, [ref, value, maxHeight])
}
