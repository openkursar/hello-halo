/**
 * Canvas Lifecycle Manager - Centralized BrowserView and Tab Management
 *
 * This class manages the lifecycle of BrowserViews and Canvas tabs in an
 * imperative, predictable manner. It replaces the complex useEffect-based
 * lifecycle management that was prone to race conditions and timing issues.
 *
 * Key responsibilities:
 * - Tab creation, switching, closing, and reordering
 * - BrowserView creation, showing, hiding, and destruction
 * - State synchronization with React via callbacks
 *
 * Content types and rendering:
 * - code/markdown/json/csv/text: Load content via IPC, render in React
 * - image: Use halo-file:// protocol (bypasses CSP in renderer)
 * - pdf: Use BrowserView with file:// (BrowserView has no cross-origin restrictions)
 * - browser: Use BrowserView with https:// URLs
 *
 * Protocol: halo-file://
 * - Custom protocol registered in main process (protocol.service.ts)
 * - Used by <img> tags in renderer to bypass CSP restrictions
 * - NOT used for BrowserView (BrowserView can access file:// directly)
 *
 * Design principles:
 * - Single source of truth for tab and view state
 * - Imperative control flow (no React side effects)
 * - React only handles UI rendering and event triggering
 */

import { api } from '../api'
import i18n from '../i18n'
import { isBinaryExtension } from '../constants/file-types'
import type { ArtifactChangeBatchEvent } from '../../shared/types/artifact'
import type { MemoryPressureLevel } from '../../shared/types/memory-pressure'
import {
  HIDDEN_CONTENT_BUDGET_BYTES,
  MAX_LIVE_BROWSER_VIEWS,
  MAX_OPEN_TABS,
} from '../../shared/constants/canvas-budget'
import { planCanvasBudget, type CanvasBudgetLimits } from './canvas-budget'
import { holdArtifactSpace } from './artifact-space-holds'

// ============================================
// Types
// ============================================

/** What the tab list renders; a change to any other field is not the list's business. */
const TAB_LIST_FIELDS = ['type', 'title', 'path', 'url', 'isDirty', 'isLoading', 'error'] as const

/** Tab types whose viewer parses raw bytes rather than text (see TabState.bytes). */
const DOCUMENT_TYPES = new Set(['xlsx', 'docx', 'pdf'])

export const CONTENT_TYPES = [
  'code',
  'markdown',
  'html',
  'image',
  'pdf',
  'text',
  'json',
  'csv',
  'xlsx',
  'docx',
  'pptx',
  'browser',
  'terminal',
  'team',
  'goal',
] as const

export type ContentType = (typeof CONTENT_TYPES)[number]

export function isContentType(value: unknown): value is ContentType {
  return (CONTENT_TYPES as readonly unknown[]).includes(value)
}

export interface BrowserState {
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  favicon?: string
  zoomLevel?: number
  deviceMode?: 'pc' | 'h5'
  error?: string
  blockedByPolicy?: boolean
  /** Exact URL that was blocked by browser policy — target of "allow and retry". */
  blockedUrl?: string
}

/**
 * Per-tab view memory a viewer writes as the user moves around (scroll offset)
 * and reads back when it mounts again. Mutable on purpose and never notified:
 * nothing renders from it, and every snapshot of a tab points at the same
 * object, so a remounting viewer always reads the latest value.
 */
export interface TabViewState {
  scrollPosition?: number
}

/**
 * One open tab. Immutable: every change replaces the object, so identity
 * tells subscribers (and React memoization) whether anything changed.
 */
export interface TabState {
  id: string
  type: ContentType
  title: string
  path?: string
  url?: string
  content?: string
  /**
   * Raw file bytes for the document viewers (xlsx/docx/pdf), filled instead of
   * `content` — those parsers want bytes, and base64 in `content` would cost a
   * main-thread decode per tab. Released with the tab on close.
   */
  bytes?: Uint8Array
  language?: string
  mimeType?: string
  isDirty: boolean
  /**
   * The file's text on disk as last seen while the tab has unsaved edits —
   * what a revert restores and what an on-disk change is compared against.
   * Held only while dirty.
   */
  savedContent?: string
  /** The file changed on disk while the tab had unsaved edits; the user picks a side. */
  diskConflict?: boolean
  /** Content dropped to stay within the canvas budget; re-read when the tab is shown. */
  contentUnloaded?: boolean
  isLoading: boolean
  error?: string
  /** Shared by every snapshot of the tab; see TabViewState. */
  view: TabViewState
  browserViewId?: string
  browserState?: BrowserState
  isEditMode?: boolean // For markdown tabs - switches between preview and editor
  terminalSessionId?: string // For terminal tabs - the pty session id
  /** Persistent Halo team rendered by the Team workbench. */
  teamId?: string
  /** Conversation whose goal the goal editor edits. */
  goal?: { spaceId: string; conversationId: string }
  /**
   * Whether the Canvas owns the BrowserView's lifecycle.
   * true  — created via createBrowserView (openUrl/openPdf): destroy on close.
   * false — attached via attachAIBrowserView: the AI drives a single view whose
   *         WebContents outlives any tab, so closing detaches rather than
   *         destroys. Destroying it would end the AI's live browser session.
   */
  browserViewOwned?: boolean
}

// Callback types
/** A tab as its opener describes it; the lifecycle adds the view memory. */
type NewTab = Omit<TabState, 'view'>

type TabListChangeCallback = (tabs: readonly TabState[]) => void
type TabChangeCallback = (tab: TabState) => void
type BudgetEvictionCallback = (event: { closedTabs: number; limit: number }) => void
type ActiveTabChangeCallback = (tabId: string | null) => void
type BrowserStateChangeCallback = (tabId: string, state: BrowserState) => void
type OpenStateChangeCallback = (isOpen: boolean) => void

// ============================================
// Utility Functions
// ============================================

/**
 * Detect content type from file extension
 */
