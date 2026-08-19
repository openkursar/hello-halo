/**
 * TlonPage — knowledge base manager.
 *
 * Master-detail layout: KB list (left rail on desktop, full-width on mobile)
 * and the selected KB's detail. Mobile uses push navigation (list ↔ detail).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from '../i18n'
import { ChevronLeft, Settings, Plus } from 'lucide-react'
import { Header } from '../components/layout/Header'
import { useAppStore } from '../stores/app.store'
import { useTlonStore } from '../stores/tlon.store'
import { useIsMobile } from '../hooks/useIsMobile'
import { useLayoutPreferences } from '../hooks/useLayoutPreferences'
import { KBList } from '../components/tlon/KBList'
import { KBDetail } from '../components/tlon/KBDetail'
import { CreateKBDialog } from '../components/tlon/CreateKBDialog'
import { EmptyState } from '../components/tlon/EmptyState'
import { ContentCanvas, TerminalCloseGuard } from '../components/canvas'
import { useCanvasIsOpen } from '../stores/canvas.store'

export function TlonPage() {
  const { t } = useTranslation()
  const setView = useAppStore(s => s.setView)
  const previousView = useAppStore(s => s.previousView)
  const isMobile = useIsMobile()

  const kbs = useTlonStore(s => s.kbs)
  const selectedKBId = useTlonStore(s => s.selectedKBId)
  const loadKBs = useTlonStore(s => s.loadKBs)
  const selectKB = useTlonStore(s => s.selectKB)

  const [showCreate, setShowCreate] = useState(false)

  // A source citation opens the original file in the Content Canvas. This page
  // has no canvas of its own, so it renders one using the same resizable
  // chat/canvas split as SpacePage (shared width prefs + drag handle).
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

  // Auto-select the first KB on desktop for a populated initial view.
  useEffect(() => {
    if (isMobile) return
    if (!selectedKBId && kbs.length > 0) {
      selectKB(kbs[0].id)
    }
  }, [isMobile, selectedKBId, kbs, selectKB])

  const selectedKB = kbs.find(k => k.id === selectedKBId) ?? null

  const handleCreated = (kbId: string) => {
    setShowCreate(false)
    selectKB(kbId)
  }

  return (
    <div className="h-full flex flex-col bg-background relative">
      <Header
        left={
          <button
            onClick={() => setView(previousView || 'home')}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
            {t('Knowledge')}
          </button>
        }
        right={
          <button
            onClick={() => setView('settings')}
            className="p-1.5 hover:bg-secondary rounded-lg transition-colors"
            title={t('Settings')}
          >
            <Settings className="w-5 h-5" />
          </button>
        }
      />

      {kbs.length === 0 ? (
        <div className="flex-1 overflow-y-auto">
          <EmptyState hasKBs={false} onCreate={() => setShowCreate(true)} />
        </div>
      ) : !isMobile ? (
        /* Desktop: split layout — KB list · detail · optional source canvas.
           A citation click opens the source in a right-side canvas (Halo style):
           the detail narrows and ContentCanvas fills the rest. */
        <div className="flex-1 flex overflow-hidden">
          <div className="w-64 flex-shrink-0 border-r border-border flex flex-col overflow-hidden">
            <KBList
              selectedKBId={selectedKBId}
              onSelect={selectKB}
              onCreate={() => setShowCreate(true)}
            />
          </div>
          <div
            ref={detailRef}
            className={`flex flex-col overflow-hidden min-w-0 relative ${
              canvasOpen ? 'border-r border-border/60' : 'flex-1'
            }`}
            style={{
              width: canvasOpen ? dragChatWidth : undefined,
              flex: canvasOpen ? 'none' : '1',
              minWidth: canvasOpen ? chatWidthMin : undefined,
              maxWidth: canvasOpen ? chatWidthMax : undefined,
            }}
          >
            {selectedKB
              ? <KBDetail kb={selectedKB} onDeleted={() => selectKB(null)} />
              : <EmptyState hasKBs={true} onCreate={() => setShowCreate(true)} />}
            {canvasOpen && (
              <div
                className={`absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize z-20 hover:bg-primary/50 transition-colors ${
                  isDraggingChat ? 'bg-primary/50' : ''
                }`}
                onMouseDown={handleChatDragStart}
                title={t('Drag to resize')}
              />
            )}
          </div>
          {canvasOpen && (
            <div className="flex-1 min-w-0 overflow-hidden">
              <ContentCanvas className="h-full" />
            </div>
          )}
        </div>
      ) : (
        /* Mobile: list OR detail (push navigation) */
        <div className="flex-1 flex flex-col overflow-hidden">
          {selectedKB ? (
            <>
              <div className="flex items-center gap-2 px-3 py-2 border-b border-border flex-shrink-0">
                <button
                  onClick={() => selectKB(null)}
                  className="flex items-center gap-1 text-sm text-primary"
                >
                  <ChevronLeft className="w-4 h-4" />
                  {t('Knowledge Bases')}
                </button>
              </div>
              <div className="flex-1 overflow-hidden">
                <KBDetail kb={selectedKB} onDeleted={() => selectKB(null)} />
              </div>
            </>
          ) : (
            <KBList
              selectedKBId={selectedKBId}
              onSelect={selectKB}
              onCreate={() => setShowCreate(true)}
            />
          )}
        </div>
      )}

      {/* Mobile floating create button when on the list */}
      {isMobile && kbs.length > 0 && !selectedKB && (
        <button
          onClick={() => setShowCreate(true)}
          className="fixed bottom-5 right-5 z-40 w-12 h-12 rounded-full bg-primary text-primary-foreground shadow-lg flex items-center justify-center btn-primary"
          title={t('New knowledge base')}
        >
          <Plus className="w-5 h-5" />
        </button>
      )}

      {showCreate && (
        <CreateKBDialog
          onClose={() => setShowCreate(false)}
          onCreated={handleCreated}
        />
      )}

      {/* Mobile: no room for a split, so the source preview takes over the screen. */}
      {canvasOpen && isMobile && (
        <div className="absolute inset-0 z-30 bg-background">
          <ContentCanvas className="h-full" />
        </div>
      )}

      {/* Terminal close policy for canvas terminals opened from KB chat — same
          guard SpacePage mounts; without it a terminal tab close here would
          bypass the keep-vs-terminate decision. */}
      <TerminalCloseGuard />
    </div>
  )
}
