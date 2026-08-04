/**
 * AppKnowledgeSection
 *
 * Lists the knowledge bases bound to a digital human (kb.appIds includes
 * appId) and lets the user toggle bindings on/off. Checkbox state writes
 * straight through `bindApp`/`unbindApp` — no restart prompt, since the
 * binding feeds `getKBReferencesForApp` which is read fresh on every run/
 * message and the chat session fingerprint already rebuilds on system
 * prompt changes (see services/agent/sdk-config.ts).
 *
 * Space/Default badges mirror KnowledgeBaseButton's read-only display —
 * pin/star toggling stays on the Knowledge page and the space entry point.
 */

import { useEffect } from 'react'
import { BookOpen, Check, Globe, Star, ArrowRight } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { useTlonStore } from '../../stores/tlon.store'
import { useAppStore } from '../../stores/app.store'

interface AppKnowledgeSectionProps {
  appId: string
}

export function AppKnowledgeSection({ appId }: AppKnowledgeSectionProps) {
  const { t } = useTranslation()
  const kbs = useTlonStore(s => s.kbs)
  const loadKBs = useTlonStore(s => s.loadKBs)
  const bindApp = useTlonStore(s => s.bindApp)
  const unbindApp = useTlonStore(s => s.unbindApp)
  const setView = useAppStore(s => s.setView)

  useEffect(() => { void loadKBs() }, [loadKBs])

  const bound = kbs.filter(kb => kb.appIds.includes(appId))
  const openKnowledgePage = () => setView('tlon')

  const toggleKb = (kbId: string) => {
    const isBound = kbs.find(kb => kb.id === kbId)?.appIds.includes(appId)
    if (isBound) void unbindApp(kbId, appId)
    else void bindApp(kbId, appId)
  }

  return (
    <div className="space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
        <BookOpen className="w-3.5 h-3.5" />
        {t('Knowledge')}
        {bound.length > 0 && (
          <span className="text-muted-foreground/60 font-normal normal-case tracking-normal">
            ({bound.length})
          </span>
        )}
      </h3>

      {kbs.length > 0 ? (
        <>
          <div className="space-y-1.5">
            {kbs.map(kb => {
              const isLoaded = kb.appIds.includes(appId)
              return (
                <div
                  key={kb.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => toggleKb(kb.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      toggleKb(kb.id)
                    }
                  }}
                  className="w-full rounded-lg border border-border bg-secondary/40 px-3 py-2 flex items-center gap-2.5 text-sm text-foreground hover:bg-secondary/60 transition-colors cursor-pointer"
                >
                  <span className="w-5 flex justify-center flex-shrink-0">
                    {isLoaded ? <Check className="w-4 h-4 text-primary" /> : <BookOpen className="w-4 h-4 text-muted-foreground" />}
                  </span>
                  <div className="min-w-0 flex-1 text-left">
                    <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                      <p className="truncate">{kb.name}</p>
                      {kb.spaceIds.length > 0 && (
                        <span className="inline-flex items-center gap-1 text-[9px] leading-none px-1 py-0.5 rounded bg-primary/15 text-primary flex-shrink-0 uppercase tracking-wide">
                          <Globe className="w-2.5 h-2.5" />
                          {t('Space')}
                        </span>
                      )}
                      {kb.isDefault && (
                        <span className="inline-flex items-center gap-1 text-[9px] leading-none px-1 py-0.5 rounded bg-primary/15 text-primary flex-shrink-0 uppercase tracking-wide">
                          <Star className="w-2.5 h-2.5" fill="currentColor" />
                          {t('Default')}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground truncate">
                      {t('{{count}} documents', { count: kb.stats.rawFileCount })}
                    </p>
                  </div>
                </div>
              )
            })}
          </div>
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-muted-foreground/60">
              {t('The digital human can reference documents from the checked knowledge bases.')}
            </p>
            <button
              onClick={openKnowledgePage}
              className="flex items-center gap-1 px-2 py-1 text-xs text-primary hover:bg-primary/10 rounded transition-colors flex-shrink-0"
            >
              {t('Manage')}
              <ArrowRight className="w-3 h-3" />
            </button>
          </div>
        </>
      ) : (
        <div className="rounded-lg border border-dashed border-border p-4 text-center space-y-2">
          <p className="text-xs text-muted-foreground">
            {t('No knowledge bases yet')}
          </p>
          <button
            onClick={openKnowledgePage}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs text-primary hover:bg-primary/10 rounded transition-colors"
          >
            <ArrowRight className="w-3.5 h-3.5" />
            {t('Add knowledge')}
          </button>
        </div>
      )}
    </div>
  )
}
