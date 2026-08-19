/**
 * Centered icon + title + description notice used for the store's empty, error,
 * and sign-in states. Callers supply the icon (already colored) and optional
 * action so one layout serves every state across the grid, detail, and my views.
 */

import type { ReactNode } from 'react'

interface StoreNoticeProps {
  icon: ReactNode
  title: string
  desc: string
  action?: ReactNode
}

export function StoreNotice({ icon, title, desc, action }: StoreNoticeProps) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="w-12 h-12 rounded-xl bg-secondary flex items-center justify-center">{icon}</div>
      <div>
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-xs text-muted-foreground mt-1 max-w-sm">{desc}</p>
      </div>
      {action}
    </div>
  )
}
