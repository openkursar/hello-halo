/**
 * IM Instance Permission Section
 *
 * Owner / guest access editor for one IM channel instance: the master toggle,
 * the owner ID list, and the guest tool policy.
 *
 * Shared by every provider's instance card. It was previously local to
 * MessageChannelsSection, which meant a second provider card could only get
 * permission editing by duplicating it — and a duplicate of this particular
 * screen drifts into two different answers about who may make a digital human
 * do what.
 */

import { useState } from 'react'
import { Info } from 'lucide-react'
import { useTranslation } from '../../i18n'
import type { ImChannelInstanceConfig } from '../../../shared/types/im-channel'
import { CapabilityPolicyFields } from '../capability/CapabilityPolicyFields'
import { Switch } from '../ui/Switch'

/** Product-level permission defaults (from IPC). Mirrors auth-loader.ImChannelsPermissionDefaults. */
export interface ImPermissionDefaults {
  defaultEnabled?: boolean
  defaultGuestAccess?: boolean
  defaultGuestPolicy?: { allowedTools?: string[] }
  ownerIdHint?: string
}

export interface ImInstancePermissionSectionProps {
  instance: ImChannelInstanceConfig
  /** Immediate save (for toggles) */
  onChange: (instance: ImChannelInstanceConfig) => void
  /** Debounced save (for text fields — 500ms delay, same as config fields) */
  onDebouncedChange: (instance: ImChannelInstanceConfig) => void
  /** Product-level permission defaults (for owner ID hint, etc.) */
  permissionDefaults?: ImPermissionDefaults | null
}

export function ImInstancePermissionSection({
  instance,
  onChange,
  onDebouncedChange,
  permissionDefaults,
}: ImInstancePermissionSectionProps) {
  const { t } = useTranslation()
  const permissionEnabled = instance.permissionEnabled ?? false
  const owners = instance.owners ?? []
  const hasOwners = owners.length > 0
  const guestPolicy = instance.guestPolicy
  const guestAccessEnabled = hasOwners && guestPolicy !== undefined

  // Local draft state for text fields (avoids cursor jumping during debounce)
  const [ownersDraft, setOwnersDraft] = useState<string | null>(null)

  const ownersDisplay = ownersDraft ?? owners.join(', ')

  // ── Handlers ──

  const handlePermissionToggle = () => {
    onChange({ ...instance, permissionEnabled: !permissionEnabled })
  }

  const handleOwnersChange = (value: string) => {
    setOwnersDraft(value)
    const parsed = value
      .split(/[,\n]/)
      .map(s => s.trim())
      .filter(Boolean)
    onDebouncedChange({
      ...instance,
      owners: parsed.length > 0 ? parsed : undefined,
    })
  }

  const handleOwnersBlur = () => {
    setOwnersDraft(null)
  }

  const handleGuestAccessToggle = () => {
    if (guestAccessEnabled) {
      onChange({ ...instance, guestPolicy: undefined })
    } else {
      onChange({ ...instance, guestPolicy: { allowedTools: [] } })
    }
  }

  // ── Render ──

  return (
    <div className="space-y-2">
      {/* Master toggle */}
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <p className="text-sm text-muted-foreground">{t('Permission Control')}</p>
          <p className="text-xs text-muted-foreground/70">
            {permissionEnabled
              ? t('Restrict access by owner/guest roles')
              : t('Everyone has full access')}
          </p>
        </div>
        <Switch checked={permissionEnabled} onCheckedChange={handlePermissionToggle} />
      </div>

      {/* Permission details (only when enabled) */}
      {permissionEnabled && (
        <div className="space-y-3 pl-1 animate-in slide-in-from-top-1 duration-150">
          {/* Owners */}
          <div className="space-y-1">
            <label className="text-sm text-muted-foreground">
              {t('Owner User IDs')}
            </label>
            <textarea
              value={ownersDisplay}
              onChange={(e) => handleOwnersChange(e.target.value)}
              onBlur={handleOwnersBlur}
              placeholder={permissionDefaults?.ownerIdHint || t('Fill in your own user ID. Ask the bot "what is my user ID" to get it.')}
              rows={2}
              className="w-full bg-muted border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary resize-none"
            />
            <p className="text-xs text-muted-foreground">
              {t('Owners always have full access and are not restricted by the guest settings below.')}
            </p>
          </div>

          {/* No owners yet — auto-claim is active, so this is an expected
              interim state rather than a misconfiguration. */}
          {!hasOwners && (
            <div className="flex items-center gap-2 rounded-lg bg-primary/10 border border-primary/30 px-3 py-2">
              <Info className="w-4 h-4 text-primary shrink-0" />
              <p className="text-xs text-foreground/80">
                {t('No owner bound yet. The first user to send this bot a direct message will be bound as the owner automatically. Until then, all users are deny-all guests.')}
              </p>
            </div>
          )}

          {/* Guest section divider — makes the owner/guest boundary visually explicit */}
          {hasOwners && (
            <div className="flex items-center gap-2 pt-1">
              <div className="flex-1 border-t border-border/60" />
              <span className="text-[10px] uppercase tracking-widest text-muted-foreground/50 px-1">
                {t('Guest Permissions')}
              </span>
              <div className="flex-1 border-t border-border/60" />
            </div>
          )}

          {/* Guest access toggle (only when owners are set) */}
          {hasOwners && (
            <>
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <p className="text-sm text-muted-foreground">{t('Guest Access')}</p>
                  <p className="text-xs text-muted-foreground/70">
                    {guestAccessEnabled
                      ? t('Guests have limited access to selected tools below')
                      : t('Guests have no tool access — chat only')}
                  </p>
                </div>
                <Switch checked={guestAccessEnabled} onCheckedChange={handleGuestAccessToggle} />
              </div>

              {guestAccessEnabled && (
                <div className="space-y-2">
                  <label className="text-sm text-muted-foreground">
                    {t('Guest Allowed Tools')}
                  </label>
                  <CapabilityPolicyFields
                    policy={guestPolicy}
                    mode="strict"
                    groupLabels={{
                      file: t('File Read'),
                      network: t('Network'),
                      other: t('Other'),
                      advanced: t('Advanced'),
                    }}
                    onChange={(next) => onChange({ ...instance, guestPolicy: next })}
                  />
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
