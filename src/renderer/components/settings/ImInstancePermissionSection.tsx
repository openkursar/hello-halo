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
import { MessageSquare } from 'lucide-react'
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

      {/* Shown only where the instance deviates from the build's default, so a
          user who inherited that default is not told about a choice they did
          not make. `permissionDefaults` is absent on open-source builds, which
          default to off; enterprise builds set defaultEnabled. Either way the
          toggle stays editable — this documents the default, it does not
          enforce it. */}
      {permissionDefaults?.defaultEnabled && !permissionEnabled && (
        <p className="text-xs text-amber-600 dark:text-amber-500 pl-0.5">
          {t('Permission control is on by default in this build — you have turned it off, so everyone has full access.')}
        </p>
      )}
      {!permissionDefaults?.defaultEnabled && permissionEnabled && (
        <p className="text-xs text-muted-foreground/70 pl-0.5">
          {t('Permission control is off by default in this build — you have turned it on. Set an owner below; until one is set, the first user to direct-message this bot is bound as the owner.')}
        </p>
      )}

      {/* Permission details (only when enabled) */}
      {permissionEnabled && (
        <div className="space-y-3 pl-1 animate-in slide-in-from-top-1 duration-150">
          {/* Owners */}
          <div className="space-y-1">
            <label className="text-sm text-muted-foreground">
              {t('Owner User IDs')}
            </label>
            <p className="text-xs text-muted-foreground/80">
              {t('Enter your own user ID on this IM platform. Separate multiple IDs with commas or new lines.')}
            </p>
            <textarea
              value={ownersDisplay}
              onChange={(e) => handleOwnersChange(e.target.value)}
              onBlur={handleOwnersBlur}
              placeholder={permissionDefaults?.ownerIdHint || t('e.g. zhangsan, johndoe — ask the bot "what is my user ID" to look it up')}
              rows={2}
              className="w-full bg-muted border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary resize-none"
            />
            <p className="text-xs text-muted-foreground">
              {t('Owners always have full access and are not restricted by the guest settings below.')}
            </p>
          </div>

          {/* No owners yet. Auto-claim makes this a race the reader is in, not
              a state they can wait out: whoever direct-messages the bot first
              becomes owner, and that may not be them. Say so — a banner that
              only describes auto-claim reads like a reassurance. */}
          {!hasOwners && (
            <div className="flex items-center gap-2 rounded-lg bg-amber-500/10 border border-amber-500/30 px-3 py-2">
              <MessageSquare className="w-4 h-4 text-amber-600 dark:text-amber-500 shrink-0" />
              <p className="text-xs text-amber-600 dark:text-amber-500">
                {t('No owner set. The first user to direct-message this bot is bound as the owner — enter your own ID above to claim it first. Until then, everyone is a guest with no tool access.')}
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
