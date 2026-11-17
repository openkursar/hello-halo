import type { ReactNode } from 'react'

interface AISourceInlinePanelProps {
  id: string
  title: string
  description?: string
  icon: ReactNode
  open: boolean
  busy?: boolean
  onOpen?: () => void
  children?: ReactNode
}

export function AISourceInlinePanel({ id, title, description, icon, open, busy, onOpen, children }: AISourceInlinePanelProps) {
  return (
    <div data-ai-provider-row={id} className={`rounded-lg border border-border bg-card ${open ? 'shadow-soft' : ''}`}>
      {open ? (
        <div data-ai-panel-header className="flex items-center gap-3 p-3">
          {icon}
          <div className="min-w-0 flex-1">
            <h3 className="font-medium text-foreground">{title}</h3>
            {description && <p className="text-xs text-muted-foreground">{description}</p>}
          </div>
        </div>
      ) : (
        <button type="button" onClick={onOpen} disabled={busy} className="flex w-full items-center gap-3 rounded-lg p-3 text-left transition-colors hover:bg-secondary disabled:opacity-50">
          {icon}
          <div className="min-w-0 flex-1">
            <div className="font-medium text-foreground">{title}</div>
            {description && <div className="text-xs text-muted-foreground">{description}</div>}
          </div>
        </button>
      )}
      {open && <div className="border-t border-border p-3 sm:p-4 animate-slide-down motion-reduce:animate-none">{children}</div>}
    </div>
  )
}
