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

import { useEffect, useState } from 'react'
import { MessageSquare } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { api } from '../../api'
import type { ImChannelInstanceConfig } from '../../../shared/types/im-channel'
import type { AvailableSkill } from '../../../shared/apps/app-types'
import { CapabilityPolicyFields } from '../capability/CapabilityPolicyFields'
import { Switch, switchRowHover } from '../ui/Switch'
import { HelpHint } from '../ui/HelpHint'
import { withGuestAccess } from '../../../shared/apps/capability-policy'

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

  // The skills the bound digital human can load, for the guest skill switches.
  // Unknown until loaded (or when loading fails): the group stays hidden rather
  // than claim the digital human has none.
  const [skills, setSkills] = useState<AvailableSkill[] | undefined>(undefined)
  useEffect(() => {
    if (!guestAccessEnabled || !instance.appId) return
    let cancelled = false
    api.appListAvailableSkills(instance.appId)
      .then(res => { if (!cancelled && res.success && Array.isArray(res.data)) setSkills(res.data) })
      .catch(() => { /* the group stays hidden */ })
    return () => { cancelled = true }
  }, [guestAccessEnabled, instance.appId])

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
    onChange(withGuestAccess(instance, !guestAccessEnabled, permissionDefaults?.defaultGuestPolicy))
  }

  // ── Render ──

  return (
    <div className="space-y-2">
      {/* Master toggle */}
      <div className={`flex items-center justify-between py-1.5 ${switchRowHover}`}>
        <div className="space-y-0.5">
          <div className="flex items-center gap-1">
            <p className="text-sm text-foreground">{t('Permission Control')}</p>
            <HelpHint
              label={t('About this setting')}
              text={t('On: owners can use everything, and guests — everyone who is not an owner — can use only what you allow below. Off: everyone is treated as an owner. Owners are the IDs in the owner list; while the list is empty, the first person to message the bot directly becomes its owner.')}
            />
          </div>
          <p className="text-xs text-muted-foreground">
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
        <p className="text-xs text-amber-600 dark:text-amber-500">
          {t('Permission control is on by default in this build — you have turned it off, so everyone has full access.')}
        </p>
      )}
      {!permissionDefaults?.defaultEnabled && permissionEnabled && (
        <p className="text-xs text-muted-foreground">
          {t('Permission control is off by default in this build — you have turned it on. Set an owner below; until one is set, the first user to direct-message this bot is bound as the owner.')}
        </p>
      )}

      {/* Permission details (only when enabled) */}
      {permissionEnabled && (
        <div className="space-y-3 animate-in slide-in-from-top-1 duration-150">
          {/* Owners */}
          <div className="space-y-1">
            <label className="text-sm text-foreground">
              {t('Owner User IDs')}
            </label>
            <p className="text-xs text-muted-foreground">
              {t('Enter your own user ID on this IM platform. Separate multiple IDs with commas or new lines.')}
            </p>
            <textarea
              value={ownersDisplay}
              onChange={(e) => handleOwnersChange(e.target.value)}
              onBlur={handleOwnersBlur}
              placeholder={permissionDefaults?.ownerIdHint || t('e.g. zhangsan, johndoe — ask the bot "what is my user ID" to look it up')}
              rows={2}
              className="w-full bg-secondary border border-transparent rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary resize-none"
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
                {t('No owner set. The first user to direct-message this bot is bound as the owner — enter your own ID above to claim it first. Until then, everyone is a guest who can only chat and use memory.')}
              </p>
            </div>
          )}

          {/* Guest section divider — makes the owner/guest boundary visually explicit */}
          {hasOwners && (
            <div className="flex items-center gap-3 pt-1">
              <span className="flex-shrink-0 text-xs text-muted-foreground">
                {t('Guest Permissions')}
              </span>
              <div className="h-px flex-1 bg-border-soft" />
            </div>
          )}

          {/* Guest access toggle (only when owners are set) */}
          {hasOwners && (
            <>
              <div className={`flex items-center justify-between py-1.5 ${switchRowHover}`}>
                <div className="space-y-0.5">
                  <p className="text-sm text-foreground">{t('Guest Access')}</p>
                  <p className="text-xs text-muted-foreground">
                    {guestAccessEnabled
                      ? t('Guests have limited access to selected tools below')
                      : t('Guests can only chat and use memory')}
                  </p>
                </div>
                <Switch checked={guestAccessEnabled} onCheckedChange={handleGuestAccessToggle} />
              </div>

              {guestAccessEnabled && (
                <div className="space-y-2">
                  <label className="text-sm text-foreground">
                    {t('Guest Allowed Tools')}
                  </label>
                  <CapabilityPolicyFields
                    policy={guestPolicy}
                    mode="strict"
                    audience="guest"
                    skills={skills?.map(s => ({ dirName: s.dirName, name: s.name, description: s.description }))}
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
