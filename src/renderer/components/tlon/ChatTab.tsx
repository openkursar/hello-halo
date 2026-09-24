/**
 * ChatTab — ephemeral "ask this knowledge base" conversation.
 *
 * Runs through the normal agent engine (sendMessage with knowledgeBaseId) so the
 * agent's working dir is the KB's text/ corpus and it can Read/Glob/Grep it.
 * The transcript is not saved as history: a live status line reflects the
 * agent's activity, and the final answer is pulled from the conversation on
 * completion (see tlon.store).
 */

import { useEffect, useRef, useState, KeyboardEvent } from 'react'
import { useTranslation } from '../../i18n'
import { useTlonStore } from '../../stores/tlon.store'
import { Sparkles, Send, Trash2, Loader2, BookOpen } from 'lucide-react'
import { MarkdownRenderer } from '../chat/MarkdownRenderer'
import { SourceChips } from '../chat/SourceChips'
import type { KnowledgeBaseEntry } from '../../../shared/types/tlon'

interface ChatTabProps {
  kb: KnowledgeBaseEntry
}

export function ChatTab({ kb }: ChatTabProps) {
  const { t } = useTranslation()
  const session = useTlonStore(s => s.chatSessions[kb.id])
  const sendChatMessage = useTlonStore(s => s.sendChatMessage)
  const clearChat = useTlonStore(s => s.clearChat)

  const [input, setInput] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)

  const messages = session?.messages ?? []
  const generating = session?.generating ?? false
  const hasSources = kb.stats.rawFileCount > 0

  // Agent events are subscribed globally in App.tsx (not here) so a turn that
  // completes while this tab is unmounted still settles.

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
      {/* Transcript — capped at the main chat's 720px reading column; the
          scroller stays full-width so the scrollbar sits at the pane edge. */}
      <div className="flex-1 overflow-y-auto px-6 sm:px-10 py-4">
        <div className="max-w-[720px] mx-auto h-full space-y-3">
        {messages.length === 0 && !generating ? (
          <div className="h-full flex flex-col items-center justify-center text-center px-6">
            <BookOpen className="w-8 h-8 text-muted-foreground mb-3" />
            <p className="text-sm font-medium">{t('Ask this knowledge base')}</p>
            <p className="mt-1 text-xs text-muted-foreground max-w-sm">
              {hasSources
                ? t('Questions are answered from the documents in this knowledge base, with sources cited.')
                : t('No documents indexed yet. Add files first, then ask questions here.')}
            </p>
          </div>
        ) : (
          /* Same bubble treatment as the main chat (shared message-user /
             message-assistant styles), so one product doesn't render two
             different-looking conversations. */
          messages.map(msg => {
            const isUser = msg.role === 'user'
            const asMarkdown = !isUser && !msg.error
            return (
              <div
                key={msg.id}
                className={`flex animate-fade-in ${isUser ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[85%] rounded-lg text-sm break-words ${
                    isUser
                      ? 'message-user px-3.5 py-2.5 whitespace-pre-wrap'
                      : msg.error
                        ? 'bg-destructive/10 text-destructive border border-destructive/30 px-4 py-3 whitespace-pre-wrap'
                        : 'message-assistant px-4 py-3'
                  }`}
                >
                  {asMarkdown
                    ? <MarkdownRenderer content={msg.content} />
                    : msg.content}
                  {msg.sources && msg.sources.length > 0 && (
                    <SourceChips sources={msg.sources} />
                  )}
                </div>
              </div>
            )
          })
        )}

        {generating && (
          <div className="flex justify-start animate-fade-in">
            <div className="message-assistant inline-flex items-center gap-2 rounded-lg px-4 py-3 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
              {session?.status || t('Thinking…')}
            </div>
          </div>
        )}

          <div ref={bottomRef} />
        </div>
      </div>

      {/* Composer — the main chat's rounded card shape and reading width,
          without its slash commands / mentions / toolset controls, none of
          which apply to a question against a single corpus. */}
      <div className="px-6 sm:px-10 pt-3 pb-4">
        <div className="max-w-[720px] mx-auto">
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
          <div className="flex items-end gap-2 rounded-[18px] border border-border bg-card px-3.5 py-2.5 shadow-soft transition-colors ease-halo focus-within:border-primary">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={2}
              placeholder={t('Ask a question…')}
              style={{ maxHeight: '180px' }}
              className="flex-1 min-w-0 min-h-[52px] resize-none bg-transparent py-1 text-[15px] leading-[1.5] text-foreground outline-none placeholder:text-subtle-foreground"
            />
            <button
              onClick={handleSend}
              disabled={!input.trim() || generating}
              className="mb-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed"
              title={t('Send')}
            >
              {generating ? <Sparkles className="w-4 h-4 animate-pulse" /> : <Send className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
