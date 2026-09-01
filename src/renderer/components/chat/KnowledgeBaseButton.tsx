/**
 * KnowledgeBaseButton — toolbar control that manages which Tlon knowledge bases
 * feed the current conversation. Lives in the input toolbar next to Web Control /
 * Deep Thinking. Active (tinted) when ≥1 KB is loaded into this conversation;
 * the count badge reflects that set.
 *
 * Two scopes, both surfaced here (single entry point for all knowledge wiring):
 *  - This conversation: row click toggles a KB in/out of the conversation's own
 *    knowledgeBaseIds (opt-in, and opt-out of a space-seeded KB for a one-off task).
 *  - This space (pin): binds a KB to the current space so future conversations in
 *    it seed with the KB. It does NOT retroactively touch existing conversations
 *    (snapshot-at-creation model), so the pin is captioned "applies to new
 *    conversations".
 *
 * New conversations seed knowledgeBaseIds in the main process from the space's
 * bindings + the default KB (conversation.service.createConversation). On a
 * brand-new chat with no conversation yet, toggling creates one on demand.
 */

import { useEffect, useState } from 'react'
import { useTranslation } from '../../i18n'
import { useChatStore } from '../../stores/chat.store'
import { useTlonStore } from '../../stores/tlon.store'
import { useSpaceStore } from '../../stores/space.store'
import { useAppStore } from '../../stores/app.store'
import { Popover, PopoverTrigger, PopoverContent } from '../ui/Popover'
import { BookOpen, Check, Star, Pin, ArrowRight } from 'lucide-react'

const NO_IDS: string[] = []

