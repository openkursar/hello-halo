/**
 * LiveSessionsHeader — a small capsule tab adhered to the top-left of the input
 * composer, surfacing the AI's live background sessions (terminal now, browser
 * next).
 *
 * Shape: top corners rounded, bottom flush and square, so it reads as a label
 * fixed onto the input box's top edge rather than a floating pill. It is a
 * sibling rendered *above* the input card — the input box itself is never
 * modified. Clicking opens an upward list to reveal or stop each session.
 * Direct response to the ai-browser visibility lesson: autonomous AI work must
 * always be perceivable and stoppable.
 */

import { useEffect, useState } from 'react'
import { TerminalSquare, Globe, ArrowUpRight, X, ChevronDown, Zap } from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent } from '../ui/Popover'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { useLiveSessions, type LiveSession } from '../../hooks/useLiveSessions'
import { useTranslation } from '../../i18n'

/** Compact "3m" style age from a ms epoch. */
function ago(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h`
}

function KindIcon({ kind, size = 13, className }: { kind: LiveSession['kind']; size?: number; className?: string }) {
  const Icon = kind === 'terminal' ? TerminalSquare : Globe
  return <Icon size={size} className={className} />
}

interface SessionRowProps {
  session: LiveSession
  onOpen: () => void
  onStop: () => void
}

/** One session line inside the popover list. */
function SessionRow({ session, onOpen, onStop }: SessionRowProps) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted/60 transition-colors">
      <KindIcon
        kind={session.kind}
        className={`shrink-0 ${session.busy ? 'text-primary animate-pulse' : 'text-muted-foreground'}`}
      />
      <button onClick={onOpen} className="flex-1 min-w-0 flex items-center gap-2 text-left" title={t('Open')}>
        <span className={`flex-1 min-w-0 truncate text-xs text-foreground/80 ${session.kind === 'terminal' ? 'font-mono' : ''}`}>
          {session.title}
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {session.busy ? t('running') : ago(session.lastActivityAt)}
        </span>
      </button>
      <button
        onClick={onOpen}
        title={t('Open')}
        className="shrink-0 p-1 rounded text-muted-foreground hover:text-foreground hover:bg-background/60 transition-colors"
      >
        <ArrowUpRight size={13} />
      </button>
      <button
        onClick={onStop}
        title={t('Stop')}
        className="shrink-0 p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
      >
        <X size={13} />
      </button>
    </div>
  )
}

export function LiveSessionsHeader() {
  const { t } = useTranslation()
  const { sessions, busy, open, stop } = useLiveSessions()
  const [listOpen, setListOpen] = useState(false)
  const [pendingStop, setPendingStop] = useState<LiveSession | null>(null)

  // Tick so the "· 3m" age stays fresh without event spam.
  const [, force] = useState(0)
  useEffect(() => {
    const id = setInterval(() => force(n => n + 1), 15000)
    return () => clearInterval(id)
  }, [])

  if (sessions.length === 0) return null

  const count = sessions.length
  const primary = sessions[0]

  const confirmStop = async () => {
    const target = pendingStop
    setPendingStop(null)
    if (target) await stop(target)
  }

  return (
    <>
      {/* Block wrapper: left-aligns the tab and keeps its bottom flush to the card. */}
      <div className="flex">
        <Popover open={listOpen} onOpenChange={setListOpen}>
          <PopoverTrigger
            className="ml-4 items-center gap-1.5 px-2.5 h-7 max-w-[calc(100%-2rem)]
              rounded-t-lg border border-border/70 bg-secondary/50 text-xs cursor-pointer
              hover:bg-secondary/70 transition-colors"
          >
            {count === 1 ? (
              <KindIcon kind={primary.kind} className={busy ? 'text-primary animate-pulse' : 'text-muted-foreground'} />
            ) : (
              <Zap size={13} className={busy ? 'text-primary animate-pulse' : 'text-muted-foreground'} />
            )}
            <span className={`truncate text-foreground/80 ${count === 1 && primary.kind === 'terminal' ? 'font-mono' : ''}`}>
              {count === 1 ? primary.title : t('{{count}} sessions running', { count })}
            </span>
            {count === 1 && (
              <span className="shrink-0 text-muted-foreground">
                · {primary.busy ? t('running') : ago(primary.lastActivityAt)}
              </span>
            )}
            <ChevronDown size={12} className="shrink-0 text-muted-foreground" />
          </PopoverTrigger>

          <PopoverContent
            side="top"
            align="start"
            sideOffset={8}
            className="w-72 max-w-[calc(100vw-16px)] p-1"
          >
            <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
              {t('Active sessions')}
            </div>
            <div className="max-h-64 overflow-y-auto">
              {sessions.map(session => (
                <SessionRow
                  key={session.id}
                  session={session}
                  onOpen={() => {
                    open(session)
                    setListOpen(false)
                  }}
                  onStop={() => setPendingStop(session)}
                />
              ))}
            </div>
          </PopoverContent>
        </Popover>
      </div>

      {pendingStop && (
        <ConfirmDialog
          title={t('Stop this session?')}
          message={t('The running process will be terminated.')}
          confirmLabel={t('Stop')}
          cancelLabel={t('Cancel')}
          variant="danger"
          onConfirm={confirmStop}
          onCancel={() => setPendingStop(null)}
        />
      )}
    </>
  )
}
