/**
 * Owns Canvas tabs and their resource budgets independently of React viewers.
 * BrowserView API names are retained for compatibility; their pages are webview
 * guests in a permanent host, and AI-owned guests outlive borrowed Canvas tabs.
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
import { canEvictTab, planCanvasBudget, type CanvasBudgetLimits } from './canvas-budget'
import { holdArtifactSpace } from './artifact-space-holds'
import { gitDiscovery } from './git-discovery'
import type { ChangesViewMemory } from '../types/changes-view'
import type { ReferenceLineRange } from '../../shared/types/content-reference'
import type { BrowserTabOpened } from '../../shared/types/browser-host'

// ============================================
// Types
// ============================================

/** What the tab list renders; a change to any other field is not the list's business. */
const TAB_LIST_FIELDS = ['type', 'title', 'path', 'url', 'isDirty', 'isLoading', 'error', 'aiWork'] as const

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
  'changes',
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
  blockedPopupHost?: string
  blockedPopupSequence?: number
}

/**
 * Per-tab view memory a viewer writes as the user moves around (scroll offset)
 * and reads back when it mounts again. Mutable on purpose and never notified:
 * nothing renders from it, and every snapshot of a tab points at the same
 * object, so a remounting viewer always reads the latest value.
 */
export interface TabViewState {
  scrollPosition?: number
  /** Where a changes tab was left; owned by the changes viewer. */
  changes?: ChangesViewMemory
}

/**
 * What a changes tab shows: the Git repositories of a space (`repoRoot` picks
 * the one a new tab starts on), or the edits one AI reply made with its edit tools.
 */
export type ChangesSource =
  | { kind: 'git'; spaceId: string; repoRoot?: string }
  | { kind: 'message'; spaceId: string; conversationId: string; messageId: string; title: string; replyAt: number }

/**
 * A one-shot request to show a place in a tab's content (going back to what a
 * reference points at). The viewer handles it once its content is in, then
 * clears it with `consumeReveal`.
 */
export interface RevealRequest {
  /** Differs on every request, so asking for the same place twice reveals it again. */
  seq: number
  range?: ReferenceLineRange
  /** The text as it was, to find the place again when the content changed. */
  quote?: string
  /**
   * The quote is rendered text (a Markdown preview passage), so it finds the
   * place only in rendered content and `range` is approximate.
   */
  passage?: boolean
  /**
   * Asked from the composer, where the user goes on typing: the viewer shows
   * the place without taking keyboard focus.
   */
  keepFocus?: boolean
  /** A pending comment on the place, gone back to for editing: its card there takes the focus. */
  commentId?: string
  /** Changes view only: the file and the side of its diff. */
  path?: string
  side?: 'before' | 'after'
  /** Changes view only: the sub-page to show. */
  page?: 'overview'
}

export type RevealTarget = Omit<RevealRequest, 'seq'>

export interface OpenFileOptions {
  title?: string
  reveal?: RevealTarget
}

function isSameChangesSource(a: ChangesSource, b: ChangesSource): boolean {
  if (a.kind === 'git' && b.kind === 'git') return a.spaceId === b.spaceId
  if (a.kind === 'message' && b.kind === 'message') return a.conversationId === b.conversationId && a.messageId === b.messageId
  return false
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
  /** What a changes tab shows. */
  changes?: ChangesSource
  /** A place to show once; see RevealRequest. */
  reveal?: RevealRequest
  /** False for pages a conversation holds: the canvas shows them but does not end them itself. */
  browserViewOwned?: boolean
  /**
   * The tab shows the AI's live work: a running terminal it used, or a page it
   * opened. Set and cleared by `syncAIWork` only.
   */
  aiWork?: boolean
}

/** A piece of the AI's live work that has a tab of its own (see services/ai-work-tabs). */
export type AIWorkItem =
  | { kind: 'terminal'; sessionId: string; title: string; activityAt: number }
  | { kind: 'page'; viewId: string; url: string | null; title: string | null; activityAt: number }

/**
 * What closing tabs does to what they run. The canvas owns tabs, not ptys or
 * the AI's pages, so the domain that can end them (and ask first) decides.
 */
