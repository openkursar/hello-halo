/**
 * Renders a .docx into a container and releases everything it created.
 *
 * docx-preview turns every embedded image and font into a blob: URL, which
 * lives as long as the app window unless revoked. The patched library records
 * them per document (`disposeUrls`); disposing also covers a render still in
 * flight, whose later URLs are then never created.
 */

import { parseAsync, renderDocument, type Options } from 'docx-preview'

interface DisposableDocument {
  /** Added by patches/docx-preview; absent if the installed version is unpatched. */
  disposeUrls?: () => void
}

/** Revoke a document's blob URLs; tolerates an unpatched library (leaks, but never breaks unmount). */
function releaseUrls(doc: DisposableDocument | null): void {
  if (typeof doc?.disposeUrls === 'function') doc.disposeUrls()
}

export interface DocxRender {
  /** Settles when the document is in the container (or rendering was abandoned). */
  done: Promise<void>
  dispose(): void
}

export function renderDocx(bytes: Uint8Array, container: HTMLElement, options: Partial<Options>): DocxRender {
  let disposed = false
  let doc: DisposableDocument | null = null

  const done = (async () => {
    const parsed = (await parseAsync(bytes, options)) as DisposableDocument
    doc = parsed
    if (disposed) {
      releaseUrls(parsed)
      return
    }
    const nodes = await renderDocument(parsed, options)
    if (disposed) return
    container.innerHTML = ''
    for (const node of nodes) container.appendChild(node)
  })()

  return {
    done,
    dispose() {
      if (disposed) return
      disposed = true
      releaseUrls(doc)
      container.innerHTML = ''
    },
  }
}
