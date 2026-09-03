/**
 * Store Page
 *
 * Independent top-level destination for browsing/installing from the
 * marketplace — separate from AppsPage (digital humans = what I already
 * own; store = getting something new). StoreView already owns its full
 * layout (search, category filter, grid/detail, publish dialog); this
 * page only supplies the shared Header chrome, matching AppsPage's own
 * Header usage.
 */

import { useAppStore } from '../stores/app.store'
import { Header } from '../components/layout/Header'
import { StoreView } from '../components/store/StoreView'
import { useTranslation } from '../i18n'
import { Settings } from 'lucide-react'

export function StorePage() {
  const { t } = useTranslation()
  const { navigate } = useAppStore()

  return (
    <div className="h-full flex flex-col bg-background">
      <Header
        right={
          <button
            onClick={() => navigate('settings')}
            className="p-1.5 hover:bg-secondary rounded-lg transition-colors"
            title={t('Settings')}
          >
            <Settings className="w-5 h-5" />
          </button>
        }
      />
      <StoreView />
    </div>
  )
}
