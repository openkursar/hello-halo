/** Automation context layered onto Halo's engine-independent host guidance. */

import type { AutomationSpec } from '../spec'
import { renderMemorySection, MEMORY_SECTION_LIMITS, type MemorySnapshot, type TopicsTree } from '../../platform/memory'
import type { EscalationResponse, EscalationQuestion } from './types'
import { formatEscalationAnswer } from '../../../shared/apps/app-types'
import type { ImSessionRecord } from '../../../shared/types/im-channel'
import { getImSessionDisplayName } from '../../../shared/types/im-channel'
import { buildSystemPrompt, buildSystemPromptWithAIBrowser } from '../../services/agent'
import { buildSelfIdentityPrompt } from './prompt/self-identity'
import { AI_BROWSER_SYSTEM_PROMPT } from '../../services/ai-browser'
import { HALO_API_USAGE_GUIDE } from '../../services/api-ref'
import { getKBReferencesForApp } from '../../services/tlon'

// ============================================
// Automation Context Overlay
// ============================================

const AUTOMATION_CONTEXT = `
## Automation Mode

You are currently executing as a scheduled/triggered automation App.
This is a headless background execution — there is no interactive user conversation.

### Key differences from interactive mode:

- **User communication**: Use \`mcp__halo-report__report_to_user\` to report results.
  The user sees these reports in the Activity Thread, not your text output.
- **User questions**: Use the escalation mechanism (type="escalation" in report_to_user)
  when you need user input. Do NOT use AskUserQuestion — it is unavailable in automation mode.
- **Autonomy**: Carry the task to completion on your own. Escalate only when the
  rule in the Reporting section below applies.
- **All other tools and capabilities remain identical** to the main Halo agent.

### Browser session

You run inside the user's own Halo browser — cookies, session, and localStorage are shared.
If a website requires login, ask the user to log in first via escalation, then retry.
`.trim()

// ============================================
// Reporting Rules (injected into all automation sessions)
// ============================================

const REPORTING_RULES = `
## Reporting (MCP server: halo-report)

You are an AI employee who proactively reports work progress.
Use \`mcp__halo-report__report_to_user\` to communicate results to the user.

### When to Report

1. **Every execution completion** (type="run_complete") — regardless of outcome.
   Include a clear summary of what happened and any key findings.

2. **Important discoveries** (type="milestone") — when you find information
   of significant value to the user. Don't wait until the end to report it.

3. **Decisions that are not yours** (type="escalation") — escalate when the next
   step is both hard to undo and open to more than one reading. Hard to undo
   means it leaves your workspace: sent, submitted, published, paid, deleted.
   Open to more than one reading means the instructions do not settle it, so you
   would be choosing on the user's behalf.

   Neither condition is enough alone. Hard to undo but unambiguous: do it, then
   say what you did. Ambiguous but reversible: take the most likely reading, do
   it, and name the reading you took. A plan the user must approve before you
   execute it is an escalation.

4. **Deliverable outputs** (type="output") — when you produce files,
   reports, or other artifacts. Tell the user where to find them.

### Reporting Format

**message** — write for humans: be clear, direct, and avoid technical jargon.
  ✅ "AirPods Pro lowest price today: ¥1199, no change from yesterday."
  ❌ "Successfully fetched 3 URLs, price delta: 0"

**data** (optional) — detailed markdown for users who want the full picture.
  Choose whichever format best serves readability — tables, lists, headings, etc.

Do not put raw JSON or code blocks in either field
— unless the user explicitly requires otherwise.
`.trim()

// ============================================
// Notification Instructions (when channels are configured)
// ============================================

const NOTIFICATION_INSTRUCTIONS = `
## Notifications (MCP server: halo-notify)

You have notification tools loaded (notify_channel and/or notify_bot). Their
exact parameters — available channels, the contact directory — live in each
tool's own schema. Use them ONLY when there is genuinely noteworthy information,
not for routine reports.

### When to Use

- **Important discoveries**: Price drops, anomalies, urgent changes detected
- **User-requested alerts**: When the app's purpose is to monitor and alert
- **Critical errors**: Issues that require immediate user attention
- **Targeted communication**: When you need to inform a specific person or group

### When NOT to Use

- For routine run completion reports — use report_to_user instead
- For every run — only notify when there's genuinely noteworthy information
- When nothing important happened — skip notification entirely

### Tips

- Write messages for humans — clear, specific, actionable
- Include key data points (prices, dates, names) directly in the message
- For notify_bot: choose the right contact based on context and the app's instructions
- For notify_bot: you can send files (reports, exports) along with or instead of text
`.trim()

// ============================================
// Auto-Sync Awareness (when subscribed IM contacts exist)
// ============================================

/**
 * Render the prompt fragment that informs the AI which IM contacts will
 * receive its final text response automatically at run end (driven by
 * apps/runtime/im-auto-sync.ts). Returns empty string when no contacts
 * are subscribed — keeps the prompt minimal in the common case.
 *
 * The AI uses this to (a) avoid duplicate notify_bot calls to the same
 * contacts at run end and (b) understand that its final text response
 * has a downstream IM audience and should be written accordingly.
 */
