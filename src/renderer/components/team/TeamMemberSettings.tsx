/**
 * What one digital human does in THIS team, and how far a teammate may borrow it.
 *
 * The duty sits on top and takes the room: it is read and rewritten constantly,
 * and it is the thing that makes a member able to carry its part of a flow
 * without anyone watching. The capability switches fold away underneath — set
 * once, then forgotten.
 *
 * A member someone else brought is readable here in full and editable nowhere:
 * it runs on their machine, so it is theirs to define.
 */

import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, ChevronRight, ExternalLink, Timer } from 'lucide-react'
import type { TeamCheckView, TeamDetail, TeamMember, TeamDelegatedPolicy } from '../../../shared/apps/team-types'
import { checksForMember, isRemoteMember } from '../../../shared/apps/team-types'
import { fullCapabilityPolicy } from '../../../shared/apps/capability-policy'
import { CapabilityPolicyFields } from '../capability/CapabilityPolicyFields'
import { useTeamStore } from '../../stores/team.store'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { useTranslation } from '../../i18n'
import { describeRhythm } from './check-format'
import { epochWorkLabel } from './run-history'

interface TeamMemberSettingsProps {
  detail: TeamDetail
  member: TeamMember
  onBack: () => void
}

export function TeamMemberSettings({ detail, member, onBack }: TeamMemberSettingsProps) {
  const { t } = useTranslation()
  const updateMember = useTeamStore(s => s.updateMember)
  const setCurrentTab = useAppsPageStore(s => s.setCurrentTab)
  const openAppConfig = useAppsPageStore(s => s.openAppConfig)

  const isMine = !isRemoteMember(member)
  const ownerName = member.ownerDisplayName || t('a teammate')
  // Every check on this member in this office, not just the one you happened to
  // walk in from: the member's live panel is where a single conversation's are.
  const checks = checksForMember(detail.checks ?? [], member.appId)

  const [duty, setDuty] = useState(member.duty ?? '')
  useEffect(() => { setDuty(member.duty ?? '') }, [member.appId, member.duty])

  const saveDuty = useCallback(() => {
    const next = duty.trim()
    if (next === (member.duty ?? '')) return
    void updateMember(detail.team.id, member.appId, { duty: next })
  }, [duty, member.duty, member.appId, detail.team.id, updateMember])

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-border px-3 py-2.5 sm:px-4">
        <button
          onClick={onBack}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          title={t('Back')}
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {member.memberName}
        </span>
        {/* Only for a member running here: a teammate's app has no local row to open. */}
        {isMine && (
          <button
            onClick={() => { setCurrentTab('my-digital-humans'); openAppConfig(member.appId) }}
            title={t('Open in Digital Humans')}
            aria-label={t('Open in Digital Humans')}
            className="flex flex-shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{t('Open in Digital Humans')}</span>
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-5 p-3 sm:p-6">
          <div className="space-y-2">
            <h3 className="text-sm font-medium text-foreground">
              {t('What does it take care of in this team?')}
            </h3>
            {isMine ? (
              <textarea
                value={duty}
                onChange={e => setDuty(e.target.value)}
                onBlur={saveDuty}
                rows={7}
                placeholder={t(
                  'For example:\nYou do the coding.\nStart once you have the design and the test cases; write the code and test it yourself.\nWhen you are done, tell "Code Review".\nIf it comes back rejected, fix it and tell them again.'
                )}
                className="w-full resize-y rounded-lg border border-border bg-secondary px-3 py-2 text-sm leading-relaxed text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
            ) : (
              <div className="rounded-lg border border-border bg-secondary/40 px-3 py-2">
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                  {member.duty?.trim() || t('Nothing written yet.')}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  {t('{{owner}} wrote this for their digital human.', { owner: ownerName })}
                </p>
              </div>
            )}
          </div>

          {isMine && <DelegatedCapabilities teamId={detail.team.id} member={member} />}

          <MemberChecks teamId={detail.team.id} checks={checks} />
        </div>
      </div>
    </div>
  )
}

/**
 * Everything standing over this member in this office, whichever piece of work
 * it was set inside. The question asked here is the owner's — "is anything
 * driving my digital human" — and that question does not stop at one
 * conversation, so each row has to say where it came from.
 */
function MemberChecks({ teamId, checks }: { teamId: string; checks: TeamCheckView[] }) {
  const { t, i18n } = useTranslation()
  const cancelCheck = useTeamStore(s => s.cancelCheck)
  const conversations = useTeamStore(s => s.conversations)
  const epochs = useTeamStore(s => s.epochs)

  if (checks.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border px-3 py-2.5">
        <Timer className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
        <span className="text-sm text-muted-foreground">{t('No periodic check running')}</span>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium text-foreground">
        {t('Periodic checks on it')}
      </h3>
      {checks.map(check => (
        <div key={check.id} className="flex items-start gap-2 rounded-lg border border-border px-3 py-2.5">
          <Timer className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="text-sm text-foreground">
              {t('{{who}} has it look {{schedule}}: {{what}}', {
                who: check.createdByMemberName,
                schedule: describeRhythm(check.schedule, t, i18n.language),
                what: check.instruction,
              })}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('In {{work}}', { work: epochWorkLabel(check.epochId, conversations, epochs, t) })}
            </p>
            {/* A check whose target cannot be reached must not read as alive. */}
            {!check.reachable && (
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t('Not running: {{owner}}’s computer is offline', {
                  owner: check.targetOwner || t('its owner'),
                })}
              </p>
            )}
          </div>
          <button
            onClick={() => void cancelCheck(teamId, check.id)}
            className="flex-shrink-0 rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            {t('Stop')}
          </button>
        </div>
      ))}
    </div>
  )
}

