/**
 * TlonPage — knowledge base manager.
 *
 * Two-tier navigation: card wall → detail page (shared code path for
 * desktop and mobile). The card wall shows all KBs in a responsive grid;
 * clicking a card navigates to its full detail view with a back button.
 * The ContentCanvas (source citation preview) opens inside the detail
 * view — full-screen on mobile, side-by-side on desktop.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from '../i18n'
import { ArrowLeft } from 'lucide-react'
import { Header } from '../components/layout/Header'
import { SearchIcon } from '../components/search/SearchIcon'
import { useSearchStore } from '../stores/search.store'
import { useTlonStore } from '../stores/tlon.store'
import { useIsMobile } from '../hooks/useIsMobile'
import { useLayoutPreferences } from '../hooks/useLayoutPreferences'
import { KBList } from '../components/tlon/KBList'
import { KBDetail } from '../components/tlon/KBDetail'
import { CreateKBDialog } from '../components/tlon/CreateKBDialog'
import { EmptyState } from '../components/tlon/EmptyState'
import { CanvasTableOpener, ContentCanvas, TerminalCloseGuard } from '../components/canvas'
import { useCanvasIsOpen } from '../stores/canvas.store'

export function TlonPage() {
  const { t } = useTranslation()
  const { openSearch } = useSearchStore()
  const isMobile = useIsMobile()

  const kbs = useTlonStore(s => s.kbs)
  const selectedKBId = useTlonStore(s => s.selectedKBId)
  const selectKB = useTlonStore(s => s.selectKB)
  const loadKBs = useTlonStore(s => s.loadKBs)

  const [showCreate, setShowCreate] = useState(false)

  // Content Canvas sizing (preserved from original for source citation preview)
  const canvasOpen = useCanvasIsOpen()
  const { effectiveChatWidth, setChatWidth, chatWidthMin, chatWidthMax } =
    useLayoutPreferences('halo-temp', false)
  const [isDraggingChat, setIsDraggingChat] = useState(false)
  const [dragChatWidth, setDragChatWidth] = useState(effectiveChatWidth)
  const detailRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isDraggingChat) setDragChatWidth(effectiveChatWidth)
  }, [effectiveChatWidth, isDraggingChat])

  const handleChatDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsDraggingChat(true)
  }, [])

  useEffect(() => {
    if (!isDraggingChat) return
    const handleMouseMove = (e: MouseEvent) => {
      if (!detailRef.current) return
      const rect = detailRef.current.getBoundingClientRect()
      setDragChatWidth(Math.max(chatWidthMin, Math.min(chatWidthMax, e.clientX - rect.left)))
    }
    const handleMouseUp = () => {
      setIsDraggingChat(false)
      setChatWidth(dragChatWidth)
    }
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDraggingChat, dragChatWidth, chatWidthMin, chatWidthMax, setChatWidth])

  useEffect(() => {
    loadKBs()
  }, [loadKBs])

  const selectedKB = kbs.find(k => k.id === selectedKBId) ?? null

  const handleCreated = (kbId: string) => {
    setShowCreate(false)
    selectKB(kbId)
  }

  return (
    <CanvasTableOpener>
      <div className="h-full flex flex-col bg-background relative">
        <Header
          left={
            <>
              <span className="text-sm font-semibold text-foreground whitespace-nowrap">{t('Knowledge Base')}</span>
              <SearchIcon onClick={() => openSearch('global')} />
            </>
          }
        />

        {/* Page title area — hidden when on the detail page */}
        {!selectedKBId && (
          <div className="px-6 sm:px-10 pt-5 sm:pt-7 flex-shrink-0">
            <h1 className="text-xl font-semibold mb-1">{t('Knowledge Base')}</h1>
            <p className="text-[13px] text-muted-foreground mb-5">
              {t('Maintain knowledge bases; reference with @ in conversations or attach to a digital human.')}
            </p>
          </div>
        )}

        {kbs.length === 0 && !selectedKBId ? (
          <div className="flex-1 overflow-y-auto">
            <EmptyState hasKBs={false} onCreate={() => setShowCreate(true)} />
          </div>
        ) : selectedKB ? (
          /* Detail page: replaces the card wall entirely. Desktop and mobile
             share the same code path — only the ContentCanvas split differs. */
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Back bar */}
            <div className="flex items-center gap-2 px-6 sm:px-10 pt-3 flex-shrink-0">
              <button
                onClick={() => selectKB(null)}
                className="inline-flex min-h-8 items-center gap-1.5 text-sm text-muted-foreground transition-colors ease-halo hover:text-primary"
              >
                <ArrowLeft className="w-4 h-4" />
                {t('Knowledge Bases')}
              </button>
            </div>

            {/* Detail + optional Content Canvas */}
            <div className="flex-1 flex overflow-hidden min-h-0">
              <div
                ref={detailRef}
                className="flex flex-col overflow-hidden min-w-0 relative flex-1"
                style={
                  canvasOpen && !isMobile
                    ? { width: dragChatWidth, flex: 'none', minWidth: chatWidthMin, maxWidth: chatWidthMax }
                    : undefined
                }
              >
                <KBDetail kb={selectedKB} onDeleted={() => selectKB(null)} />

                {/* Resize handle for Content Canvas (desktop only) */}
                {canvasOpen && !isMobile && (
                  <div
                    className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize z-20 hover:bg-primary/50 transition-colors"
                    onMouseDown={handleChatDragStart}
                    title={t('Drag to resize')}
                  />
                )}
              </div>

              {/* Content Canvas (desktop: side-by-side; mobile: fullscreen overlay) */}
              {canvasOpen && !isMobile && (
                <div className="flex-1 min-w-0 overflow-hidden">
                  <ContentCanvas className="h-full" />
                </div>
              )}
            </div>

            {/* Mobile: Content Canvas fullscreen overlay */}
            {canvasOpen && isMobile && (
              <div className="absolute inset-0 z-30 bg-background">
                <ContentCanvas className="h-full" />
              </div>
            )}
          </div>
        ) : (
          /* Card wall */
          <KBList onCreate={() => setShowCreate(true)} />
        )}

        {showCreate && (
          <CreateKBDialog
            onClose={() => setShowCreate(false)}
            onCreated={handleCreated}
          />
        )}

        <TerminalCloseGuard />
      </div>
    </CanvasTableOpener>
  )
}