export function KnowledgeBaseButton() {
  const { t } = useTranslation()
  const currentSpace = useSpaceStore(s => s.currentSpace)
  const kbs = useTlonStore(s => s.kbs)
  const loadKBs = useTlonStore(s => s.loadKBs)
  const setDefaultKB = useTlonStore(s => s.setDefaultKB)
  const bindSpace = useTlonStore(s => s.bindSpace)
  const unbindSpace = useTlonStore(s => s.unbindSpace)
  const navigate = useAppStore(s => s.navigate)

  const getCurrentConversationId = useChatStore(s => s.getCurrentConversationId)
  const getCachedConversation = useChatStore(s => s.getCachedConversation)
  const createConversation = useChatStore(s => s.createConversation)
  const attachKnowledgeBase = useChatStore(s => s.attachKnowledgeBase)
  const detachKnowledgeBase = useChatStore(s => s.detachKnowledgeBase)
  // Subscribe to cache changes so the label reflects attach/detach immediately.
  const cache = useChatStore(s => s.conversationCache)

  const [open, setOpen] = useState(false)

  useEffect(() => { void loadKBs() }, [loadKBs])

  const spaceId = currentSpace?.id ?? null
  const convId = getCurrentConversationId()
  const convIds = (convId ? cache.get(convId)?.knowledgeBaseIds : undefined) ?? NO_IDS
  const defaultKb = kbs.find(k => k.isDefault)
  // Before the conversation exists, mirror what the main process would seed:
  // the space's bound KBs plus the default (see getSeedKBIds).
  const seedIds = kbs
    .filter(k => (spaceId && k.spaceIds.includes(spaceId)) || k.isDefault)
    .map(k => k.id)
  const effectiveIds = convId ? convIds : (seedIds.length > 0 ? seedIds : NO_IDS)
  const loaded = kbs.filter(k => effectiveIds.includes(k.id))
  const count = loaded.length
  const active = count > 0

  const toggleKb = async (kbId: string) => {
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

  const toggleSpaceBinding = (e: React.MouseEvent, kbId: string) => {
    e.stopPropagation()
    if (!spaceId) return
    const kb = kbs.find(k => k.id === kbId)
    if (kb?.spaceIds.includes(spaceId)) void unbindSpace(kbId, spaceId)
    else void bindSpace(kbId, spaceId)
  }

  const openKnowledgePage = () => {
    setOpen(false)
    navigate('tlon')
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        title={t('Load knowledge bases into this conversation')}
        className={`h-8 shrink-0 items-center gap-1.5 px-2.5 rounded-lg cursor-pointer transition-colors duration-200 ${
          active
            ? 'bg-primary/10 text-primary'
            : 'text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/50'
        }`}
      >
        <BookOpen size={15} className="flex-shrink-0" />
        <span className="text-xs">{t('Knowledge')}</span>
        {count > 0 && (
          <span className="text-[10px] leading-none min-w-[15px] h-[15px] px-1 rounded-full bg-primary/20 text-primary inline-flex items-center justify-center tabular-nums">
            {count}
          </span>
        )}
      </PopoverTrigger>

      <PopoverContent side="top" align="start" sideOffset={8} className="w-72 max-h-80 overflow-y-auto py-1.5 rounded-xl">
        <div>
          {kbs.length === 0 ? (
            <div className="px-3 py-4 flex flex-col items-center text-center gap-2">
              <BookOpen className="w-6 h-6 text-muted-foreground/50" />
              <p className="text-sm text-foreground">{t('No knowledge yet')}</p>
              <p className="text-xs text-muted-foreground">
                {t('Add documents to a knowledge base so the AI can reference them.')}
              </p>
              <button
                onClick={openKnowledgePage}
                className="mt-1 inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs hover:bg-primary/90 transition-colors"
              >
                {t('Add knowledge')}
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <>
              <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground">
                {t('Load knowledge bases')}
              </div>
              {kbs.map(kb => {
                const isLoaded = effectiveIds.includes(kb.id)
                const isDefault = kb.id === defaultKb?.id
                const isPinned = spaceId ? kb.spaceIds.includes(spaceId) : false
                return (
                  // Row is the primary toggle; pin/star are nested actions. A native
                  // <button> may not contain other buttons, so the row is role="button"
                  // and the target guard keeps its key handler from firing while an
                  // inner action button holds focus.
                  <div
                    key={kb.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => toggleKb(kb.id)}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget) return
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        void toggleKb(kb.id)
                      }
                    }}
                    className="w-full px-3 py-2 flex items-center gap-2.5 text-sm text-foreground hover:bg-muted/50 transition-colors cursor-pointer"
                  >
                    <span className="w-5 flex justify-center flex-shrink-0">
                      {isLoaded ? <Check className="w-4 h-4 text-primary" /> : <BookOpen className="w-4 h-4 text-muted-foreground" />}
                    </span>
                    <div className="min-w-0 flex-1 text-left">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <p className="truncate">{kb.name}</p>
                        {isPinned && (
                          <span className="text-[9px] leading-none px-1 py-0.5 rounded bg-primary/15 text-primary flex-shrink-0 uppercase tracking-wide">
                            {t('Space')}
                          </span>
                        )}
                        {isDefault && (
                          <span className="text-[9px] leading-none px-1 py-0.5 rounded bg-primary/15 text-primary flex-shrink-0 uppercase tracking-wide">
                            {t('Default')}
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-muted-foreground truncate">
                        {t('{{count}} documents', { count: kb.stats.rawFileCount })}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => toggleSpaceBinding(e, kb.id)}
                      className={`p-1 rounded hover:bg-muted flex-shrink-0 ${isPinned ? 'text-primary' : 'text-muted-foreground/40'}`}
                      title={isPinned ? t('Always enabled in this space (applies to new conversations)') : t('Always enable in this space (applies to new conversations)')}
                    >
                      <Pin className="w-3.5 h-3.5" fill={isPinned ? 'currentColor' : 'none'} />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => toggleDefault(e, kb.id)}
                      className={`p-1 rounded hover:bg-muted flex-shrink-0 ${isDefault ? 'text-primary' : 'text-muted-foreground/40'}`}
                      title={isDefault ? t('Default — seeded into new conversations everywhere') : t('Set as default')}
                    >
                      <Star className="w-3.5 h-3.5" fill={isDefault ? 'currentColor' : 'none'} />
                    </button>
                  </div>
                )
              })}
              <div className="mt-1 pt-1 border-t border-border">
                <button
                  onClick={openKnowledgePage}
                  className="w-full px-3 py-2 flex items-center justify-between text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors"
                >
                  {t('Manage knowledge bases')}
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
