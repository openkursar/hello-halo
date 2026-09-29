/**
 * Glyphs for the rail's destinations (conversation / digital humans /
 * knowledge base / store) and the task panel. Each keeps a distinct outer
 * silhouette so they tell apart at a glance in one column.
 *
 * Each has an outline form and a solid `active` form — the selected
 * destination reads as filled, the way native sidebars mark the current
 * page. In the solid form, detail is cut out as negative space rather than
 * layered on top, so it stays crisp at 20px.
 */
import { useId, type FC } from 'react'

export interface NavIconProps {
  className?: string
  /** Render the solid (selected) form. */
  active?: boolean
}

const BUBBLE = 'M5.7 15.96A8.3 8.3 0 1 1 8.99 18.72C7.4 19.7 5.6 20.4 3.6 20.4C4.6 19.1 5.3 17.6 5.7 15.96Z'
const PAGE_L = 'M12 7.2C10.4 5.9 8.2 5.3 5.2 5.4A1.6 1.6 0 0 0 3.6 7V17A1.6 1.6 0 0 0 5.3 18.6C8.2 18.5 10.4 19.1 12 20.4Z'
const PAGE_R = 'M12 7.2C13.6 5.9 15.8 5.3 18.8 5.4A1.6 1.6 0 0 1 20.4 7V17A1.6 1.6 0 0 1 18.7 18.6C15.8 18.5 13.6 19.1 12 20.4Z'
const STAR = 'M16.8 12.6C16.99 15.54 18.06 16.61 21 16.8C18.06 16.99 16.99 18.06 16.8 21C16.61 18.06 15.54 16.99 12.6 16.8C15.54 16.61 16.61 15.54 16.8 12.6Z'
const STAR_SOLID = 'M16.9 12.3C17.11 15.52 18.28 16.69 21.5 16.9C18.28 17.11 17.11 18.28 16.9 21.5C16.69 18.28 15.52 17.11 12.3 16.9C15.52 16.69 16.69 15.52 16.9 12.3Z'

function Glyph({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

/** `useId` output contains colons, which some url(#…) consumers reject. */
function useMaskId(): string {
  return 'nav-' + useId().replace(/:/g, '')
}

export const ChatNavIcon: FC<NavIconProps> = ({ className, active }) => (
  <Glyph className={className}>
    <path d={BUBBLE} fill={active ? 'currentColor' : 'none'} />
  </Glyph>
)

/**
 * One face from the digital-human avatar generator (the beam algorithm behind
 * AutomationAvatar, seeded with "echo"), with its features enlarged to read at
 * 20px. FACE maps the generator's 36-unit face space onto this glyph.
 */
const FACE = 'matrix(0.841 0.074 -0.074 0.841 -3.243 -4.339)'
function FaceFeatures({ fill }: { fill: string }) {
  return (
    <g transform={FACE} fill={fill} stroke="none">
      <path d="M13 20a1 .75 0 0 0 10 0Z" />
      <rect x="14" y="14" width="1.5" height="2.2" rx=".75" />
      <rect x="20" y="14" width="1.5" height="2.2" rx=".75" />
    </g>
  )
}

export const DigitalHumanNavIcon: FC<NavIconProps> = ({ className, active }) => {
  const mask = useMaskId()
  if (!active) {
    return (
      <Glyph className={className}>
        <circle cx="12" cy="12" r="8.8" />
        <FaceFeatures fill="currentColor" />
      </Glyph>
    )
  }
  return (
    <Glyph className={className}>
      <mask id={mask}>
        <rect width="24" height="24" fill="white" />
        <FaceFeatures fill="black" />
      </mask>
      <circle cx="12" cy="12" r="9.6" fill="currentColor" stroke="none" mask={`url(#${mask})`} />
    </Glyph>
  )
}

export const KnowledgeNavIcon: FC<NavIconProps> = ({ className, active }) => {
  const mask = useMaskId()
  if (!active) {
    return (
      <Glyph className={className}>
        <path d={PAGE_L} />
        <path d={PAGE_R} />
      </Glyph>
    )
  }
  return (
    <Glyph className={className}>
      <mask id={mask}>
        <rect width="24" height="24" fill="white" />
        <rect x="11.15" y="4" width="1.7" height="18" fill="black" />
      </mask>
      <g mask={`url(#${mask})`} fill="currentColor">
        <path d={PAGE_L} />
        <path d={PAGE_R} />
      </g>
    </Glyph>
  )
}

/** Squircle rather than a circle so it stays distinct from the digital-human glyph. */
export const TasksNavIcon: FC<NavIconProps> = ({ className, active }) => {
  const mask = useMaskId()
  const check = 'M8.4 12.2l2.5 2.5 4.9-5.1'
  if (!active) {
    return (
      <Glyph className={className}>
        <rect x="3.4" y="3.4" width="17.2" height="17.2" rx="6" />
        <path d={check} />
      </Glyph>
    )
  }
  return (
    <Glyph className={className}>
      <mask id={mask}>
        <rect width="24" height="24" fill="white" />
        <path d={check} stroke="black" strokeWidth={1.9} fill="none" />
      </mask>
      <rect x="2.6" y="2.6" width="18.8" height="18.8" rx="6.8" fill="currentColor" stroke="none" mask={`url(#${mask})`} />
    </Glyph>
  )
}

/** App-grid with a sparkle in the fourth cell: a market of capabilities to discover. */
export const StoreNavIcon: FC<NavIconProps> = ({ className, active }) => {
  if (!active) {
    return (
      <Glyph className={className}>
        <rect x="3.8" y="3.8" width="6.8" height="6.8" rx="2" />
        <rect x="13.4" y="3.8" width="6.8" height="6.8" rx="2" />
        <rect x="3.8" y="13.4" width="6.8" height="6.8" rx="2" />
        <path d={STAR} fill="currentColor" stroke="none" />
      </Glyph>
    )
  }
  return (
    <Glyph className={className}>
      <g fill="currentColor" stroke="none">
        <rect x="3" y="3" width="8.2" height="8.2" rx="2.4" />
        <rect x="12.8" y="3" width="8.2" height="8.2" rx="2.4" />
        <rect x="3" y="12.8" width="8.2" height="8.2" rx="2.4" />
        <path d={STAR_SOLID} />
      </g>
    </Glyph>
  )
}
