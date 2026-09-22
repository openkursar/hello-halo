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
 *
 * Above the duty sits what the digital human is in its own right, so the panel
 * answers "who is this" before "what does it do here" — without it, a reader
 * who never opens the Digital Humans screen only ever sees an assignment.
 */

import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, ChevronRight, ExternalLink, Timer } from 'lucide-react'
import type { TeamCheckView, TeamDetail, TeamMember, TeamDelegatedPolicy, TeamToolAudit } from '../../../shared/apps/team-types'
import { checksForMember, isRemoteMember } from '../../../shared/apps/team-types'
import { fullCapabilityPolicy } from '../../../shared/apps/capability-policy'
import { CapabilityPolicyFields } from '../capability/CapabilityPolicyFields'
import { api } from '../../api'
import { SystemPromptEditor } from '../apps/SystemPromptEditor'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { useTeamStore } from '../../stores/team.store'
import { useAppsStore } from '../../stores/apps.store'
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
  // Read live rather than copied onto the member row, so editing the digital
  // human shows here immediately. Absent for a member on a teammate's machine —
  // its app record lives there, and nothing replicates it.
  const description = useAppsStore(
    s => s.apps.find(a => a.id === member.appId)?.spec.description?.trim() ?? ''
  )
  // Its own instructions, shown to explain the member to a reader — NOT shared
  // with the team. Same reason it is read live: it is the app's, not the row's.
  const systemPrompt = useAppsStore(s => {
    const spec = s.apps.find(a => a.id === member.appId)?.spec
    return spec?.type === 'automation' ? spec.system_prompt?.trim() ?? '' : ''
  })
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
          {description && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-foreground">
                {t('The digital human itself')}
              </h3>
              <p className="whitespace-pre-wrap rounded-lg border border-border bg-secondary/40 px-3 py-2 text-sm leading-relaxed text-muted-foreground">
                {description}
              </p>
              <p className="text-xs text-muted-foreground/60">
                {t('Teammates can read this — it is how they tell what this one can do.')}
              </p>
            </div>
          )}

          <div className="space-y-2">
            <h3 className="text-sm font-medium text-foreground">
              {t('Duty in this team')}
            </h3>
            {isMine ? (
              <SystemPromptEditor
                value={duty}
                onChange={setDuty}
                onBlur={saveDuty}
                onDone={saveDuty}
                title={t('What {{member}} does in {{team}}', {
                  member: member.memberName,
                  team: detail.team.name,
                })}
                className="leading-relaxed"
                placeholder={t(
                  'For example:\nYou do the coding.\nStart once you have the design and the test cases; write the code and test it yourself.\nWhen you are done, tell "Code Review".\nIf it comes back rejected, fix it and tell them again.'
                )}
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
            <p className="text-xs text-muted-foreground/60">
              {t('Teammates can read this too, and it is what they go on when handing out work.')}
            </p>
          </div>

          {isMine && systemPrompt && <OwnInstructions prompt={systemPrompt} />}

          {isMine && <DelegatedCapabilities teamId={detail.team.id} member={member} />}

          {isMine && <BorrowedWorkRecord teamId={detail.team.id} member={member} />}

          <MemberChecks teamId={detail.team.id} checks={checks} />
        </div>
      </div>
    </div>
  )
}

/**
 * The digital human's own instructions, read-only and folded away.
 *
 * It is here to answer "who am I actually working with" — the same reason you
 * open a colleague's profile — and for no other reason: it is NOT shared with
 * the team, and editing it belongs on the digital human itself, where the
 * change applies everywhere rather than only in this office.
 *
 * Folded because it is usually long: a full prompt dropped into this panel
 * buries the duty, which is the part that gets read and rewritten constantly.
 */