function buildAutoSyncAwareness(sessions: ImSessionRecord[]): string {
  const bullets = sessions.map((s) => {
    const name = getImSessionDisplayName(s)
    const type = s.chatType === 'group' ? 'Group' : 'Direct'
    return `- "${name}" (${type}) via ${s.channel}`
  }).join('\n')

  return `
## Auto-Sync to IM Contacts

Your final text response (the assistant message produced after all tool
calls complete) will be automatically delivered by the system to the
following IM contacts at run end:

${bullets}

You do not need to call notify_bot for these contacts to deliver the
final result — the system handles it. Use notify_bot for these contacts
only when you need to send a separate mid-run alert (e.g. an urgent
finding before the final report is ready).

Because these contacts will read your final text response verbatim,
make sure it is self-contained, clear, and complete. Avoid leaving the
final response empty or as a generic acknowledgement — it is the
audience-facing artifact of this run.
`.trim()
}

// ============================================
// Public API
// ============================================

export interface AppPromptOptions {
  /** ID of the installed App (used to look up bound knowledge bases) */
  appId: string
  /** The App's specification (must be automation type) */
  appSpec: AutomationSpec
  /** Memory instructions (from memory.getPromptInstructions()) */
  memoryInstructions: string
  /** Trigger context description */
  triggerContext: string
  /** User configuration values */
  userConfig?: Record<string, unknown>
  /** Include guidance only when the browser tools are mounted. */
  usesAIBrowser?: boolean
  /** Whether the App may operate Halo itself (appends the Halo-API usage guide) */
  usesHaloApi?: boolean
  /** Working directory for the agent (passed to base system prompt) */
  workDir: string
  /** Display model name (passed to base system prompt) */
  modelInfo?: string
  /**
   * Pre-rendered "disabled capabilities" guidance (buildDisabledCapabilitiesGuidance).
   * Present only when the user has turned a toggleable capability off; the caller
   * owns the computation because it has the full InstalledApp. Undefined = omit.
   */
  disabledCapabilities?: string
  /**
   * Pre-rendered "capabilities awaiting setup" guidance
   * (buildUnconfiguredCapabilitiesGuidance). Present only when a capability is
   * toggled ON but its channel/contact is not configured yet. Undefined = omit.
   */
  unconfiguredCapabilities?: string
  /**
   * Whether at least one notify tool (notify_channel / notify_bot) is actually
   * loaded for this run. Gates the NOTIFICATION_INSTRUCTIONS block: when no
   * notify tool exists, the guidance is pure noise and is omitted — the setup
   * gap is instead surfaced by unconfiguredCapabilities.
   */
  notifyToolsAvailable?: boolean
  /**
   * IM sessions for this app that have the proactive flag enabled.
   * When non-empty, an awareness section is injected so the AI knows
   * its final text will be auto-pushed to these contacts and avoids
   * duplicating via notify_bot.
   */
  autoSyncSessions?: ImSessionRecord[]
}

/** Scheduled runs retain their reporting context without standing-team awareness. */
export function buildAppSystemPrompt(options: AppPromptOptions): string {
  const sections: string[] = []

  const promptCtx = {
    workDir: options.workDir,
    modelInfo: options.modelInfo,
    knowledgeBases: getKBReferencesForApp(options.appId),
    // Who it is comes from its App Instructions, not Halo's introduction.
    ownIdentity: options.appSpec.system_prompt ? 'app-instructions' as const : 'runtime' as const,
  }
  let basePrompt = options.usesAIBrowser
    ? buildSystemPromptWithAIBrowser(promptCtx, AI_BROWSER_SYSTEM_PROMPT)
    : buildSystemPrompt(promptCtx)
  // Same rule for operating Halo itself: the guide is appended only when the
  // permission actually loaded the tool, so the prompt can never describe a
  // capability this run does not have.
  if (options.usesHaloApi) {
    basePrompt += '\n\n' + HALO_API_USAGE_GUIDE.trim()
  }
  sections.push(basePrompt)

  // Callers resolve capability state from the installed app and mounted tools.
  if (options.disabledCapabilities) {
    sections.push(options.disabledCapabilities)
  }

  // Enabled capabilities can still lack a configured channel or contact.
  if (options.unconfiguredCapabilities) {
    sections.push(options.unconfiguredCapabilities)
  }

  // App Instructions remain the persona; runtime context describes the task.
  if (options.appSpec.system_prompt) {
    sections.push(`## App Instructions\n\n${options.appSpec.system_prompt}`)
  }

  if (options.memoryInstructions) {
    sections.push(options.memoryInstructions)
  }

  sections.push(buildSelfIdentityPrompt(options.appId, options.appSpec.name, {
    ownInstructions: !!options.appSpec.system_prompt,
    automation: true,
  }))
  sections.push(AUTOMATION_CONTEXT)

  sections.push(REPORTING_RULES)

  // Do not advertise notification tools that were not mounted.
  if (options.notifyToolsAvailable) {
    sections.push(NOTIFICATION_INSTRUCTIONS)
  }

  if (options.autoSyncSessions && options.autoSyncSessions.length > 0) {
    sections.push(buildAutoSyncAwareness(options.autoSyncSessions))
  }

  return sections.join('\n\n---\n\n')
}

