/**
 * ChatTab — ephemeral "ask this knowledge base" conversation.
 *
 * Runs through the normal agent engine (sendMessage with tlonKbId) so the
 * agent's working dir is the KB's wiki/ and it can Read/Glob/Grep the pages.
 * The transcript is not saved as history: a live status line reflects the
 * agent's activity, and the final answer is pulled from the conversation on
 * completion (see tlon.store).
 */

import { useEffect, useRef, useState, KeyboardEvent } from 'react'
import { useTranslation } from '../../i18n'
import { useTlonStore } from '../../stores/tlon.store'
import { Sparkles, Send, Trash2, Loader2, BookOpen } from 'lucide-react'
import type { KnowledgeBaseEntry } from '../../../shared/types/tlon'

interface ChatTabProps {
  kb: KnowledgeBaseEntry
}

export function ChatTab({ kb }: ChatTabProps) {
  const { t } = useTranslation()
  const session = useTlonStore(s => s.chatSessions[kb.id])
  const sendChatMessage = useTlonStore(s => s.sendChatMessage)
  const clearChat = useTlonStore(s => s.clearChat)
  const subscribeChatEvents = useTlonStore(s => s.subscribeChatEvents)

  const [input, setInput] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)

  const messages = session?.messages ?? []
  const generating = session?.generating ?? false
  const hasWiki = kb.stats.wikiPageCount > 0

  useEffect(() => subscribeChatEvents(), [subscribeChatEvents])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, session?.status])

  const handleSend = () => {
    const text = input.trim()
    if (!text || generating) return
    setInput('')
    void sendChatMessage(kb.id, text)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      // Don't send while an IME is composing — the Enter is confirming a
      // candidate (e.g. pinyin), not submitting.
      if (e.nativeEvent.isComposing || e.keyCode === 229) return
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Transcript */}
      <div className="flex-1 overflow-y-auto p-3 sm:p-4 space-y-3">
        {messages.length === 0 && !generating ? (
          <div className="h-full flex flex-col items-center justify-center text-center px-6">
            <BookOpen className="w-8 h-8 text-muted-foreground mb-3" />
            <p className="text-sm font-medium">{t('Ask this knowledge base')}</p>
            <p className="mt-1 text-xs text-muted-foreground max-w-sm">
              {hasWiki
                ? t('Questions are answered from the AI notes in this knowledge base, with sources cited.')
                : t('No AI notes yet. Add files and run learning first, then ask questions here.')}
            </p>
          </div>
        ) : (
          messages.map(msg => (
            <div
              key={msg.id}
              className={msg.role === 'user' ? 'flex justify-end' : 'flex justify-start'}
            >
              <div
                className={`max-w-[85%] rounded-xl px-3 py-2 text-sm whitespace-pre-wrap break-words ${
                  msg.role === 'user'
                    ? 'bg-primary text-primary-foreground'
                    : msg.error
                      ? 'bg-destructive/10 text-destructive border border-destructive/30'
                      : 'bg-card border border-border'
                }`}
              >
                {msg.content}
              </div>
            </div>
          ))
        )}

        {generating && (
          <div className="flex justify-start">
            <div className="inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm bg-card border border-border text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
              {session?.status || t('Thinking…')}
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Composer */}
      <div className="border-t border-border p-3 sm:p-4">
        {messages.length > 0 && (
          <div className="flex justify-end mb-2">
            <button
              onClick={() => clearChat(kb.id)}
              disabled={generating}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              {t('Clear chat')}
            </button>
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            placeholder={t('Ask a question…')}
            className="flex-1 resize-none max-h-32 px-3 py-2 bg-input rounded-lg border border-border focus:border-primary focus:outline-none transition-colors text-sm"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || generating}
            className="inline-flex items-center justify-center w-10 h-10 bg-primary text-primary-foreground rounded-lg btn-primary disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
            title={t('Send')}
          >
            {generating ? <Sparkles className="w-4 h-4 animate-pulse" /> : <Send className="w-4 h-4" />}
          </button>
        </div>
      </div>
    </div>
  )
}
