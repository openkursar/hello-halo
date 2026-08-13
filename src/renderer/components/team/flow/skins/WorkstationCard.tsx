/**
 * WorkstationCard — the cartoon office skin for a team member.
 *
 * A flat "peek over the monitor" character sits at a desk; the pose is driven
 * entirely by the shared MemberView (no new data): working = typing at a lit
 * screen, idle = a coffee break, needs-you = a raised "!", unreachable = an
 * empty chair. Structural surfaces (card, desk, monitor frame, text) follow the
 * theme tokens so it blends into light/dark; the intrinsic illustration hues
 * (skin, hair, coffee) are local to this drawing and don't touch the global
 * palette. Owner identity tints the hair via a stable per-member hue.
 */

import { Star, Timer } from 'lucide-react'
import { MemberPresenceChip, OwnerLabel } from '../../MemberPresenceChip'
import { useTranslation } from '../../../../i18n'
import type { MemberView } from '../member-view'

/** Stable hue (0–359) from a seed, so each teammate keeps a consistent color. */
function memberHue(seed: string): number {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (Math.imul(h, 31) + seed.charCodeAt(i)) >>> 0
  return h % 360
}

// Illustration palette (local to this drawing — semantic, not theme surfaces).
const SKIN = 'hsl(28 40% 76%)'
const EYE = 'hsl(0 0% 30%)'
const GREEN = 'hsl(160 84% 39%)'
const AMBER = 'hsl(38 92% 50%)'
const COFFEE = 'hsl(25 48% 42%)'
// Structural surfaces (theme tokens).
const DESK = 'hsl(var(--secondary))'
const EDGE = 'hsl(var(--border))'
const OUTLINE = 'hsl(var(--foreground) / 0.14)'

interface WorkstationProps {
  view: MemberView
  hair: string
}

/** The flat SVG scene, 160×120 user units. */
function Workstation({ view, hair }: WorkstationProps) {
  const { isUnreachable, isWorking, isAlert } = view
  const idle = !isUnreachable && !isWorking && !isAlert
  const { t } = useTranslation()

  const shadow = <ellipse cx={80} cy={114} rx={58} ry={6} fill="hsl(var(--secondary) / 0.5)" />
  const stand = <rect x={76} y={80} width={8} height={7} fill={DESK} />
  const deskBar = (
    <>
      <rect x={14} y={86} width={132} height={17} rx={3} fill={DESK} stroke={EDGE} strokeWidth={1} />
      <rect x={14} y={86} width={132} height={3.5} rx={2} fill="hsl(var(--muted-foreground) / 0.14)" />
      <rect x={52} y={94} width={56} height={4} rx={2} fill="hsl(var(--muted-foreground) / 0.10)" />
    </>
  )

  if (isUnreachable) {
    return (
      <svg width={160} height={120} viewBox="0 0 160 120" fill="none" role="img">
        {shadow}
        <text x={80} y={24} textAnchor="middle" fontSize={11} fill="hsl(var(--muted-foreground))">{t('Away')}</text>
        <rect x={63} y={30} width={34} height={26} rx={9} fill="none" stroke="hsl(var(--muted-foreground) / 0.45)" strokeWidth={1.5} strokeDasharray="4 3" />
        {stand}
        <rect x={48} y={40} width={64} height={42} rx={5} fill="hsl(var(--muted))" stroke={EDGE} strokeWidth={1.5} />
        <path d="M80 52 v10 M74 56 a8 8 0 1 0 12 0" fill="none" stroke="hsl(var(--muted-foreground) / 0.4)" strokeWidth={2} strokeLinecap="round" />
        {deskBar}
      </svg>
    )
  }

  const screenTint = isWorking ? 'hsl(160 84% 39% / 0.16)' : isAlert ? 'hsl(38 92% 50% / 0.14)' : 'hsl(var(--primary) / 0.10)'

  return (
    <svg width={160} height={120} viewBox="0 0 160 120" fill="none" role="img">
      {shadow}

      {/* Head peeking over the monitor. */}
      <g className={isWorking ? 'ws-bob' : undefined}>
        <circle cx={80} cy={30} r={14} fill={SKIN} stroke={OUTLINE} strokeWidth={1} />
        <path d="M66 28 Q66 12 80 12 Q94 12 94 28 Q90 21 80 21 Q70 21 66 28 Z" fill={hair} />
        {idle ? (
          <path d="M71.5 31 q3 2.5 6 0 M82.5 31 q3 2.5 6 0" fill="none" stroke={EYE} strokeWidth={1.6} strokeLinecap="round" />
        ) : (
          <>
            <circle cx={74.5} cy={31} r={1.7} fill={EYE} />
            <circle cx={85.5} cy={31} r={1.7} fill={EYE} />
          </>
        )}
      </g>

      {stand}

      {/* Monitor (front, occludes the chin → "peeking"). */}
      <rect x={48} y={40} width={64} height={42} rx={5} fill={DESK} stroke={EDGE} strokeWidth={1.5} />
      <rect x={53} y={45} width={54} height={32} rx={3} fill={screenTint} />

      {/* Screen content by state. */}
      {isWorking && (
        <>
          <rect x={58} y={52} width={26} height={3.4} rx={1.7} fill={GREEN} />
          <rect x={58} y={59} width={17} height={3.4} rx={1.7} fill="hsl(160 84% 39% / 0.6)" />
          <rect x={58} y={66} width={22} height={3.4} rx={1.7} fill="hsl(160 84% 39% / 0.6)" />
          <rect className="ws-blink" x={78} y={59} width={6} height={3.4} rx={1.5} fill={GREEN} />
        </>
      )}
      {isAlert && (
        <text x={80} y={69} textAnchor="middle" fontSize={24} fontWeight={700} fill={AMBER}>?</text>
      )}
      {idle && (
        <>
          <rect x={60} y={55} width={40} height={3.4} rx={1.7} fill="hsl(var(--muted-foreground) / 0.35)" />
          <rect x={60} y={62} width={28} height={3.4} rx={1.7} fill="hsl(var(--muted-foreground) / 0.28)" />
        </>
      )}

      {deskBar}

      {/* Idle = coffee break: a steaming mug on the desk. */}
      {idle && (
        <g>
          <path className="ws-steam" d="M112 74 q-2 -3 0 -6 q2 -3 0 -6" fill="none" stroke="hsl(var(--muted-foreground) / 0.55)" strokeWidth={1.6} strokeLinecap="round" />
          <path className="ws-steam-2" d="M118 74 q-2 -3 0 -6 q2 -3 0 -6" fill="none" stroke="hsl(var(--muted-foreground) / 0.55)" strokeWidth={1.6} strokeLinecap="round" />
          <rect x={106} y={76} width={16} height={13} rx={2} fill="hsl(var(--background))" stroke={EDGE} strokeWidth={1.5} />
          <rect x={107.5} y={78.5} width={13} height={3} rx={1} fill={COFFEE} />
          <path d="M122 79 q6 1 6 5 t-6 5" fill="none" stroke={EDGE} strokeWidth={1.5} />
        </g>
      )}

      {/* Needs-you = a raised "!" bubble. */}
      {isAlert && (
        <g>
          <circle cx={106} cy={20} r={11} fill={AMBER} />
          <path d="M99 27 L101 34 L106 28 Z" fill={AMBER} />
          <text x={106} y={25} textAnchor="middle" fontSize={15} fontWeight={800} fill="hsl(0 0% 10%)">!</text>
        </g>
      )}
    </svg>
  )
}

