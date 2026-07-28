/**
 * apps/runtime -- App System Prompt Builder
 *
 * Assembles the complete system prompt for automation App sessions.
 *
 * Strategy: start with the FULL main Agent system prompt (identity, tools,
 * coding guidelines, tool usage policy, environment info), then append
 * automation-specific context and App instructions.
 *
 * This ensures automation Apps have 100% of the main Agent's capabilities.
 * The only difference is operating mode: headless background execution
 * instead of interactive conversation.
 */

import type { AutomationSpec } from '../spec'
import type { MemorySnapshot } from '../../platform/memory/snapshot'
import type { EscalationResponse } from './types'
import type { ImSessionRecord } from '../../../shared/types/im-channel'
import { buildSystemPrompt, buildSystemPromptWithAIBrowser } from '../../services/agent/system-prompt'
import { AI_BROWSER_SYSTEM_PROMPT } from '../../services/ai-browser'
import { AI_TERMINAL_SYSTEM_PROMPT } from '../../services/ai-terminal'

// ============================================
// Automation Context Overlay
// ============================================

/**
 * Appended after the main Agent system prompt to establish automation mode.
 * Provides context-specific overrides without removing any base capabilities.
 */
const AUTOMATION_CONTEXT = `
## Automation Mode

You are currently executing as a scheduled/triggered automation App.
This is a headless background execution — there is no interactive user conversation.

### Key differences from interactive mode:

- **User communication**: Use \`mcp__halo-report__report_to_user\` to report results.
  The user sees these reports in the Activity Thread, not your text output.
- **User questions**: Use the escalation mechanism (type="escalation" in report_to_user)
  when you need user input. Do NOT use AskUserQuestion — it is unavailable in automation mode.
- **Autonomy**: Execute the task to completion without asking for confirmation.
  Only escalate when genuinely uncertain about a consequential decision.
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

3. **Uncertain decisions** (type="escalation") — when you encounter any
   situation where you're unsure what the user would want. Do NOT make
   assumptions. Ask first, then wait for the user's response.

4. **Deliverable outputs** (type="output") — when you produce files,
   reports, or other artifacts. Tell the user where to find them.

### Reporting Format

**summary** — write for humans: be clear, direct, and avoid technical jargon.
  ✅ "AirPods Pro lowest price today: ¥1199, no change from yesterday."
  ❌ "Successfully fetched 3 URLs, price delta: 0"

**data** (optional) — detailed markdown for users who want the full picture.
  Choose whichever format best serves readability — tables, lists, headings, etc.

Do not put raw JSON or code blocks in either field
— unless the user explicitly requires otherwise.
`.trim()

// ============================================
// Sub-Agent Instructions (when App uses AI Browser)
// ============================================

