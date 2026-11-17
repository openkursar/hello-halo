import type { ButtonHTMLAttributes } from 'react'
import { cn } from '../../../lib/utils'

export const runtimeInputClass = 'w-full min-w-0 rounded-lg border border-border bg-input px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50'

export function RuntimeButton({ primary, className, type = 'button', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) {
  return <button type={type} className={cn(
    'inline-flex min-h-9 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-50',
    primary ? 'bg-primary text-primary-foreground hover:opacity-90' : 'border border-border bg-background hover:bg-muted',
    className,
  )} {...props} />
}