export interface CanvasClosePolicy {
  /** One tab closed by the user: end what it runs, asking first for the AI's work. False keeps the tab. */
  closeOne(tab: TabState): Promise<boolean>
  /** Several closed at once: keeps the AI's work, asking only when nothing else is closing. Null cancels; `keep` stays open. */
  closeMany(tabs: readonly TabState[]): Promise<{ keep: ReadonlySet<string> } | null>
  /** The tabs of a removed space: end what they run, without asking. */
  endRemoved(tabs: readonly TabState[]): Promise<void>
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

/**
 * The tabs of a space that is not on screen, kept as the user left them. They
 * hold no browser page and no file text that can be read again, and the
 * space's files are not watched while it is away.
 */
interface ParkedSpace {
  tabs: Map<string, TabState>
  activeTabId: string | null
  isOpen: boolean
  lastActivated: Map<string, number>
}

/**
 * A tab as it waits in a parked space: a clean file tab drops its text and
 * reads the file again when shown. Unsaved edits, content with no file, and a
 * desktop PDF (its page reads the file itself) stay as they are.
 */
function parkedForm(tab: TabState): TabState {
  if (!tab.path || tab.url || tab.isDirty) return tab
  return { ...tab, content: undefined, bytes: undefined, contentUnloaded: true, isLoading: false }
}

/** Which piece of AI work a tab shows, if it can show one. */
function aiWorkKeyOf(tab: TabState): string | null {
  if (tab.type === 'terminal' && tab.terminalSessionId) return `terminal:${tab.terminalSessionId}`
  if (tab.type === 'browser' && tab.browserViewId && tab.browserViewOwned === false) return `page:${tab.browserViewId}`
  return null
}

function aiWorkKey(item: AIWorkItem): string {
  return item.kind === 'terminal' ? `terminal:${item.sessionId}` : `page:${item.viewId}`
}

function pageTitle(url: string | null, title: string | null): string {
  if (title) return title
  try {
    if (url) return new URL(url).hostname || url
  } catch {
    // Not a URL worth naming the tab after.
  }
  return i18n.t('Web page')
}

/** A quiet tab for a piece of AI work: added, never opened or switched to. */
function aiWorkTab(item: AIWorkItem): NewTab {
  if (item.kind === 'terminal') {
    return {
      id: generateTabId(),
      type: 'terminal',
      title: item.title || 'Terminal',
      terminalSessionId: item.sessionId,
      isDirty: false,
      isLoading: false,
      aiWork: true,
    }
  }
  return {
    id: generateTabId(),
    type: 'browser',
    title: pageTitle(item.url, item.title),
    url: item.url ?? undefined,
    isDirty: false,
    isLoading: false,
    browserViewId: item.viewId,
    browserViewOwned: false,
    browserState: { isLoading: false, canGoBack: false, canGoForward: false },
    aiWork: true,
  }
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
  /** The tabs of every other space the user has left, by space id. */
  private parkedSpaces = new Map<string, ParkedSpace>()
  /** Bumped whenever the tabs on screen are parked, so work that awaits can tell they still are. */
  private parkGeneration = 0
  /**
   * Keeps the space's watcher alive while a tab shows one of its files, so
   * open files refresh and detect disk conflicts even with the file tree closed.
   */
  private spaceHold: { spaceId: string; release: () => void } | null = null

  // Container bounds getter (set by BrowserViewer)
  private containerBoundsGetter: (() => DOMRect | null) | null = null

  // IPC listener cleanup
  private browserStateUnsubscribe: (() => void) | null = null
  private browserPageGoneUnsubscribe: (() => void) | null = null
  private browserTabOpenedUnsubscribe: (() => void) | null = null
  private artifactChangedUnsubscribe: (() => void) | null = null
  private memoryPressureUnsubscribe: (() => void) | null = null

  private memoryPressure: MemoryPressureLevel = 'normal'
  private applyingBudgets = false
  /** A budget pass was asked for while one was running; run again when it ends. */
  private budgetsDirty = false
  /** Makes each created view id unique, so a replacement never collides with one still being destroyed. */
  private viewGeneration = 0
  /** At most one browser page creation per tab, including after an unexpected loss. */
  private creatingViews = new Map<string, Promise<void>>()
  /** Explicit close/eviction must never be mistaken for an unexpected lost page. */
  private releasingViews = new Set<string>()
  private budgetEvictionCallbacks: Set<BudgetEvictionCallback> = new Set()

  /** Tab id -> activation sequence number; larger = used more recently. */
  private lastActivated = new Map<string, number>()
  private activationSeq = 0
  private revealSeq = 0

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
   * What closing tabs ends (see CanvasClosePolicy). Absent a policy (its host
   * not mounted) tabs close and what they run keeps running. A removed space's
   * tabs wait for the next policy instead: spaces are removed from the spaces
   * list, where the host is not mounted, and nothing else could reach them.
   */
  private closePolicy: CanvasClosePolicy | null = null
  private pendingRemovals: TabState[] = []
  /** Spaces removed in this session: the AI's work there gets no new tab. */
  private removedSpaces = new Set<string>()
  /** AI tab id -> when its work was last active, to pick a tab when the canvas opens with none chosen. */
  private aiActivity = new Map<string, number>()

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
        blockedPopupHost: event.state.blockedPopupHost,
        blockedPopupSequence: event.state.blockedPopupSequence,
      }
      const changes = (tab: TabState) => ({
        browserState,
        url: event.state.url || tab.url,
        title: event.state.title || tab.title,
        isLoading: event.state.isLoading ?? tab.isLoading,
        // Sync error to tab level (e.g. browser policy block during navigation)
        error: event.state.error,
      })

