/**
 * Federation Section Component
 * Gateway server used to relay team collaboration beyond the local network.
 *
 * Its own section rather than part of Remote Access: the gateway belongs to
 * team collaboration, and a headless server has to configure it from the web
 * client, where the Remote Access section is never shown.
 */

import { useState, useEffect } from 'react'
import { useTranslation } from '../../i18n'
import { api } from '../../api'
import type { HaloConfig } from '../../types'

const SUPPORTED_PROTOCOLS = ['http:', 'https:', 'ws:', 'wss:']

interface FederationSectionProps {
  config: HaloConfig | null
  setConfig: (config: HaloConfig) => void
  embedded?: boolean
}

export function FederationSection({ config, setConfig, embedded = false }: FederationSectionProps) {
  const { t } = useTranslation()

  const [gatewayInput, setGatewayInput] = useState(config?.federation?.gatewayUrl || '')
  const [gatewayError, setGatewayError] = useState<string | null>(null)
  const [gatewaySaved, setGatewaySaved] = useState(false)
  const [isSavingGateway, setIsSavingGateway] = useState(false)
  const [defaultGatewayUrl, setDefaultGatewayUrl] = useState<string | null | undefined>()

  useEffect(() => {
    let cancelled = false
    api.getConfig().then(response => {
      if (!response.success) {
        console.error('[FederationSection] Failed to load gateway default:', response.error)
        return
      }
      if (!cancelled) setDefaultGatewayUrl(response.productDefaults?.federation.gatewayUrl)
    }).catch(error => {
      console.error('[FederationSection] Failed to load gateway default:', error)
    })
    return () => { cancelled = true }
  }, [])

  const handleGatewaySave = async () => {
    const value = gatewayInput.trim()
    if (value) {
      try {
        const u = new URL(value)
        if (!SUPPORTED_PROTOCOLS.includes(u.protocol)) {
          setGatewayError(t('Unsupported protocol. Use http://, https://, ws://, wss://'))
          return
        }
      } catch {
        setGatewayError(t('Invalid gateway URL. Example: https://gateway.example.com'))
        return
      }
    }
    setGatewayError(null)
    setIsSavingGateway(true)
    try {
      // An empty string, unlike undefined, survives JSON to the main process,
      // where it clears the override and falls back to the built-in gateway.
      const updatedFederation = { ...config?.federation, gatewayUrl: value }
      const updatedConfig = { ...config, federation: updatedFederation } as HaloConfig
      const response = await api.setConfig({ federation: updatedFederation })
      if (!response.success) {
        console.error('[FederationSection] Gateway override was not saved:', response.error)
        setGatewayError(response.error || t('Failed to save'))
        return
      }
      setConfig(updatedConfig)
      setGatewayInput(value)
      setGatewaySaved(true)
      setTimeout(() => setGatewaySaved(false), 2000)
    } catch (error) {
      console.error('[FederationSection] Failed to save gateway URL:', error)
      setGatewayError(t('Failed to save'))
    } finally {
      setIsSavingGateway(false)
    }
  }

  return (
    <section id="federation" className={embedded ? 'space-y-2 border-t border-border pt-4' : 'rounded-xl border border-border-faint bg-card p-4 sm:p-6'}>
      <div className={embedded ? 'space-y-1' : 'mb-4 space-y-1'}>
        <h2 className={embedded ? 'font-medium' : 'text-lg font-medium'}>{t('Federation Gateway')}</h2>
        <p className="text-sm text-muted-foreground">
          {t('Relay team collaboration through a gateway server so members outside your local network can join.')}
        </p>
        {defaultGatewayUrl ? (
          <p className="text-sm text-muted-foreground break-words">
            {config?.federation?.gatewayUrl?.trim() ? t('Built-in gateway') : t('Using the built-in gateway')}: <code className="block break-all sm:inline">{defaultGatewayUrl}</code>
            <span className="block">{t('Leave empty to use the built-in gateway.')}</span>
          </p>
        ) : defaultGatewayUrl === null ? (
          <p className="text-sm text-muted-foreground">{t('Leave empty for LAN-only teams.')}</p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          type="text"
          value={gatewayInput}
          onChange={(e) => {
            setGatewayInput(e.target.value)
            setGatewayError(null)
            setGatewaySaved(false)
          }}
          aria-label={t('Federation Gateway')}
          disabled={isSavingGateway}
          placeholder={defaultGatewayUrl || t('https://gateway.example.com')}
          className="w-full min-w-0 flex-1 px-2 py-1 text-sm bg-input rounded border border-border focus:border-primary focus:outline-none disabled:opacity-50"
        />
        <button
          onClick={handleGatewaySave}
          disabled={isSavingGateway}
          className="text-xs px-3 py-1.5 bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50"
        >
          {isSavingGateway ? t('Saving...') : gatewaySaved ? t('Saved') : t('Save')}
        </button>
      </div>
      {gatewayError && <p className="mt-2 text-xs text-destructive">{gatewayError}</p>}

      {/* An office already hosted without a gateway keeps its LAN-only
          attachment; the relay is picked up the next time it is hosted. */}
      <p className="text-xs text-muted-foreground mt-3">
        {t('Restart Halo to apply gateway changes to existing team connections.')}
      </p>
    </section>
  )
}
