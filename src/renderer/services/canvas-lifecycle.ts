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
import { isBinaryExtension } from '../constants/file-types'

// ============================================
// Types
// ============================================

export type ContentType =
  | 'code'
  | 'markdown'
  | 'html'
  | 'image'
  | 'pdf'
  | 'text'
  | 'json'
  | 'csv'
  | 'browser'
  | 'terminal'

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

export interface TabState {
  id: string
  type: ContentType
  title: string
  path?: string
  url?: string
  content?: string
  language?: string
  mimeType?: string
  isDirty: boolean
  isLoading: boolean
  error?: string
  scrollPosition?: number
  browserViewId?: string
  browserState?: BrowserState
  isEditMode?: boolean // For markdown tabs - switches between preview and editor
}

// Callback types
type TabsChangeCallback = (tabs: TabState[]) => void
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

  // Container bounds getter (set by BrowserViewer)
  private containerBoundsGetter: (() => DOMRect | null) | null = null

  // IPC listener cleanup
  private browserStateUnsubscribe: (() => void) | null = null
  private artifactChangedUnsubscribe: (() => void) | null = null

  // Callback subscriptions
  private tabsChangeCallbacks: Set<TabsChangeCallback> = new Set()
  private activeTabChangeCallbacks: Set<ActiveTabChangeCallback> = new Set()
  private browserStateChangeCallbacks: Set<BrowserStateChangeCallback> = new Set()
  private openStateChangeCallbacks: Set<OpenStateChangeCallback> = new Set()

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

      // Find the tab with this browserViewId
      for (const [tabId, tab] of this.tabs) {
        if (tab.browserViewId === event.viewId) {
          // Update tab state
          tab.browserState = {
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

          // Update URL and title if changed
          if (event.state.url && event.state.url !== tab.url) {
            tab.url = event.state.url
          }
          if (event.state.title && event.state.title !== tab.title) {
            tab.title = event.state.title
          }

          // Update isLoading at tab level too
          if (event.state.isLoading !== undefined) {
            tab.isLoading = event.state.isLoading
          }

          // Sync error to tab level (e.g. browser policy block during navigation)
          tab.error = event.state.error

          // Notify listeners
          this.notifyTabsChange()
          this.notifyBrowserStateChange(tabId, tab.browserState)
          break
        }
      }
    })

    // Listen for file changes via existing artifact watcher, auto-refresh open tabs
    this.artifactChangedUnsubscribe = api.onArtifactChanged((event) => {
      if (event.type !== 'change') return
      for (const [tabId, tab] of this.tabs) {
        if (tab.path === event.path && !tab.isDirty) {
          this.refreshTab(tabId)
          break
        }
      }
    })

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

    // Destroy all browser views
    this.closeAll()

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

          // Use backend-detected content type
          type = info.contentType as ContentType
          language = info.language
        }
      } catch (error) {
        console.warn(`[CanvasLifecycle] Backend detection failed, falling back to text:`, error)
        // Fall back to text type on error
      }
    }

    // PDF files are opened via BrowserView (Chromium native PDF renderer)
    if (type === 'pdf') {
      return this.openPdf(path, title)
    }

    // Create new tab
    const tabId = generateTabId()
    const tab: TabState = {
      id: tabId,
      type,
      title: title || getFileName(path),
      path,
      language,
      isDirty: false,
      isLoading: true,
    }

    this.tabs.set(tabId, tab)
    this.setOpen(true)
    this.notifyTabsChange()

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

    const tab: TabState = {
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

    this.tabs.set(tabId, tab)
    this.setOpen(true)
    this.notifyTabsChange()

    // Switch to new tab (this will create the BrowserView)
    await this.switchTab(tabId)

    return tabId
  }

  /**
   * Load file content asynchronously
   */
  private async loadFileContent(tabId: string, path: string, type: ContentType): Promise<void> {
    const tab = this.tabs.get(tabId)
    if (!tab) return

    // Images use halo-file:// protocol directly (no content loading needed)
    if (type === 'image') {
      tab.isLoading = false
      this.notifyTabsChange()
      return
    }

    try {
      const response = await api.readArtifactContent(path)

      // Tab might have been closed during async operation
      if (!this.tabs.has(tabId)) return

      if (response.success && response.data) {
        const data = response.data as { content: string; mimeType?: string }
        tab.content = data.content
        tab.mimeType = data.mimeType
        tab.isLoading = false
        tab.error = undefined
      } else {
        throw new Error(response.error || 'Failed to read file')
      }
    } catch (error) {
      const tab = this.tabs.get(tabId)
      if (tab) {
        tab.isLoading = false
        tab.error = (error as Error).message
      }
    }

    this.notifyTabsChange()
  }

  /**
   * Open a URL in embedded browser
   */
  async openUrl(url: string, title?: string): Promise<string> {
    // Check if URL is already open (skip dedup for about:blank — new tabs)
    if (url !== 'about:blank') {
      for (const [tabId, tab] of this.tabs) {
        if (tab.type === 'browser' && tab.url === url) {
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
    const tab: TabState = {
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

    this.tabs.set(tabId, tab)
    this.setOpen(true)
    this.notifyTabsChange()

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
    const tab: TabState = {
      id: tabId,
      type: 'browser',
      title: displayTitle,
      url,
      isDirty: false,
      isLoading: false, // Already loaded by AI
      browserViewId: viewId, // Reference to existing view
      browserState: {
        isLoading: false,
        canGoBack: false,
        canGoForward: false,
      },
    }

    this.tabs.set(tabId, tab)
    this.setOpen(true)
    this.notifyTabsChange()

    // Switch to new tab (will show existing view)
    await this.switchTab(tabId)

    return tabId
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
    const tab: TabState = {
      id: tabId,
      type,
      title,
      content,
      language,
      isDirty: false,
      isLoading: false,
    }

    this.tabs.set(tabId, tab)
    this.setOpen(true)
    this.notifyTabsChange()

    await this.switchTab(tabId)

    return tabId
  }

  /**
   * Close a tab
   */
  async closeTab(tabId: string): Promise<void> {
    const tab = this.tabs.get(tabId)
    if (!tab) return

    console.log(`[CanvasLifecycle] Closing tab: ${tabId}`)

    // Destroy BrowserView if this is a browser/pdf tab
    const hasBrowserView = (tab.type === 'browser' || tab.type === 'pdf') && tab.browserViewId
    if (hasBrowserView) {
      await this.destroyBrowserView(tab.browserViewId!)
    }

    // Remove tab
    this.tabs.delete(tabId)

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

    this.notifyTabsChange()
  }

  /**
   * Close all tabs
   */
  async closeAll(): Promise<void> {
    console.log('[CanvasLifecycle] Closing all tabs')

    // Destroy all browser views (browser and pdf types)
    for (const [, tab] of this.tabs) {
      const hasBrowserView = (tab.type === 'browser' || tab.type === 'pdf') && tab.browserViewId
      if (hasBrowserView) {
        await this.destroyBrowserView(tab.browserViewId!)
      }
    }

    this.tabs.clear()
    this.activeTabId = null
    this.setOpen(false)

    this.notifyTabsChange()
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

    // 1. Hide previous BrowserView if it exists (browser or pdf types)
    const prevNeedsBrowserView = previousTab?.type === 'browser' || previousTab?.type === 'pdf'
    if (prevNeedsBrowserView && previousTab.browserViewId && previousTabId !== tabId) {
      console.log(`[CanvasLifecycle] Hiding previous BrowserView: ${previousTab.browserViewId}`)
      await api.hideBrowserView(previousTab.browserViewId)
    }

    // 2. Update activeTabId
    this.activeTabId = tabId

    // 3. For browser/pdf tabs, show/create BrowserView
    const needsBrowserView = tab.type === 'browser' || tab.type === 'pdf'
    if (needsBrowserView) {
      if (tab.browserViewId) {
        // Existing view - just show it
        console.log(`[CanvasLifecycle] Showing existing BrowserView: ${tab.browserViewId}`)
        await this.showBrowserView(tab.browserViewId)
      } else {
        // Need to create new view - don't await, let it load in background
        // UI switches immediately, loading state updates via IPC events
        console.log(`[CanvasLifecycle] Creating new BrowserView for tab: ${tabId}`)
        this.createBrowserView(tabId, tab.url || 'about:blank').catch(err => {
          console.error(`[CanvasLifecycle] Failed to create BrowserView for tab ${tabId}:`, err)
        })
      }
    }

    // 4. Notify React
    this.notifyActiveTabChange()
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
    this.notifyTabsChange()
  }

  // ============================================
  // BrowserView Lifecycle
  // ============================================

  /**
   * Create a new BrowserView
   */
  private async createBrowserView(tabId: string, url: string): Promise<void> {
    const tab = this.tabs.get(tabId)
    if (!tab) return

    const viewId = `browser-${tabId}`
    console.log(`[CanvasLifecycle] Creating BrowserView: ${viewId} for URL: ${url}`)

    try {
      const result = await api.createBrowserView(viewId, url)

      // Tab might have been closed during async operation
      if (!this.tabs.has(tabId)) {
        console.log(`[CanvasLifecycle] Tab closed during BrowserView creation, destroying view`)
        await api.destroyBrowserView(viewId)
        return
      }

      if (result.success) {
        tab.browserViewId = viewId
        this.notifyTabsChange()

        // Show the view
        await this.showBrowserView(viewId)
      } else if ((result as { code?: string }).code === 'BROWSER_POLICY_BLOCKED') {
        // Initial URL blocked by browser policy — no BrowserView exists yet.
        // Surface the same blocked state as navigation blocks so the policy
        // overlay (and its "allow and retry" action) covers this entry too.
        console.warn(`[CanvasLifecycle] BrowserView creation blocked by policy: ${url}`)
        tab.error = result.error
        tab.isLoading = false
        tab.browserState = {
          isLoading: false,
          canGoBack: false,
          canGoForward: false,
          error: result.error,
          blockedByPolicy: true,
          blockedUrl: url,
        }
        this.notifyTabsChange()
        this.notifyBrowserStateChange(tabId, tab.browserState)
      } else {
        console.error(`[CanvasLifecycle] Failed to create BrowserView: ${result.error}`)
        tab.error = result.error || 'Failed to create browser view'
        tab.isLoading = false
        this.notifyTabsChange()
      }
    } catch (error) {
      console.error(`[CanvasLifecycle] Exception creating BrowserView:`, error)
      const tab = this.tabs.get(tabId)
      if (tab) {
        tab.error = (error as Error).message
        tab.isLoading = false
        this.notifyTabsChange()
      }
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

    tab.error = undefined
    tab.browserState = undefined
    tab.isLoading = true
    this.notifyTabsChange()
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
   * Update bounds of active BrowserView (called on resize)
   * Uses resizeBrowserView instead of showBrowserView to avoid
   * expensive addBrowserView calls during animation
   */
  async updateActiveBounds(): Promise<void> {
    console.log('[CanvasLifecycle] 🔵 updateActiveBounds called, time:', Date.now())
    if (!this.activeTabId) return

    const tab = this.tabs.get(this.activeTabId)
    const hasBrowserView = (tab?.type === 'browser' || tab?.type === 'pdf') && tab.browserViewId
    if (hasBrowserView) {
      await this.resizeBrowserView(tab.browserViewId!)
    }
  }

  /**
   * Ensure active BrowserView is shown (called when BrowserViewer mounts)
   * This handles the case where BrowserView was created before the container
   * was ready, and showBrowserView() returned early due to missing bounds.
   */
  async ensureActiveBrowserViewShown(): Promise<void> {
    console.log('[CanvasLifecycle] 🟢 ensureActiveBrowserViewShown called, time:', Date.now())
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
    console.log('[CanvasLifecycle] 🔵 resizeBrowserView bounds:', bounds, 'time:', Date.now())
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

  /**
   * Show active BrowserView (called when canvas is shown)
   */
  async showActiveBrowserView(): Promise<void> {
    if (!this.activeTabId) return

    const tab = this.tabs.get(this.activeTabId)
    const hasBrowserView = (tab?.type === 'browser' || tab?.type === 'pdf') && tab.browserViewId
    if (hasBrowserView) {
      await this.showBrowserView(tab.browserViewId!)
    }
  }

  // ============================================
  // Content Actions
  // ============================================

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
      // Reload file content
      tab.isLoading = true
      tab.error = undefined
      this.notifyTabsChange()

      await this.loadFileContent(tabId, tab.path, tab.type)
    }
  }

  /**
   * Update tab content (for editing)
   */
  updateTabContent(tabId: string, content: string): void {
    const tab = this.tabs.get(tabId)
    if (tab) {
      tab.content = content
      tab.isDirty = true
      this.notifyTabsChange()
    }
  }

  /**
   * Mark tab as saved (clear dirty flag)
   */
  markTabSaved(tabId: string, content?: string): void {
    const tab = this.tabs.get(tabId)
    if (tab) {
      if (content !== undefined) {
        tab.content = content
      }
      tab.isDirty = false
      this.notifyTabsChange()
    }
  }

  /**
   * Save scroll position
   */
  saveScrollPosition(tabId: string, position: number): void {
    const tab = this.tabs.get(tabId)
    if (tab) {
      tab.scrollPosition = position
      // No need to notify for scroll position updates
    }
  }

  /**
   * Toggle edit mode for markdown tabs
   */
  toggleEditMode(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (tab && tab.type === 'markdown') {
      tab.isEditMode = !tab.isEditMode
      this.notifyTabsChange()
    }
  }

  /**
   * Set edit mode for a tab
   */
  setEditMode(tabId: string, editMode: boolean): void {
    const tab = this.tabs.get(tabId)
    if (tab) {
      tab.isEditMode = editMode
      this.notifyTabsChange()
    }
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

    // Handle BrowserView visibility
    if (open) {
      this.showActiveBrowserView()
    } else {
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

  getTabs(): TabState[] {
    return Array.from(this.tabs.values())
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
   * Called when entering a space - clears tabs if switching to different space
   * This is the single point of control for Space isolation of Canvas state.
   * Returns true if tabs were cleared
   */
  enterSpace(spaceId: string): boolean {
    const previousSpaceId = this.currentSpaceId

    if (previousSpaceId && previousSpaceId !== spaceId && this.tabs.size > 0) {
      // Switching to different space with existing tabs - clear all
      console.log(`[CanvasLifecycle] Space switch: clearing ${this.tabs.size} tabs`)
      this.closeAll()
      this.currentSpaceId = spaceId
      return true
    }

    this.currentSpaceId = spaceId
    return false
  }

  // ============================================
  // Event Subscriptions
  // ============================================

  onTabsChange(callback: TabsChangeCallback): () => void {
    this.tabsChangeCallbacks.add(callback)
    // Immediately call with current state
    callback(this.getTabs())
    return () => this.tabsChangeCallbacks.delete(callback)
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

  private notifyTabsChange(): void {
    const tabs = this.getTabs()
    this.tabsChangeCallbacks.forEach(cb => cb(tabs))
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
export type { TabsChangeCallback, ActiveTabChangeCallback, BrowserStateChangeCallback, OpenStateChangeCallback }
