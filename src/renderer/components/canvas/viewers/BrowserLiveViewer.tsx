/**
 * Watching a browser page from a client that cannot host it.
 *
 * Most of the time nobody needs to see the browser, so nothing streams until
 * the person asks. Frames are deliberately cheap — enough to tell where the
 * page is, not enough to read a QR code, which is what the full-resolution
 * still is for.
 *
 * The person can also operate the page from here — click, scroll, type — to
 * take over a step only they can do. A frame shows one screen of a taller
 * page, so the scrollbar and an image of the whole page let them jump to any
 * part of it.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CompositionEvent, FormEvent, KeyboardEvent, MouseEvent, PointerEvent } from 'react'
import { Eye, ExternalLink, Keyboard, Loader2, Maximize2, ScrollText, X } from 'lucide-react'
import { api } from '../../../api'
import type { TabState } from '../../../services/canvas-lifecycle'
import type {
  BrowserLiveDetailScope, BrowserLiveFrame, BrowserLivePageSpan, BrowserLiveScroll, BrowserLiveStopped,
} from '../../../../shared/types/browser-live'
import { BrowserLiveInputController } from './browser-live-input'
import { BrowserViewerFallback } from './BrowserViewer'
import { AIWorkStatusLine } from '../AIWorkMarks'
import type { WsConnectionState } from '../../../api/transport'
import { useViewerResources } from '../viewer-resources'
import { useTranslation } from '../../../i18n'

interface StreamFrame {
  seq: number
  image: string
  width: number
  height: number
  url?: string
  scroll?: BrowserLiveScroll
}

interface Still {
  image: string
  width: number
  page?: BrowserLivePageSpan
}

export function BrowserLiveViewer({ tab }: { tab: TabState }) {
  const { t } = useTranslation()
  const resources = useViewerResources()
  const viewId = tab.browserViewId
  const [watching, setWatching] = useState(true)
  const [frame, setFrame] = useState<StreamFrame | null>(null)
  const [stopped, setStopped] = useState<BrowserLiveStopped['reason'] | null>(null)
  const [still, setStill] = useState<Still | null>(null)
  const [stillPending, setStillPending] = useState(false)
  const acceptingFrames = useRef(false)
  const acked = useRef(-1)
  const frameImage = useRef<HTMLImageElement>(null)
  const keyboard = useRef<HTMLTextAreaElement>(null)
  const controller = useRef<BrowserLiveInputController | null>(null)

  const start = useCallback(() => {
    setStopped(null)
    setFrame(null)
    setWatching(true)
  }, [])

  useEffect(() => {
    if (!watching || !viewId) return
    const scope = resources.scope()
    // A stream claimed again may be a new session whose seq restarts, so
    // acknowledgements from before no longer apply.
    const attach = (): boolean => {
      if (document.visibilityState === 'hidden' || acceptingFrames.current) return true
      acked.current = -1
      acceptingFrames.current = api.attachBrowserLive(viewId)
      return acceptingFrames.current
    }
    const detach = () => {
      acceptingFrames.current = false
      api.detachBrowserLive(viewId)
    }
    scope.add(detach)

    scope.add(api.onBrowserLiveFrame((incoming: BrowserLiveFrame) => {
      if (!acceptingFrames.current || incoming.viewId !== viewId) return
      if (incoming.detail) {
        setStill({ image: incoming.image, width: incoming.width, page: incoming.page })
        setStillPending(false)
        return
      }
      setFrame({
        seq: incoming.seq, image: incoming.image, width: incoming.width, height: incoming.height,
        url: incoming.url, scroll: incoming.scroll,
      })
    }))

    scope.add(api.onBrowserLiveStopped((event: BrowserLiveStopped) => {
      if (!acceptingFrames.current || event.viewId !== viewId) return
      setWatching(false)
      setStopped(event.reason)
      setFrame(null)
      setStill(null)
      setStillPending(false)
    }))

    // A reconnected socket is a new client id, so the stream has to be claimed again.
    scope.add(api.onWsStateChange((state: WsConnectionState) => {
      if (state === 'connected') attach()
    }))

    // Nothing should stream to a window the person switched away from.
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        controller.current?.pointerCancel()
        controller.current?.releaseKeys()
        detach()
        setFrame(null)
        setStill(null)
        setStillPending(false)
      } else attach()
    }
    document.addEventListener('visibilitychange', onVisibility)
    scope.add(() => document.removeEventListener('visibilitychange', onVisibility))

    if (!attach()) {
      setWatching(false)
      setStopped('unavailable')
    }
    return () => scope.dispose()
  }, [watching, viewId, resources])

  // Acknowledging after paint is what paces the stream: the next frame is sent
  // only once this one is on screen.
  const onFramePainted = useCallback(() => {
    if (!acceptingFrames.current || !viewId || !frame || frame.seq <= acked.current) return
    acked.current = frame.seq
    api.ackBrowserLive(viewId, frame.seq)
  }, [viewId, frame])

  // A resent frame with identical pixels leaves `src` unchanged, so no load
  // event fires; it is already on screen and must still be acknowledged.
  useEffect(() => {
    const img = frameImage.current
    if (img?.complete && img.naturalWidth > 0) onFramePainted()
  }, [onFramePainted])

  // Nothing may stay pressed on the page once this viewer stops operating it.
  useEffect(() => {
    if (!watching || !viewId) return
    const input = new BrowserLiveInputController(event => {
      if (acceptingFrames.current) api.sendBrowserLiveInput(viewId, event)
    })
    controller.current = input
    return () => {
      input.dispose()
      if (controller.current === input) controller.current = null
    }
  }, [watching, viewId])

  const hasFrame = frame !== null
  // React listens to wheel passively, so it could not keep the viewer itself from scrolling.
  useEffect(() => {
    const img = frameImage.current
    if (!img || !hasFrame) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      controller.current?.wheel(event, img.getBoundingClientRect())
    }
    img.addEventListener('wheel', onWheel, { passive: false })
    return () => img.removeEventListener('wheel', onWheel)
  }, [hasFrame])

  const onPointerDown = (event: PointerEvent<HTMLImageElement>) => {
    if (!controller.current) return
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    // A mouse click is the moment to start typing; a finger tap would pop the
    // phone's keyboard over the page each time, so it waits for the keyboard button.
    if (event.pointerType === 'mouse') keyboard.current?.focus({ preventScroll: true })
    controller.current.pointerDown(event, event.currentTarget.getBoundingClientRect())
  }
  const onPointerMove = (event: PointerEvent<HTMLImageElement>) => {
    controller.current?.pointerMove(event, event.currentTarget.getBoundingClientRect())
  }
  const onPointerUp = (event: PointerEvent<HTMLImageElement>) => {
    controller.current?.pointerUp(event, event.currentTarget.getBoundingClientRect())
  }
  const onPointerCancel = () => controller.current?.pointerCancel()

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const { key, shiftKey, ctrlKey, altKey, metaKey } = event
    if (!controller.current?.keyDown({ key, shiftKey, ctrlKey, altKey, metaKey, isComposing: event.nativeEvent.isComposing })) return
    event.preventDefault()
    event.stopPropagation()
  }
  const onKeyUp = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (controller.current?.keyUp(event)) event.stopPropagation()
  }
  // Text is taken from the box and the box emptied, except mid-composition,
  // where emptying it would break the input method's candidate.
  const onInput = (event: FormEvent<HTMLTextAreaElement>) => {
    const native = event.nativeEvent as InputEvent
    if (native.isComposing) return
    const box = event.currentTarget
    if (native.inputType === 'deleteContentBackward') controller.current?.press('Backspace')
    else if (native.inputType === 'insertLineBreak') controller.current?.press('Enter')
    else controller.current?.text(box.value)
    box.value = ''
  }
  const onCompositionEnd = (event: CompositionEvent<HTMLTextAreaElement>) => {
    const box = event.currentTarget
    controller.current?.text(box.value)
    box.value = ''
  }

  const requestStill = useCallback((scope: BrowserLiveDetailScope) => {
    if (!viewId || !acceptingFrames.current) return
    setStillPending(true)
    api.requestBrowserLiveDetail(viewId, scope)
  }, [viewId])

  const jump = useCallback((top: number) => controller.current?.scrollTo(top), [])

  if (!viewId) return <BrowserLiveUnavailable tab={tab} />
  if (stopped === 'unsupported') return <BrowserViewerFallback tab={tab} />

  const pageUrl = frame?.url || tab.url

  return (
    <div className="relative flex flex-col h-full bg-background">
      {tab.aiWork && <AIWorkStatusLine tab={tab} />}
      <div className="flex items-center gap-2 px-2 sm:px-3 py-2 border-b border-border-soft shrink-0">
        <span className="flex-1 min-w-0 truncate text-xs text-muted-foreground" title={pageUrl ?? ''}>
          {pageUrl ?? tab.title}
        </span>
        {watching && frame && (
          <>
            <button
              onClick={() => keyboard.current?.focus()}
              title={t('Type on the page')}
              aria-label={t('Type on the page')}
              className="p-2 rounded-md hover:bg-accent text-muted-foreground"
            >
              <Keyboard className="w-4 h-4" />
            </button>
            <button
              onClick={() => requestStill('page')}
              disabled={stillPending}
              title={t('Show the whole page')}
              className="p-1.5 rounded-md hover:bg-accent text-muted-foreground disabled:opacity-50"
            >
              <ScrollText className="w-4 h-4" />
            </button>
            <button
              onClick={() => requestStill('screen')}
              disabled={stillPending}
              title={t('Show a full-resolution still')}
              className="p-1.5 rounded-md hover:bg-accent text-muted-foreground disabled:opacity-50"
            >
              {stillPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Maximize2 className="w-4 h-4" />}
            </button>
          </>
        )}
      </div>

      <div className="relative flex-1 min-h-0 flex items-center justify-center overflow-auto bg-muted/30">
        {!watching ? (
          <BrowserLiveIdle stopped={stopped} onStart={start} />
        ) : frame ? (
          <>
            <img
              ref={frameImage}
              data-browser-live-frame="true"
              src={frame.image}
              width={frame.width}
              height={frame.height}
              onLoad={onFramePainted}
              alt={tab.title}
              draggable={false}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerCancel}
              onContextMenu={event => event.preventDefault()}
              className="max-w-full max-h-full w-auto h-auto select-none touch-none cursor-default"
            />
            {frame.scroll && <BrowserLiveScrollbar scroll={frame.scroll} onJump={jump} />}
            <textarea
              ref={keyboard}
              aria-label={t('Keyboard input for this page')}
              tabIndex={-1}
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              onKeyDown={onKeyDown}
              onKeyUp={onKeyUp}
              onInput={onInput}
              onCompositionEnd={onCompositionEnd}
              onPaste={event => {
                event.preventDefault()
                controller.current?.text(event.clipboardData.getData('text/plain'))
              }}
              onBlur={() => controller.current?.releaseKeys()}
              className="absolute left-0 bottom-0 w-px h-px opacity-0 resize-none pointer-events-none"
            />
          </>
        ) : (
          <div className="flex flex-col items-center gap-3 text-muted-foreground">
            <Loader2 className="w-6 h-6 animate-spin" />
            <p className="text-sm">{t('Waiting for the page…')}</p>
          </div>
        )}
      </div>

      {still?.page ? (
        <BrowserLiveWholePage
          still={still}
          page={still.page}
          scroll={frame?.scroll}
          onJump={jump}
          onClose={() => setStill(null)}
        />
      ) : still && (
        <div className="absolute inset-0 z-10 flex flex-col bg-background/95">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border-soft shrink-0">
            <span className="text-xs text-muted-foreground">{t('Full resolution — hold still to scan')}</span>
            <button onClick={() => setStill(null)} className="p-1.5 rounded-md hover:bg-accent text-muted-foreground">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-auto flex items-start justify-center p-2">
            <img src={still.image} alt={t('Full resolution page')} className="max-w-full h-auto" />
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Where the frame sits in a page taller than one screen; absent when it all
 * fits. When the viewer operates the page, pressing or dragging on it jumps
 * the page there.
 */