function DelegatedCapabilities({ teamId, member }: { teamId: string; member: TeamMember }) {
  const { t } = useTranslation()
  const updateMember = useTeamStore(s => s.updateMember)
  const [open, setOpen] = useState(false)
  // The switches read from a local draft, not from the member row: a save is a
  // round-trip through main and a full detail reload, and two switches flipped
  // inside that window would both start from the pre-flip policy — the second
  // save would silently hand back the permission the first one took away. The
  // draft is only re-seeded when the screen moves to another member; nobody
  // else authors this policy, so there is nothing to lose by ignoring refreshes.
  const [policy, setPolicy] = useState<TeamDelegatedPolicy | undefined>(member.delegatedPolicy ?? undefined)
  const appId = member.appId
  useEffect(() => { setPolicy(member.delegatedPolicy ?? undefined) }, [appId])

  const save = (next: TeamDelegatedPolicy) => {
    setPolicy(next)
    void updateMember(teamId, appId, { delegatedPolicy: next })
  }

  return (
    <div className="rounded-lg border border-border">
      <button
        onClick={() => setOpen(v => !v)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
      >
        <span className="flex-1 text-sm text-foreground">{t('What others can ask it to do')}</span>
        <ChevronRight className={`h-4 w-4 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="space-y-3 border-t border-border px-3 py-3">
          <p className="text-xs text-muted-foreground/70">
            {t('The tools it has in hand when anyone else puts it to work — a teammate’s digital human, or a person on another machine. Talking to it yourself is unaffected.')}
          </p>
          <CapabilityPolicyFields
            policy={policy}
            mode="permissive"
            groupLabels={{
              file: t('File Read'),
              network: t('Network'),
              other: t('Other'),
              // Reworded for this scenario: these are the ones that touch the
              // owner's machine, which is the whole reason the screen exists.
              advanced: t('Touches your computer'),
            }}
            onChange={next => save({ ...policy, ...next })}
            extraToggles={[
              {
                key: 'allowChecks',
                label: t('Let teammates set a periodic check on it'),
                checked: policy?.allowChecks !== false,
                onToggle: () =>
                  save({ ...(policy ?? fullCapabilityPolicy()), allowChecks: policy?.allowChecks === false }),
              },
            ]}
          />
        </div>
      )}
    </div>
  )
}
