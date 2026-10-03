/**
 * Canvas viewer rules that must hold for every viewer, current and future.
 */

import { describe, it, expect } from 'vitest'
import { findMatches, formatMatches, listSourceFiles, readSource } from './lib/source-scan'

const RENDERER_FILES = listSourceFiles('src/renderer')
const VIEWER_FILES = listSourceFiles('src/renderer/components/canvas/viewers')
const VIEWER_COMPONENTS = VIEWER_FILES.filter((file) => file.endsWith('.tsx'))

describe('canvas viewers', () => {
  it('never give previewed documents the app origin', () => {
    // A srcdoc frame inherits the app origin unless sandboxed without
    // allow-same-origin; with it, its scripts reach the preload API and the
    // app's storage. Only a frame loaded from its own site may keep its origin.
    const offenders = RENDERER_FILES.flatMap((file) =>
      iframeElements(readSource(file))
        .filter((el) => /allow-same-origin/.test(el.text) && !/\bsrc=\{/.test(el.text))
        .map((el) => ({ file, line: el.line, text: el.text.replace(/\s+/g, ' ') }))
    )
    const programmatic = findMatches(RENDERER_FILES, /setAttribute\(\s*'sandbox'.*allow-same-origin/)
    expect([...offenders, ...programmatic], formatMatches([...offenders, ...programmatic])).toEqual([])
  })

  it('load a local HTML preview only from its own preview origin', () => {
    const viewer = readSource('src/renderer/components/canvas/viewers/HtmlViewer.tsx')
    const isolated = iframeElements(viewer).filter((el) => /\bsrc=\{/.test(el.text))
    expect(isolated).toHaveLength(1)
    expect(isolated[0].text).toMatch(/src=\{isolatedUrl\}/)
    expect(isolated[0].text).not.toMatch(/allow-top-navigation|allow-popups-to-escape-sandbox/)
  })

  it('mount one viewer instance per tab', () => {
    // Without a key, React reuses one editor across same-type tabs: switching
    // becomes an undoable whole-document replace and edit state leaks.
    const source = readSource('src/renderer/components/canvas/ContentCanvas.tsx')
    expect(source).toMatch(/<TabContent\s[^>]*key=\{\w+\.id\}/)
  })

  it('never reset state when the tab changes', () => {
    // A viewer mounts once per tab, so an effect keyed on the tab identity is
    // either dead code or a sign the viewer is being reused across tabs.
    const offenders = VIEWER_FILES.flatMap((file) =>
      effectDependencyLists(readSource(file))
        .filter((deps) => /\btab\.(id|terminalSessionId)\b/.test(deps.text))
        .map((deps) => ({ file, line: deps.line, text: deps.text }))
    )
    expect(offenders, formatMatches(offenders)).toEqual([])
  })
})


describe('viewer boundaries', () => {
  it('reach canvas state only through their tab prop, useBrowserState and useCanvasActions', () => {
    // Subscribing to the global canvas state re-renders the visible viewer for
    // every change to any tab (a hidden browser tab navigating, typing elsewhere).
    const offenders: Array<{ file: string; line: number; text: string }> = []
    for (const file of VIEWER_COMPONENTS) {
      for (const imp of importStatements(readSource(file))) {
        const fromStoreOrLifecycle = /stores\/canvas\.store|services\/canvas-lifecycle/.test(imp.from)
        const fromHooks = /hooks\/useCanvasLifecycle$/.test(imp.from)
        const allowedHookValues = imp.names.every((name) => ['useCanvasActions', 'useBrowserState'].includes(name))
        if ((fromStoreOrLifecycle && !imp.typeOnly) || (fromHooks && !imp.typeOnly && !allowedHookValues)) {
          offenders.push({ file, line: imp.line, text: imp.text })
        }
      }
    }
    expect(offenders, formatMatches(offenders)).toEqual([])
  })

  it('register every imperative resource with their resource store', () => {
    // Workers, observers, editor/terminal instances, subscriptions and object
    // URLs must be created inside `resources.add(...)` / `scope.add(...)`, so
    // unmounting the viewer releases them even when an effect forgets to.
    const created = /new (Worker|ResizeObserver|MutationObserver|IntersectionObserver|EditorView|Terminal)\b|URL\.createObjectURL|\bgetDocument\(|\bapi\.on[A-Z]\w*\(|\bsetInterval\(/
    const offenders = findMatches(VIEWER_COMPONENTS, created).filter((m) => !/\.add\(/.test(m.text))
    expect(offenders, formatMatches(offenders)).toEqual([])
  })

  it('leave error and suspense boundaries to the host', () => {
    // The host wraps every viewer in a per-tab boundary; one inside a viewer
    // would hide failures the host is meant to contain and report.
    const offenders = findMatches(VIEWER_COMPONENTS, /import .*\bErrorBoundary\b|<Suspense\b/)
    expect(offenders, formatMatches(offenders)).toEqual([])
  })
})

describe('canvas store consumers', () => {
  it('select what they use instead of subscribing to the whole store', () => {
    // `useCanvasStore()` with no selector re-renders on every canvas change.
    const offenders = findMatches(RENDERER_FILES, /\buseCanvasStore\(\s*\)/)
    expect(offenders, formatMatches(offenders)).toEqual([])
  })
})

describe('the canvas host', () => {
  it('picks viewers from the registry, not from a switch over content types', () => {
    const host = readSource('src/renderer/components/canvas/ContentCanvas.tsx')
    expect(host).not.toMatch(/switch\s*\(\s*tab\.type\s*\)/)
    expect(host).not.toMatch(/from '\.\/viewers\//)
    expect(readSource('src/renderer/components/canvas/viewer-registry.tsx')).toMatch(
      /export const VIEWERS: Record<ContentType, ViewerSpec>/
    )
  })
})

describe('third-party renderers used by viewers', () => {
  it('docx-preview carries the patch that lets a viewer revoke its blob URLs', () => {
    // patches/docx-preview+<version>.patch. A version bump that drops it
    // brings back one leaked blob per embedded image and font, per open.
    const patched = findMatches(
      ['node_modules/docx-preview/dist/docx-preview.mjs'],
      /disposeUrls\(\) \{|this\._objectUrls\.push\(url\)/
    )
    expect(patched).toHaveLength(2)
  })
})

/** The dependency array of every useEffect/useLayoutEffect call in `source`. */
function effectDependencyLists(source: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = []
  const call = /\buse(?:Layout)?Effect\(/g
  for (let match = call.exec(source); match; match = call.exec(source)) {
    let depth = 1
    let i = match.index + match[0].length
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === '(') depth++
      else if (source[i] === ')') depth--
    }
    const body = source.slice(match.index, i)
    const deps = /\[([^\[\]]*)\]\s*\)$/.exec(body)
    if (deps) out.push({ line: source.slice(0, match.index).split('\n').length, text: deps[0] })
  }
  return out
}

interface ImportStatement {
  line: number
  text: string
  from: string
  names: string[]
  typeOnly: boolean
}

/** Named imports in `source` (default and namespace imports are reported with no names). */
function importStatements(source: string): ImportStatement[] {
  const out: ImportStatement[] = []
  const pattern = /import\s+(type\s+)?([^'";]*?)\s+from\s+'([^']+)'/g
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    const clause = match[2]
    const named = /\{([^}]*)\}/.exec(clause)
    const specifiers = named ? named[1].split(',').map((n) => n.trim()).filter(Boolean) : []
    const values = specifiers.filter((n) => !n.startsWith('type '))
    const hasDefault = /^[A-Za-z_$][\w$]*\s*(,|$)/.test(clause.trim()) || clause.includes('* as')
    out.push({
      line: source.slice(0, match.index).split('\n').length,
      text: match[0].replace(/\s+/g, ' '),
      from: match[3],
      names: values.map((n) => n.split(/\s+as\s+/)[0]),
      typeOnly: Boolean(match[1]) || (values.length === 0 && !hasDefault),
    })
  }
  return out
}

/** Every `<iframe ...>` JSX element in `source`, with its start line. */
function iframeElements(source: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = []
  const pattern = /<iframe\b[\s\S]*?\/?>/g
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    out.push({ line: source.slice(0, match.index).split('\n').length, text: match[0] })
  }
  return out
}
