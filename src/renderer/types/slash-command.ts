import type { EngineId } from '../../shared/types/engine'
/**
 * SlashCommandItem - Represents a single entry in the slash-command autocomplete menu.
 *
 * The list is built in ChatView from SDK init `slash_commands` array.
 * Commands are categorized as 'skill' if they appear in the `skills` array, otherwise 'builtin'.
 */
export interface SlashCommandItem {
  /** Stable unique key for React rendering (e.g. "builtin-compact") */
  id: string
  /** Full command string including the leading slash, e.g. "/compact" */
  command: string
  /** Short display label without the slash, e.g. "compact" */
  label: string
  /** One-line description shown as secondary text in the menu */
  description?: string
  /** CC SDK `argument-hint` — shown after the command, e.g. "[issue-number]" */
  argumentHint?: string
  /** Category controls grouping and icon choice in the menu */
  category: 'builtin' | 'skill'
}

/**
 * Raw session-info payload forwarded from the SDK system:init message.
 * Stored in the chat store per conversation and consumed by ChatView.
 */
export interface SessionInitInfo {
  engineId?: EngineId
  /** Built-in slash commands registered by Claude Code (e.g. ["compact", "review"]) */
  slashCommands: string[]
  /** Active skill slugs in this session (e.g. ["research-lookup"]) */
  skills: string[]
  /** Available agent types (e.g. ["general-purpose", "Explore"]) */
  agents: string[]
}
