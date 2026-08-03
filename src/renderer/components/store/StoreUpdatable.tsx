/**
 * My Installs · Updatable — the second block of the store's "My" view: every
 * installed app that has an available update, with an in-place update action.
 * Reuses the shared update flow (overwrite / install-as-copy / ignore).
 */

import { Loader2 } from 'lucide-react'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { useStoreUpdateFlow } from './useStoreUpdateFlow'
import { resolveEntryI18n } from '../../utils/spec-i18n'
import { getCurrentLanguage, useTranslation } from '../../i18n'
import { AppTypeIcon } from './AppTypeIcon'
import type { UpdateInfo } from '../../../shared/store/store-types'

export function StoreUpdatable() {
  const { t } = useTranslation()
  const availableUpdates = useAppsPageStore(state => state.availableUpdates)

  return (
    <section className="mt-6">
      <div className="mb-3">
        <h2 className="text-[13px] font-semibold tracking-[0.5px] text-foreground">{t('My installs · Updatable')}</h2>
      </div>
      <div className="overflow-x-auto rounded-[10px] border border-border/60 bg-background">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground border-b border-border/60">
              <th className="font-medium py-2.5 px-3">{t('App')}</th>
              <th className="font-medium py-2.5 px-3">{t('Current version')}</th>
              <th className="font-medium py-2.5 px-3">{t('Latest version')}</th>
              <th className="font-medium py-2.5 px-3 text-right">{t('Actions')}</th>
            </tr>
          </thead>
          <tbody>
            {availableUpdates.length === 0 ? (
              <tr>
                <td colSpan={4} className="py-12 text-center text-[13px] text-muted-foreground">
                  {t('No data')}
                </td>
              </tr>
            ) : (
              availableUpdates.map(update => (
                <UpdatableRow key={update.appId} update={update} />
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function UpdatableRow({ update }: { update: UpdateInfo }) {
  const { t } = useTranslation()
  const name = resolveEntryI18n(update.entry, getCurrentLanguage()).name
  const { start, busy, dialogs } = useStoreUpdateFlow(update.entry, update)

  return (
    <>
      <tr className="border-b border-border/60 last:border-0">
        <td className="py-2.5 px-3">
          <div className="flex items-center gap-2 min-w-0">
            <AppTypeIcon type={update.entry.type} icon={update.entry.icon} name={name} size="sm" />
            <span className="truncate font-medium text-foreground">{name}</span>
          </div>
        </td>
        <td className="py-2.5 px-3 font-mono text-xs text-muted-foreground whitespace-nowrap">v{update.currentVersion}</td>
        <td className="py-2.5 px-3 font-mono text-xs text-halo-success whitespace-nowrap">v{update.latestVersion}</td>
        <td className="py-2.5 px-3">
          <div className="flex justify-end">
            <button
              onClick={start}
              disabled={busy}
              className="flex items-center gap-1 px-3 py-1 text-xs font-medium rounded-md border border-halo-success text-halo-success hover:bg-halo-success hover:text-white transition-colors disabled:opacity-60 whitespace-nowrap"
            >
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
              {t('Update')}
            </button>
          </div>
        </td>
      </tr>
      {dialogs}
    </>
  )
}