function detectContentType(path: string): { type: ContentType; language?: string; needsBackendDetection?: boolean } {
  const ext = path.split('.').pop()?.toLowerCase() || ''
  const filename = path.split('/').pop()?.toLowerCase() || ''

  // Special filenames without extensions
  const specialFiles: Record<string, string> = {
    dockerfile: 'dockerfile',
    makefile: 'makefile',
    gemfile: 'ruby',
    rakefile: 'ruby',
    podfile: 'ruby',
    vagrantfile: 'ruby',
    jenkinsfile: 'groovy',
    '.gitignore': 'gitignore',
    '.dockerignore': 'gitignore',
    '.editorconfig': 'ini',
    '.env': 'shell',
    '.env.local': 'shell',
    '.env.development': 'shell',
    '.env.production': 'shell',
  }

  if (specialFiles[filename]) {
    return { type: 'code', language: specialFiles[filename] }
  }

  const codeExtensions: Record<string, string> = {
    // JavaScript/TypeScript
    js: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    mjs: 'javascript',
    cjs: 'javascript',

    // Web frameworks
    vue: 'vue',
    svelte: 'svelte',

    // Systems programming
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    cs: 'csharp',
    swift: 'swift',
    kt: 'kotlin',
    kts: 'kotlin',
    scala: 'scala',
    dart: 'dart',
    m: 'objectivec', // Objective-C
    mm: 'objectivec',
    d: 'd',
    cr: 'crystal', // Crystal

    // Scripting
    php: 'php',
    lua: 'lua',
    pl: 'perl',
    pm: 'perl',
    r: 'r',
    R: 'r',
    rmd: 'r',
    hs: 'haskell',
    tcl: 'tcl',

    // Shell & PowerShell
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    ps1: 'powershell',
    psm1: 'powershell',
    psd1: 'powershell',

    // Data & Config
    sql: 'sql',
    yaml: 'yaml',
    yml: 'yaml',
    xml: 'xml',
    toml: 'toml',
    ini: 'ini',
    conf: 'ini',
    properties: 'properties',
    proto: 'protobuf',

    // Functional languages
    clj: 'clojure',
    cljs: 'clojure',
    cljc: 'clojure',
    edn: 'clojure',
    erl: 'erlang',
    hrl: 'erlang',
    ex: 'elixir',
    exs: 'elixir',
    elm: 'elm',

    // ML-like languages
    fs: 'fsharp',
    fsi: 'fsharp',
    fsx: 'fsharp',
    ml: 'ocaml',
    mli: 'ocaml',
    sml: 'sml',

    // Scientific computing
    jl: 'julia',
    f: 'fortran',
    f90: 'fortran',
    f95: 'fortran',
    for: 'fortran',

    // Pascal/Delphi
    pas: 'pascal',
    dpr: 'pascal',

    // Visual Basic
    vb: 'vb',
    vbs: 'vbscript',
    bas: 'vb',

    // Lisp/Scheme
    scm: 'scheme',
    rkt: 'scheme',
    lisp: 'lisp',
    lsp: 'lisp',
    cl: 'lisp',

    // CSS preprocessors & templates
    sass: 'sass',
    styl: 'stylus',
    pug: 'pug',
    jade: 'pug',

    // Alt-JS
    coffee: 'coffeescript',

    // Hardware description
    v: 'verilog',
    sv: 'verilog',
    vhd: 'vhdl',
    vhdl: 'vhdl',

    // DevOps
    pp: 'puppet',
    nsh: 'nsis',

    // Other
    diff: 'diff',
    patch: 'diff',
    dockerfile: 'dockerfile',
    groovy: 'groovy',

    // Lock files (JSON/YAML-like)
    lock: 'json', // package-lock.json, yarn.lock, etc.
  }

  if (codeExtensions[ext]) {
    return { type: 'code', language: codeExtensions[ext] }
  }

  switch (ext) {
    case 'md':
    case 'markdown':
      return { type: 'markdown', language: 'markdown' }
    case 'html':
    case 'htm':
      return { type: 'html', language: 'html' }
    case 'css':
    case 'scss':
    case 'less':
      return { type: 'code', language: 'css' }
    case 'json':
      return { type: 'json', language: 'json' }
    case 'csv':
      return { type: 'csv' }
    case 'xlsx':
    case 'xls':
      return { type: 'xlsx' }
    case 'docx':
      return { type: 'docx' }
    case 'pptx':
      return { type: 'pptx' }
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
    case 'svg':
    case 'ico':
    case 'bmp':
      return { type: 'image' }
    case 'pdf':
      return { type: 'pdf' }
    case 'txt':
    case 'log':
    case 'env':
      return { type: 'text' }
    default:
      // Unknown extension - needs backend detection for binary vs text
      return { type: 'text', needsBackendDetection: true }
  }
}

/**
 * Generate a unique tab ID
 */
