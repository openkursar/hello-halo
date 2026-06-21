/**
 * Browser Allowlist Card
 *
 * Settings card for the user-extensible browser allowlist. Renders only
 * when the build enables it (`browserPolicy.userExtensible` → exposed as
 * `browserAllowlistEditable` in the public security policy); open-source
 * builds and locked enterprise builds never see this card.
 *
 * Built-in patterns from product.json are shown read-only; user entries
 * can be added (domain / *.wildcard / IPv4 / CIDR — full URLs are
 * normalized to their hostname) and removed. Desktop-only by transport:
 * the underlying IPC has no HTTP mirror.
 */

import { useState, useEffect, useCallback } from 'react'
import { Globe, Plus, X, ChevronRight, Loader2 } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { api } from '../../api'
import { useSecurityPolicy } from '../../hooks/useSecurityPolicy'

/** Mirrors BrowserPolicyView in src/main/services/browser-policy.service.ts. */
interface BrowserPolicyView {
  editable: boolean
  builtinPatterns: string[]
  customPatterns: string[]
}

export function BrowserAllowlistCard() {
  const { t } = useTranslation()
  const securityPolicy = useSecurityPolicy()
  // Desktop-only by transport (the IPC has no HTTP mirror). SettingsPage
  // already hides SystemSection in remote mode; this keeps the invariant
  // local instead of relying on the page-level conditional.
  const editable = !api.isRemoteMode() && securityPolicy?.browserAllowlistEditable === true

  const [builtinPatterns, setBuiltinPatterns] = useState<string[]>([])
  const [customPatterns, setCustomPatterns] = useState<string[]>([])
  const [isLoaded, setIsLoaded] = useState(false)
  const [builtinExpanded, setBuiltinExpanded] = useState(false)
  const [input, setInput] = useState('')
  const [inputError, setInputError] = useState<string | null>(null)
  const [isAdding, setIsAdding] = useState(false)
  const [removingPattern, setRemovingPattern] = useState<string | null>(null)

  useEffect(() => {
    if (!editable || isLoaded) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await api.getBrowserPolicy()
        if (cancelled) return
        if (res.success && res.data) {
          const view = res.data as BrowserPolicyView
          setBuiltinPatterns(view.builtinPatterns)
          setCustomPatterns(view.customPatterns)
          setIsLoaded(true)
        }
      } catch (error) {
        console.error('[BrowserAllowlistCard] Failed to load policy:', error)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [editable, isLoaded])

  const handleAdd = useCallback(async () => {
    const value = input.trim()
    if (!value || isAdding) return
    setIsAdding(true)
    setInputError(null)
    try {
      const res = await api.addBrowserAllowlistEntry(value)
      if (res.success && res.data) {
        const view = res.data as BrowserPolicyView
        setCustomPatterns(view.customPatterns)
        setInput('')
      } else if ((res as { code?: string }).code === 'BROWSER_ALLOWLIST_INVALID_PATTERN') {
        setInputError(t('Not a valid domain, IP or CIDR pattern. Examples: example.com, *.example.com, 10.0.0.0/8'))
      } else {
        setInputError(res.error || t('Failed to update allowlist'))
      }
    } catch (error) {
      console.error('[BrowserAllowlistCard] Add failed:', error)
      setInputError((error as Error).message)
    } finally {
      setIsAdding(false)
    }
  }, [input, isAdding, t])

  const handleRemove = useCallback(async (pattern: string) => {
    setRemovingPattern(pattern)
    try {
      const res = await api.removeBrowserAllowlistEntry(pattern)
      if (res.success && res.data) {
        setCustomPatterns((res.data as BrowserPolicyView).customPatterns)
      }
    } catch (error) {
      console.error('[BrowserAllowlistCard] Remove failed:', error)
    } finally {
      setRemovingPattern(null)
    }
  }, [])

  if (!editable) return null

  return (
    <section id="browser-allowlist" className="bg-card rounded-xl border border-border p-6">
      <div className="flex items-center gap-2 mb-1">
        <Globe className="w-5 h-5 text-muted-foreground" />
        <h2 className="text-lg font-medium">{t('Browser Allowed Sites')}</h2>
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        {t('The browser can only open sites on the allowlist. Add the sites you need below.')}
      </p>

      {/* Add entry */}
      <div className="flex flex-col sm:flex-row gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => {
            setInput(e.target.value)
            setInputError(null)
          }}
          onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
          placeholder={t('example.com or *.example.com')}
          className="flex-1 px-3 py-1.5 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50 font-mono"
        />
        <button
          onClick={handleAdd}
          disabled={isAdding || !input.trim()}
          className="flex items-center justify-center gap-1.5 px-3 py-1.5 text-sm bg-primary/10 text-primary hover:bg-primary/20 rounded-lg transition-colors shrink-0 disabled:opacity-50"
        >
          {isAdding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
          {t('Add')}
        </button>
      </div>
      {inputError && <p className="mt-1.5 text-xs text-destructive">{inputError}</p>}

      {/* Custom entries */}
      <div className="mt-4">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
          {t('Added by you')}
        </p>
        {customPatterns.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('No custom sites yet')}</p>
        ) : (
          <ul className="space-y-1">
            {customPatterns.map((pattern) => (
              <li
                key={pattern}
                className="flex items-center justify-between gap-2 px-3 py-1.5 bg-muted/30 rounded-lg"
              >
                <span className="text-sm font-mono break-all">{pattern}</span>
                <button
                  onClick={() => handleRemove(pattern)}
                  disabled={removingPattern === pattern}
                  className="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-destructive transition-colors shrink-0 disabled:opacity-50"
                  title={t('Remove')}
                >
                  {removingPattern === pattern ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <X className="w-3.5 h-3.5" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Built-in entries (read-only) */}
      {builtinPatterns.length > 0 && (
        <div className="mt-4 pt-4 border-t border-border">
          <button
            onClick={() => setBuiltinExpanded(!builtinExpanded)}
            className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide hover:text-foreground transition-colors"
          >
            <ChevronRight
              className={`w-3.5 h-3.5 transition-transform ${builtinExpanded ? 'rotate-90' : ''}`}
            />
            {t('Built-in sites ({{count}})', { count: builtinPatterns.length })}
          </button>
          {builtinExpanded && (
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {builtinPatterns.map((pattern) => (
                <li
                  key={pattern}
                  className="px-2 py-0.5 text-xs font-mono bg-muted/50 text-muted-foreground rounded"
                >
                  {pattern}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