function OwnInstructions({ prompt }: { prompt: string }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium text-foreground">{t('Its own instructions')}</h3>
      <div className="rounded-lg border border-border bg-secondary/40 px-3 py-2">
        <p
          className={`whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground ${
            expanded ? '' : 'line-clamp-6'
          }`}
        >
          {prompt}
        </p>
        <button
          onClick={() => setExpanded(v => !v)}
          className="mt-1.5 text-xs text-primary transition-colors hover:text-primary/80"
        >
          {expanded ? t('Show less') : t('Show more')}
        </button>
      </div>
      <p className="text-xs text-muted-foreground/60">
        {t('Only you see this. Change it on the digital human itself, where it applies everywhere.')}
      </p>
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
  const [stopping, setStopping] = useState<TeamCheckView | null>(null)

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
            onClick={() => setStopping(check)}
            className="flex-shrink-0 rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            {t('Stop')}
          </button>
        </div>
      ))}
      {stopping && (
        <ConfirmDialog
          title={t('Stop this periodic check?')}
          message={t('The instruction it was checking for is not saved anywhere else — stopping it cannot be undone.')}
          confirmLabel={t('Stop')}
          cancelLabel={t('Cancel')}
          variant="danger"
          onConfirm={() => { const c = stopping; setStopping(null); void cancelCheck(teamId, c.id) }}
          onCancel={() => setStopping(null)}
        />
      )}
    </div>
  )
}

/**
 * What was actually done with this digital human while somebody else was
 * driving it.
 *
 * The permission switches above say what is POSSIBLE; this says what happened,
 * and the two answer different questions. A person who has granted something
 * broad is not asking "what did I allow" — they know — they are asking whether
 * they should have. Only a record of real calls answers that.
 *
 * Folded away because on a healthy team it is long and uninteresting; the count
 * of refusals is on the outside, because that is the part worth noticing
 * without opening anything.
 */
function BorrowedWorkRecord({ teamId, member }: { teamId: string; member: TeamMember }) {
  const { t, i18n } = useTranslation()
  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState<TeamToolAudit[] | null>(null)
  const appId = member.appId

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void (async () => {
      const res = await api.teamToolAudit(teamId, { appId, limit: 200 })
      if (!cancelled) setEntries(res.success ? (res.data as TeamToolAudit[]) ?? [] : [])
    })()
    return () => { cancelled = true }
  }, [open, teamId, appId])

  const nameByApp = new Map(
    (useTeamStore.getState().detail?.members ?? []).map(m => [m.appId, m.memberName]),
  )
  const refused = entries?.filter(e => e.decision === 'denied').length ?? 0

  return (
    <div className="rounded-lg border border-border">
      <button
        onClick={() => setOpen(v => !v)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
      >
        <span className="flex-1 text-sm text-foreground">{t('What it has been asked to do')}</span>
        {refused > 0 && (
          <span className="flex-shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400">
            {t('{{count}} refused', { count: refused })}
          </span>
        )}
        <ChevronRight className={`h-4 w-4 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="space-y-2 border-t border-border px-3 py-3">
          <p className="text-xs text-muted-foreground/70">
            {t('Every tool it reached for while a teammate — or a person on another machine — was driving it. Your own conversations with it are not listed.')}
          </p>
          {entries === null ? (
            <p className="text-sm text-muted-foreground">{t('Loading…')}</p>
          ) : entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('Nobody else has put it to work yet.')}</p>
          ) : (
            <div className="space-y-1">
              {entries.map(entry => (
                <div
                  key={entry.id}
                  className="flex items-start gap-2 rounded-md border border-border/60 px-2 py-1.5"
                >
                  <span
                    className={`mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full ${
                      entry.decision === 'denied' ? 'bg-amber-500' : 'bg-emerald-500'
                    }`}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs text-foreground">
                      <span className="font-medium">{entry.toolName}</span>
                      {entry.detail && <span className="text-muted-foreground"> · {entry.detail}</span>}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground/70">
                      {t('{{who}} · {{when}}', {
                        who: entry.actorAppId
                          ? nameByApp.get(entry.actorAppId) ?? t('a teammate')
                          : t('a person on another machine'),
                        when: new Date(entry.createdAt).toLocaleString(i18n.language),
                      })}
                      {entry.decision === 'denied' && ` · ${t('refused')}`}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
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