/** Small floating status pill in the scene's top-right corner. */
function StatusBadge({ view }: { view: MemberView }) {
  const { t } = useTranslation()
  const { member, presence, isWorking, isUnreachable, isAlert, waitsOnOwner } = view

  if (isWorking) {
    return (
      <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        {t('Working')}
      </span>
    )
  }
  if (isAlert) {
    const label = member.status === 'waiting_user' ? t('Waiting for you') : t('Needs attention')
    return (
      <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full border border-amber-500/45 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
        {label}
      </span>
    )
  }
  // Blocked, but on someone else's word — stated plainly, in the resting palette
  // so it never reads as this reader's to clear.
  if (waitsOnOwner) {
    const owner = presence.ownerName || t('its owner')
    return (
      <span className="absolute right-2 top-2 inline-flex max-w-[85%] items-center gap-1 truncate rounded-full border border-border bg-secondary/70 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
        {t('Waiting on {{owner}}', { owner })}
      </span>
    )
  }
  if (isUnreachable) return null
  return (
    <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full border border-border bg-secondary/70 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
      {t('On a break')}
    </span>
  )
}

export function WorkstationCard({ view, active }: { view: MemberView; active: boolean }) {
  const { t } = useTranslation()
  const { member, presence, isLead, isUnreachable, isWorking, isAlert, summary, checkCount } = view
  const hair = `hsl(${memberHue(member.appId)} 46% 46%)`

  return (
    <div
      className={`relative w-full overflow-hidden rounded-xl border bg-background shadow-sm transition-all
        ${isUnreachable ? 'border-dashed opacity-60 saturate-0' : ''}
        ${active ? 'border-primary ring-1 ring-primary/40'
          : isAlert ? 'border-amber-500/50'
          : isWorking ? 'border-emerald-500/40'
          : isLead ? 'border-primary/40 shadow-md'
          : 'border-border'}`}
    >
      <div className="relative flex h-[120px] items-end justify-center bg-gradient-to-b from-transparent to-secondary/25">
        {isLead && <Star className="absolute left-2 top-2 h-3.5 w-3.5 fill-current text-amber-500" />}
        {checkCount > 0 && (
          <span
            className="absolute bottom-2 left-2 inline-flex items-center gap-0.5 rounded-full border border-border bg-background/80 px-1.5 py-0.5 text-[10px] text-muted-foreground"
            title={t('Someone has it check in on a schedule')}
          >
            <Timer className="h-3 w-3" />
            {checkCount}
          </span>
        )}
        <StatusBadge view={view} />
        <Workstation view={view} hair={hair} />
      </div>

      <div className="flex flex-col gap-1 px-3 pb-2.5 pt-1.5">
        <span className="truncate text-sm font-semibold text-foreground">{member.memberName}</span>
        {presence.isRemote && (
          <div className="flex min-w-0 items-center gap-1.5">
            <OwnerLabel ownerName={presence.ownerName} />
            <MemberPresenceChip
              reachability={presence.reachability}
              ownerName={presence.ownerName}
              showLabel={isUnreachable}
            />
          </div>
        )}
        <span className="truncate text-xs text-muted-foreground">
          {summary || (isLead ? t('Team Lead') : '\u00A0')}
        </span>
      </div>
    </div>
  )
}