function BrowserLiveScrollbar({ scroll, onJump }: { scroll: BrowserLiveScroll; onJump?: (top: number) => void }) {
  const { t } = useTranslation()
  // Follows the pointer while dragging, ahead of the frames that confirm it.
  const [dragged, setDragged] = useState<number | null>(null)
  if (scroll.total <= scroll.viewport + 1) return null
  const size = Math.max(0.04, scroll.viewport / scroll.total)
  const top = dragged ?? Math.min(1, scroll.top / scroll.total)
  const shown = Math.round(Math.min(1, (scroll.top + scroll.viewport) / scroll.total) * 100)

  const jumpTo = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    if (!onJump || rect.height <= 0) return
    // The thumb centres on the pointer, which is where the person aimed.
    const position = Math.min(1 - size, Math.max(0, (event.clientY - rect.top) / rect.height - size / 2))
    setDragged(position)
    onJump(position * scroll.total)
  }

  return (
    <div
      className={`group absolute right-0 top-2 bottom-2 w-4 flex justify-end pr-1 ${onJump ? 'cursor-pointer touch-none' : 'pointer-events-none'}`}
      title={t('Scrolled through {{percent}}% of the page', { percent: shown })}
      onPointerDown={onJump ? event => {
        event.preventDefault()
        event.currentTarget.setPointerCapture?.(event.pointerId)
        jumpTo(event)
      } : undefined}
      onPointerMove={onJump ? event => {
        if (event.currentTarget.hasPointerCapture?.(event.pointerId)) jumpTo(event)
      } : undefined}
      onPointerUp={onJump ? () => setDragged(null) : undefined}
      onPointerCancel={onJump ? () => setDragged(null) : undefined}
    >
      <div className={`relative h-full rounded-full bg-foreground/10 transition-[width] ${onJump ? 'w-1.5 group-hover:w-2.5' : 'w-1.5'}`}>
        <div
          className="absolute left-0 right-0 rounded-full bg-foreground/40"
          style={{ top: `${top * 100}%`, height: `${Math.min(size, 1 - top) * 100}%` }}
        />
      </div>
    </div>
  )
}

