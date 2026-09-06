import type { Page } from '@playwright/test'

/**
 * Whether the renderer has fallen back to its root error boundary
 * (`src/renderer/components/ErrorBoundary.tsx`).
 *
 * This failure mode is invisible to every other signal the harness collects.
 * The renderer process does not die, so `crashCount` stays 0; the window stays
 * responsive, so no unresponsive event fires; and React has replaced the entire
 * tree, so the canvas checks find no tab in an error state and no "No files
 * open" empty state either — a total loss of the UI reads as a clean run.
 *
 * It is not hypothetical. Reverting one line in `CsvViewer.tsx` and opening a
 * 5MB CSV of short rows throws `RangeError: Maximum call stack size exceeded`
 * inside a `useMemo`, and the whole application is replaced by this fallback
 * while S10 recorded `crashCount: 0` and passed.
 *
 * Matched on the boundary's second line, which is deliberately not translated
 * (it has to render when i18n itself may be broken) and is unique to the root
 * boundary — the chat-level boundaries share its heading but not this sentence.
 */
export async function isRendererFatal(window: Page): Promise<boolean> {
  return window
    .evaluate(() =>
      document.body.innerText.includes('An error occurred while rendering the application')
    )
    .catch(() => false)
}
