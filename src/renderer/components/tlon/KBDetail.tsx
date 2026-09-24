/**
 * KBDetail — the full detail view for a selected knowledge base.
 *
 * Hero section at the top (avatar, name, status, stats, quick actions)
 * followed by three tabs: Chat (ChatTab) · Files (RawFilesTab) · Settings (SettingsTab).
 */

import { useState } from 'react'
import { useTranslation } from '../../i18n'
import type { KnowledgeBaseEntry } from '../../../shared/types/tlon'
import { KbAvatar } from './KbAvatar'
import { ChatTab } from './ChatTab'
import { RawFilesTab } from './RawFilesTab'
import { SettingsTab } from './SettingsTab'
import { MessageSquare, Star } from 'lucide-react'

type KBTab = 'chat' | 'files' | 'settings'

interface KBDetailProps {
  kb: KnowledgeBaseEntry
  onDeleted: () => void
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function formatTimeAgo(dateStr: string | undefined): string | null {
  if (!dateStr) return null
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  if (isNaN(then)) return null
  const diffMs = now - then
  if (diffMs < 0) return null
  const seconds = Math.floor(diffMs / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function KBDetail({ kb, onDeleted }: KBDetailProps) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<KBTab>('files')

  const tabs: Array<{ id: KBTab; label: string }> = [
    { id: 'chat', label: t('Chat') },
    { id: 'files', label: t('Files') },
    { id: 'settings', label: t('Settings') },
  ]

  const sizeStr = kb.stats.rawSizeBytes > 0 ? formatSize(kb.stats.rawSizeBytes) : null
  const lastLearnTime = formatTimeAgo(kb.stats.lastIngestAt)

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Hero section */}
      <div className="flex-shrink-0 px-6 sm:px-10">
        <div className="flex items-center gap-3 py-3">
          <KbAvatar name={kb.name} id={kb.id} size={44} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold text-foreground truncate leading-tight">{kb.name}</h2>
              {kb.isDefault && (
                <span title={t('Default knowledge base')} className="flex-shrink-0">
                  <Star className="w-3.5 h-3.5 text-amber-500 fill-amber-500" />
                </span>
              )}
            </div>
            {/* Stats row */}
            <div className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground flex-wrap">
              <span
                className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${
                  kb.status === 'active' ? 'bg-emerald-500' : 'border border-muted-foreground/40'
                }`}
              />
              <span className={kb.status === 'active' ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}>
                {kb.status === 'active' ? t('Active') : t('Paused')}
              </span>
              <span className="text-muted-foreground/40">·</span>
              <span className="tabular-nums">
                {kb.stats.rawFileCount > 0
                  ? t('{{indexed}}/{{count}} learned', {
                      indexed: kb.stats.indexedCount,
                      count: kb.stats.rawFileCount,
                    })
                  : t('No documents')}
              </span>
              {sizeStr && (
                <>
                  <span className="text-muted-foreground/40">·</span>
                  <span className="tabular-nums">{sizeStr}</span>
                </>
              )}
              {lastLearnTime && (
                <>
                  <span className="text-muted-foreground/40">·</span>
                  <span>{lastLearnTime}</span>
                </>
              )}
            </div>
          </div>
          {/* The one action worth a header slot — same treatment as the
              digital human header's lead button. Everything else lives in
              the tabs directly below. */}
          <button
            onClick={() => setTab('chat')}
            title={t('Ask this knowledge base')}
            className="flex-shrink-0 flex min-h-9 items-center gap-1.5 rounded-lg bg-primary border border-primary px-3.5 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            <MessageSquare size={14} />
            {t('Ask')}
          </button>
        </div>
      </div>

      {/* Tab bar — same inset rule as the hero. `min-w-full w-max` keeps the
          rule under the whole strip once the tabs scroll horizontally. */}
      <div className="flex-shrink-0 px-6 sm:px-10 overflow-x-auto">
        <div className="flex items-center gap-1 border-b border-border min-w-full w-max">
          {tabs.map(tb => (
            <button
              key={tb.id}
              onClick={() => setTab(tb.id)}
              className={`flex-shrink-0 h-[34px] px-3.5 border-b-2 -mb-px text-[13px] font-medium whitespace-nowrap transition-colors ease-halo ${
                tab === tb.id
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-subtle-foreground hover:text-foreground'
              }`}
            >
              {tb.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 min-h-0">
        {tab === 'chat' ? (
          <ChatTab kb={kb} />
        ) : (
          <div className="h-full overflow-y-auto">
            {tab === 'files' && <RawFilesTab kb={kb} />}
            {tab === 'settings' && <SettingsTab kb={kb} onDeleted={onDeleted} />}
          </div>
        )}
      </div>
    </div>
  )
}