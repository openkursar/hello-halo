/** Halo product context and session bindings, appended to native engine guidance. */
import os from 'os'
import { getDataFolderName } from '../../foundation/product-config'
import type { KBReference } from '../../../shared/types/tlon'
import type { EngineId } from '../../../shared/types/engine'

// ============================================
// Constants
// ============================================

/**
 * Default allowed tools that don't require user approval.
 * Used by both send-message.ts and session-manager.ts.
 */
export const DEFAULT_ALLOWED_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'Grep',
  'Glob',
  'Bash',
  'Skill'
] as const

export type AllowedTool = (typeof DEFAULT_ALLOWED_TOOLS)[number]

// ============================================
// System Prompt Context
// ============================================

/**
 * Context for building the dynamic parts of the system prompt
 */
export interface SystemPromptContext {
  engineId?: EngineId
  /** Current working directory */
  workDir: string
  /** Model name/identifier being used */
  modelInfo?: string
  /** Operating system platform */
  platform?: string
  /** OS version string */
  osVersion?: string
  /** Current date in YYYY-MM-DD format */
  today?: string
  /** Whether the current directory is a git repo */
  isGitRepo?: boolean
  /** List of allowed tools (defaults to DEFAULT_ALLOWED_TOOLS) */
  allowedTools?: readonly string[]
  /** Claude config directory path (defaults to platform-specific path) */
  claudeConfigDir?: string
  /**
   * Capability index for toolset-broker sessions (see agent/toolsets).
   * When set (even to ''), the session appends the usage guides of currently
   * enabled optional toolsets; awareness of disabled ones lives in the
   * request_toolset tool description. Undefined for sessions that manage their
   * own capability guidance (e.g. digital-human prompts).
   */
  toolsetIndex?: string
  /** Knowledge bases bound to this session's space/app (Tlon) */
  knowledgeBases?: KBReference[]
  /** Where the caller defines a non-Halo identity; omission retains Halo's identity. */
  ownIdentity?: 'app-instructions' | 'runtime'
}

// ============================================
// System Prompt Templates
// ============================================

export const SYSTEM_PROMPT_HALO_CONTEXT = `
# Halo
You are Halo, the AI assistant in Halo's chat.
Use \`read_halo_doc\` for Halo product guidance, starting with \`index.md\` when needed; consult the relevant guide before configuring or building anything in Halo. Current tools and permissions determine what you can do, not product documentation.

# Halo directories
- Halo config: {{HALO_DIR}} (stores spaces, settings, app data)
- Agent config: {{CLAUDE_CONFIG_DIR}}
- Personal global skills: ~/.agents/skills/<skill-name>/SKILL.md
- Personal project skills: <space-path>/.agents/skills/<skill-name>/SKILL.md
- Store-installed and built-in skills live in the same folders. Manage them with the capability library or skill_manage when that tool is directly available. If ToolSearch is offered instead, discover the skill-management tool before calling it. Files you change directly are kept when Halo updates the skill.

When looking for Halo configuration or skills, use these paths.
`.trim()

/** Every template states who the assistant is in one line starting like this. */
const HALO_IDENTITY_LINE = /^You are Halo, .*$/m

/**
 * That line for an assistant whose own instructions define who it is: asked
 * who it is, it should answer as those say, not with Halo's introduction.
 */
const RUNS_ON_HALO = 'You run in Halo.'
const RUNS_ON_HALO_LINE = RUNS_ON_HALO + ' Your identity and duties come from App Instructions.'

export type EngineSystemPrompt = string | { type: 'preset'; preset: 'default'; append: string }

/** Append the same host context to every engine's native guidance. */
export function toEngineSystemPrompt(hostPrompt: string, _engineId?: EngineId): EngineSystemPrompt {
  return { type: 'preset', preset: 'default', append: hostPrompt }
}

/** Host-authored text of a prompt produced by toEngineSystemPrompt; '' when absent. */
export function hostSystemPromptText(prompt: unknown): string {
  if (typeof prompt === 'string') return prompt
  if (prompt && typeof prompt === 'object' && typeof (prompt as { append?: unknown }).append === 'string') {
    return (prompt as { append: string }).append
  }
  return ''
}

/** Append host text to a prompt of either shape; anything else is returned unchanged. */
export function appendToSystemPrompt(prompt: unknown, extra: string): unknown {
  if (typeof prompt === 'string') return prompt + extra
  if (prompt && typeof prompt === 'object' && typeof (prompt as { append?: unknown }).append === 'string') {
    const preset = prompt as Exclude<EngineSystemPrompt, string>
    return { ...preset, append: preset.append + extra }
  }
  return prompt
}

// ============================================
// Dynamic System Prompt Builder
// ============================================

/**
 * Apply variable replacements to a prompt template.
 */
