/**
 * Lazy Highlight.js Loader
 *
 * Loads highlight.js core and language definitions on-demand.
 * Instead of loading all 190+ languages (1.5MB), we only load:
 * 1. Core library (~50KB)
 * 2. Common languages bundle (~100KB)
 * 3. Additional languages as needed
 *
 * This reduces initial load from 1.5MB to ~150KB for common cases.
 */

import hljs from 'highlight.js/lib/core'

// Common languages - loaded immediately with core
// These cover ~90% of code in typical AI conversations
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import python from 'highlight.js/lib/languages/python'
import json from 'highlight.js/lib/languages/json'
import bash from 'highlight.js/lib/languages/bash'
import shell from 'highlight.js/lib/languages/shell'
import css from 'highlight.js/lib/languages/css'
import xml from 'highlight.js/lib/languages/xml' // Also covers HTML
import markdown from 'highlight.js/lib/languages/markdown'
import yaml from 'highlight.js/lib/languages/yaml'
import sql from 'highlight.js/lib/languages/sql'

// Register common languages
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('js', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('ts', typescript)
hljs.registerLanguage('python', python)
hljs.registerLanguage('py', python)
hljs.registerLanguage('json', json)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('sh', bash)
hljs.registerLanguage('shell', shell)
hljs.registerLanguage('css', css)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('html', xml)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('md', markdown)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('yml', yaml)
hljs.registerLanguage('sql', sql)

// Language loader cache - prevent duplicate loading
const loadingLanguages = new Map<string, Promise<void>>()
const loadedLanguages = new Set<string>([
  'javascript', 'js', 'typescript', 'ts', 'python', 'py',
  'json', 'bash', 'sh', 'shell', 'css', 'xml', 'html',
  'markdown', 'md', 'yaml', 'yml', 'sql'
])

// Language to module mapping for dynamic imports
const languageModules: Record<string, () => Promise<{ default: any }>> = {
  // Systems programming
  rust: () => import('highlight.js/lib/languages/rust'),
  go: () => import('highlight.js/lib/languages/go'),
  c: () => import('highlight.js/lib/languages/c'),
  cpp: () => import('highlight.js/lib/languages/cpp'),
  java: () => import('highlight.js/lib/languages/java'),
  kotlin: () => import('highlight.js/lib/languages/kotlin'),
  swift: () => import('highlight.js/lib/languages/swift'),
  csharp: () => import('highlight.js/lib/languages/csharp'),

  // Web & scripting
  php: () => import('highlight.js/lib/languages/php'),
  ruby: () => import('highlight.js/lib/languages/ruby'),
  perl: () => import('highlight.js/lib/languages/perl'),
  lua: () => import('highlight.js/lib/languages/lua'),
  r: () => import('highlight.js/lib/languages/r'),
  scala: () => import('highlight.js/lib/languages/scala'),

  // Frontend
  jsx: () => import('highlight.js/lib/languages/javascript'),
  tsx: () => import('highlight.js/lib/languages/typescript'),
  scss: () => import('highlight.js/lib/languages/scss'),
  less: () => import('highlight.js/lib/languages/less'),

  // Config & data
  toml: () => import('highlight.js/lib/languages/ini'),
  ini: () => import('highlight.js/lib/languages/ini'),
  dockerfile: () => import('highlight.js/lib/languages/dockerfile'),
  nginx: () => import('highlight.js/lib/languages/nginx'),
  makefile: () => import('highlight.js/lib/languages/makefile'),
  cmake: () => import('highlight.js/lib/languages/cmake'),

  // Other
  diff: () => import('highlight.js/lib/languages/diff'),
  graphql: () => import('highlight.js/lib/languages/graphql'),
  wasm: () => import('highlight.js/lib/languages/wasm'),
  protobuf: () => import('highlight.js/lib/languages/protobuf'),
  latex: () => import('highlight.js/lib/languages/latex'),
  tex: () => import('highlight.js/lib/languages/latex'),
}

// Alias mapping
const languageAliases: Record<string, string> = {
  'c++': 'cpp',
  'c#': 'csharp',
  'objective-c': 'objectivec',
  'objc': 'objectivec',
}

/**
 * Load a language dynamically if not already loaded
 */
async function loadLanguage(lang: string): Promise<boolean> {
  const normalizedLang = lang.toLowerCase()
  const resolvedLang = languageAliases[normalizedLang] || normalizedLang

  // Already loaded
  if (loadedLanguages.has(resolvedLang)) {
    return true
  }

  // Already loading
  if (loadingLanguages.has(resolvedLang)) {
    await loadingLanguages.get(resolvedLang)
    return loadedLanguages.has(resolvedLang)
  }

  // Check if we have a loader for this language
  const loader = languageModules[resolvedLang]
  if (!loader) {
    return false
  }

  // Start loading
  const loadPromise = (async () => {
    try {
      const module = await loader()
      hljs.registerLanguage(resolvedLang, module.default)
      loadedLanguages.add(resolvedLang)

      // Also register the original name if different
      if (normalizedLang !== resolvedLang) {
        loadedLanguages.add(normalizedLang)
      }
    } catch (err) {
      console.warn(`[highlight-loader] Failed to load language: ${resolvedLang}`, err)
    }
  })()

  loadingLanguages.set(resolvedLang, loadPromise)
  await loadPromise
  loadingLanguages.delete(resolvedLang)

  return loadedLanguages.has(resolvedLang)
}

/**
 * Highlight code with automatic language loading
 */
export async function highlightCode(code: string, language?: string): Promise<string> {
  if (!code) return ''

  try {
    if (language) {
      const normalizedLang = language.toLowerCase()

      // Try to load the language if not available
      if (!hljs.getLanguage(normalizedLang)) {
        await loadLanguage(normalizedLang)
      }

      // Check again after loading attempt
      if (hljs.getLanguage(normalizedLang)) {
        return hljs.highlight(code, { language: normalizedLang }).value
      }
    }

    // Fallback to auto-detection (only uses loaded languages)
    return hljs.highlightAuto(code).value
  } catch (err) {
    console.error('[highlight-loader] Highlight error:', err)
    return escapeHtml(code)
  }
}

/**
 * Synchronous highlight - only works for already-loaded languages
 * Falls back to plain text if language not loaded
 */
export function highlightCodeSync(code: string, language?: string): string {
  if (!code) return ''

  try {
    if (language) {
      const normalizedLang = language.toLowerCase()
      if (hljs.getLanguage(normalizedLang)) {
        return hljs.highlight(code, { language: normalizedLang }).value
      }

      // Trigger async load for next time
      loadLanguage(normalizedLang).catch(() => {})
    }

    // Auto-detect with loaded languages
    return hljs.highlightAuto(code).value
  } catch (err) {
    return escapeHtml(code)
  }
}

/**
 * Check if a language is loaded
 */
export function isLanguageLoaded(language: string): boolean {
  return loadedLanguages.has(language.toLowerCase())
}

/**
 * Get the hljs instance for direct use (e.g., with rehype-highlight)
 */
export { hljs }

/**
 * Escape HTML special characters
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}
