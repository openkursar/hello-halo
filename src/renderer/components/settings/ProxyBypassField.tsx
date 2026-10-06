/**
 * Settings field for the hosts that skip the proxy (`network.noProxy`).
 * The main process reads the list as NO_PROXY does (proxy-policy).
 */

import { useState } from 'react'
import { CheckCircle, Save } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { api } from '../../api'
import type { HaloConfig } from '../../types'

interface ProxyBypassFieldProps {
  config: HaloConfig | null
  setConfig: (config: HaloConfig) => void
}

export function ProxyBypassField({ config, setConfig }: ProxyBypassFieldProps) {
  const { t } = useTranslation()
  const [value, setValue] = useState(config?.network?.noProxy || '')
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSave = async () => {
    setError(null)
    try {
      const updatedNetwork = { ...config?.network, noProxy: value.trim() || undefined }
      await api.setConfig({ network: updatedNetwork })
      setConfig({ ...config, network: updatedNetwork } as HaloConfig)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      console.error('[ProxyBypassField] Failed to save the proxy bypass list:', err)
      setError(t('Failed to save'))
    }
  }

  return (
    <div className="mt-3 pt-3 border-t border-border/50">
      <p className="text-sm font-medium">{t("Don't use the proxy for")}</p>
      <p className="text-xs text-muted-foreground">
        {t('Separate hosts with commas. A leading dot includes subdomains (.example.com). Local addresses never use the proxy.')}
      </p>
      <div className="flex flex-col sm:flex-row gap-2 mt-2">
        <input
          type="text"
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            setError(null)
          }}
          onKeyDown={(e) => e.key === 'Enter' && handleSave()}
          placeholder=".example.com, intranet.example.com"
          aria-label={t("Don't use the proxy for")}
          className="flex-1 min-w-0 px-3 py-1.5 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50 font-mono"
        />
        <button
          onClick={handleSave}
          className="flex items-center justify-center gap-1.5 px-3 py-1.5 text-sm bg-primary/10 text-primary hover:bg-primary/20 rounded-lg transition-colors shrink-0"
        >
          {saved ? <CheckCircle className="w-3.5 h-3.5" /> : <Save className="w-3.5 h-3.5" />}
          {saved ? t('Saved') : t('Save')}
        </button>
      </div>
      {error && <p className="mt-1.5 text-xs text-destructive">{error}</p>}
    </div>
  )
}
