/**
 * KBDetail — the detail pane for a selected knowledge base.
 *
 * Header (icon + name + file/note counts) over four tabs:
 *   Chat (ChatTab) · Files (RawFilesTab) · AI Notes (WikiTab) · Settings (SettingsTab)
 */

import { useState } from 'react'
import { useTranslation } from '../../i18n'
import type { KnowledgeBaseEntry } from '../../../shared/types/tlon'
import { BookOpen } from 'lucide-react'
import { ChatTab } from './ChatTab'
import { WikiTab } from './WikiTab'
import { RawFilesTab } from './RawFilesTab'
import { SettingsTab } from './SettingsTab'

type KBTab = 'chat' | 'notes' | 'files' | 'settings'

interface KBDetailProps {
  kb: KnowledgeBaseEntry
  onDeleted: () => void
}

export function KBDetail({ kb, onDeleted }: KBDetailProps) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<KBTab>('files')

  const tabs: Array<{ id: KBTab; label: string }> = [
    { id: 'chat', label: t('Chat') },
    { id: 'files', label: t('Files') },
    { id: 'notes', label: t('AI Notes') },
    { id: 'settings', label: t('Settings') },
  ]

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Detail header */}
      <div className="flex items-center gap-2.5 px-3 sm:px-4 py-3 border-b border-border flex-shrink-0">
        <BookOpen className="w-5 h-5 text-muted-foreground flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold truncate">{kb.name}</h2>
          <p className="text-[11px] text-muted-foreground truncate">
            {t('{{files}} files · {{notes}} notes', {
              files: kb.stats.rawFileCount,
              notes: kb.stats.wikiPageCount,
            })}
          </p>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex items-center gap-1 px-3 sm:px-4 py-1.5 border-b border-border flex-shrink-0 overflow-x-auto">
        {tabs.map(tb => (
          <button
            key={tb.id}
            onClick={() => setTab(tb.id)}
            className={`px-3 py-1.5 text-sm rounded-lg transition-colors whitespace-nowrap ${
              tab === tb.id
                ? 'bg-primary/10 text-primary font-medium'
                : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
            }`}
          >
            {tb.label}
          </button>
        ))}
      </div>

      {/* Tab content. Chat manages its own scroll/layout; the others scroll here. */}
      <div className="flex-1 min-h-0">
        {tab === 'chat' ? (
          <ChatTab kb={kb} />
        ) : (
          <div className="h-full overflow-y-auto">
            {tab === 'files' && <RawFilesTab kb={kb} />}
            {tab === 'notes' && <WikiTab kb={kb} />}
            {tab === 'settings' && <SettingsTab kb={kb} onDeleted={onDeleted} />}
          </div>
        )}
      </div>
    </div>
  )
}
