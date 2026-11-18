import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { useTranslation } from '../../../i18n'
import { usePointerDrag } from '../../../hooks/usePointerDrag'
import { useTeamViewPrefsStore } from '../../../stores/team-view-prefs.store'

const MIN_WIDTH = 400
const DEFAULT_MAX = 640
const DEFAULT_SHARE = 0.45
/** The page beside the panel never gets narrower than this. */
const MIN_PAGE = 480
const KEY_STEP = 16

/** The detail column docked beside the team page; its left edge drags to resize, remembered on this screen. */
export function DockedPanel({ label, containerWidth, children }: { label: string; containerWidth: number; children: ReactNode }) {
  const { t } = useTranslation()
  const stored = useTeamViewPrefsStore(state => state.detailPanelWidth)
  const [live, setLive] = useState<number | null>(null)
  const origin = useRef({ x: 0, width: 0 })
  const max = Math.max(MIN_WIDTH, containerWidth - MIN_PAGE)
  const clamp = (value: number) => Math.round(Math.min(max, Math.max(MIN_WIDTH, value)))
  const width = clamp(live ?? stored ?? Math.min(DEFAULT_MAX, containerWidth * DEFAULT_SHARE))
  const save = (value: number) => useTeamViewPrefsStore.getState().setDetailPanelWidth(clamp(value))

  const drag = usePointerDrag({
    enabled: true,
    onStart: () => undefined,
    onMove: ({ clientX }) => setLive(clamp(origin.current.width + origin.current.x - clientX)),
    onEnd: ({ clientX }) => {
      setLive(null)
      if (clientX !== origin.current.x) save(origin.current.width + origin.current.x - clientX)
    },
  })
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    origin.current = { x: event.clientX, width }
    drag(event)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    save(width + (event.key === 'ArrowLeft' ? KEY_STEP : -KEY_STEP))
  }

  return <section aria-label={label} className="relative shrink-0 border-l border-border-soft bg-background" style={{ width }}>
    <div className="h-full overflow-hidden">{children}</div>
    <div
      role="separator"
      aria-label={t('Resize details panel')}
      aria-orientation="vertical"
      aria-valuemin={MIN_WIDTH}
      aria-valuemax={max}
      aria-valuenow={width}
      title={t('Drag to resize. Double-click to reset.')}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => useTeamViewPrefsStore.getState().setDetailPanelWidth(null)}
      className={`absolute inset-y-0 -left-[3px] z-10 w-1.5 cursor-col-resize touch-none select-none transition-colors hover:bg-primary/40 focus-visible:bg-primary/40 focus-visible:outline-none ${live !== null ? 'bg-primary/40' : ''}`}
    />
  </section>
}
