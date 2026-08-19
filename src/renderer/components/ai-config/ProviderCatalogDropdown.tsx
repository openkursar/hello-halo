/**
 * ProviderCatalogDropdown — searchable, grouped provider picker.
 *
 * The single dropdown UI for choosing a built-in API-key provider, shared by:
 *  - Settings (`ProviderSelector`) — add / edit a source.
 *  - First-run setup (`CustomApiSetupForm`) — the BYOK config step.
 *
 * Self-contained: owns its open / search / click-outside state and renders only
 * the button + panel. The selected provider id is controlled by the parent via
 * `value` / `onChange` (the parent also runs any side effects on change, e.g.
 * resetting the API key). Pass an empty `value` to show `placeholder` (used by
 * setup, where no provider is preselected).
 */

import { useState, useEffect, useMemo, useRef } from 'react'
import { ChevronDown, Search, Check, Star } from 'lucide-react'
import type { BuiltinProvider, ProviderId } from '../../types'
import { getApiKeyProviders, getBuiltinProvider } from '../../types'
import { useTranslation } from '../../i18n'

interface ProviderCatalogDropdownProps {
  /** Selected provider id, or '' for no selection (shows placeholder). */
  value: ProviderId | ''
  /** Called with the chosen provider id. */
  onChange: (id: ProviderId) => void
  /** Button text when nothing is selected. Defaults to "Select provider". */
  placeholder?: string
}

export function ProviderCatalogDropdown({ value, onChange, placeholder }: ProviderCatalogDropdownProps) {
  const { t } = useTranslation()
  const dropdownRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const all = useMemo(() => getApiKeyProviders(), [])
  const recommended = useMemo(() => all.filter(p => p.recommended), [all])
  const others = useMemo(() => all.filter(p => !p.recommended), [all])
  const current = value ? getBuiltinProvider(value) : undefined

  const matches = (p: BuiltinProvider, q: string) =>
    t(p.name).toLowerCase().includes(q) || p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)

  const filteredRecommended = useMemo(() => {
    if (!query) return recommended
    const q = query.toLowerCase()
    return recommended.filter(p => matches(p, q))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recommended, query, t])

  const filteredOthers = useMemo(() => {
    if (!query) return others
    const q = query.toLowerCase()
    return others.filter(p => matches(p, q))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [others, query, t])

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  const handleSelect = (id: ProviderId) => {
    onChange(id)
    setOpen(false)
    setQuery('')
  }

  const renderItem = (provider: BuiltinProvider, showRecommended = false) => (
    <button
      key={provider.id}
      onClick={() => handleSelect(provider.id)}
      className={`w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-secondary/80 transition-colors ${
        value === provider.id ? 'bg-primary/10' : ''
      }`}
    >
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
        value === provider.id ? 'bg-primary/20 text-primary' : 'bg-secondary text-muted-foreground'
      }`}>
        <span className="text-sm font-bold">{t(provider.name).charAt(0)}</span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{t(provider.name)}</span>
          {showRecommended && provider.recommended && (
            <Star className="w-3 h-3 text-amber-500 fill-amber-500" />
          )}
        </div>
        {provider.description && (
          <div className="text-xs text-muted-foreground truncate">{t(provider.description)}</div>
        )}
      </div>
      {value === provider.id && (
        <Check className="w-4 h-4 text-primary shrink-0" />
      )}
    </button>
  )

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-3 py-2.5 bg-input border border-border rounded-lg
                 text-foreground hover:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary/30 transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
            <span className="text-sm font-bold text-primary">
              {t(current?.name || '').charAt(0) || 'C'}
            </span>
          </div>
          <div className="text-left">
            <div className={`text-sm font-medium ${current ? '' : 'text-muted-foreground'}`}>
              {current ? t(current.name) : (placeholder ?? t('Select provider'))}
            </div>
            {current?.description && (
              <div className="text-xs text-muted-foreground">{t(current.description)}</div>
            )}
          </div>
        </div>
        <ChevronDown className={`w-5 h-5 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute z-50 w-full mt-1 bg-card border border-border rounded-xl shadow-lg overflow-hidden">
          <div className="p-2 border-b border-border">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('Search providers...')}
                className="w-full pl-9 pr-3 py-2 text-sm bg-input border border-border rounded-lg
                         text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
                autoFocus
              />
            </div>
          </div>

          <div className="max-h-80 overflow-y-auto">
            {filteredRecommended.length > 0 && (
              <>
                <div className="px-3 py-2 text-xs font-medium text-muted-foreground bg-secondary/30 flex items-center gap-1.5">
                  <Star className="w-3 h-3 text-amber-500" />
                  {t('Recommended')}
                </div>
                {filteredRecommended.map(p => renderItem(p, false))}
              </>
            )}

            {filteredOthers.length > 0 && (
              <>
                <div className="px-3 py-2 text-xs font-medium text-muted-foreground bg-secondary/30">
                  {t('All Providers')}
                </div>
                {filteredOthers.map(p => renderItem(p, true))}
              </>
            )}

            {filteredRecommended.length === 0 && filteredOthers.length === 0 && (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                {t('No providers found')}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
