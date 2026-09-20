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
import { MessageSquare, Settings, Star } from 'lucide-react'

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
      <div className="flex-shrink-0 border-b border-border px-3 sm:px-4 py-3">
        <div className="flex items-center gap-3">
          <KbAvatar name={kb.name} id={kb.id} size={40} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold truncate">{kb.name}</h2>
              {kb.isDefault && (
                <span title={t('Default knowledge base')} className="flex-shrink-0">
                  <Star className="w-3.5 h-3.5 text-amber-500 fill-amber-500" />
                </span>
              )}
            </div>
            {/* Stats row */}
            <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground flex-wrap">
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
          {/* Quick actions */}
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              onClick={() => setTab('chat')}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors btn-primary"
              title={t('Ask this knowledge base')}
            >
              <MessageSquare className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{t('Ask')}</span>
            </button>
            <button
              onClick={() => setTab('settings')}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs bg-secondary hover:bg-secondary/80 rounded-lg transition-colors"
              title={t('Settings')}
            >
              <Settings className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{t('Settings')}</span>
            </button>
          </div>
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