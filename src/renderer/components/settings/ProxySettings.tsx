/**
 * Proxy settings (Settings > System): where the app's requests go out, plus a
 * folded group for everything that refines it.
 *
 * What each route does with these values is decided in the main process
 * (proxy-policy, proxy-fetch); this block only edits `config.network`.
 */

import { useEffect, useId, useState } from 'react'
import { AlertTriangle, CheckCircle, ChevronDown, ChevronRight, Save } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { api } from '../../api'
import type { HaloConfig } from '../../types'
import type { ProxyRouteInfo } from '../../../shared/rpc/contracts/system.contract'
import { Switch, switchRowHover } from '../ui/Switch'
import { ProxyBypassField } from './ProxyBypassField'

interface ProxySettingsProps {
  config: HaloConfig | null
  setConfig: (config: HaloConfig) => void
  /** Opened from a "proxy required" message: the fold holds the switch the person came for. */
  openAdvanced?: boolean
}

function bypassCount(noProxy: string | undefined): number {
  return (noProxy ?? '').split(/[\s,;]+/).filter(Boolean).length
}

export function ProxySettings({ config, setConfig, openAdvanced = false }: ProxySettingsProps) {
  const { t } = useTranslation()
  const advancedId = useId()

  const [proxyInput, setProxyInput] = useState(config?.network?.proxy || '')
  const [proxyError, setProxyError] = useState<string | null>(null)
  const [proxySaved, setProxySaved] = useState(false)
  const [browserUseProxy, setBrowserUseProxy] = useState(config?.network?.browserUseProxy ?? false)
  const [imUseProxy, setImUseProxy] = useState(config?.network?.imUseProxy !== false)
  const [requireProxy, setRequireProxy] = useState(config?.network?.requireProxyForOAuth === true)
  const [advancedOpen, setAdvancedOpen] = useState(openAdvanced)
  const [route, setRoute] = useState<ProxyRouteInfo | null>(null)

  useEffect(() => {
    if (openAdvanced) setAdvancedOpen(true)
  }, [openAdvanced])

  // Message Channels can also turn this off ("Connect directly").
  useEffect(() => {
    setImUseProxy(config?.network?.imUseProxy !== false)
  }, [config?.network?.imUseProxy])

  const savedProxy = config?.network?.proxy
  const savedNoProxy = config?.network?.noProxy
  useEffect(() => {
    let current = true
    api.getProxyRoute().then(result => {
      if (current && result.success && result.data) setRoute(result.data)
    }).catch(() => {})
    return () => { current = false }
  }, [savedProxy, savedNoProxy])

  const saveNetwork = async (patch: Partial<NonNullable<HaloConfig['network']>>) => {
    const updatedNetwork = { ...config?.network, ...patch }
    const result = await api.setConfig({ network: updatedNetwork })
    // A refused save is a result, not an exception; callers revert on a throw.
    if (!result.success) throw new Error(result.error || 'Settings were not saved')
    setConfig({ ...config, network: updatedNetwork } as HaloConfig)
  }

  const handleProxySave = async () => {
    const value = proxyInput.trim()

    if (value) {
      try {
        const u = new URL(value)
        const supported = ['http:', 'https:']
        if (!supported.includes(u.protocol)) {
          setProxyError(t('Unsupported protocol. Use http://, https://'))
          return
        }
      } catch {
        setProxyError(t('Invalid proxy URL. Example: http://127.0.0.1:1087'))
        return
      }
    }

    setProxyError(null)
    try {
      await saveNetwork({ proxy: value || undefined })
      setProxySaved(true)
      setTimeout(() => setProxySaved(false), 2000)
    } catch (error) {
      console.error('[ProxySettings] Failed to save proxy:', error)
      setProxyError(t('Failed to save'))
    }
  }

  // Each toggle reverts when the save fails, so the switch never shows a state that was not stored.
  const toggle = (
    name: 'browserUseProxy' | 'imUseProxy' | 'requireProxyForOAuth',
    set: (enabled: boolean) => void
  ) => async (enabled: boolean) => {
    set(enabled)
    try {
      await saveNetwork({ [name]: enabled })
    } catch (error) {
      console.error(`[ProxySettings] Failed to update ${name}:`, error)
      set(!enabled)
    }
  }

  const blockedWithoutProxy = requireProxy && route?.kind === 'direct'

  const summary = [
    bypassCount(savedNoProxy) > 0 ? t('Direct addresses: {{total}}', { total: bypassCount(savedNoProxy) }) : null,
    browserUseProxy && proxyInput.trim() ? t('AI Browser uses the proxy') : null,
    imUseProxy ? null : t('Message channels connect directly'),
  ].filter(Boolean).join(' · ')

  return (
    <div id="proxy" className="pt-4 border-t border-border">
      <div className="flex-1 mb-3">
        <p className="font-medium">{t('Proxy')}</p>
        <p className="text-sm text-muted-foreground">
          {t('Override system proxy. Leave empty to auto-detect from system settings.')}
        </p>
      </div>

      {route && (
        <p role="status" className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
          <span
            aria-hidden
            className={`h-2 w-2 shrink-0 rounded-full ${route.kind === 'proxy' ? 'bg-green-500' : 'bg-muted-foreground'}`}
          />
          <span className="min-w-0 break-words">
            {route.kind === 'proxy'
              ? (route.via === 'settings'
                ? t('Connecting through your proxy {{address}}', { address: route.address })
                : t('Following the system proxy {{address}}', { address: route.address }))
              : (route.listed
                ? t('Connecting directly: the address is on the list that skips the proxy')
                : t('Connecting directly: no proxy found'))}
          </span>
        </p>
      )}

      <div className="flex flex-col sm:flex-row gap-2">
        <input
          type="text"
          value={proxyInput}
          onChange={(e) => {
            setProxyInput(e.target.value)
            setProxyError(null)
          }}
          onKeyDown={(e) => e.key === 'Enter' && handleProxySave()}
          placeholder="http://127.0.0.1:1087"
          className="flex-1 px-3 py-1.5 text-sm bg-secondary border border-transparent rounded-lg focus:outline-none focus:border-primary/50 font-mono"
        />
        <button
          onClick={handleProxySave}
          className="flex items-center justify-center gap-1.5 px-3 py-1.5 text-sm bg-primary/10 text-primary hover:bg-primary/20 rounded-lg transition-colors shrink-0"
        >
          {proxySaved ? <CheckCircle className="w-3.5 h-3.5" /> : <Save className="w-3.5 h-3.5" />}
          {proxySaved ? t('Saved') : t('Save')}
        </button>
      </div>
      {proxyError && (
        <p className="mt-1.5 text-xs text-destructive">{proxyError}</p>
      )}
      <p className="mt-1.5 text-xs text-muted-foreground">
        {t('Supports http://, https://')}
      </p>

      <div className="mt-3 pt-3 border-t border-border-faint">
        <button
          type="button"
          onClick={() => setAdvancedOpen(open => !open)}
          aria-expanded={advancedOpen}
          aria-controls={advancedId}
          className="flex w-full items-center gap-1.5 text-left text-sm font-medium"
        >
          {advancedOpen ? <ChevronDown className="h-4 w-4 shrink-0" aria-hidden /> : <ChevronRight className="h-4 w-4 shrink-0" aria-hidden />}
          <span>{t('More proxy settings')}</span>
          {summary && (
            <span className="min-w-0 truncate text-xs font-normal text-muted-foreground">{summary}</span>
          )}
        </button>

        {advancedOpen && (
          <div id={advancedId} className="mt-2">
            <ProxyBypassField config={config} setConfig={setConfig} />

            {proxyInput.trim() && (
              <div className="mt-3 pt-3 border-t border-border-faint">
                <div className={`flex items-center justify-between py-1.5 ${switchRowHover}`}>
                  <div className="flex-1 min-w-0 mr-3">
                    <p className="text-sm font-medium">{t('Also apply to AI Browser')}</p>
                    <p className="text-xs text-muted-foreground">
                      {t('By default, AI Browser uses system proxy instead of the proxy above')}
                    </p>
                  </div>
                  <Switch
                    checked={browserUseProxy}
                    onCheckedChange={toggle('browserUseProxy', setBrowserUseProxy)}
                    size="sm"
                  />
                </div>
              </div>
            )}

            <div className="mt-3 pt-3 border-t border-border-faint">
              <div className={`flex items-center justify-between py-1.5 ${switchRowHover}`}>
                <div className="flex-1 min-w-0 mr-3">
                  <p className="text-sm font-medium">{t('Message channels use the proxy')}</p>
                  <p className="text-xs text-muted-foreground">
                    {t('WeCom, Feishu and WeChat bots connect through this proxy (or the system proxy when it is empty). Turn off if the proxy is only meant for AI requests.')}
                  </p>
                </div>
                <Switch
                  checked={imUseProxy}
                  onCheckedChange={toggle('imUseProxy', setImUseProxy)}
                  size="sm"
                />
              </div>
            </div>

            <div className="mt-3 pt-3 border-t border-border-faint">
              <div className={`flex items-center justify-between py-1.5 ${switchRowHover}`}>
                <div className="flex-1 min-w-0 mr-3">
                  <p className="text-sm font-medium">{t('Block direct AI connections')}</p>
                  <p className="text-xs text-muted-foreground">
                    {t('Accounts signed in with Claude or ChatGPT (OAuth) never connect directly. Without a usable proxy their requests are blocked with a message, so a dropped proxy cannot expose your network. Other models are not affected.')}
                  </p>
                  {blockedWithoutProxy && (
                    <p role="status" className="mt-1.5 flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-500">
                      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                      <span>{t('No proxy is available right now, so Claude and ChatGPT are blocked until one is set.')}</span>
                    </p>
                  )}
                </div>
                <Switch
                  checked={requireProxy}
                  onCheckedChange={toggle('requireProxyForOAuth', setRequireProxy)}
                  size="sm"
                  ariaLabel={t('Block direct AI connections')}
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
