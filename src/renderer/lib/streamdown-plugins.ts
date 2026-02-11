/**
 * Streamdown plugin configuration (lazy-loaded)
 *
 * Loads @streamdown/code (Shiki) asynchronously to avoid blocking
 * the module graph in Vite dev mode. The plugin initializes on first
 * use and caches the result for subsequent renders.
 */

import { useState, useEffect } from 'react'
import type { CodeHighlighterPlugin } from 'streamdown'

let cachedPlugin: CodeHighlighterPlugin | null = null
let loadPromise: Promise<CodeHighlighterPlugin> | null = null

function loadCodePlugin(): Promise<CodeHighlighterPlugin> {
  if (!loadPromise) {
    loadPromise = import('@streamdown/code').then(m => {
      cachedPlugin = m.code
      return m.code
    })
  }
  return loadPromise
}

/**
 * Hook that returns the Shiki code highlighter plugin.
 * Returns undefined until the plugin is loaded, then the cached instance.
 */
export function useCodePlugin(): CodeHighlighterPlugin | undefined {
  const [plugin, setPlugin] = useState<CodeHighlighterPlugin | undefined>(cachedPlugin ?? undefined)

  useEffect(() => {
    if (cachedPlugin) {
      setPlugin(cachedPlugin)
      return
    }
    loadCodePlugin().then(setPlugin)
  }, [])

  return plugin
}