/**
 * The page from its top in one image, with the part the live frame shows
 * outlined. Clicking a spot centres the page on it and returns to the live view.
 */
function BrowserLiveWholePage({
  still,
  page,
  scroll,
  onJump,
  onClose,
}: {
  still: Still
  page: BrowserLivePageSpan
  scroll?: BrowserLiveScroll
  onJump?: (top: number) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const body = useRef<HTMLDivElement>(null)
  const marker = useRef<HTMLDivElement>(null)
  const placed = page.height > 0
  const partial = !placed || page.top > 0 || page.height < page.total - 1
  const inView = placed && scroll && scroll.top + scroll.viewport > page.top && scroll.top < page.top + page.height

  // Opens on the part the person was looking at; the image has no height until it loads.
  const showCurrent = () => {
    const box = body.current
    const mark = marker.current
    if (box && mark) box.scrollTop = Math.max(0, mark.offsetTop + mark.offsetHeight / 2 - box.clientHeight / 2)
  }

  const onClick = (event: MouseEvent<HTMLImageElement>) => {
    if (!onJump || !placed) return
    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.height <= 0) return
    const spot = page.top + (event.clientY - rect.top) / rect.height * page.height
    onJump(Math.max(0, spot - (scroll?.viewport ?? 0) / 2))
    onClose()
  }

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-background/95">
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border-soft shrink-0">
        <div className="min-w-0 text-xs text-muted-foreground">
          <p>{onJump && placed ? t('The whole page — click a spot to go there') : t('The whole page')}</p>
          <p className="mt-0.5 opacity-80">
            {partial
              ? t('Only part of the page could be captured.')
              : t('Images still loading may be missing, and a bar that stays on screen repeats down the image.')}
          </p>
        </div>
        <button onClick={onClose} className="p-1.5 rounded-md hover:bg-accent text-muted-foreground shrink-0">
          <X className="w-4 h-4" />
        </button>
      </div>
      <div ref={body} className="flex-1 min-h-0 overflow-auto p-2">
        <div className="relative mx-auto" style={{ maxWidth: still.width }}>
          <img
            src={still.image}
            alt={t('The whole page')}
            draggable={false}
            onLoad={showCurrent}
            onClick={onClick}
            className={`block w-full h-auto select-none ${onJump && placed ? 'cursor-crosshair' : ''}`}
          />
          {inView && (
            <div
              ref={marker}
              className="absolute left-0 right-0 border-2 border-primary/70 bg-primary/5 pointer-events-none"
              style={{
                top: `${Math.max(0, (scroll.top - page.top) / page.height) * 100}%`,
                height: `${Math.min(scroll.viewport, page.top + page.height - scroll.top) / page.height * 100}%`,
              }}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function BrowserLiveIdle({
  stopped,
  onStart,
}: {
  stopped: BrowserLiveStopped['reason'] | null
  onStart: () => void
}) {
  const { t } = useTranslation()
  const message =
    stopped === 'gone'
      ? t('This page has closed')
      : stopped === 'stalled'
        ? t('The connection was too slow to keep up')
        : stopped === 'unavailable'
          ? t('This page could not be captured')
          : t('Watching sends low-quality snapshots of the page while you look at it')

  return (
    <div className="text-center max-w-sm px-4 py-8">
      <Eye className="w-12 h-12 mx-auto mb-4 text-muted-foreground/30" />
      <p className="text-sm text-muted-foreground mb-4">{message}</p>
      {stopped !== 'gone' && (
        <button
          onClick={onStart}
          className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
        >
          <Eye className="w-4 h-4" />
          {stopped ? t('Try again') : t('View this page')}
        </button>
      )}
      {!stopped && (
        <div className="mt-6 text-left text-xs text-muted-foreground border border-border-soft rounded-lg p-3">
          <p className="font-medium text-foreground/80 mb-1.5">{t('When to use it')}</p>
          <ul className="list-disc pl-4 space-y-1">
            <li>{t('Scan a login QR code, or pass a slider or verification check')}</li>
            <li>{t('Enter a password or verification code yourself instead of giving it to the AI')}</li>
            <li>{t('See what the AI is doing, or take over a step it is stuck on')}</li>
          </ul>
          <p className="mt-2">
            {t('You can click, scroll and type on the page, and the AI is told when you have. It keeps working whether you watch or not, so there is no need to keep this open.')}
          </p>
        </div>
      )}
    </div>
  )
}

/** A tab whose page is not attached (or has gone) has nothing to watch. */
function BrowserLiveUnavailable({ tab }: { tab: TabState }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col h-full bg-background items-center justify-center">
      <div className="text-center max-w-sm px-4">
        <Eye className="w-12 h-12 mx-auto mb-4 text-muted-foreground/30" />
        <p className="text-sm text-muted-foreground mb-4">{t('This tab has no live page to watch')}</p>
        {tab.url && (
          <button
            onClick={() => window.open(tab.url, '_blank')}
            className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
          >
            <ExternalLink className="w-4 h-4" />
            {t('Open in new window')}
          </button>
        )}
      </div>
    </div>
  )
}
