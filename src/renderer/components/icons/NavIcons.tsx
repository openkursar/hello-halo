/**
 * Glyphs for the rail's destinations (conversation / digital humans /
 * knowledge base / store) and the task panel, drawn to share the brand logo's
 * ring geometry.
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
const HALO_ARC = 'M6.91 5.46A9.6 9.6 0 0 1 17.09 5.46'
const PAGE_L = 'M12 7.2C10.4 5.9 8.2 5.3 5.2 5.4A1.6 1.6 0 0 0 3.6 7V17A1.6 1.6 0 0 0 5.3 18.6C8.2 18.5 10.4 19.1 12 20.4Z'
const PAGE_R = 'M12 7.2C13.6 5.9 15.8 5.3 18.8 5.4A1.6 1.6 0 0 1 20.4 7V17A1.6 1.6 0 0 1 18.7 18.6C15.8 18.5 13.6 19.1 12 20.4Z'
const STAR = 'M12 7.3C12.5 10.6 13.4 11.5 16.7 12C13.4 12.5 12.5 13.4 12 16.7C11.5 13.4 10.6 12.5 7.3 12C10.6 11.5 11.5 10.6 12 7.3Z'

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

export const DigitalHumanNavIcon: FC<NavIconProps> = ({ className, active }) => {
  const mask = useMaskId()
  return (
    <Glyph className={className}>
      <path d={HALO_ARC} />
      {active ? (
        <>
          <mask id={mask}>
            <rect width="24" height="24" fill="white" />
            <ellipse cx="9.4" cy="12.8" rx="1.2" ry="2.1" fill="black" />
            <ellipse cx="14.6" cy="12.8" rx="1.2" ry="2.1" fill="black" />
          </mask>
          <circle cx="12" cy="13.6" r="7.2" fill="currentColor" stroke="none" mask={`url(#${mask})`} />
        </>
      ) : (
        <>
          <circle cx="12" cy="13.6" r="6.4" />
          <ellipse cx="9.4" cy="12.8" rx="1.05" ry="1.95" fill="currentColor" stroke="none" />
          <ellipse cx="14.6" cy="12.8" rx="1.05" ry="1.95" fill="currentColor" stroke="none" />
        </>
      )}
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

/** Squircle rather than a circle so it stays distinct from the store glyph. */
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

export const StoreNavIcon: FC<NavIconProps> = ({ className, active }) => {
  const mask = useMaskId()
  if (!active) {
    return (
      <Glyph className={className}>
        <circle cx="12" cy="12" r="8.8" />
        <path d={STAR} fill="currentColor" stroke="none" />
      </Glyph>
    )
  }
  return (
    <Glyph className={className}>
      <mask id={mask}>
        <rect width="24" height="24" fill="white" />
        <path d={STAR} fill="black" />
      </mask>
      <circle cx="12" cy="12" r="9.6" fill="currentColor" stroke="none" mask={`url(#${mask})`} />
    </Glyph>
  )
}