function applyTemplateVariables(template: string, ctx: SystemPromptContext): string {
  // Compute paths based on dataFolderName from product.json for per-variant isolation
  const folderName = getDataFolderName()
  const home = os.homedir()

  // Halo config directory (e.g. ~/.halo/ or ~/.halo-enterprise/)
  const haloDir = `${home}/.${folderName}/`

  // Claude config directory based on platform (Electron's userData + /claude-config)
  let claudeConfigDir = ctx.claudeConfigDir
  if (!claudeConfigDir) {
    if (process.platform === 'darwin') {
      claudeConfigDir = `${home}/Library/Application Support/${folderName}/claude-config`
    } else if (process.platform === 'win32') {
      claudeConfigDir = `${process.env.APPDATA || home + '/AppData/Roaming'}/${folderName}/claude-config`
    } else {
      claudeConfigDir = `${home}/.config/${folderName}/claude-config`
    }
  }

  return template
    .replace(/\{\{HALO_DIR\}\}/g, haloDir)
    .replace(/\{\{CLAUDE_CONFIG_DIR\}\}/g, claudeConfigDir)
}

/** Native behavior and environment stay with the engine; only Halo context is built here. */
export function buildSystemPrompt(ctx: SystemPromptContext): string {
  let prompt = applyTemplateVariables(SYSTEM_PROMPT_HALO_CONTEXT, ctx)
  if (ctx.ownIdentity) {
    prompt = prompt.replace(HALO_IDENTITY_LINE, ctx.ownIdentity === 'app-instructions' ? RUNS_ON_HALO_LINE : RUNS_ON_HALO)
  }

  // Toolset-broker sessions (main chat): append the usage guides of currently-
  // enabled optional toolsets. Awareness of disabled ones lives in the
  // request_toolset tool description, not here. Sessions that manage their own
  // capability guidance (digital-human prompts — see apps/runtime/prompt) leave
  // toolsetIndex undefined and inject their own "disabled capabilities" fragment;
  // this function stays capability-hint free for them.
  if (ctx.toolsetIndex) prompt += '\n\n' + ctx.toolsetIndex.trim()

  prompt += buildKnowledgeSection(ctx.knowledgeBases)

  return prompt
}

/**
 * The "# Knowledge" system-prompt section for a set of resolved knowledge
 * bases; '' when there are none. Exported separately from buildSystemPrompt so
 * chat sessions can defer the expensive part (each KB's index.md content) to
 * actual session creation and append it there — a reused session never reads
 * or formats KB content (see getOrCreateV2Session's resolveKnowledgeBases).
 */
export function buildKnowledgeSection(knowledgeBases?: KBReference[]): string {
  if (!knowledgeBases?.length) return ''
  let section = '\n\n# Knowledge\n\n'
    + 'You have knowledge bases of source documents. Search them on demand to '
    + 'answer, like a colleague who knows where everything is:\n'
    + '- To answer from a knowledge base, search the listed document files for '
    + 'relevant passages and read the matching ones — refine your search and look '
    + 'again until you have what you need. Do not answer from memory when a document '
    + 'can be checked.\n'
    + '- Answer in your own words and attribute what you use to the source document '
    + 'by name (e.g. "your PCB survey"), never to a file path. Be proactive: surface '
    + 'relevant context, draw cross-document links, and flag tensions worth knowing.\n'
    + '- Search exhaustively before enumerating or concluding absence: try several '
    + 'search patterns (synonyms, translations, spelling variants) — one pattern '
    + 'finding nothing does not mean the corpus lacks it.\n'
    + '- If the documents do not actually cover the question, say so plainly rather '
    + 'than forcing a connection.\n'
    + '- Each entry below is a document with a one-line synopsis and the path of its '
    + 'extracted text to search and read.\n\n'
  for (const kb of knowledgeBases) {
    section += `## ${kb.name}\n\n${truncateIndexContent(kb.indexContent)}\n\n`
  }
  return section
}

// Last-resort guard against a pathologically large document map blowing up the
// prompt; rebuildIndexMd already caps the doc count at the source.
const KB_INDEX_MAX_CHARS = 24_000

function truncateIndexContent(indexContent: string): string {
  if (indexContent.length <= KB_INDEX_MAX_CHARS) return indexContent
  // Cut on a line boundary so no half-written entry misleads the agent.
  const cut = indexContent.lastIndexOf('\n', KB_INDEX_MAX_CHARS)
  return indexContent.slice(0, cut > 0 ? cut : KB_INDEX_MAX_CHARS)
    + '\n\n(Document list truncated — list the text directory above to find all documents.)'
}

/**
 * Build system prompt with AI Browser instructions appended
 *
 * @param ctx - Dynamic context for the prompt
 * @param aiBrowserPrompt - AI Browser specific instructions to append
 * @returns Complete system prompt with AI Browser instructions
 */
export function buildSystemPromptWithAIBrowser(
  ctx: SystemPromptContext,
  aiBrowserPrompt: string
): string {
  return buildSystemPrompt(ctx) + '\n\n' + aiBrowserPrompt
}
