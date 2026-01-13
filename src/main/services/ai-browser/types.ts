/**
 * AI Browser Types - Type definitions for AI Browser module
 *
 * Defines the core types used throughout the AI Browser system:
 * - Tool definitions compatible with Claude Agent SDK
 * - Accessibility tree node structures
 * - Network and console monitoring types
 */

// ============================================
// Tool System Types
// ============================================

/**
 * JSON Schema for tool parameter definitions
 */
export interface JSONSchema {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object'
  description?: string
  enum?: string[]
  items?: JSONSchema
  properties?: Record<string, JSONSchema>
  required?: string[]
  default?: unknown
}

/**
 * Tool result returned by tool handlers
 */
export interface ToolResult {
  content: string           // Text result
  images?: {                // Optional images (e.g., screenshots)
    data: string            // base64 encoded
    mimeType: string
  }[]
  isError?: boolean
}

/**
 * Tool categories for organization and UI display
 */
export type ToolCategory =
  | 'navigation'    // Navigation tools
  | 'input'         // Input tools
  | 'snapshot'      // Snapshot/debugging tools
  | 'network'       // Network monitoring
  | 'console'       // Console monitoring
  | 'emulation'     // Device/network emulation
  | 'performance'   // Performance tracing

/**
 * AI Browser Tool definition
 * Compatible with Claude Agent SDK tool format
 */
export interface AIBrowserTool {
  name: string
  description: string
  category: ToolCategory
  inputSchema: {
    type: 'object'
    properties: Record<string, JSONSchema>
    required?: string[]
  }
  handler: (
    params: Record<string, unknown>,
    context: BrowserContextInterface
  ) => Promise<ToolResult>
}

// ============================================
// Accessibility Tree Types
// ============================================

/**
 * Accessibility node in the a11y tree
 * Represents a single interactive element on the page
 */
export interface AccessibilityNode {
  uid: string              // Format: {snapshotId}_{nodeIndex}
  role: string             // 'button', 'textbox', 'link', etc.
  name: string             // Accessible name
  value?: string           // Current value (for inputs/selects)
  description?: string     // Accessible description
  focused?: boolean        // Whether element is focused
  checked?: boolean        // Checkbox/radio state
  disabled?: boolean       // Whether element is disabled
  expanded?: boolean       // For expandable elements
  selected?: boolean       // Selection state
  required?: boolean       // Form validation
  level?: number           // Heading level
  children: AccessibilityNode[]

  // Internal - used for element location
  backendNodeId: number    // CDP node ID for element operations
  boundingBox?: {
    x: number
    y: number
    width: number
    height: number
  }
}

/**
 * Complete accessibility snapshot of a page
 */
export interface AccessibilitySnapshot {
  root: AccessibilityNode
  snapshotId: string
  timestamp: number
  url: string
  title: string

  // Lookup table for quick access
  idToNode: Map<string, AccessibilityNode>

  // Format as text for AI consumption
  format(verbose?: boolean): string
}

// ============================================
// Network Monitoring Types
// ============================================

/**
 * HTTP request information
 */
export interface NetworkRequest {
  id: string
  url: string
  method: string
  resourceType: string
  status?: number
  statusText?: string
  mimeType?: string
  requestHeaders?: Record<string, string>
  responseHeaders?: Record<string, string>
  requestBody?: string
  responseBody?: string
  timing?: {
    requestTime: number
    responseTime: number
    duration: number
  }
  error?: string
}

// ============================================
// Console Monitoring Types
// ============================================

/**
 * Console message types
 */
export type ConsoleMessageType = 'log' | 'info' | 'warn' | 'error' | 'debug' | 'trace'

/**
 * Console message information
 */
export interface ConsoleMessage {
  id: string
  type: ConsoleMessageType
  text: string
  timestamp: number
  url?: string
  lineNumber?: number
  stackTrace?: string
  args?: unknown[]
}

// ============================================
// Dialog Types
// ============================================

/**
 * Browser dialog types
 */
export type DialogType = 'alert' | 'confirm' | 'prompt' | 'beforeunload'

/**
 * Dialog information
 */
export interface DialogInfo {
  type: DialogType
  message: string
  defaultPrompt?: string
}

// ============================================
// Context Interface
// ============================================

/**
 * Browser context interface
 * Provides access to the BrowserView and CDP commands
 */
export interface BrowserContextInterface {
  // View management
  getActiveViewId(): string | null
  setActiveViewId(viewId: string): void

  // WebContents access
  getWebContents(): Electron.WebContents | null

  // CDP command execution
  sendCDPCommand<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>

  // Accessibility snapshot
  createSnapshot(verbose?: boolean): Promise<AccessibilitySnapshot>
  getLastSnapshot(): AccessibilitySnapshot | null
  getElementByUid(uid: string): AccessibilityNode | null

  // Network monitoring (aligned with chrome-devtools-mcp: includePreserved param)
  getNetworkRequests(includePreserved?: boolean): NetworkRequest[]
  getNetworkRequest(id: string): NetworkRequest | undefined
  getSelectedNetworkRequest?(): NetworkRequest | undefined
  clearNetworkRequests(): void

  // Console monitoring (aligned with chrome-devtools-mcp: includePreserved param)
  getConsoleMessages(includePreserved?: boolean): ConsoleMessage[]
  getConsoleMessage(id: string): ConsoleMessage | undefined
  clearConsoleMessages(): void

  // Dialog handling
  getPendingDialog(): DialogInfo | null
  handleDialog(accept: boolean, promptText?: string): Promise<void>

  // Element operations
  clickElement(uid: string, options?: { dblClick?: boolean }): Promise<void>
  hoverElement(uid: string): Promise<void>
  fillElement(uid: string, value: string): Promise<void>
  selectOption(uid: string, value: string): Promise<void>
  dragElement(fromUid: string, toUid: string): Promise<void>

  // Keyboard input
  pressKey(key: string): Promise<void>
  typeText(text: string): Promise<void>

  // Screenshot (aligned with chrome-devtools-mcp: supports webp format)
  captureScreenshot(options?: {
    format?: 'png' | 'jpeg' | 'webp'
    quality?: number
    fullPage?: boolean
    uid?: string
  }): Promise<{ data: string; mimeType: string }>

  // Script execution
  evaluateScript<T = unknown>(script: string, args?: unknown[]): Promise<T>

  // Page state
  getPageInfo(): Promise<{
    url: string
    title: string
    viewport: { width: number; height: number }
  }>

  // Wait utilities
  waitForText(text: string, timeout?: number): Promise<void>
  waitForElement(selector: string, timeout?: number): Promise<void>
}

// ============================================
// Emulation Types
// ============================================

/**
 * Network condition presets
 */
export interface NetworkConditions {
  offline?: boolean
  latency?: number       // Additional latency in ms
  downloadThroughput?: number  // Bytes per second
  uploadThroughput?: number    // Bytes per second
}

/**
 * Geolocation override
 */
export interface Geolocation {
  latitude: number
  longitude: number
  accuracy?: number
}

/**
 * Device emulation settings
 */
export interface DeviceEmulation {
  width?: number
  height?: number
  deviceScaleFactor?: number
  mobile?: boolean
  screenOrientation?: 'portrait' | 'landscape'
}

// ============================================
// Performance Types
// ============================================

/**
 * Performance trace state
 */
export interface PerformanceTraceState {
  isTracing: boolean
  startTime?: number
  categories?: string[]
}

/**
 * Performance insight
 */
export interface PerformanceInsight {
  name: string
  value: number
  unit: string
  description: string
}
