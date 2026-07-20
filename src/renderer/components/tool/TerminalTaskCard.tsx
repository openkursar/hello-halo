/**
 * TerminalTaskCard - AI Terminal operation visualization.
 *
 * When the AI uses terminal_* tools, this renders below the message bubble as a
 * compact card summarizing the activity and offering a one-click "Open terminal"
 * that reveals the live session in the Canvas — the visibility principle: the
 * user can always see what the AI is doing in a shared terminal and take over.
 */

import { useMemo } from 'react'
import { TerminalSquare, ArrowUpRight, Loader2 } from 'lucide-react'
import { useTerminalStore } from '../../stores/terminal.store'
import type { ToolCall } from '../../types'
import { useTranslation } from '../../i18n'

const TERMINAL_TOOL_PREFIX = 'mcp__ai-terminal__'

/** Whether a tool name belongs to the AI Terminal toolset. */
export function isTerminalTool(name: string): boolean {
  return name.startsWith(TERMINAL_TOOL_PREFIX)
}

function shortName(fullName: string): string {
  return fullName.replace(TERMINAL_TOOL_PREFIX, '')
}

/** One-line human summary of a terminal tool call. */
function describe(call: ToolCall, t: (s: string) => string): string {
  const name = shortName(call.name)
  const input = call.input as Record<string, unknown>
  switch (name) {
    case 'terminal_create':
      return t('Started a terminal session')
    case 'terminal_write': {
      const cmd = typeof input.input === 'string' ? input.input.trim() : ''
      return cmd ? `$ ${cmd.split('\n')[0].slice(0, 80)}` : t('Sent input to terminal')
    }
    case 'terminal_read':
      return t('Read terminal output')
    case 'terminal_wait_for':
      return t('Waiting for terminal output')
    case 'terminal_kill':
      return t('Closed a terminal session')
    case 'terminal_list':
      return t('Listed terminal sessions')
    default:
      return name
  }
}

interface TerminalTaskCardProps {
  terminalToolCalls: ToolCall[]
  isActive: boolean
  /** Hide the "Open terminal" button in contexts without a Canvas (automation). */
  showOpenButton?: boolean
}

export function TerminalTaskCard({ terminalToolCalls, isActive, showOpenButton = true }: TerminalTaskCardProps) {
  const { t } = useTranslation()
  const runningSessions = useTerminalStore(s => s.runningSessions)
  const openInCanvas = useTerminalStore(s => s.openInCanvas)

  // The most recent tool call drives the headline; the target session is the
  // most-recently-active running one (best-effort — tool calls don't always
  // carry a session id, e.g. terminal_create's result does).
  const lastCall = terminalToolCalls[terminalToolCalls.length - 1]
  const summary = useMemo(() => (lastCall ? describe(lastCall, t) : ''), [lastCall, t])

  if (terminalToolCalls.length === 0) return null

  const handleOpen = () => {
    // Prefer the session id of the MOST RECENT tool call (scan from the end, to
    // match the headline which is driven by the last call); else the
    // latest-active running session.
    let referenced: string | undefined
    for (let i = terminalToolCalls.length - 1; i >= 0 && !referenced; i--) {
      const session = (terminalToolCalls[i].input as Record<string, unknown>).session
      if (typeof session === 'string') referenced = session
    }
    const target = referenced || runningSessions()[0]?.id
    if (target) openInCanvas(target)
  }

  return (
    <div className="mt-2 rounded-xl border border-border bg-muted/30 overflow-hidden">
      <div className="flex items-center gap-2.5 px-3 py-2">
        <span className="shrink-0 text-muted-foreground">
          {isActive ? <Loader2 size={15} className="animate-spin text-primary" /> : <TerminalSquare size={15} />}
        </span>
        <span className="flex-1 min-w-0 truncate text-xs font-mono text-foreground/90">{summary}</span>
        {showOpenButton && (
          <button
            onClick={handleOpen}
            className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-md text-xs
              text-primary hover:bg-primary/10 transition-colors"
            title={t('Open terminal')}
          >
            <ArrowUpRight size={13} />
            <span>{t('Open terminal')}</span>
          </button>
        )}
      </div>
    </div>
  )
}