const SUB_AGENT_INSTRUCTIONS = `
## Browser Task Delegation

When you need to interact with web pages, use the Task tool to delegate
to a sub-agent. The sub-agent inherits your MCP tools including browser tools.

Pattern:
1. Review your memory state (loaded in trigger message above)
2. Use Task tool with clear instructions for the browser sub-agent
3. The sub-agent navigates, extracts data, returns structured JSON
4. You process the data, make decisions, update memory, and report

Example Task tool prompt:
"Navigate to https://example.com, use browser_snapshot to get the page structure,
extract the price from the product listing, and return it as JSON: { price: number, currency: string }"
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
    const name = s.customName || s.displayName || s.chatId
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
  /** The App's specification (must be automation type) */
  appSpec: AutomationSpec
  /** Memory instructions (from memory.getPromptInstructions()) */
  memoryInstructions: string
  /** Trigger context description */
  triggerContext: string
  /** User configuration values */
  userConfig?: Record<string, unknown>
  /** Whether the App uses AI Browser (includes sub-agent instructions) */
  usesAIBrowser?: boolean
  /** Whether the App uses AI Terminal (appends the terminal usage guide) */
  usesTerminal?: boolean
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

/**
 * Build the complete system prompt for an automation App session.
 *
 * Structure:
 * 1. Full main Agent system prompt (identity, tools, coding guidelines, env)
 * 2. Automation context overlay (headless mode, report_to_user, escalation)
 * 3. App-specific system_prompt (from spec)
 * 4. Memory instructions (from memory service)
 * 5. Reporting rules (report_to_user usage)
 * 6. Sub-agent instructions (if App uses AI Browser)
 */
export function buildAppSystemPrompt(options: AppPromptOptions): string {
  const sections: string[] = []

  // 1. Full main Agent system prompt — gives the automation agent
  //    100% of the same capabilities as the interactive agent
  //    When AI Browser is enabled, append full browser tool workflow guide
  const promptCtx = { workDir: options.workDir, modelInfo: options.modelInfo }
  let basePrompt = options.usesAIBrowser
    ? buildSystemPromptWithAIBrowser(promptCtx, AI_BROWSER_SYSTEM_PROMPT)
    : buildSystemPrompt(promptCtx)
  // Append the terminal usage guide when the App has the ai-terminal permission.
  if (options.usesTerminal) {
    basePrompt += '\n\n' + AI_TERMINAL_SYSTEM_PROMPT.trim()
  }
  sections.push(basePrompt)

  // 1b. Capability awareness — name the capabilities the user turned off and
  //     where to re-enable them, so a disabled tool is reported rather than
  //     silently missing. Rendered by the caller (has the full InstalledApp).
  if (options.disabledCapabilities) {
    sections.push(options.disabledCapabilities)
  }

  // 1c. Capability awareness (setup gap) — capabilities toggled ON but tool-less
  //     until a channel/contact is configured. Without this a scheduled run can
  //     "believe" it notified when no channel exists and falsely report success.
  if (options.unconfiguredCapabilities) {
    sections.push(options.unconfiguredCapabilities)
  }

  // 2. Automation context overlay — establishes headless mode,
  //    overrides interaction patterns (escalation vs AskUserQuestion)
  sections.push(AUTOMATION_CONTEXT)

  // 3. App-specific instructions (from App spec)
  if (options.appSpec.system_prompt) {
    sections.push(`## App Instructions\n\n${options.appSpec.system_prompt}`)
  }

  // 4. Memory instructions (from memory service)
  if (options.memoryInstructions) {
    sections.push(options.memoryInstructions)
  }

  // 5. Reporting rules
  sections.push(REPORTING_RULES)

  // 6. Notification instructions — only when a notify tool is actually loaded.
  //    When none is, the block is omitted and unconfiguredCapabilities (1c)
  //    explains the setup gap instead.
  if (options.notifyToolsAvailable) {
    sections.push(NOTIFICATION_INSTRUCTIONS)
  }

  // 6b. Auto-sync awareness (only when subscribed IM contacts exist for
  //     this app — keeps the prompt minimal otherwise)
  if (options.autoSyncSessions && options.autoSyncSessions.length > 0) {
    sections.push(buildAutoSyncAwareness(options.autoSyncSessions))
  }

  // 7. Sub-agent instructions (only if App uses AI Browser)
  // TODO: Temporarily disabled — testing whether skipping sub-agent delegation
  // improves quality by preserving full context in the main agent.
  // Re-enable and compare results before making permanent.
  // if (options.usesAIBrowser) {
  //   sections.push(SUB_AGENT_INSTRUCTIONS)
  // }

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
  memorySnapshot: MemorySnapshot
}): string {
  const parts: string[] = []

  // ── Trigger ────────────────────────────────────────────────────────────
  parts.push(`## Trigger\n\nWhat initiated this run.\n\n${options.triggerContext}`)

  // ── Memory ─────────────────────────────────────────────────────────────
  parts.push(buildMemorySection(options.memorySnapshot))

  // ── User Configuration ─────────────────────────────────────────────────
  if (options.userConfig && Object.keys(options.userConfig).length > 0) {
    parts.push(`## User Configuration\n\n\`\`\`json\n${JSON.stringify(options.userConfig, null, 2)}\n\`\`\``)
  }

  // ── Instructions ───────────────────────────────────────────────────────
  parts.push(
    `## Instructions\n\n` +
    `Strictly follow the "${options.appName}" task requirements defined in your App Instructions (system prompt).\n` +
    `Complete this run based on the trigger above, then:\n` +
    `1. Update memory (\`# now\` and \`# History\`) — internal housekeeping, do not mention this in your report\n` +
    `2. Report results via \`mcp__halo-report__report_to_user\``
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
  userResponse: EscalationResponse
}): string {
  const responseText = escalation.userResponse.text
    || escalation.userResponse.choice
    || '(no response)'
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
 * Build the ## Memory section for the initial message.
 *
 * Three variants based on memory state:
 * - No file: guidance to create one
 * - Small file (≤30 lines): full content inline
 * - Large file (>30 lines): first section + structural outline
 */
function buildMemorySection(snapshot: MemorySnapshot): string {
  const lines: string[] = []
  lines.push('## Memory')
  lines.push('')
  lines.push('Your persistent memory from previous runs. Read it to maintain continuity and avoid repeating work.')
  lines.push('')

  if (!snapshot.exists) {
    // ── No memory file ─────────────────────────────────────────────────
    lines.push(`**File**: \`${snapshot.memoryFilePath}\``)
    lines.push('')
    lines.push('No memory file exists yet. Create it with Write using the `# now` / `# History` structure.')
    lines.push('Put your most important state under `# now` — it will be auto-loaded next run.')
  } else if (snapshot.fullContent !== null) {
    // ── Small memory: inject full content ──────────────────────────────
    const sizeKB = (snapshot.sizeBytes / 1024).toFixed(1)
    lines.push(`**File**: \`${snapshot.memoryFilePath}\``)
    lines.push(`**Size**: ${snapshot.totalLines} lines, ${sizeKB}KB`)
    lines.push('')
    lines.push('### Content (full):')
    lines.push('')
    lines.push(snapshot.fullContent)
  } else {
    // ── Large memory: first section + outline ──────────────────────────
    const sizeKB = (snapshot.sizeBytes / 1024).toFixed(1)
    lines.push(`**File**: \`${snapshot.memoryFilePath}\``)
    lines.push(`**Size**: ${snapshot.totalLines} lines, ${sizeKB}KB`)

    if (snapshot.firstSection) {
      lines.push('')
      lines.push('### Working Memory (# now, auto-loaded):')
      lines.push('')
      lines.push(snapshot.firstSection)
    }

    if (snapshot.headers.length > 0) {
      lines.push('')
      lines.push('### Structure:')
      for (const h of snapshot.headers) {
        const loadedTag = h === snapshot.headers[0] && snapshot.firstSection
          ? ' ← loaded above'
          : ''
        lines.push(`  L${h.line}: ${h.heading} (${h.lineCount} lines)${loadedTag}`)
      }
    }

    lines.push('')
    lines.push(`Use \`Read("${snapshot.memoryFilePath}")\` to see full content or specific sections.`)
  }

  // ── Archive info ─────────────────────────────────────────────────────
  if (snapshot.archiveTotalCount > 0 || snapshot.compactionArchiveCount > 0) {
    lines.push('')

    if (snapshot.archiveTotalCount > 0) {
      lines.push(`**Run History** (\`${snapshot.memoryArchiveDir}\`, ${snapshot.archiveTotalCount} files):`)
      for (const f of snapshot.archiveFiles) {
        lines.push(`  - ${f}`)
      }
      if (snapshot.archiveTotalCount > snapshot.archiveFiles.length) {
        lines.push(`  ... and ${snapshot.archiveTotalCount - snapshot.archiveFiles.length} more`)
      }
    }

    if (snapshot.compactionArchiveCount > 0) {
      const compactDir = snapshot.memoryArchiveDir.replace(/\/run$/, '')
      lines.push(`**Compaction Archives** (\`${compactDir}\`, ${snapshot.compactionArchiveCount} files)`)
    }
  }

  return lines.join('\n')
}