      for (const [tabId, tab] of this.tabs) {
        if (tab.browserViewId === event.viewId) {
          // The tab list hears about this only when a field it shows changed
          // (title, loading, error) — a page's own churn stays on the
          // browser-state channel its viewer subscribes to.
          this.patchTab(tabId, changes(tab))
          this.notifyBrowserStateChange(tabId, browserState)
          return
        }
      }
      // The AI goes on using a page while its tab waits in a space not on screen.
      this.patchParkedTab(tab => tab.browserViewId === event.viewId, changes)
    })

    this.browserPageGoneUnsubscribe = api.onBrowserPageGone(({ viewId, reason }) => this.handleBrowserPageGone(viewId, reason))
    this.browserTabOpenedUnsubscribe = api.onBrowserTabOpened(event => {
      void this.attachWebsiteTab(event).catch(error => {
        console.error('[CanvasLifecycle] Website tab attachment failed', { viewId: event.viewId }, error)
        if (!event.borrowed) void api.destroyBrowserView(event.viewId)
      })
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
    gitDiscovery.forget()

    if (this.browserStateUnsubscribe) {
      this.browserStateUnsubscribe()
      this.browserStateUnsubscribe = null
    }

    this.browserPageGoneUnsubscribe?.()
    this.browserPageGoneUnsubscribe = null
    this.browserTabOpenedUnsubscribe?.()
    this.browserTabOpenedUnsubscribe = null

    if (this.artifactChangedUnsubscribe) {
      this.artifactChangedUnsubscribe()
      this.artifactChangedUnsubscribe = null
    }

    this.memoryPressureUnsubscribe?.()
    this.memoryPressureUnsubscribe = null

    // Release every tab's page; nothing is asked or ended on the way out.
    this.closePolicy = null
    void this.closeAll()
    for (const spaceId of [...this.parkedSpaces.keys()]) void this.forgetSpace(spaceId)
    this.spaceHold?.release()
    this.spaceHold = null

    console.log('[CanvasLifecycle] Destroyed')
  }

  /**
   * Set the container bounds getter function
   * Called by BrowserViewer to provide DOM reference
   */
  setContainerBoundsGetter(getter: () => DOMRect | null): () => void {
    this.containerBoundsGetter = getter
    return () => {
      if (this.containerBoundsGetter === getter) this.containerBoundsGetter = null
    }
  }

  // ============================================
  // Tab Management
  // ============================================

  /**
   * Open a file in the canvas
   * Uses fast path for known extensions, backend detection for unknown ones.
   * With `reveal`, the viewer shows that place once the content is in.
   */
  async openFile(path: string, titleOrOptions?: string | OpenFileOptions): Promise<string> {
    const { title, reveal } = typeof titleOrOptions === 'string' ? { title: titleOrOptions, reveal: undefined } : titleOrOptions ?? {}
    // Check if file is already open
    for (const [tabId, tab] of this.tabs) {
      if (tab.path === path) {
        if (reveal) this.patchTab(tabId, { reveal: this.createRevealRequest(reveal) })
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

    // Desktop uses Chromium's native PDF viewer; remote clients load bytes for pdfjs.
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
      ...(reveal ? { reveal: this.createRevealRequest(reveal) } : {}),
    }

    this.addTab(tab)

    // Switch to new tab
    await this.switchTab(tabId)

    // Load content (async)
    this.loadFileContent(tabId, path, type)

    return tabId
  }

  /** A reveal request for `target`, distinct from every earlier one. */
  createRevealRequest(target: RevealTarget): RevealRequest {
    this.revealSeq += 1
    return { ...target, seq: this.revealSeq }
  }

  /** Shows `target` in an open tab, activating it. */
  async revealInTab(tabId: string, target: RevealTarget): Promise<void> {
    if (!this.tabs.has(tabId)) return
    this.patchTab(tabId, { reveal: this.createRevealRequest(target) })
    this.setOpen(true)
    await this.switchTab(tabId)
  }

  /** The viewer handled the reveal request `seq`; a newer request is kept. */
  consumeReveal(tabId: string, seq: number): void {
    if (this.tabs.get(tabId)?.reveal?.seq === seq) this.patchTab(tabId, { reveal: undefined })
  }

  private async openPdf(path: string, title?: string): Promise<string> {
    const tabId = generateTabId()
    // Native PDF guests navigate directly to the file; the app never reads its bytes.
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

    await this.switchTab(tabId)

    return tabId
  }

  /** Navigation survives a viewer unmount while its guest is still being created. */
  async navigateBrowserTab(tabId: string, url: string): Promise<void> {
    const tab = this.tabs.get(tabId)
    if (!tab || (tab.type !== 'browser' && tab.type !== 'pdf')) return
    if (!tab.browserViewId) await this.createBrowserView(tabId, 'about:blank')
    const current = this.tabs.get(tabId)
    if (!current?.browserViewId) return
    await api.navigateBrowserView(current.browserViewId, url)
  }

  private async attachWebsiteTab(event: BrowserTabOpened): Promise<void> {
    const opener = [...this.tabs.values()].find(tab => tab.browserViewId === event.openerViewId)
    if (!opener) {
      console.warn('[CanvasLifecycle] Website tab discarded because its opener left this canvas', { viewId: event.viewId })
      if (!event.borrowed) await api.destroyBrowserView(event.viewId)
      return
    }
    if ([...this.tabs.values()].some(tab => tab.browserViewId === event.viewId)) return
    const foreground = !event.background && this.activeTabId === opener.id && this.isOpen
    const tabId = generateTabId()
    this.addTab({
      id: tabId,
      type: 'browser',
      title: event.title,
      url: event.url,
      isDirty: false,
      isLoading: true,
      browserViewId: event.viewId,
      browserViewOwned: !event.borrowed,
      browserState: { isLoading: true, canGoBack: false, canGoForward: false },
    }, false)
    if (foreground) {
      await this.switchTab(tabId)
    } else {
      await this.applyBudgets()
    }
  }

  /** Borrows an AI page without changing its owner or guest identity. */
  async attachAIBrowserView(viewId: string, url: string, title?: string): Promise<string> {
    // Check if this view is already attached
    for (const [tabId, tab] of this.tabs) {
      if (tab.browserViewId === viewId) {
        this.setOpen(true)
        await this.switchTab(tabId)
        return tabId
      }
    }

    // Create tab with existing browserViewId
    const tabId = generateTabId()
    const tab: NewTab = {
      id: tabId,
      type: 'browser',
      title: pageTitle(url || null, title ?? null),
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
   * (TerminalViewer). Dedups by session id. With `reveal`,
   * the viewer shows that output once its replay is in.
   */
  async openTerminal(sessionId: string, title?: string, options: { reveal?: RevealTarget } = {}): Promise<string> {
    const reveal = options.reveal ? this.createRevealRequest(options.reveal) : undefined
    for (const [tabId, tab] of this.tabs) {
      if (tab.type === 'terminal' && tab.terminalSessionId === sessionId) {
        if (reveal) this.patchTab(tabId, { reveal })
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
      ...(reveal ? { reveal } : {}),
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

  /**
   * Open the changes view for `source`, reusing its tab: one per space for Git,
   * one per reply for the edits a reply made.
   */
  async openChanges(source: ChangesSource, options: { reveal?: RevealTarget } = {}): Promise<string> {
    const reveal = options.reveal ? this.createRevealRequest(options.reveal) : undefined
    for (const [tabId, tab] of this.tabs) {
      if (tab.type === 'changes' && tab.changes && isSameChangesSource(tab.changes, source)) {
        if (reveal) this.patchTab(tabId, { reveal })
        this.setOpen(true)
        await this.switchTab(tabId)
        return tabId
      }
    }

    const tabId = generateTabId()
    const tab: NewTab = {
      id: tabId,
      type: 'changes',
      title: source.kind === 'message' ? `${i18n.t('Changes')} · ${source.title}` : i18n.t('Changes'),
      changes: source,
      reveal,
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
  setTerminalTitle(sessionId: string, title: string, spaceId?: string): void {
    const isSession = (tab: TabState) => tab.type === 'terminal' && tab.terminalSessionId === sessionId
    if (spaceId) {
      for (const tab of this.spaceTabs(spaceId)?.values() ?? []) {
        if (isSession(tab) && tab.title !== title) this.updateSpaceTab(spaceId, tab, { title })
      }
      return
    }
    for (const [, tab] of this.tabs) {
      if (isSession(tab)) {
        this.patchTab(tab.id, { title })
        return
      }
    }
    // A terminal keeps running while its tab waits in a space not on screen.
    this.patchParkedTab(isSession, () => ({ title }))
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
   * Register what closing tabs ends (CanvasCloseGuard). Returns an unsubscribe
   * function. Only one policy is active at a time.
   */
  setClosePolicy(policy: CanvasClosePolicy): () => void {
    this.closePolicy = policy
    void this.endRemovedTabs(this.pendingRemovals.splice(0))
    return () => {
      if (this.closePolicy === policy) this.closePolicy = null
    }
  }

  // ============================================
  // The AI's work as tabs
  // ============================================

  /**
   * Bring every space's tabs in line with the AI's live work there, given for
   * each space that has any (services/ai-work-tabs). New work gets a tab at the
   * end of its space's tabs without opening the canvas or switching tabs, in a
   * space not on screen too. Work that ended loses its mark; a terminal nobody
   * ever looked at loses its tab as well.
   */
  syncAIWork(work: ReadonlyMap<string, readonly AIWorkItem[]>, changedSpaces?: ReadonlySet<string>): void {
    if (changedSpaces) {
      for (const spaceId of changedSpaces) this.syncSpaceAIWork(spaceId, work.get(spaceId) ?? [])
      return
    }
    const spaces = new Set(work.keys())
    if (this.currentSpaceId && [...this.tabs.values()].some(tab => tab.aiWork)) spaces.add(this.currentSpaceId)
    for (const [spaceId, parked] of this.parkedSpaces) {
      if ([...parked.tabs.values()].some(tab => tab.aiWork)) spaces.add(spaceId)
    }
    for (const spaceId of spaces) this.syncSpaceAIWork(spaceId, work.get(spaceId) ?? [])
  }

  /** Make sure one piece of AI work has its tab in `spaceId`; returns the tab id. */
  ensureAIWorkTab(spaceId: string, item: AIWorkItem): string | null {
    if (this.removedSpaces.has(spaceId)) return null
    const shows = (tab: TabState) => item.kind === 'terminal'
      ? tab.type === 'terminal' && tab.terminalSessionId === item.sessionId
      : tab.browserViewId === item.viewId
    const existing = [...this.spaceTabs(spaceId)?.values() ?? []].find(shows)
    if (existing) return existing.id
    const tab = aiWorkTab(item)
    this.aiActivity.set(tab.id, item.activityAt)
    this.addTabToSpace(spaceId, tab)
    return tab.id
  }

  /**
   * Make sure a file has a tab in `spaceId` without opening the canvas or
   * switching to it; its content is read when the tab is first shown.
   */
  ensureFileTab(spaceId: string, path: string, presenting = false): string | null {
    if (this.removedSpaces.has(spaceId)) return null
    const tabs = this.spaceTabs(spaceId)
    let counted = 0
    let evictable = 0
    for (const tab of tabs?.values() ?? []) {
      if (tab.path === path) return tab.id
      if (!tab.aiWork) counted++
      if (canEvictTab(tab)) evictable++
    }
    // A quiet request cannot displace the user's tabs. A reveal protects its
    // new tab as active and lets the ordinary eviction rule make room.
    if (counted >= MAX_OPEN_TABS &&
      (!presenting || spaceId !== this.currentSpaceId || evictable <= counted - MAX_OPEN_TABS)) return null
    const { type, language } = detectContentType(path)
    const nativePdf = type === 'pdf' && !api.isRemoteMode()
    const tab: NewTab = {
      id: generateTabId(),
      type,
      title: getFileName(path),
      path,
      language,
      isDirty: false,
      isLoading: false,
      ...(nativePdf
        ? { url: `file://${encodeURI(path)}`, browserState: { isLoading: true, canGoBack: false, canGoForward: false } }
        : { contentUnloaded: true }),
    }
    this.addTabToSpace(spaceId, tab)
    return tab.id
  }

  /**
   * Pages whose conversation ended stay open as the user's own: their tabs now
   * own them, so closing such a tab ends the page like any page the user opened.
   */
  adoptPages(viewIds: readonly string[]): void {
    const adopted = new Set(viewIds)
    const adopt = (tab: TabState) => tab.browserViewId && adopted.has(tab.browserViewId) && tab.browserViewOwned === false
    for (const tab of [...this.tabs.values()]) {
      if (adopt(tab)) this.patchTab(tab.id, { browserViewOwned: true, aiWork: undefined })
    }
    for (const parked of this.parkedSpaces.values()) {
      for (const tab of [...parked.tabs.values()]) {
        if (adopt(tab)) parked.tabs.set(tab.id, { ...tab, browserViewOwned: true, aiWork: undefined })
      }
    }
  }

  updateAIPageMetadata(spaceId: string, viewId: string, url: string | null, title: string | null): void {
    const displayTitle = pageTitle(url, title)
    for (const tab of this.spaceTabs(spaceId)?.values() ?? []) {
      if (tab.browserViewId === viewId && (tab.title !== displayTitle || tab.url !== (url ?? undefined))) {
        this.updateSpaceTab(spaceId, tab, { title: displayTitle, url: url ?? undefined })
      }
    }
  }

  /** Whether the user ever looked at the tab (it was the active tab at some point). */
  private wasViewed(tabId: string, lastActivated: ReadonlyMap<string, number>): boolean {
    return lastActivated.has(tabId)
  }

  /** The tabs of a space, shown or parked; undefined when it has none. */
  private spaceTabs(spaceId: string): Map<string, TabState> | undefined {
    if (spaceId === this.currentSpaceId) return this.tabs
    return this.parkedSpaces.get(spaceId)?.tabs
  }

  /** Adds a tab to a space's tabs without opening the canvas or switching to it. */
  private addTabToSpace(spaceId: string, tab: NewTab): void {
    if (spaceId === this.currentSpaceId) {
      this.addTab(tab, false)
      return
    }
    let parked = this.parkedSpaces.get(spaceId)
    if (!parked) {
      parked = { tabs: new Map(), activeTabId: null, isOpen: false, lastActivated: new Map() }
      this.parkedSpaces.set(spaceId, parked)
    }
    parked.tabs.set(tab.id, parkedForm({ ...tab, view: {} }))
  }

  private syncSpaceAIWork(spaceId: string, items: readonly AIWorkItem[]): void {
    if (this.removedSpaces.has(spaceId)) return
    const wanted = new Map(items.map(item => [aiWorkKey(item), item]))
    const shown = spaceId === this.currentSpaceId
    const parked = shown ? undefined : this.parkedSpaces.get(spaceId)
    const tabs = shown ? this.tabs : parked?.tabs
    const lastActivated = shown ? this.lastActivated : parked?.lastActivated ?? new Map<string, number>()

    for (const tab of [...tabs?.values() ?? []]) {
      const key = aiWorkKeyOf(tab)
      const item = key ? wanted.get(key) : undefined
      if (item) {
        wanted.delete(key!)
        this.aiActivity.set(tab.id, item.activityAt)
        if (!tab.aiWork) this.updateSpaceTab(spaceId, tab, { aiWork: true })
        continue
      }
      if (!tab.aiWork) continue
      this.aiActivity.delete(tab.id)
      if (tab.type === 'terminal' && !this.wasViewed(tab.id, lastActivated)) {
        this.dropSpaceTab(spaceId, tab.id)
      } else {
        this.updateSpaceTab(spaceId, tab, { aiWork: undefined })
      }
    }

    for (const item of wanted.values()) {
      const tab = aiWorkTab(item)
      this.aiActivity.set(tab.id, item.activityAt)
      this.addTabToSpace(spaceId, tab)
    }
  }

  private updateSpaceTab(spaceId: string, tab: TabState, patch: Partial<Omit<TabState, 'id' | 'view'>>): void {
    if (spaceId === this.currentSpaceId) {
      this.patchTab(tab.id, patch)
      return
    }
    this.parkedSpaces.get(spaceId)?.tabs.set(tab.id, { ...tab, ...patch })
  }

  /** Removes a tab that holds no view and was never viewed (so it is not the active one). */
  private dropSpaceTab(spaceId: string, tabId: string): void {
    this.aiActivity.delete(tabId)
    if (spaceId === this.currentSpaceId) {
      if (!this.tabs.delete(tabId)) return
      this.lastActivated.delete(tabId)
      if (this.activeTabId === tabId) this.activeTabId = null
      if (this.tabs.size === 0) this.setOpen(false)
      this.notifyTabListChange()
      return
    }
    const parked = this.parkedSpaces.get(spaceId)
    if (!parked) return
    parked.tabs.delete(tabId)
    parked.lastActivated.delete(tabId)
    if (parked.activeTabId === tabId) parked.activeTabId = null
    if (parked.tabs.size === 0) this.parkedSpaces.delete(spaceId)
  }

  /**
   * The tab to show when the canvas opens with none chosen: the one looked at
   * last, else the AI's most recently active work, else the last tab.
   */
  private resumeTabId(): string | null {
    let best: string | null = null
    let bestSeq = -1
    for (const tabId of this.tabs.keys()) {
      const seq = this.lastActivated.get(tabId)
      if (seq !== undefined && seq > bestSeq) {
        best = tabId
        bestSeq = seq
      }
    }
    if (best) return best
    let latest = -1
    for (const tabId of this.tabs.keys()) {
      const at = this.aiActivity.get(tabId)
      if (at !== undefined && at > latest) {
        best = tabId
        latest = at
      }
    }
    return best ?? [...this.tabs.keys()].pop() ?? null
  }

  /**
   * Register the prompt asked before a dirty tab of `type` is closed by the
   * user, one tab at a time or all at once. Returns an unsubscribe function.
   * Removing a space closes its tabs without asking.
   */
  setDirtyCloseGuard(type: ContentType, guard: (tab: TabState) => Promise<boolean>): () => void {
    this.dirtyCloseGuards.set(type, guard)
    return () => {
      if (this.dirtyCloseGuards.get(type) === guard) this.dirtyCloseGuards.delete(type)
    }
  }

  /**
   * An AI owner ended the page. Owned Canvas pages instead follow the general
   * browser page-loss event so they can recover independently of AI sessions.
   */
  async closeTabsOfGoneView(viewId: string): Promise<void> {
    const isGone = (tab: TabState) => tab.browserViewId === viewId && (!tab.browserViewOwned || api.isRemoteMode())
    for (const [spaceId, parked] of this.parkedSpaces) {
      for (const tab of [...parked.tabs.values()]) {
        if (!isGone(tab)) continue
        parked.tabs.delete(tab.id)
        parked.lastActivated.delete(tab.id)
        this.aiActivity.delete(tab.id)
      }
      if (parked.tabs.size === 0) this.parkedSpaces.delete(spaceId)
      else if (parked.activeTabId && !parked.tabs.has(parked.activeTabId)) parked.activeTabId = [...parked.tabs.keys()].pop()!
    }
    const stale = [...this.tabs.values()].filter(isGone)
    for (const tab of stale) await this.removeTab(tab.id, false)
  }

  private handleBrowserPageGone(viewId: string, reason: 'closed' | 'lost'): void {
    if (this.releasingViews.has(viewId)) return
    for (const tab of this.tabs.values()) {
      if (tab.browserViewId !== viewId || !tab.browserViewOwned) continue
      if (reason === 'closed') {
        void this.removeTab(tab.id).catch(error => {
          console.error('[CanvasLifecycle] Closing a browser tab failed:', viewId, error)
        })
        continue
      }
      const browserState: BrowserState = { isLoading: true, canGoBack: false, canGoForward: false }
      this.patchTab(tab.id, {
        browserViewId: undefined,
        browserViewOwned: undefined,
        browserState,
        error: undefined,
        isLoading: true,
      })
      this.notifyBrowserStateChange(tab.id, browserState)
      console.warn('[CanvasLifecycle] Browser page lost; releasing its tab attachment:', viewId)
      void this.restoreLostBrowserPage(tab.id).catch(error => {
        console.error('[CanvasLifecycle] Restoring a lost browser page failed:', viewId, error)
      })
    }
  }

  private async restoreLostBrowserPage(tabId: string): Promise<void> {
    await this.creatingViews.get(tabId)
    const tab = this.tabs.get(tabId)
    if (!tab || (tab.type !== 'browser' && tab.type !== 'pdf') || tab.browserViewId || this.activeTabId !== tabId || !this.isOpen) return
    await this.createBrowserView(tabId, tab.url || 'about:blank')
  }

  /**
   * The user closes one tab: unsaved edits and what the tab runs (a terminal,
   * the AI's page) are asked about first, and the tab stays if either says no.
   */
  async closeTab(tabId: string): Promise<void> {
    const tab = this.tabs.get(tabId)
    if (!tab) return

    const dirtyGuard = tab.isDirty ? this.dirtyCloseGuards.get(tab.type) : undefined
    if (dirtyGuard && !(await dirtyGuard(tab))) {
      console.log(`[CanvasLifecycle] Close of dirty tab ${tabId} cancelled by user`)
      return
    }

    const current = this.tabs.get(tabId)
    if (!current) return
    if (this.closePolicy && !(await this.closePolicy.closeOne(current))) return
    await this.removeTab(tabId)
  }

  /** Removes a tab, releasing its page per ownership; asks nothing and ends nothing else. */
  private async removeTab(tabId: string, releaseView = true): Promise<void> {
    const tab = this.tabs.get(tabId)
    if (!tab) return

    // Tear the tab's view down per ownership: a page a conversation holds is
    // only hidden here; ending it is the close policy's decision.
    const hasBrowserView = (tab.type === 'browser' || tab.type === 'pdf') && tab.browserViewId
    if (releaseView && hasBrowserView) {
      await this.releaseBrowserView(tab)
    }

    // Remove tab
    if (!this.tabs.delete(tabId)) return
    this.tabsSnapshot = null
    this.lastActivated.delete(tabId)
    this.aiActivity.delete(tabId)

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
   * Close every tab and the canvas. `confirmDirty` is for a close the user
   * asked for: each dirty tab with a guard asks first, and one "keep" cancels
   * the whole close. Tabs the close policy keeps (the AI's work the user chose
   * to keep) stay, with the canvas collapsed.
   */
  async closeAll(options?: { confirmDirty?: boolean }): Promise<void> {
    await this.closeTabs([...this.tabs.keys()], { confirmDirty: options?.confirmDirty, collapse: true })
  }

  /**
   * Close several tabs at once (close others, close to the right, close all).
   * Unsaved edits are asked about one by one; the close policy is asked once
   * for the lot and may keep some (the AI's work) or cancel. `collapse` closes
   * the canvas too, leaving whatever was kept behind its edge handle.
   */
  async closeTabs(tabIds: readonly string[], options: { confirmDirty?: boolean; collapse?: boolean } = {}): Promise<void> {
    // A space switch during any await below parks these tabs and shows another
    // space's, which this close was not asked for.
    const generation = this.parkGeneration
    const spaceChanged = () => {
      if (this.parkGeneration === generation) return false
      console.log('[CanvasLifecycle] Closing tabs stopped: the space changed while it ran')
      return true
    }
    const targets = () => tabIds.flatMap(id => this.tabs.get(id) ?? [])

    if (options.confirmDirty) {
      for (const tab of targets()) {
        const dirtyGuard = tab.isDirty ? this.dirtyCloseGuards.get(tab.type) : undefined
        if (!dirtyGuard || !this.tabs.has(tab.id)) continue
        await this.switchTab(tab.id)
        if (spaceChanged()) return
        if (!(await dirtyGuard(tab))) {
          console.log(`[CanvasLifecycle] Closing tabs cancelled by user at dirty tab ${tab.id}`)
          return
        }
        if (spaceChanged()) return
      }
    }

    let keep: ReadonlySet<string> = new Set()
    if (this.closePolicy) {
      const decision = await this.closePolicy.closeMany(targets())
      if (spaceChanged() || !decision) return
      keep = decision.keep
    }

    const closing = targets().filter(tab => !keep.has(tab.id))
    for (const tab of closing) {
      const hasBrowserView = (tab.type === 'browser' || tab.type === 'pdf') && tab.browserViewId
      if (!hasBrowserView) continue
      await this.releaseBrowserView(tab)
      if (spaceChanged()) return
    }

    for (const tab of closing) {
      this.tabs.delete(tab.id)
      this.lastActivated.delete(tab.id)
      this.aiActivity.delete(tab.id)
    }
    this.tabsSnapshot = null
    const activeClosed = this.activeTabId !== null && !this.tabs.has(this.activeTabId)
    if (options.collapse || this.tabs.size === 0) {
      if (activeClosed) this.activeTabId = null
      this.setOpen(false)
      this.notifyTabListChange()
      if (activeClosed) this.notifyActiveTabChange()
      return
    }
    this.notifyTabListChange()
    if (activeClosed) {
      const next = this.resumeTabId()
      if (next) await this.switchTab(next)
    }
  }

  async switchTab(tabId: string, { open = false } = {}): Promise<void> {
    const tab = this.tabs.get(tabId)
    if (!tab) {
      console.warn(`[CanvasLifecycle] Tab not found: ${tabId}`)
      return
    }

    const previousTabId = this.activeTabId
    const previousTab = previousTabId ? this.tabs.get(previousTabId) : null

    const spaceId = this.currentSpaceId
    const activation = ++this.activationSeq
    this.activeTabId = tabId
    this.lastActivated.set(tabId, activation)
    if (spaceId && tab.path && tab.type !== 'changes') {
      gitDiscovery.noteFile(spaceId, tab.path)
    }

    const prevNeedsBrowserView = previousTab?.type === 'browser' || previousTab?.type === 'pdf'
    if (prevNeedsBrowserView && previousTab.browserViewId && previousTabId !== tabId) {
      const hide = this.hideBrowserView(previousTab.browserViewId)
      if (open) {
        // A reveal commits in this stack. A delayed hide must never open the
        // canvas in whatever space the user has since moved to.
        void hide.catch(error => console.warn('[CanvasLifecycle] Could not hide the previous page during reveal', { tabId: previousTabId, error }))
      } else {
        await hide
      }
    }

    const current = this.tabs.get(tabId)
    if (!current || this.currentSpaceId !== spaceId || this.activeTabId !== tabId || this.lastActivated.get(tabId) !== activation) return

    // The outgoing viewer still owns the bounds; the new viewer presents after commit.
    const needsBrowserView = current.type === 'browser' || current.type === 'pdf'
    if (needsBrowserView && !current.browserViewId) {
      // Creation must not delay the tab switch; navigation state arrives by event.
      this.createBrowserView(tabId, current.url || 'about:blank').catch(err => {
        console.error(`[CanvasLifecycle] Failed to create browser page for tab ${tabId}:`, err)
      })
    }

    if (current.contentUnloaded && current.path) {
      this.patchTab(tabId, { contentUnloaded: false, isLoading: true, error: undefined })
      void this.loadFileContent(tabId, current.path, current.type)
    }

    this.notifyActiveTabChange()
    if (open) this.setOpen(true)
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
      return !!tab && tabId !== this.activeTabId && canEvictTab(tab)
    }
    if (!untouched()) return false
    const tab = this.tabs.get(tabId)!
    if (tab.browserViewId) {
      this.patchTab(tabId, { browserViewId: undefined, browserViewOwned: undefined })
      await this.releaseBrowserView(tab)
      if (!untouched()) return false
    }
    await this.removeTab(tabId)
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
  // Browser Page Lifecycle
  // ============================================

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
    try {
      const result = await api.createBrowserView(viewId, url)

      // The tab was closed, or got a view another way, while this one was
      // being created: nothing would ever reference it, so it goes now.
      const current = this.tabs.get(tabId)
      if (!current || (current.browserViewId && current.browserViewId !== viewId)) {
        if (result.success) {
          await api.destroyBrowserView(viewId)
        }
        return
      }

      if (result.success) {
        this.patchTab(tabId, { browserViewId: viewId, browserViewOwned: true })
        void this.applyBudgets()

        // Creation may finish after the user switched away from this tab.
        if (this.activeTabId === tabId && this.isOpen) await this.showBrowserView(viewId)
      } else if ((result as { code?: string }).code === 'BROWSER_POLICY_BLOCKED') {
        // No guest exists yet; the policy overlay still needs to offer allow-and-retry.
        console.warn('[CanvasLifecycle] Browser page creation blocked by policy:', viewId)
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
        console.error(`[CanvasLifecycle] Failed to create browser page ${viewId}: ${result.error}`)
        this.patchTab(tabId, { error: result.error || 'Failed to create browser view', isLoading: false })
      }
    } catch (error) {
      console.error('[CanvasLifecycle] Browser page creation failed:', viewId, error)
      this.patchTab(tabId, { error: (error as Error).message, isLoading: false })
    }
  }

  /**
   * Retry a tab whose page creation was blocked by browser policy
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

    await api.showBrowserView(viewId, {
      x: Math.round(bounds.left),
      y: Math.round(bounds.top),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    })
  }

  private async hideBrowserView(viewId: string): Promise<void> {
    await api.hideBrowserView(viewId)
  }

  private async destroyBrowserView(viewId: string): Promise<void> {
    this.releasingViews.add(viewId)
    try {
      await api.hideBrowserView(viewId)
      await api.destroyBrowserView(viewId)
    } finally {
      this.releasingViews.delete(viewId)
    }
  }

  /**
   * Give up a tab's browser page, destroying it only if the Canvas owns it.
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
    await this.hideBrowserView(tab.browserViewId)
  }

  async updateActiveBounds(): Promise<void> {
    if (!this.activeTabId) return

    const tab = this.tabs.get(this.activeTabId)
    const hasBrowserView = (tab?.type === 'browser' || tab?.type === 'pdf') && tab.browserViewId
    if (hasBrowserView) {
      await this.resizeBrowserView(tab.browserViewId!)
    }
  }

  /**
   * The viewer calls this after mounting, when its presentation surface exists.
   */
  async ensureActiveBrowserViewShown(): Promise<void> {
    if (!this.activeTabId) return

    const tab = this.tabs.get(this.activeTabId)
    const hasBrowserView = (tab?.type === 'browser' || tab?.type === 'pdf') && tab.browserViewId
    if (hasBrowserView) {
      await this.showBrowserView(tab.browserViewId!)
    }
  }

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

  async hideActiveBrowserView(): Promise<void> {
    if (!this.activeTabId) return

    const tab = this.tabs.get(this.activeTabId)
    const hasBrowserView = (tab?.type === 'browser' || tab?.type === 'pdf') && tab.browserViewId
    if (hasBrowserView) {
      await this.hideBrowserView(tab.browserViewId!)
    }
  }

  /**
   * Leaving the space page parks guests while retaining their tabs and owners.
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
    if (!tab) {
      // A save that finished after its space was left.
      this.patchParkedTab(parked => parked.id === tabId, parked => ({
        content: content ?? parked.content,
        isDirty: false,
        savedContent: undefined,
        diskConflict: false,
      }))
      return
    }
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

    // Tabs the AI added quietly may be all there is: open on one of them.
    if (open && !this.activeTabId) {
      const resume = this.resumeTabId()
      if (resume) void this.switchTab(resume)
    }

    this.isOpen = open
    this.isTransitioning = true

    // Only hiding belongs here. Showing needs the canvas container's bounds, and
    // the container is BrowserViewer's — it mounts with the canvas, after this.
    if (!open) {
      this.hideActiveBrowserView()
    }

    this.notifyOpenStateChange()

    const activeTabId = this.activeTabId
    if (open && activeTabId) {
      void this.restoreLostBrowserPage(activeTabId).catch(error => {
        console.error('[CanvasLifecycle] Restoring the expanded browser page failed:', activeTabId, error)
      })
    }

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

  /** Whether a tab is still kept in its original space, even if parked. */
  hasSpaceTab(spaceId: string, tabId: string): boolean {
    return !this.removedSpaces.has(spaceId) && !!this.spaceTabs(spaceId)?.has(tabId)
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
   * Called when entering a space; the single point of control for which
   * space's tabs the canvas shows. Each space keeps its own: the tabs on
   * screen are parked as they are (unsaved edits, running terminals, scroll)
   * and the entered space's come back as it was left. Tabs opened before any
   * space was entered stay with the first one.
   *
   * The space id and the tabs are swapped synchronously, so a second caller
   * for the same space during the awaits — SpacePage's mount effect while a
   * tray reveal is still awaiting — short-circuits instead of swapping again.
   */
  async enterSpace(spaceId: string): Promise<void> {
    const previousSpaceId = this.currentSpaceId
    this.currentSpaceId = spaceId
    // A space removed and added back is a space again.
    this.removedSpaces.delete(spaceId)
    if (!previousSpaceId && this.parkedSpaces.has(spaceId)) {
      // The AI's work that got its tabs before any space was entered joins the tabs already shown.
      this.mergeParked(spaceId)
      return
    }
    if (!previousSpaceId || previousSpaceId === spaceId || (this.tabs.size === 0 && !this.parkedSpaces.has(spaceId))) {
      this.syncSpaceHold()
      return
    }

    console.log(`[CanvasLifecycle] Space switch: parking ${this.tabs.size} tab(s), restoring ${this.parkedSpaces.get(spaceId)?.tabs.size ?? 0}`)
    // The space left behind lets go of its pages on its own; the one entered need not wait.
    void this.parkShown(previousSpaceId)
    const parked = this.parkedSpaces.get(spaceId)
    this.parkedSpaces.delete(spaceId)
    await this.showParked(parked)
  }

  /**
   * Closes a space's tabs for good, shown or parked: the space was deleted or
   * removed from the list. Without asking, what they run ends with them.
   */
  async forgetSpace(spaceId: string): Promise<void> {
    gitDiscovery.forget(spaceId)
    this.removedSpaces.add(spaceId)
    const released = spaceId === this.currentSpaceId ? this.parkShown(spaceId) : undefined
    const parked = this.parkedSpaces.get(spaceId)
    this.parkedSpaces.delete(spaceId)
    const shown = released ? this.showParked(undefined) : undefined
    const tabs = [...parked?.tabs.values() ?? []]
    for (const tab of tabs) this.aiActivity.delete(tab.id)
    // A parked borrowed page can become canvas-owned after the space was left.
    const adopted = tabs.filter(tab => tab.browserViewId && tab.browserViewOwned)
    const releasedAdopted = adopted.map(tab => this.releaseBrowserView(tab).catch(error => {
      console.error('[CanvasLifecycle] Could not release a removed workspace page', { spaceId, viewId: tab.browserViewId, error })
    }))
    await Promise.all([released, shown, ...releasedAdopted, this.endRemovedTabs(tabs)])
  }

  private mergeParked(spaceId: string): void {
    const parked = this.parkedSpaces.get(spaceId)
    if (!parked) return
    this.parkedSpaces.delete(spaceId)
    for (const [tabId, tab] of parked.tabs) this.tabs.set(tabId, tab)
    for (const [tabId, seq] of parked.lastActivated) this.lastActivated.set(tabId, seq)
    this.notifyTabListChange()
  }

  /**
   * Moves the tabs on screen aside as `spaceId`'s, leaving none shown. The
   * move is synchronous, so no tab can land in the wrong space; the promise
   * settles once their browser pages are released.
   */
  private parkShown(spaceId: string): Promise<void> {
    this.parkGeneration++
    const releases: Promise<void>[] = []
    if (this.tabs.size > 0) {
      const tabs = new Map<string, TabState>()
      for (const [tabId, tab] of this.tabs) {
        let parked = parkedForm(tab)
        if (tab.browserViewId) {
          // Its own page is made again from its url when shown; an AI page is
          // only hidden, its conversation keeps it.
          releases.push(this.releaseBrowserView(tab))
          if (tab.browserViewOwned) parked = { ...parked, browserViewId: undefined, browserViewOwned: undefined }
        }
        tabs.set(tabId, parked)
      }
      this.parkedSpaces.set(spaceId, {
        tabs,
        activeTabId: this.activeTabId,
        isOpen: this.isOpen,
        lastActivated: this.lastActivated,
      })
    }
    this.tabs = new Map()
    this.tabsSnapshot = null
    this.lastActivated = new Map()
    this.activeTabId = null
    return Promise.allSettled(releases).then(results => {
      for (const result of results) {
        if (result.status === 'rejected') console.error('[CanvasLifecycle] Releasing a parked tab\'s browser page failed:', result.reason)
      }
    })
  }

  /**
   * Shows `parked` as it was left, or no tabs. The space's files were not
   * watched while it was away: the file tabs read their file again when shown,
   * and unsaved edits are checked against what is on disk now.
   */
  private showParked(parked: ParkedSpace | undefined): Promise<void> {
    if (parked) {
      this.tabs = parked.tabs
      this.lastActivated = parked.lastActivated
    }
    this.tabsSnapshot = null
    this.notifyTabListChange()
    const activated = parked?.activeTabId ? this.switchTab(parked.activeTabId) : undefined
    if (!activated) this.notifyActiveTabChange()
    this.setOpen(parked?.isOpen ?? false)
    for (const tab of this.tabs.values()) {
      if (tab.isDirty && tab.path) void this.checkDiskConflict(tab.id)
    }
    return activated ?? Promise.resolve()
  }

  private async endRemovedTabs(tabs: TabState[]): Promise<void> {
    if (tabs.length === 0) return
    const policy = this.closePolicy
    if (!policy) {
      this.pendingRemovals.push(...tabs)
      return
    }
    try {
      await policy.endRemoved(tabs)
    } catch (error) {
      console.error('[CanvasLifecycle] Ending what a removed space\'s tabs ran failed:', error)
    }
  }

  /**
   * Applies a change to the first parked tab `match` finds. Parked tabs notify
   * no one: nothing renders them until their space is shown again.
   */
  private patchParkedTab(
    match: (tab: TabState) => boolean,
    change: (tab: TabState) => Partial<Omit<TabState, 'id' | 'view'>>
  ): void {
    for (const parked of this.parkedSpaces.values()) {
      for (const tab of parked.tabs.values()) {
        if (!match(tab)) continue
        parked.tabs.set(tab.id, parkedForm({ ...tab, ...change(tab) }))
        return
      }
    }
  }

  // ============================================
  // Tab State Updates
  // ============================================

  private addTab(tab: NewTab, openCanvas = true): void {
    this.tabs.set(tab.id, { ...tab, view: {} })
    this.tabsSnapshot = null
    if (openCanvas) this.setOpen(true)
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
