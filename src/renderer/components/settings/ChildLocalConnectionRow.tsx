/**
 * Diagnostics row: the router reached from a child process started the way
 * engine processes start. When the system refuses it, names the program an
 * allowlist needs.
 */

import { useTranslation } from '../../i18n'
import type { ChildLocalConnectionInfo } from '../../../shared/types/health'

export function ChildLocalConnectionRow({ check }: { check: ChildLocalConnectionInfo }) {
  const { t } = useTranslation()
  return (
    <div className="text-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className={`w-2 h-2 rounded-full shrink-0 ${check.reachable ? 'bg-green-500' : 'bg-red-500'}`} />
          <span className="text-muted-foreground">{t('Child process local connection')}</span>
        </div>
        {check.reachable ? (
          <span className="text-green-500">{t('Healthy')}</span>
        ) : (
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-red-500">{t('Failed')}</span>
            {check.error && <span className="text-xs text-muted-foreground truncate">({check.error})</span>}
          </div>
        )}
      </div>
      {check.blocked && (
        <p className="mt-1 text-xs text-muted-foreground break-all">
          {t("Security software on this computer blocks Halo's internal connection. Ask your IT team to allow this program to make local connections: {{program}}", { program: check.program })}
        </p>
      )}
    </div>
  )
}
