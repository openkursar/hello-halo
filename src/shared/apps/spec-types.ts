/**
 * Shared App Spec Types
 *
 * Pure TypeScript type definitions for the App Spec system.
 * These types are used by both the main process and the renderer process.
 *
 * IMPORTANT: This file must NOT import any Node.js or Electron APIs.
 * It is included in the renderer (web) tsconfig.
 *
 * All types here are manually mirrored from the Zod-derived types in
 * src/main/apps/spec/schema.ts. They must be kept in sync. When the Zod
 * schema changes, update these types accordingly.
 *
 * Why manual mirror instead of re-export?
 * - The renderer tsconfig does not include src/main/
 * - Importing from src/main/ would pull in Node.js types
 * - Zod schemas (runtime code) should not be bundled into the renderer
 */

// ============================================
// App Type
// ============================================

export type AppType = 'mcp' | 'skill' | 'automation' | 'extension'

// ============================================
// Filter Rules
// ============================================

export type FilterOp = 'eq' | 'neq' | 'contains' | 'matches' | 'gt' | 'lt' | 'gte' | 'lte'

export interface FilterRule {
  field: string
  op: FilterOp
  value?: unknown
}

// ============================================
// Input Definition (config_schema items)
// ============================================

export type InputType = 'url' | 'text' | 'string' | 'number' | 'select' | 'boolean' | 'email'

export interface SelectOption {
  label: string
  value: string | number | boolean
}

export interface InputDef {
  key: string
  label: string
  type: InputType
  description?: string
  required?: boolean
  default?: unknown
  placeholder?: string
  options?: SelectOption[]
}

// ============================================
// Memory Schema
// ============================================

export interface MemoryField {
  type: string
  description?: string
}

export type MemorySchema = Record<string, MemoryField>

// ============================================
// Subscription Source Configs
// ============================================

export interface ScheduleSourceConfig {
  every?: string
  cron?: string
}

export interface FileSourceConfig {
  pattern?: string
  path?: string
}

export interface WebhookSourceConfig {
  path?: string
  secret?: string
}

export interface WebpageSourceConfig {
  watch?: string
  selector?: string
  url?: string
}

export interface RssSourceConfig {
  url?: string
}

export type CustomSourceConfig = Record<string, unknown>

export interface WecomSourceConfig {
  chatId?: string
}

// ============================================
// Subscription Source (discriminated union)
// ============================================

export type SubscriptionSourceType = 'schedule' | 'file' | 'webhook' | 'webpage' | 'rss' | 'custom' | 'wecom'

export type SubscriptionSource =
  | { type: 'schedule'; config: ScheduleSourceConfig }
  | { type: 'file'; config: FileSourceConfig }
  | { type: 'webhook'; config: WebhookSourceConfig }
  | { type: 'webpage'; config: WebpageSourceConfig }
  | { type: 'rss'; config: RssSourceConfig }
  | { type: 'custom'; config: CustomSourceConfig }
  | { type: 'wecom'; config: WecomSourceConfig }

// ============================================
// Frequency Definition
// ============================================

export interface FrequencyDef {
  default: string
  min?: string
  max?: string
}

// ============================================
// Subscription Definition
// ============================================

export interface SubscriptionDef {
  id?: string
  source: SubscriptionSource
  frequency?: FrequencyDef
  config_key?: string
}

// ============================================
// MCP Dependency Declaration
// ============================================

export interface McpDependency {
  id: string
  reason?: string
  bundled?: boolean
  /**
   * Whether this digital human uses the dependency. Absent = enabled.
   * `false` keeps the declaration but stops injecting the MCP for THIS digital
   * human only (per-app switch; never affects the shared MCP server's status).
   */
  enabled?: boolean
}

// ============================================
// Skill Dependency Declaration
// ============================================

export type SkillDependency = string | {
  id: string
  reason?: string
  bundled?: boolean
  files?: string[]
}

// ============================================
// MCP Server Config (for type=mcp)
// ============================================

export interface McpServerConfig {
  transport?: 'stdio' | 'sse' | 'streamable-http'
  command: string
  args?: string[]
  env?: Record<string, string>
  headers?: Record<string, string>
  cwd?: string
}

// ============================================
// Notification Channel Type
// ============================================

export type NotificationChannelType = 'email' | 'wecom' | 'dingtalk' | 'feishu' | 'webhook'

// ============================================
// Output Notify Config
// ============================================

export interface OutputNotifyConfig {
  /** Send system desktop notification (default: true) */
  system?: boolean
  /** External notification channels to deliver to */
  channels?: NotificationChannelType[]
}

// ============================================
// Output Config
// ============================================

export interface OutputConfig {
  notify?: OutputNotifyConfig
  format?: string
}

