/**
 * KnowledgeBaseButton — toolbar control that loads Tlon knowledge bases into
 * the current conversation. Lives in the input toolbar next to Web Control /
 * Deep Thinking. Active (tinted) when ≥1 KB is loaded; the label shows the
 * loaded KB's name. Clicking opens a picker to toggle KBs and set the default.
 *
 * New conversations auto-load the default KB (see chat.store.createConversation);
 * on a brand-new chat with no conversation yet, toggling creates one on demand.
 */

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from '../../i18n'
import { useChatStore } from '../../stores/chat.store'
import { useTlonStore } from '../../stores/tlon.store'
import { useSpaceStore } from '../../stores/space.store'
import { BookOpen, Check, Star } from 'lucide-react'

const NO_IDS: string[] = []

export function KnowledgeBaseButton() {
  const { t } = useTranslation()
  const currentSpace = useSpaceStore(s => s.currentSpace)
  const kbs = useTlonStore(s => s.kbs)
  const loadKBs = useTlonStore(s => s.loadKBs)
  const setDefaultKB = useTlonStore(s => s.setDefaultKB)

  const getCurrentConversationId = useChatStore(s => s.getCurrentConversationId)
  const getCachedConversation = useChatStore(s => s.getCachedConversation)
  const createConversation = useChatStore(s => s.createConversation)
  const attachKnowledgeBase = useChatStore(s => s.attachKnowledgeBase)
  const detachKnowledgeBase = useChatStore(s => s.detachKnowledgeBase)
  // Subscribe to cache changes so the label reflects attach/detach immediately.
  const cache = useChatStore(s => s.conversationCache)

  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => { void loadKBs() }, [loadKBs])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const convId = getCurrentConversationId()
  const convIds = (convId ? cache.get(convId)?.knowledgeBaseIds : undefined) ?? NO_IDS
  const defaultKb = kbs.find(k => k.isDefault)
  // Before the conversation exists, reflect the default that will auto-load.
  const effectiveIds = convId ? convIds : (defaultKb ? [defaultKb.id] : NO_IDS)
  const loaded = kbs.filter(k => effectiveIds.includes(k.id))
  const count = loaded.length
  const active = count > 0

  const toggleKb = async (kbId: string) => {
    const spaceId = currentSpace?.id
    if (!spaceId) return
    let conversationId = getCurrentConversationId()
    if (!conversationId) {
      const conv = await createConversation(spaceId)
      conversationId = conv?.id ?? null
    }
    if (!conversationId) return
    const ids = getCachedConversation(conversationId)?.knowledgeBaseIds ?? []
    if (ids.includes(kbId)) await detachKnowledgeBase(spaceId, conversationId, kbId)
    else await attachKnowledgeBase(spaceId, conversationId, kbId)
  }

  const toggleDefault = (e: React.MouseEvent, kbId: string) => {
    e.stopPropagation()
    void setDefaultKB(defaultKb?.id === kbId ? null : kbId)
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className={`h-8 flex items-center gap-1.5 px-2.5 rounded-lg transition-colors duration-200 ${
          active
            ? 'bg-primary/10 text-primary'
            : 'text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/50'
        }`}
        title={t('Load knowledge bases into this conversation')}
      >
        <BookOpen size={15} className="flex-shrink-0" />
        <span className="text-xs">{t('Knowledge')}</span>
        {count > 0 && (
          <span className="text-[10px] leading-none min-w-[15px] h-[15px] px-1 rounded-full bg-primary/20 text-primary inline-flex items-center justify-center tabular-nums">
            {count}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-2 w-72 max-h-72 overflow-y-auto py-1.5 bg-popover border border-border rounded-xl shadow-lg z-30 animate-fade-in">
          <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground">
            {t('Load knowledge bases')}
          </div>
          {kbs.length === 0 ? (
            <div className="px-3 py-3 text-xs text-muted-foreground">
              {t('No knowledge bases yet. Create one in the Knowledge section.')}
            </div>
          ) : (
            kbs.map(kb => {
              const isLoaded = effectiveIds.includes(kb.id)
              const isDefault = kb.id === defaultKb?.id
              return (
                <button
                  key={kb.id}
                  onClick={() => toggleKb(kb.id)}
                  className="w-full px-3 py-2 flex items-center gap-2.5 text-sm text-foreground hover:bg-muted/50 transition-colors"
                >
                  <span className="w-5 flex justify-center flex-shrink-0">
                    {isLoaded ? <Check className="w-4 h-4 text-primary" /> : <BookOpen className="w-4 h-4 text-muted-foreground" />}
                  </span>
                  <div className="min-w-0 flex-1 text-left">
                    <p className="truncate">{kb.name}</p>
                    <p className="text-[11px] text-muted-foreground truncate">
                      {t('{{notes}} notes', { notes: kb.stats.wikiPageCount })}
                    </p>
                  </div>
                  <span
                    role="button"
                    onClick={(e) => toggleDefault(e, kb.id)}
                    className={`p-1 rounded hover:bg-muted flex-shrink-0 ${isDefault ? 'text-primary' : 'text-muted-foreground/40'}`}
                    title={isDefault ? t('Default — loaded into new conversations') : t('Set as default')}
                  >
                    <Star className="w-3.5 h-3.5" fill={isDefault ? 'currentColor' : 'none'} />
                  </span>
                </button>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}