function generateTabId(): string {
  return `tab-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
}

/**
 * Extract filename from path
 */
function getFileName(path: string): string {
  return path.split('/').pop() || path
}

// ============================================
// CanvasLifecycle Class
// ============================================

class CanvasLifecycle {
  // Core state
  private tabs: Map<string, TabState> = new Map()
  private activeTabId: string | null = null
  private isOpen: boolean = false
  private isTransitioning: boolean = false

  // Track which space the current tabs belong to
  private currentSpaceId: string | null = null
  /**
   * Keeps the space's watcher alive while a tab shows one of its files, so
   * open files refresh and detect disk conflicts even with the file tree closed.
   */
  private spaceHold: { spaceId: string; release: () => void } | null = null

  // Container bounds getter (set by BrowserViewer)
  private containerBoundsGetter: (() => DOMRect | null) | null = null

  // IPC listener cleanup
  private browserStateUnsubscribe: (() => void) | null = null
  private artifactChangedUnsubscribe: (() => void) | null = null
  private memoryPressureUnsubscribe: (() => void) | null = null

  private memoryPressure: MemoryPressureLevel = 'normal'
  private applyingBudgets = false
  /** A budget pass was asked for while one was running; run again when it ends. */
  private budgetsDirty = false
  /** Makes each created view id unique, so a replacement never collides with one still being destroyed. */
  private viewGeneration = 0
  /** Tab id -> its BrowserView creation in flight; at most one per tab. */
  private creatingViews = new Map<string, Promise<void>>()
  private budgetEvictionCallbacks: Set<BudgetEvictionCallback> = new Set()

  /** Tab id -> activation sequence number; larger = used more recently. */
  private lastActivated = new Map<string, number>()
  private activationSeq = 0

  /** Cached `getTabs()` result; cleared by any change. */
  private tabsSnapshot: readonly TabState[] | null = null
  /** The tabs as of the last tab-list notification (see getTabListSnapshot). */
  private tabListSnapshot: readonly TabState[] = []

  // Callback subscriptions
  private tabListChangeCallbacks: Set<TabListChangeCallback> = new Set()
  private tabChangeCallbacks: Set<TabChangeCallback> = new Set()
  private activeTabChangeCallbacks: Set<ActiveTabChangeCallback> = new Set()
  private browserStateChangeCallbacks: Set<BrowserStateChangeCallback> = new Set()
  private openStateChangeCallbacks: Set<OpenStateChangeCallback> = new Set()

  /**
   * Policy for disposing a terminal's pty when its tab goes away. This manager
   * owns tabs, not ptys, so it delegates the pty decision to the terminal domain
   * (which can read session state and prompt the user):
   *  - `confirmSingleClose` — a deliberate single-tab close: prompt keep vs
   *    terminate for an AI-operated session, resolve false to cancel the close.
   *  - `disposeOnBulkClose` — a non-interactive bulk teardown (closeAll / space
   *    switch): silently terminate the user's own terminals, keep AI-operated
   *    ones alive (they remain reachable in the live-sessions tray).
   * Absent a policy (host not mounted) tabs are removed and ptys left running —
   * the pre-existing decoupled behavior.
   */
  private terminalClosePolicy: {
    confirmSingleClose: (sessionId: string) => Promise<boolean>
    disposeOnBulkClose: (sessionId: string) => Promise<void>
  } | null = null

  /**
   * Content type -> prompt shown before a user closes a tab of that type with
   * unsaved changes. Registered by the domain that owns the editor; it resolves
   * false to keep the tab open. Types with no guard close without asking.
   */
  private dirtyCloseGuards = new Map<ContentType, (tab: TabState) => Promise<boolean>>()

  /** Content type -> reload for tabs whose content is neither a file nor a view. */
  private refreshHandlers = new Map<ContentType, (tab: TabState) => Promise<void>>()

  // ============================================
  // Initialization
  // ============================================

  // Track if already initialized
  private initialized: boolean = false

  /**
   * Initialize IPC listeners for browser state changes
   * Safe to call multiple times - will only initialize once
   */
  initialize(): void {
    if (this.initialized) {
      console.log('[CanvasLifecycle] Already initialized, skipping...')
      return
    }

    console.log('[CanvasLifecycle] Initializing...')
    this.initialized = true

    // Listen for browser state changes from main process
    this.browserStateUnsubscribe = api.onBrowserStateChange((data: unknown) => {
      const event = data as { viewId: string; state: BrowserState & { url?: string; title?: string } }

      for (const [tabId, tab] of this.tabs) {
        if (tab.browserViewId === event.viewId) {
          const browserState: BrowserState = {
            isLoading: event.state.isLoading,
            canGoBack: event.state.canGoBack,
            canGoForward: event.state.canGoForward,
            favicon: event.state.favicon,
            zoomLevel: event.state.zoomLevel,
            deviceMode: event.state.deviceMode,
            error: event.state.error,
            blockedByPolicy: event.state.blockedByPolicy,
            blockedUrl: event.state.blockedUrl,
          }
          // The tab list hears about this only when a field it shows changed
          // (title, loading, error) — a page's own churn stays on the
          // browser-state channel its viewer subscribes to.
          this.patchTab(tabId, {
            browserState,
            url: event.state.url || tab.url,
            title: event.state.title || tab.title,
            isLoading: event.state.isLoading ?? tab.isLoading,
            // Sync error to tab level (e.g. browser policy block during navigation)
            error: event.state.error,
          })
          this.notifyBrowserStateChange(tabId, browserState)
          break
        }
      }
    })

    this.artifactChangedUnsubscribe = api.onArtifactChangedBatch((batch) => this.handleArtifactChanges(batch))

    this.memoryPressureUnsubscribe = api.onMemoryPressure(({ level }) => this.setMemoryPressure(level))
    // The event only reports changes; a reloaded renderer asks for the current level.
    void api.getMemoryPressure().then(level => this.setMemoryPressure(level))

    console.log('[CanvasLifecycle] Initialized successfully')
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    console.log('[CanvasLifecycle] Destroying...')

    if (this.browserStateUnsubscribe) {
      this.browserStateUnsubscribe()
      this.browserStateUnsubscribe = null
    }

    if (this.artifactChangedUnsubscribe) {
      this.artifactChangedUnsubscribe()
      this.artifactChangedUnsubscribe = null
    }

    this.memoryPressureUnsubscribe?.()
    this.memoryPressureUnsubscribe = null

    // Destroy all browser views
    this.closeAll()
    this.spaceHold?.release()
    this.spaceHold = null

    console.log('[CanvasLifecycle] Destroyed')
  }

  /**
   * Set the container bounds getter function
   * Called by BrowserViewer to provide DOM reference
   */
  setContainerBoundsGetter(getter: () => DOMRect | null): void {
    this.containerBoundsGetter = getter
  }

  // ============================================
  // Tab Management
  // ============================================

  /**
   * Open a file in the canvas
   * Uses fast path for known extensions, backend detection for unknown ones
   */
  async openFile(path: string, title?: string): Promise<string> {
    // Check if file is already open
    for (const [tabId, tab] of this.tabs) {
      if (tab.path === path) {
        this.setOpen(true)
        await this.switchTab(tabId)
        return tabId
      }
    }

    const ext = path.split('.').pop()?.toLowerCase() || ''

    // Fast path: known binary extensions - open with system app
    if (isBinaryExtension(ext)) {
      console.log(`[CanvasLifecycle] Known binary extension: ${ext}, opening with system`)
      await api.openArtifact(path)
      return ''
    }

    // Detect content type from extension
    let { type, language, needsBackendDetection } = detectContentType(path)

    // For unknown extensions, use backend detection
    if (needsBackendDetection) {
      console.log(`[CanvasLifecycle] Unknown extension: ${ext}, using backend detection`)
      try {
        const response = await api.detectFileType(path)
        if (response.success && response.data) {
          const info = response.data
          console.log(`[CanvasLifecycle] Backend detection result:`, info)

          // If backend says it's binary, open with system app
          if (!info.canViewInCanvas) {
            console.log(`[CanvasLifecycle] File is binary, opening with system`)
            await api.openArtifact(path)
            return ''
          }

          // A type this renderer has no viewer for (e.g. from a newer main
          // process) opens as plain text rather than as a blank pane.
          type = isContentType(info.contentType) ? info.contentType : 'text'
          language = info.language
        }
      } catch (error) {
        console.warn(`[CanvasLifecycle] Backend detection failed, falling back to text:`, error)
        // Fall back to text type on error
      }
    }

    // PDF files are opened via BrowserView (Chromium native PDF renderer) on
    // desktop. Remote clients have no BrowserView — fall through to a content
    // tab whose base64 bytes are rendered by the pdfjs-based PdfViewer.
    if (type === 'pdf' && !api.isRemoteMode()) {
      return this.openPdf(path, title)
    }

    // Create new tab
    const tabId = generateTabId()
    const tab: NewTab = {
      id: tabId,
      type,
      title: title || getFileName(path),
      path,
      language,
      isDirty: false,
      isLoading: true,
    }

    this.addTab(tab)

    // Switch to new tab
    await this.switchTab(tabId)

    // Load content (async)
    this.loadFileContent(tabId, path, type)

    return tabId
  }

  /**
   * Open a PDF file using BrowserView (Chromium native PDF renderer)
   * Note: BrowserView can access file:// directly, no need for halo-file://
   */
  private async openPdf(path: string, title?: string): Promise<string> {
    const tabId = generateTabId()
    // BrowserView has no cross-origin restrictions, use file:// directly
    // Encode path to handle non-ASCII characters and spaces
    const pdfUrl = `file://${encodeURI(path)}`

    const tab: NewTab = {
      id: tabId,
      type: 'pdf',
      title: title || getFileName(path),
      path,
      url: pdfUrl,
      isDirty: false,
      isLoading: true,
      browserState: {
        isLoading: true,
        canGoBack: false,
        canGoForward: false,
      },
    }

    this.addTab(tab)

    // Switch to new tab (this will create the BrowserView)
    await this.switchTab(tabId)

    return tabId
  }

  /**
   * Documents take the bytes channel; everything else takes the text/base64
   * one. Splitting here rather than in the viewers keeps every tab holding
   * exactly one representation of its file.
   */
  private async loadFileContent(tabId: string, path: string, type: ContentType): Promise<void> {
    const tab = this.tabs.get(tabId)
    if (!tab) return

    // Images use halo-file:// protocol directly (no content loading needed).
    // pptx has no in-canvas renderer, so its placeholder needs no bytes either.
    if (type === 'image' || type === 'pptx') {
      this.patchTab(tabId, { isLoading: false })
      return
    }

    try {
      if (DOCUMENT_TYPES.has(type)) {
        const response = await api.readArtifactBytes(path)
        if (!this.tabs.has(tabId)) return
        if (!response.success || !response.data) {
          throw new Error(response.error || 'Failed to read file')
        }
        this.patchTab(tabId, { bytes: response.data, isLoading: false, error: undefined })
        return
      }

      const response = await api.readArtifactContent(path)

      // Tab might have been closed during async operation
      const current = this.tabs.get(tabId)
      if (!current) return

      if (response.success && response.data) {
        const data = response.data as { content: string; mimeType?: string }
        if (current.isDirty) {
          // The user started editing while this read was in flight.
          if (data.content !== current.savedContent) {
            this.patchTab(tabId, { savedContent: data.content, diskConflict: true })
          }
          return
        }
        this.patchTab(tabId, { content: data.content, mimeType: data.mimeType, isLoading: false, error: undefined })
      } else {
        throw new Error(response.error || 'Failed to read file')
      }
    } catch (error) {
      this.patchTab(tabId, { isLoading: false, error: (error as Error).message })
    }
  }

  /**
   * Open a URL in embedded browser
   */
  async openUrl(url: string, title?: string): Promise<string> {
    // Check if URL is already open (skip dedup for about:blank — new tabs)
    if (url !== 'about:blank') {
      for (const [tabId, tab] of this.tabs) {
        if (tab.type === 'browser' && tab.url === url) {
          this.setOpen(true)
          await this.switchTab(tabId)
          return tabId
        }
      }
    }

    // Parse URL to get hostname for title
    let displayTitle = title
    if (!displayTitle) {
      try {
        displayTitle = new URL(url).hostname
      } catch {
        displayTitle = url.substring(0, 30)
      }
    }

    // Create browser tab
    // Only show loading for real HTTP(S) URLs — about:blank / file: load instantly
    const needsLoading = url.startsWith('http://') || url.startsWith('https://')
    const tabId = generateTabId()
    const tab: NewTab = {
      id: tabId,
      type: 'browser',
      title: displayTitle,
      url,
      isDirty: false,
      isLoading: needsLoading,
      browserState: {
        isLoading: needsLoading,
        canGoBack: false,
        canGoForward: false,
      },
    }

    this.addTab(tab)

    // Switch to new tab (this will create the BrowserView)
    await this.switchTab(tabId)

    return tabId
  }

  /**
   * Attach an existing AI Browser BrowserView to the Canvas
   */
  async attachAIBrowserView(viewId: string, url: string, title?: string): Promise<string> {
    // Check if this view is already attached
    for (const [tabId, tab] of this.tabs) {
      if (tab.browserViewId === viewId) {
        this.setOpen(true)
        await this.switchTab(tabId)
        return tabId
      }
    }

    // Parse URL for title
    let displayTitle = title || '🤖 AI Browser'
    if (!title) {
      try {
        displayTitle = `🤖 ${new URL(url).hostname}`
      } catch {
        // Keep default
      }
    }

    // Create tab with existing browserViewId
    const tabId = generateTabId()
    const tab: NewTab = {
      id: tabId,
      type: 'browser',
      title: displayTitle,
      url,
      isDirty: false,
      isLoading: false, // Already loaded by AI
      browserViewId: viewId, // Reference to existing view
      browserViewOwned: false, // AI-driven view — detach on close, do not destroy
      browserState: {
        isLoading: false,
        canGoBack: false,
        canGoForward: false,
      },
    }

    this.addTab(tab)

    // Switch to new tab (will show existing view)
    await this.switchTab(tabId)

    return tabId
  }

  /**
   * Open a terminal session in the canvas. Terminal tabs render in React
   * (TerminalViewer) — no BrowserView. Dedups by session id.
   */
  async openTerminal(sessionId: string, title?: string): Promise<string> {
    for (const [tabId, tab] of this.tabs) {
      if (tab.type === 'terminal' && tab.terminalSessionId === sessionId) {
        this.setOpen(true)
        await this.switchTab(tabId)
        return tabId
      }
    }

    const tabId = generateTabId()
    const tab: NewTab = {
      id: tabId,
      type: 'terminal',
      title: title || 'Terminal',
      terminalSessionId: sessionId,
      isDirty: false,
      isLoading: false,
    }

    this.addTab(tab)
    await this.switchTab(tabId)
    return tabId
  }

  /** Open the existing Team workbench inside the Content Canvas. */
  async openTeam(teamId: string, title?: string): Promise<string> {
    for (const [tabId, tab] of this.tabs) {
      if (tab.type === 'team' && tab.teamId === teamId) {
        this.setOpen(true)
        await this.switchTab(tabId)
        return tabId
      }
    }

    const tabId = generateTabId()
    const tab: NewTab = {
      id: tabId,
      type: 'team',
      title: title || i18n.t('Team'),
      teamId,
      isDirty: false,
      isLoading: false,
    }

    this.addTab(tab)
    await this.switchTab(tabId)
    return tabId
  }

  /** Open the goal editor for a conversation, reusing its tab if one is open. */
  async openGoal(spaceId: string, conversationId: string): Promise<string> {
    for (const [tabId, tab] of this.tabs) {
      if (tab.type === 'goal' && tab.goal?.conversationId === conversationId) {
        this.setOpen(true)
        await this.switchTab(tabId)
        return tabId
      }
    }

    const tabId = generateTabId()
    const tab: NewTab = {
      id: tabId,
      type: 'goal',
      title: i18n.t('Goal'),
      goal: { spaceId, conversationId },
      isDirty: false,
      isLoading: false,
    }

    this.addTab(tab)
    await this.switchTab(tabId)
    return tabId
  }

  /** Rename a tab, e.g. when what it shows is renamed elsewhere. */
  setTabTitle(tabId: string, title: string): void {
    if (this.tabs.get(tabId)?.title === title) return
    this.patchTab(tabId, { title })
  }

  /** Update a terminal tab's title (from lifecycle title events). */
  setTerminalTitle(sessionId: string, title: string): void {
    for (const [, tab] of this.tabs) {
      if (tab.type === 'terminal' && tab.terminalSessionId === sessionId) {
        this.patchTab(tab.id, { title })
        break
      }
    }
  }

  /**
   * Open content directly (for dynamically generated content)
   */
  async openContent(
    content: string,
    title: string,
    type: ContentType,
    language?: string
  ): Promise<string> {
    const tabId = generateTabId()
    const tab: NewTab = {
      id: tabId,
      type,
      title,
      content,
      language,
      isDirty: false,
      isLoading: false,
    }

    this.addTab(tab)

    await this.switchTab(tabId)

    return tabId
  }

  /**
   * Register the terminal close policy. Returns an unsubscribe function.
   * Provided by TerminalCloseGuard, which can read session state and prompt the
   * user. Only one policy is active at a time.
   */
  setTerminalClosePolicy(policy: {
    confirmSingleClose: (sessionId: string) => Promise<boolean>
    disposeOnBulkClose: (sessionId: string) => Promise<void>
  }): () => void {
    this.terminalClosePolicy = policy
    return () => {
      if (this.terminalClosePolicy === policy) this.terminalClosePolicy = null
    }
  }

  /**
   * Register the prompt asked before a dirty tab of `type` is closed by the
   * user, one tab at a time or all at once. Returns an unsubscribe function.
   * Space-switch teardown never asks.
   */
  setDirtyCloseGuard(type: ContentType, guard: (tab: TabState) => Promise<boolean>): () => void {
    this.dirtyCloseGuards.set(type, guard)
    return () => {
      if (this.dirtyCloseGuards.get(type) === guard) this.dirtyCloseGuards.delete(type)
    }
  }

  /**
   * Close the tabs showing an AI-attached view that no longer exists (its
   * session ended). Owned views are the Canvas's own to close; only attached
   * ones can vanish underneath their tab.
   */
  async closeTabsOfGoneView(viewId: string): Promise<void> {
    const stale = [...this.tabs.values()].filter(tab => tab.browserViewId === viewId && !tab.browserViewOwned)
    for (const tab of stale) await this.closeTab(tab.id)
  }

  /**
   * Close a tab
   */
  async closeTab(tabId: string): Promise<void> {
    const tab = this.tabs.get(tabId)
    if (!tab) return

    const dirtyGuard = tab.isDirty ? this.dirtyCloseGuards.get(tab.type) : undefined
    if (dirtyGuard && !(await dirtyGuard(tab))) {
      console.log(`[CanvasLifecycle] Close of dirty tab ${tabId} cancelled by user`)
      return
    }

    console.log(`[CanvasLifecycle] Closing tab: ${tabId}`)

    // Terminal tabs: defer to the close policy for the underlying pty (keep in
    // background / terminate / cancel). A cancel aborts the whole close.
    if (tab.type === 'terminal' && tab.terminalSessionId && this.terminalClosePolicy) {
      const proceed = await this.terminalClosePolicy.confirmSingleClose(tab.terminalSessionId)
      if (!proceed) return
    }

    // Tear the tab's view down per ownership: an AI-attached view is only
    // hidden, so the session it belongs to survives losing its tab.
    const hasBrowserView = (tab.type === 'browser' || tab.type === 'pdf') && tab.browserViewId
    if (hasBrowserView) {
      await this.releaseBrowserView(tab)
    }

    // Remove tab
    this.tabs.delete(tabId)
    this.tabsSnapshot = null
    this.lastActivated.delete(tabId)

    // If closing active tab, switch to another tab
    if (this.activeTabId === tabId) {
      const remainingTabs = Array.from(this.tabs.keys())
      if (remainingTabs.length > 0) {
        await this.switchTab(remainingTabs[remainingTabs.length - 1])
      } else {
        this.activeTabId = null
        this.setOpen(false)
        this.notifyActiveTabChange()
      }
    }

    this.notifyTabListChange()
  }

  /** Register how tabs of `type` reload on Refresh. Returns an unsubscribe function. */
  setRefreshHandler(type: ContentType, handler: (tab: TabState) => Promise<void>): () => void {
    this.refreshHandlers.set(type, handler)
    return () => {
      if (this.refreshHandlers.get(type) === handler) this.refreshHandlers.delete(type)
    }
  }

  /**
   * Close all tabs. `confirmDirty` is for a close the user asked for: each
   * dirty tab with a guard asks first, and one "keep" cancels the whole close.
   */
  async closeAll(options?: { confirmDirty?: boolean }): Promise<void> {
    if (options?.confirmDirty) {
      for (const tab of [...this.tabs.values()]) {
        const dirtyGuard = tab.isDirty ? this.dirtyCloseGuards.get(tab.type) : undefined
        if (!dirtyGuard || !this.tabs.has(tab.id)) continue
        await this.switchTab(tab.id)
        if (!(await dirtyGuard(tab))) {
          console.log(`[CanvasLifecycle] Close all cancelled by user at dirty tab ${tab.id}`)
          return
        }
      }
    }

    console.log('[CanvasLifecycle] Closing all tabs')

    // Tear down each tab's underlying resource. Browser/pdf views go by
    // ownership (see releaseBrowserView). Terminals defer to the bulk disposal
    // policy — non-interactive, so no per-tab prompts: the user's own terminals
    // are terminated, AI-operated ones are kept alive in the tray. Also drives
    // space-switch teardown (enterSpace → closeAll).
    const terminalDisposals: Promise<void>[] = []
    for (const [, tab] of this.tabs) {
      const hasBrowserView = (tab.type === 'browser' || tab.type === 'pdf') && tab.browserViewId
      if (hasBrowserView) {
        await this.releaseBrowserView(tab)
      } else if (tab.type === 'terminal' && tab.terminalSessionId && this.terminalClosePolicy) {
        terminalDisposals.push(this.terminalClosePolicy.disposeOnBulkClose(tab.terminalSessionId))
      }
    }
    await Promise.all(terminalDisposals)

    this.tabs.clear()
    this.tabsSnapshot = null
    this.lastActivated.clear()
    this.activeTabId = null
    this.setOpen(false)

    this.notifyTabListChange()
    this.notifyActiveTabChange()
  }

  /**
   * Switch to a specific tab (CORE METHOD)
   * Handles hiding previous BrowserView and showing/creating new one
   */
  async switchTab(tabId: string): Promise<void> {
    const tab = this.tabs.get(tabId)
    if (!tab) {
      console.warn(`[CanvasLifecycle] Tab not found: ${tabId}`)
      return
    }

    console.log(`[CanvasLifecycle] Switching to tab: ${tabId}`)

    const previousTabId = this.activeTabId
    const previousTab = previousTabId ? this.tabs.get(previousTabId) : null

    // 1. Publish the new active tab before the hide await, so a caller that
    // arrives mid-switch reads where we are going rather than where we were.
    // The hide below targets the previous tab by captured id, so it is unaffected.
    this.activeTabId = tabId
    this.lastActivated.set(tabId, ++this.activationSeq)

    // 2. Hide previous BrowserView if it exists (browser or pdf types)
    const prevNeedsBrowserView = previousTab?.type === 'browser' || previousTab?.type === 'pdf'
    if (prevNeedsBrowserView && previousTab.browserViewId && previousTabId !== tabId) {
      console.log(`[CanvasLifecycle] Hiding previous BrowserView: ${previousTab.browserViewId}`)
      await api.hideBrowserView(previousTab.browserViewId)
    }

    // 3. Create a BrowserView for browser/pdf tabs that lack one. Showing is
    // deliberately left out: this runs before notifyActiveTabChange(), so
    // containerBoundsGetter still resolves against the outgoing tab's DOM.
    // BrowserViewer positions the view after React commits the new active tab.
    const needsBrowserView = tab.type === 'browser' || tab.type === 'pdf'
    if (needsBrowserView && !tab.browserViewId) {
      // Don't await - let it load in background, UI switches immediately,
      // loading state updates via IPC events
      console.log(`[CanvasLifecycle] Creating new BrowserView for tab: ${tabId}`)
      this.createBrowserView(tabId, tab.url || 'about:blank').catch(err => {
        console.error(`[CanvasLifecycle] Failed to create BrowserView for tab ${tabId}:`, err)
      })
    }

    // 4. A tab whose content was dropped for the budget reads it back.
    if (tab.contentUnloaded && tab.path) {
      this.patchTab(tabId, { contentUnloaded: false, isLoading: true, error: undefined })
      void this.loadFileContent(tabId, tab.path, tab.type)
    }

    // 5. Notify React
    this.notifyActiveTabChange()

    void this.applyBudgets()
  }

  // ============================================
  // Resource Budgets
  // ============================================

  /**
   * Keep hidden tabs within the canvas budgets. Under critical memory
   * pressure nothing hidden keeps content or a live browser view.
   */
  private async applyBudgets(): Promise<void> {
    if (this.applyingBudgets) {
      this.budgetsDirty = true
      return
    }
    this.applyingBudgets = true
    try {
      do {
        this.budgetsDirty = false
        await this.applyBudgetsOnce()
      } while (this.budgetsDirty)
    } finally {
      this.applyingBudgets = false
    }
  }

  private async applyBudgetsOnce(): Promise<void> {
    const critical = this.memoryPressure === 'critical'
    const limits: CanvasBudgetLimits = {
      maxOpenTabs: MAX_OPEN_TABS,
      maxLiveBrowserViews: critical ? 0 : MAX_LIVE_BROWSER_VIEWS,
      hiddenContentBytes: critical ? 0 : HIDDEN_CONTENT_BUDGET_BYTES,
    }
    const plan = planCanvasBudget(this.getTabs(), this.activeTabId, this.lastActivated, limits)

    let closed = 0
    for (const tabId of plan.close) {
      if (await this.closeTabForBudget(tabId)) closed++
    }
    for (const tabId of plan.unloadContent) {
      // Re-checked here: earlier awaits in this pass may have let the user switch to or edit it.
      const tab = this.tabs.get(tabId)
      if (!tab || tabId === this.activeTabId || tab.isDirty || tab.contentUnloaded) continue
      this.patchTab(tabId, { content: undefined, bytes: undefined, contentUnloaded: true })
    }
    for (const tabId of plan.releaseView) {
      // Re-checked here: earlier awaits in this pass may have let the user switch to it.
      const tab = this.tabs.get(tabId)
      if (!tab?.browserViewId || !tab.browserViewOwned || tabId === this.activeTabId) continue
      // Detach first: a switch to this tab while the view is being destroyed
      // then sees no view and creates a fresh one (the url stays on the tab).
      this.patchTab(tabId, { browserViewId: undefined, browserViewOwned: undefined })
      await this.releaseBrowserView(tab)
    }
    if (closed > 0) {
      console.log(`[CanvasLifecycle] Closed ${closed} least recently used tab(s) over the ${MAX_OPEN_TABS}-tab limit`)
      this.budgetEvictionCallbacks.forEach(cb => cb({ closedTabs: closed, limit: MAX_OPEN_TABS }))
    }
  }

  /**
   * Closes a tab the budget planned to close, unless the user switched to or
   * edited it while this pass awaited. A browser view is detached before it is
   * released, so a switch during the release recreates the view and the tab
   * stays open. Returns whether the tab was closed.
   */
  private async closeTabForBudget(tabId: string): Promise<boolean> {
    const untouched = () => {
      const tab = this.tabs.get(tabId)
      return !!tab && tabId !== this.activeTabId && !tab.isDirty
    }
    if (!untouched()) return false
    const tab = this.tabs.get(tabId)!
    if (tab.browserViewId) {
      this.patchTab(tabId, { browserViewId: undefined, browserViewOwned: undefined })
      await this.releaseBrowserView(tab)
      if (!untouched()) return false
    }
    await this.closeTab(tabId)
    return !this.tabs.has(tabId)
  }

  setMemoryPressure(level: MemoryPressureLevel): void {
    if (this.memoryPressure === level) return
    this.memoryPressure = level
    if (level === 'critical') void this.applyBudgets()
  }

  /**
   * Switch to next tab (cyclic)
   */
  async switchToNextTab(): Promise<void> {
    if (this.tabs.size === 0) return

    const tabIds = Array.from(this.tabs.keys())
    const currentIndex = this.activeTabId ? tabIds.indexOf(this.activeTabId) : -1
    const nextIndex = (currentIndex + 1) % tabIds.length

    await this.switchTab(tabIds[nextIndex])
  }

  /**
   * Switch to previous tab (cyclic)
   */
  async switchToPrevTab(): Promise<void> {
    if (this.tabs.size === 0) return

    const tabIds = Array.from(this.tabs.keys())
    const currentIndex = this.activeTabId ? tabIds.indexOf(this.activeTabId) : 0
    const prevIndex = currentIndex <= 0 ? tabIds.length - 1 : currentIndex - 1

    await this.switchTab(tabIds[prevIndex])
  }

  /**
   * Switch to tab by index (1-indexed for keyboard shortcuts)
   */
  async switchToTabIndex(index: number): Promise<void> {
    const tabIds = Array.from(this.tabs.keys())
    if (index > 0 && index <= tabIds.length) {
      await this.switchTab(tabIds[index - 1])
    }
  }

  /**
   * Reorder tabs (for drag and drop)
   */
  reorderTabs(fromIndex: number, toIndex: number): void {
    const tabsArray = Array.from(this.tabs.entries())
    const [removed] = tabsArray.splice(fromIndex, 1)
    tabsArray.splice(toIndex, 0, removed)

    this.tabs = new Map(tabsArray)
    this.tabsSnapshot = null
    this.notifyTabListChange()
  }

  // ============================================
  // BrowserView Lifecycle
  // ============================================

  /**
   * Create a new BrowserView
   */
  private createBrowserView(tabId: string, url: string): Promise<void> {
    // A second request (double click, the AI and the user at once, a retry)
    // joins the first: two creations would leave one view no tab references.
    const inFlight = this.creatingViews.get(tabId)
    if (inFlight) return inFlight
    const creation = this.createBrowserViewOnce(tabId, url).finally(() => this.creatingViews.delete(tabId))
    this.creatingViews.set(tabId, creation)
    return creation
  }

  private async createBrowserViewOnce(tabId: string, url: string): Promise<void> {
    const tab = this.tabs.get(tabId)
    if (!tab) return

    const viewId = `browser-${tabId}-${++this.viewGeneration}`
    console.log(`[CanvasLifecycle] Creating BrowserView: ${viewId} for URL: ${url}`)

    try {
      const result = await api.createBrowserView(viewId, url)

      // The tab was closed, or got a view another way, while this one was
      // being created: nothing would ever reference it, so it goes now.
      const current = this.tabs.get(tabId)
      if (!current || (current.browserViewId && current.browserViewId !== viewId)) {
        if (result.success) {
          console.log(`[CanvasLifecycle] BrowserView ${viewId} no longer needed, destroying it`)
          await api.destroyBrowserView(viewId)
        }
        return
      }

      if (result.success) {
        this.patchTab(tabId, { browserViewId: viewId, browserViewOwned: true })
        void this.applyBudgets()

        // Show the view
        await this.showBrowserView(viewId)
      } else if ((result as { code?: string }).code === 'BROWSER_POLICY_BLOCKED') {
        // Initial URL blocked by browser policy — no BrowserView exists yet.
        // Surface the same blocked state as navigation blocks so the policy
        // overlay (and its "allow and retry" action) covers this entry too.
        console.warn(`[CanvasLifecycle] BrowserView creation blocked by policy: ${url}`)
        const browserState: BrowserState = {
          isLoading: false,
          canGoBack: false,
          canGoForward: false,
          error: result.error,
          blockedByPolicy: true,
          blockedUrl: url,
        }
        this.patchTab(tabId, { error: result.error, isLoading: false, browserState })
        this.notifyBrowserStateChange(tabId, browserState)
      } else {
        console.error(`[CanvasLifecycle] Failed to create BrowserView: ${result.error}`)
        this.patchTab(tabId, { error: result.error || 'Failed to create browser view', isLoading: false })
      }
    } catch (error) {
      console.error(`[CanvasLifecycle] Exception creating BrowserView:`, error)
      this.patchTab(tabId, { error: (error as Error).message, isLoading: false })
    }
  }

  /**
   * Retry a tab whose BrowserView creation was blocked by browser policy
   * (no view exists yet, so browser:navigate cannot be used). Called by the
   * policy-block overlay after the user allowlisted the blocked host.
   */
  async retryBlockedBrowserView(tabId: string): Promise<void> {
    const tab = this.tabs.get(tabId)
    if (!tab || tab.browserViewId) return
    const url = tab.browserState?.blockedUrl
    if (!url) return

    this.patchTab(tabId, { error: undefined, browserState: undefined, isLoading: true })
    await this.createBrowserView(tabId, url)
  }

  /**
   * Show a BrowserView at the container position
   */
  private async showBrowserView(viewId: string): Promise<void> {
    if (!this.containerBoundsGetter) {
      console.warn('[CanvasLifecycle] No container bounds getter set, deferring showBrowserView')
      // Will be called again when container is ready
      return
    }

    const bounds = this.containerBoundsGetter()
    if (!bounds) {
      console.warn('[CanvasLifecycle] Container bounds not available')
      return
    }

    console.log(`[CanvasLifecycle] Showing BrowserView: ${viewId} at`, {
      x: Math.round(bounds.left),
      y: Math.round(bounds.top),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    })

    await api.showBrowserView(viewId, {
      x: Math.round(bounds.left),
      y: Math.round(bounds.top),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    })
  }

  /**
   * Hide a BrowserView
   */
  private async hideBrowserView(viewId: string): Promise<void> {
    console.log(`[CanvasLifecycle] Hiding BrowserView: ${viewId}`)
    await api.hideBrowserView(viewId)
  }

  /**
   * Destroy a BrowserView
   */
  private async destroyBrowserView(viewId: string): Promise<void> {
    console.log(`[CanvasLifecycle] Destroying BrowserView: ${viewId}`)
    await api.hideBrowserView(viewId)
    await api.destroyBrowserView(viewId)
  }

  /**
   * Give up a tab's BrowserView, destroying it only if the Canvas owns it.
   *
   * The single place both close paths go through, so a tab can never be
   * removed one way and leak (or kill) its view the other way.
   */
  private async releaseBrowserView(tab: TabState): Promise<void> {
    if (!tab.browserViewId) return
    if (tab.browserViewOwned) {
      await this.destroyBrowserView(tab.browserViewId)
      return
    }
    console.log(`[CanvasLifecycle] Detaching BrowserView: ${tab.browserViewId}`)
    await this.hideBrowserView(tab.browserViewId)
  }

  /**
   * Update bounds of active BrowserView (called on resize)
   * Uses resizeBrowserView instead of showBrowserView to avoid
   * expensive addBrowserView calls during animation
   */
  async updateActiveBounds(): Promise<void> {
    if (!this.activeTabId) return

    const tab = this.tabs.get(this.activeTabId)
    const hasBrowserView = (tab?.type === 'browser' || tab?.type === 'pdf') && tab.browserViewId
    if (hasBrowserView) {
      await this.resizeBrowserView(tab.browserViewId!)
    }
  }

  /**
   * Show and position the active BrowserView. The only entry point that does so:
   * BrowserViewer calls it once mounted, which is the earliest moment the
   * container it is positioned against exists.
   */
  async ensureActiveBrowserViewShown(): Promise<void> {
    if (!this.activeTabId) return

    const tab = this.tabs.get(this.activeTabId)
    const hasBrowserView = (tab?.type === 'browser' || tab?.type === 'pdf') && tab.browserViewId
    if (hasBrowserView) {
      // Use showBrowserView which adds the view to the window
      await this.showBrowserView(tab.browserViewId!)
    }
  }

  /**
   * Resize a BrowserView (without re-adding to window)
   * More efficient than showBrowserView for continuous updates
   */
  private async resizeBrowserView(viewId: string): Promise<void> {
    if (!this.containerBoundsGetter) return

    const bounds = this.containerBoundsGetter()
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return

    await api.resizeBrowserView(viewId, {
      x: Math.round(bounds.left),
      y: Math.round(bounds.top),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    })
  }

  /**
   * Hide active BrowserView (called when canvas is hidden)
   */
  async hideActiveBrowserView(): Promise<void> {
    if (!this.activeTabId) return

    const tab = this.tabs.get(this.activeTabId)
    const hasBrowserView = (tab?.type === 'browser' || tab?.type === 'pdf') && tab.browserViewId
    if (hasBrowserView) {
      await this.hideBrowserView(tab.browserViewId!)
    }
  }

  /**
   * Hide all BrowserViews (called when leaving SpacePage)
   * Keeps tabs in memory, just hides the native views
   */
  async hideAllBrowserViews(): Promise<void> {
    for (const [, tab] of this.tabs) {
      const hasBrowserView = (tab.type === 'browser' || tab.type === 'pdf') && tab.browserViewId
      if (hasBrowserView) {
        await this.hideBrowserView(tab.browserViewId!)
      }
    }
  }

  // ============================================
  // Content Actions
  // ============================================

  /**
   * Brings open tabs in line with files rewritten on disk. A clean tab
   * re-reads in place; a tab with unsaved edits is never overwritten — it is
   * checked for a real divergence and, if so, flagged for the user to resolve.
   */
  handleArtifactChanges(batch: ArtifactChangeBatchEvent): void {
    let changed: Set<string> | null = null
    if (!batch.resync) {
      for (const change of batch.changes) {
        // Atomic writers (temp file + rename) surface as 'add' for the open path.
        if (change.type === 'change' || change.type === 'add') (changed ??= new Set()).add(change.path)
      }
      if (!changed) return
    }
    for (const [tabId, tab] of this.tabs) {
      if (!tab.path || (changed && !changed.has(tab.path))) continue
      // An unloaded tab re-reads when shown anyway.
      if (tab.contentUnloaded) continue
      if (tab.isDirty) void this.checkDiskConflict(tabId)
      else void this.refreshTab(tabId)
    }
  }

  private async checkDiskConflict(tabId: string): Promise<void> {
    const path = this.tabs.get(tabId)?.path
    if (!path) return
    const response = await api.readArtifactContent(path)
    const tab = this.tabs.get(tabId)
    if (!tab?.isDirty || !response.success || !response.data) return
    const disk = (response.data as { content: string }).content
    // Our own save echoing back through the watcher is not a conflict.
    if (disk === tab.savedContent) return
    this.patchTab(tabId, { savedContent: disk, diskConflict: true })
  }

  /**
   * Settles an on-disk change against unsaved edits: 'disk' discards the edits
   * for the file's current text, 'mine' keeps them (a save then overwrites).
   */
  resolveDiskConflict(tabId: string, keep: 'disk' | 'mine'): void {
    if (!this.tabs.get(tabId)?.diskConflict) return
    if (keep === 'disk') {
      this.revertTabContent(tabId)
      return
    }
    this.patchTab(tabId, { diskConflict: false })
  }

  /** Drops unsaved edits, restoring the file's text as last seen on disk. */
  revertTabContent(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (!tab?.isDirty) return
    this.patchTab(tabId, {
      content: tab.savedContent ?? tab.content,
      savedContent: undefined,
      diskConflict: false,
      isDirty: false,
    })
  }

  /**
   * Refresh tab content
   */
  async refreshTab(tabId: string): Promise<void> {
    const tab = this.tabs.get(tabId)
    if (!tab) return

    const hasBrowserView = (tab.type === 'browser' || tab.type === 'pdf') && tab.browserViewId
    if (hasBrowserView) {
      // Reload browser/PDF view
      await api.browserReload(tab.browserViewId!)
    } else if (tab.path) {
      // A tab already showing the file re-reads in place — the viewer stays
      // mounted and swaps the text (keeping scroll) instead of flashing a
      // loading state and rebuilding.
      if (tab.content === undefined && tab.bytes === undefined) {
        this.patchTab(tabId, { isLoading: true, error: undefined })
      }

      await this.loadFileContent(tabId, tab.path, tab.type)
    } else {
      await this.refreshHandlers.get(tab.type)?.(tab)
    }
  }

  /**
   * Update tab content (for editing)
   */
  updateTabContent(tabId: string, content: string): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    this.patchTab(tabId, {
      content,
      isDirty: true,
      savedContent: tab.isDirty ? tab.savedContent : tab.content,
    })
  }

  /**
   * Mark tab as saved (clear dirty flag)
   */
  markTabSaved(tabId: string, content?: string): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    this.patchTab(tabId, {
      content: content ?? tab.content,
      isDirty: false,
      savedContent: undefined,
      diskConflict: false,
    })
  }

  /**
   * Save scroll position
   */
  saveScrollPosition(tabId: string, position: number): void {
    const tab = this.tabs.get(tabId)
    if (tab) tab.view.scrollPosition = position
  }

  /**
   * Toggle edit mode for markdown tabs
   */
  toggleEditMode(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (tab && tab.type === 'markdown') this.patchTab(tabId, { isEditMode: !tab.isEditMode })
  }

  /**
   * Set edit mode for a tab
   */
  setEditMode(tabId: string, editMode: boolean): void {
    this.patchTab(tabId, { isEditMode: editMode })
  }

  // ============================================
  // Layout Actions
  // ============================================

  /**
   * Set canvas open state
   */
  setOpen(open: boolean): void {
    if (this.isOpen === open) return

    // Can't open if no tabs
    if (open && this.tabs.size === 0) return

    console.log(`[CanvasLifecycle] Setting open: ${open}`)

    this.isOpen = open
    this.isTransitioning = true

    // Only hiding belongs here. Showing needs the canvas container's bounds, and
    // the container is BrowserViewer's — it mounts with the canvas, after this.
    if (!open) {
      this.hideActiveBrowserView()
    }

    this.notifyOpenStateChange()

    // Clear transitioning after animation
    setTimeout(() => {
      this.isTransitioning = false
    }, 300)
  }

  /**
   * Toggle canvas visibility
   */
  toggleOpen(): void {
    if (!this.isOpen && this.tabs.size === 0) return
    this.setOpen(!this.isOpen)
  }

  // ============================================
  // State Queries
  // ============================================

  /** Current tabs in display order. */
  getTabs(): readonly TabState[] {
    this.tabsSnapshot ??= Array.from(this.tabs.values())
    return this.tabsSnapshot
  }

  /**
   * The tabs as of the last tab-list change — a stable array for the tab
   * strip. Fields the strip does not show (content, bytes, browser state) may
   * be older than `getTab()`.
   */
  getTabListSnapshot(): readonly TabState[] {
    return this.tabListSnapshot
  }

  getTab(tabId: string): TabState | undefined {
    return this.tabs.get(tabId)
  }

  getActiveTabId(): string | null {
    return this.activeTabId
  }

  getActiveTab(): TabState | undefined {
    return this.activeTabId ? this.tabs.get(this.activeTabId) : undefined
  }

  getIsOpen(): boolean {
    return this.isOpen
  }

  getIsTransitioning(): boolean {
    return this.isTransitioning
  }

  getTabCount(): number {
    return this.tabs.size
  }

  getCurrentSpaceId(): string | null {
    return this.currentSpaceId
  }

  /**
   * Called when entering a space - clears tabs if switching to different space.
   * This is the single point of control for Space isolation of Canvas state.
   * Returns true if tabs were cleared.
   *
   * The new space id is published before the teardown is awaited, so a second
   * caller arriving for the same space during it — SpacePage's mount effect
   * while a tray reveal is still awaiting — matches and short-circuits, instead
   * of re-entering teardown and wiping the tab the reveal is about to open.
   */
  async enterSpace(spaceId: string): Promise<boolean> {
    const previousSpaceId = this.currentSpaceId

    if (previousSpaceId && previousSpaceId !== spaceId && this.tabs.size > 0) {
      // Switching to different space with existing tabs - clear all
      console.log(`[CanvasLifecycle] Space switch: clearing ${this.tabs.size} tabs`)
      this.currentSpaceId = spaceId
      try {
        await this.closeAll()
      } catch (err) {
        // A rejected teardown can leave tabs behind, and the id now published
        // says they belong to the space being entered. Drop them rather than
        // let the next space inherit the previous one's tabs.
        console.error('[CanvasLifecycle] Space-switch teardown failed, dropping tabs:', err)
        this.tabs.clear()
        this.tabsSnapshot = null
        this.lastActivated.clear()
        this.activeTabId = null
        this.setOpen(false)
        this.notifyTabListChange()
        this.notifyActiveTabChange()
      }
      return true
    }

    this.currentSpaceId = spaceId
    this.syncSpaceHold()
    return false
  }

  // ============================================
  // Tab State Updates
  // ============================================

  private addTab(tab: NewTab): void {
    this.tabs.set(tab.id, { ...tab, view: {} })
    this.tabsSnapshot = null
    this.setOpen(true)
    this.notifyTabListChange()
  }

  /**
   * Replace a tab with an updated copy. Tab-list subscribers hear about it
   * only when a field the list shows changed; per-tab subscribers always do.
   */
  private patchTab(tabId: string, patch: Partial<Omit<TabState, 'id' | 'view'>>): void {
    const previous = this.tabs.get(tabId)
    if (!previous) return
    const next: TabState = { ...previous, ...patch }
    this.tabs.set(tabId, next)
    this.tabsSnapshot = null
    this.tabChangeCallbacks.forEach(cb => cb(next))
    if (TAB_LIST_FIELDS.some(field => previous[field] !== next[field])) this.notifyTabListChange()
  }

  // ============================================
  // Event Subscriptions
  // ============================================

  /**
   * Tabs added, removed or reordered, or a field the tab list shows changed
   * (see TAB_LIST_FIELDS). Content, bytes and browser state do not fire it.
   */
  onTabListChange(callback: TabListChangeCallback): () => void {
    this.tabListChangeCallbacks.add(callback)
    // Immediately call with current state
    callback(this.getTabs())
    return () => this.tabListChangeCallbacks.delete(callback)
  }

  /** Tabs were closed to stay within the open-tab limit. */
  onBudgetEviction(callback: BudgetEvictionCallback): () => void {
    this.budgetEvictionCallbacks.add(callback)
    return () => this.budgetEvictionCallbacks.delete(callback)
  }

  /** Any change to one tab, with its new snapshot. */
  onTabChange(callback: TabChangeCallback): () => void {
    this.tabChangeCallbacks.add(callback)
    return () => this.tabChangeCallbacks.delete(callback)
  }

  onActiveTabChange(callback: ActiveTabChangeCallback): () => void {
    this.activeTabChangeCallbacks.add(callback)
    // Immediately call with current state
    callback(this.activeTabId)
    return () => this.activeTabChangeCallbacks.delete(callback)
  }

  onBrowserStateChange(callback: BrowserStateChangeCallback): () => void {
    this.browserStateChangeCallbacks.add(callback)
    return () => this.browserStateChangeCallbacks.delete(callback)
  }

  onOpenStateChange(callback: OpenStateChangeCallback): () => void {
    this.openStateChangeCallbacks.add(callback)
    // Immediately call with current state
    callback(this.isOpen)
    return () => this.openStateChangeCallbacks.delete(callback)
  }

  // ============================================
  // Notification Helpers
  // ============================================

  private notifyTabListChange(): void {
    this.tabsSnapshot = null
    this.tabListSnapshot = this.getTabs()
    const tabs = this.tabListSnapshot
    this.syncSpaceHold()
    this.tabListChangeCallbacks.forEach(cb => cb(tabs))
  }

  private syncSpaceHold(): void {
    let wanted: string | null = null
    if (this.currentSpaceId) {
      for (const tab of this.tabs.values()) {
        if (tab.path) {
          wanted = this.currentSpaceId
          break
        }
      }
    }
    if (this.spaceHold?.spaceId === wanted) return
    this.spaceHold?.release()
    this.spaceHold = wanted ? { spaceId: wanted, release: holdArtifactSpace(wanted) } : null
  }

  private notifyActiveTabChange(): void {
    this.activeTabChangeCallbacks.forEach(cb => cb(this.activeTabId))
  }

  private notifyBrowserStateChange(tabId: string, state: BrowserState): void {
    this.browserStateChangeCallbacks.forEach(cb => cb(tabId, state))
  }

  private notifyOpenStateChange(): void {
    this.openStateChangeCallbacks.forEach(cb => cb(this.isOpen))
  }
}

// Singleton instance
export const canvasLifecycle = new CanvasLifecycle()

// Auto-initialize on module load
// This ensures IPC listeners are ready before any React components mount
canvasLifecycle.initialize()

// Export types for external use
export type { TabListChangeCallback, TabChangeCallback, BudgetEvictionCallback, ActiveTabChangeCallback, BrowserStateChangeCallback, OpenStateChangeCallback }