// ============================================
// Requires Block
// ============================================

export interface Requires {
  mcps?: McpDependency[]
  skills?: SkillDependency[]
}

// ============================================
// Escalation Config
// ============================================

export interface EscalationConfig {
  enabled?: boolean
  timeout_hours?: number
}

// ============================================
// Store Metadata (for registry distribution)
// ============================================

export interface StoreMetadata {
  slug?: string
  category?: string
  tags?: string[]
  /** Per-version release notes surfaced in the store version history. */
  changelog?: string
  locale?: string
  min_app_version?: string
  license?: string
  homepage?: string
  repository?: string
  /** Install provenance: registry identifier used for update checks */
  registry_id?: string
  /**
   * Install provenance: how this app reached the user's machine.
   * - 'store':   downloaded from a registry (default for store installs)
   * - 'builtin': bundled with the build itself (auto-installed at startup,
   *              protected from permanent deletion, refreshed on every launch)
   * - 'manual':  added via direct IPC/HTTP call (e.g. drag-and-drop)
   * Older records may not carry this field; treat 'undefined' as 'store'.
   */
  install_source?: 'store' | 'builtin' | 'manual'
}

// ============================================
// i18n — Localization Overrides
// ============================================

/**
 * Per-field display text overrides for a single locale.
 * All fields are optional — only the overridden fields need to be provided.
 */
export interface I18nConfigFieldOverride {
  /** Translated field label */
  label?: string
  /** Translated help text */
  description?: string
  /** Translated placeholder */
  placeholder?: string
  /**
   * Translated option labels, keyed by option value (as string).
   * Only values explicitly listed are overridden; others fall back to canonical labels.
   * Example: { "en-US": "English", "zh-CN": "中文" }
   */
  options?: Record<string, string>
}

/**
 * Locale-specific display text overrides for a single BCP 47 locale.
 * Used as a value in the AppSpec `i18n` record.
 */
export interface I18nLocaleBlock {
  /** Translated app display name */
  name?: string
  /** Translated app description */
  description?: string
  /**
   * Per-field overrides, keyed by config_schema[].key.
   * Only fields that need translation need to be listed.
   */
  config_schema?: Record<string, I18nConfigFieldOverride>
  /**
   * Per-URL label overrides for browser_login entries, keyed by URL.
   * Example: { "https://www.xiaohongshu.com": { label: "小红书" } }
   */
  browser_login?: Record<string, { label?: string }>
}

// ============================================
// Browser Login Entries
// ============================================

export interface BrowserLoginEntry {
  url: string
  label: string
}

// ============================================
// Full App Spec (Discriminated Union by type)
// ============================================

/** Common fields shared by ALL app types */
export interface AppSpecCommon {
  spec_version: string
  /**
   * Canonical name. For skills it is the ecosystem identifier (skill directory,
   * SKILL.md frontmatter `name`, slash command) and is always ASCII; for other
   * types it doubles as the display name.
   */
  name: string
  /** Display name used when `name` is not presentable. `i18n` overrides it. */
  display_name?: string
  version: string
  author: string
  description: string
  type: AppType
  icon?: string
  permissions?: string[]
  requires?: Requires
  config_schema?: InputDef[]
  store?: StoreMetadata
  i18n?: Record<string, I18nLocaleBlock>
}

/** Automation (AI Digital Human) — Halo core type */
export interface AutomationSpec extends AppSpecCommon {
  type: 'automation'
  system_prompt: string
  subscriptions?: SubscriptionDef[]
  filters?: FilterRule[]
  memory_schema?: MemorySchema
  output?: OutputConfig
  escalation?: EscalationConfig
  recommended_model?: string
  /** Websites the user needs to log into before the automation can run */
  browser_login?: BrowserLoginEntry[]
}

/** MCP Server — external community format */
export interface McpSpec extends AppSpecCommon {
  type: 'mcp'
  mcp_server: McpServerConfig
}

/** Skill — external community format (Claude SKILL.md) */
export interface SkillSpec extends Omit<AppSpecCommon, 'author'> {
  type: 'skill'
  /** Author is optional for skills — SKILL.md format does not include an author field */
  author?: string
  /** Single-file content (manual add / legacy) */
  skill_content?: string
  /** All files in the skill folder, keyed by filename. Used for registry installs. */
  skill_files?: Record<string, string>
}

/** Extension — reserved for future use */
export interface ExtensionSpec extends AppSpecCommon {
  type: 'extension'
}

/** Discriminated union — narrow via spec.type */
export type AppSpec = AutomationSpec | McpSpec | SkillSpec | ExtensionSpec

// ============================================
// Validation Issue (for error display in UI)
// ============================================

export interface ValidationIssue {
  path: string
  message: string
  received?: unknown
}
