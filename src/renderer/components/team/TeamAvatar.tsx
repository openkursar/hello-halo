import type { TeamAvatarFaces } from '../../hooks/useTeamConversationRows'
import { cn } from '../../lib/utils'
import { AutomationAvatar } from '../apps/AutomationAvatar'

const MAX_OVERFLOW_LABEL = 99
const FACE_SLOTS = 4
const BASE = 18

/** A team's mark: up to four overlapping member faces; past that the last face is veiled with `+n`. */
export function TeamAvatar({ faces, name, size = BASE }: { faces: TeamAvatarFaces; name: string; size?: number }) {
  const { names, overflow } = faces
  const scale = size / BASE
  const face = Math.round(size * 2 / 3)
  const step = size - face
  const ring = Math.max(1, Math.round(size / 24))
  const veiled = overflow > 0 && names.length === FACE_SLOTS
  const slots = names.length + (overflow > 0 && !veiled ? 1 : 0)
  const label = overflow > MAX_OVERFLOW_LABEL ? '…' : `+${overflow}`
  const labelStyle = { fontSize: (label.length > 2 ? 6 : 7) * scale }
  const place = (index: number) => ({
    left: slots === 3 && index === 2 ? step / 2 : (index % 2) * step,
    top: Math.floor(index / 2) * step,
    width: face,
    height: face,
    zIndex: index,
    boxShadow: `0 0 0 ${ring}px hsl(var(--background))`,
  })
  return <span aria-hidden="true" className="flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
    {names.length === 0
      ? <span className="font-medium text-muted-foreground" style={{ fontSize: 11 * scale }}>{Array.from(name.trim())[0] ?? ''}</span>
      : slots === 1
        ? <AutomationAvatar name={names[0]} size={size} />
        : <span className="relative isolate" style={{ width: size, height: slots === 2 ? face : size }}>
          {names.map((memberName, index) => <span key={index} className="absolute overflow-hidden rounded-full" style={place(index)}>
            <AutomationAvatar name={memberName} size={face} />
            {veiled && index === names.length - 1 && <span className={cn('absolute inset-0 flex items-center justify-center bg-foreground/30 font-bold leading-none tabular-nums text-background', label.length > 2 && 'tracking-tighter')} style={labelStyle}>{label}</span>}
          </span>)}
          {overflow > 0 && !veiled && <span className={cn('absolute flex items-center justify-center rounded-full bg-border font-bold leading-none tabular-nums text-muted-foreground', label.length > 2 && 'tracking-tighter')} style={{ ...place(names.length), ...labelStyle }}>{label}</span>}
        </span>}
  </span>
}