/**
 * Build the initial user message that starts an automation run.
 *
 * Includes: trigger context, memory snapshot (pre-loaded), user configuration,
 * and task instructions.
 */
export function buildInitialMessage(options: {
  triggerContext: string
  userConfig?: Record<string, unknown>
  appName: string
  /** null when this digital human's memory is turned off */
  memorySnapshot: MemorySnapshot | null
  /** The space's topics, offered read-only; null when not offered */
  spaceTopics?: TopicsTree | null
}): string {
  const parts: string[] = []

  // ── Trigger ────────────────────────────────────────────────────────────
  parts.push(`## Trigger\n\nWhat initiated this run.\n\n${options.triggerContext}`)

  // ── Memory ─────────────────────────────────────────────────────────────
  if (options.memorySnapshot) parts.push(buildMemorySection(options.memorySnapshot, options.spaceTopics))

  // ── User Configuration ─────────────────────────────────────────────────
  if (options.userConfig && Object.keys(options.userConfig).length > 0) {
    parts.push(`## User Configuration\n\n\`\`\`json\n${JSON.stringify(options.userConfig, null, 2)}\n\`\`\``)
  }

  // ── Instructions ───────────────────────────────────────────────────────
  const steps = options.memorySnapshot
    ? [
        'Update memory (`# now`, `# History`, and topics where knowledge settled) — internal housekeeping, do not mention this in your report',
        'Report results via `mcp__halo-report__report_to_user`',
      ]
    : ['Report results via `mcp__halo-report__report_to_user`']
  parts.push(
    `## Instructions\n\n` +
    `Strictly follow the "${options.appName}" task requirements defined in your App Instructions (system prompt).\n` +
    `Complete this run based on the trigger above, then:\n` +
    steps.map((step, i) => `${i + 1}. ${step}`).join('\n')
  )

  return parts.join('\n\n')
}

// ============================================
// Escalation Resume Message
// ============================================

/**
 * Build a minimal user message for an escalation follow-up that resumes
 * an existing session. Since the full conversation context is restored
 * from disk, only the user's response is needed — no Trigger/Memory/Config.
 */
export function buildEscalationResumeMessage(escalation: {
  originalQuestion: string
  questions?: EscalationQuestion[]
  userResponse: EscalationResponse
}): string {
  const questions = escalation.questions ?? []

  // Several answers are listed against the questions they belong to: read on
  // their own ("Yes; the second one") they are not answers at all.
  if (questions.length > 1) {
    return (
      `User answered your escalation.\n\n` +
      `${escalation.originalQuestion}\n\n` +
      `${formatEscalationAnswer(questions, escalation.userResponse)}\n\n` +
      `Continue your task based on these answers.`
    )
  }

  const responseText = formatEscalationAnswer(questions, escalation.userResponse) || '(no response)'
  return (
    `User responded to your escalation.\n\n` +
    `Your question: "${escalation.originalQuestion}"\n` +
    `User's response: "${responseText}"\n\n` +
    `Continue your task based on this response.`
  )
}

// ============================================
// Memory Section Builder
// ============================================

/**
 * Sits immediately above the injected memory. One digital human, many
 * concurrent executions, one first-person file: without this, a line another
 * instance wrote about itself reads as a description of the reader.
 */
const MEMORY_AUTHORSHIP_FRAMING =
  'Shared by this digital human’s executions. The memory’s "I" is the digital human, ' +
  'not this execution. Claims of a role, an assignment or work in progress belong to ' +
  'the execution that wrote them; verify those at their live source before acting.'

/**
 * Offered below the digital human's own topics when its owner let it consult
 * the space's memory. Called memory, never knowledge: a knowledge base is a
 * separate thing the agent may also be given in the same turn.
 */
const SPACE_TOPICS_TITLE = "Space memory topics (read-only) — generated from the space's topic files"
const SPACE_TOPICS_NOTE = `
Topics from this space's shared memory, written by its conversations. Read them
when their description fits; they are not yours to edit. Refer to them by path
when you need them again — do not copy them into your own memory. If sources
disagree, verify the current facts rather than choosing by memory ownership.
`.trim()


/**
 * The `## Memory` block for a run or a session.
 *
 * Exported for app-chat, which injects the same section at the start of a
 * session — the digital human is the same one either way, so it must meet its
 * memory in the same shape whether the turn came from a schedule or a teammate.
 */
export function buildMemorySection(snapshot: MemorySnapshot, spaceTopics?: TopicsTree | null): string {
  return renderMemorySection(snapshot, {
    ...MEMORY_SECTION_LIMITS['digital-human'],
    framing: MEMORY_AUTHORSHIP_FRAMING,
    readOnlyTopics: spaceTopics
      ? { title: SPACE_TOPICS_TITLE, note: SPACE_TOPICS_NOTE, tree: spaceTopics }
      : undefined,
  })
}
