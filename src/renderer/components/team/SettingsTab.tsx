/** Unified team configuration surface (goal, schedule, collaboration, members). */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  GitBranch, RefreshCw, Bot, UserCircle,
  Trash2, Plus, Info, Crown, Star, LogOut, ChevronRight, Settings2, Users, Network,
} from 'lucide-react'
import type { TeamDetail, TeamTrigger, TeamScheduleConfig, TeamTriggerInput } from '../../../shared/apps/team-types'
import { useTeamStore } from '../../stores/team.store'
import { useOfficeSkin, useTeamViewPrefsStore } from '../../stores/team-view-prefs.store'
import { useAppsStore } from '../../stores/apps.store'
import { useTranslation } from '../../i18n'
import { api } from '../../api'
import { SchedulePicker } from '../apps/SchedulePicker'
import { SystemPromptEditor } from '../apps/SystemPromptEditor'
import type { ScheduleValue } from '../apps/schedule-utils'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { Switch } from '../ui/Switch'
import { HttpTriggerCard } from '../common/HttpTriggerCard'
import { TeamMemberSettings } from './TeamMemberSettings'

interface SettingsTabProps {
  detail: TeamDetail
  /** The member whose settings screen is open; null shows the team's own settings. */
  openMemberId: string | null
  onOpenMemberChange: (appId: string | null) => void
}

// ── Helpers ──

function configToValue(config: TeamScheduleConfig): ScheduleValue {
  if (config.cron) return { type: 'cron', cron: config.cron }
  return { type: 'every', every: config.every || '1h' }
}

function valueToConfig(value: ScheduleValue): TeamScheduleConfig {
  return value.type === 'cron' ? { cron: value.cron } : { every: value.every }
}

// ── Component ──

export function SettingsTab({ detail, openMemberId, onOpenMemberChange }: SettingsTabProps) {
  const { t } = useTranslation()
  // A joined office is owned by someone else: settings are read-only here and
  // schedule/triggers (authoritative run config) are hidden entirely.
  const readOnly = detail.team.hostNodeId != null
  // Adding a member lands straight on its settings: a member joined without a
  // duty is mute in the team, so "added" is not the end of the flow.
  const openMember = detail.members.find(m => m.appId === openMemberId) ?? null

  if (openMember) {
    return (
      <TeamMemberSettings
        detail={detail}
        member={openMember}
        onBack={() => onOpenMemberChange(null)}
      />
    )
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-2xl space-y-6 p-3 sm:p-6">
        {readOnly && (
          <p className="rounded-lg border border-border bg-secondary/40 px-3 py-2.5 text-xs text-muted-foreground">
            {t('This office is managed by its owner. You are watching it — settings are read-only.')}
          </p>
        )}
        {/* Everyday settings up top (§6.6): name / goal, schedule, members. */}
        <GoalSection team={detail.team} first readOnly={readOnly} />
        {!readOnly && <ScheduleSection teamId={detail.team.id} />}
        <MembersSection detail={detail} readOnly={readOnly} onOpenMember={onOpenMemberChange} />

        {/* Advanced, folded away (§6.6): collaboration structure, escalation
            routing, HTTP trigger, and disband — rarely touched, out of the way. */}
        <AdvancedSection>
          <OfficeSkinSection teamId={detail.team.id} />
          <CollaborationSection team={detail.team} readOnly={readOnly} />
          {!readOnly && (
            <div className="border-t border-border pt-6">
              <HttpTriggerCard kind="team" id={detail.team.id} />
            </div>
          )}
          {readOnly
            ? <LeaveSection teamId={detail.team.id} teamName={detail.team.name} />
            : <DangerSection detail={detail} />}
        </AdvancedSection>
      </div>
    </div>
  )
}

// ── 1. Goal ──

function GoalSection({ team, first, readOnly }: { team: TeamDetail['team']; first?: boolean; readOnly?: boolean }) {
  const updateTeam = useTeamStore(s => s.updateTeam)
  const { t } = useTranslation()
  const [draft, setDraft] = useState(team.goal)
  const [nameDraft, setNameDraft] = useState(team.name)

  useEffect(() => { setDraft(team.goal) }, [team.goal])
  useEffect(() => { setNameDraft(team.name) }, [team.name])

  const saveGoal = useCallback(() => {
    const next = draft.trim()
    if (next && next !== team.goal) void updateTeam(team.id, { goal: next })
  }, [draft, team.goal, team.id, updateTeam])

  const saveName = useCallback(() => {
    const next = nameDraft.trim()
    if (next && next !== team.name) void updateTeam(team.id, { name: next })
  }, [nameDraft, team.name, team.id, updateTeam])

  return (
    <Section title={t('Team')} first={first}>
      <label className="block space-y-1">
        <span className="text-xs text-muted-foreground">{t('Name')}</span>
        <input
          value={nameDraft}
          onChange={e => setNameDraft(e.target.value)}
          onBlur={saveName}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
          readOnly={readOnly}
          disabled={readOnly}
          className="w-full rounded-lg border border-border bg-secondary px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60"
        />
      </label>
      <label className="mt-3 block space-y-1">
        <span className="text-xs text-muted-foreground">{t('Goal')}</span>
        {/* A joined office keeps the plain disabled field: the editor exists to
            open a dialog, and there is nothing here to open. */}
        {readOnly ? (
          <textarea
            value={draft}
            rows={4}
            readOnly
            disabled
            className="w-full resize-y rounded-lg border border-border bg-secondary px-3 py-2 text-sm text-foreground disabled:opacity-60"
          />
        ) : (
          <SystemPromptEditor
            value={draft}
            onChange={setDraft}
            onBlur={saveGoal}
            onDone={saveGoal}
            title={t('What {{team}} should get done', { team: team.name })}
          />
        )}
        {!readOnly && (
          <p className="text-xs text-muted-foreground/70">
            {t('The lead will decompose this goal into tasks for the team.')}
          </p>
        )}
      </label>
    </Section>
  )
}

// ── 2. Schedule ──

function ScheduleSection({ teamId }: { teamId: string }) {
  const { t } = useTranslation()
  const [loading, setLoading] = useState(true)
  const [trigger, setTrigger] = useState<TeamTrigger | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [value, setValue] = useState<ScheduleValue>({ type: 'every', every: '1h' })

  useEffect(() => {
    let cancelled = false
    void api.teamListTriggers(teamId).then(res => {
      if (cancelled) return
      const list = (res?.success ? (res.data as TeamTrigger[]) : []) ?? []
      const schedule = list.find(tr => tr.sourceType === 'schedule') ?? null
      setTrigger(schedule)
      if (schedule) {
        setEnabled(schedule.enabled)
        setValue(configToValue(schedule.config as TeamScheduleConfig))
      }
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [teamId])

  const save = useCallback(async (nextEnabled: boolean, nextValue: ScheduleValue) => {
    const input: TeamTriggerInput = {
      sourceType: 'schedule',
      config: valueToConfig(nextValue),
      enabled: nextEnabled,
    }
    const res = await api.teamSetTrigger(teamId, input, trigger?.id)
    if (res?.success && res.data) setTrigger(res.data as TeamTrigger)
  }, [teamId, trigger?.id])

  const handleToggle = useCallback((next: boolean) => {
    setEnabled(next)
    void save(next, value)
  }, [value, save])

  const handleValueChange = useCallback((v: ScheduleValue) => {
    setValue(v)
    if (enabled) void save(true, v)
  }, [enabled, save])

  return (
    <Section title={t('Schedule')}>
      {loading ? (
        <p className="py-2 text-xs text-muted-foreground">{t('Loading…')}</p>
      ) : (
        <div className="space-y-3">
          <label className="flex items-center justify-between gap-2">
            <span className="text-sm text-foreground">{t('Run on a schedule')}</span>
            <Switch checked={enabled} onCheckedChange={handleToggle} size="sm" />
          </label>

          {enabled && <SchedulePicker value={value} onChange={handleValueChange} />}

          <p className="text-xs text-muted-foreground/70">
            {t('Manual run and HTTP trigger stay available regardless of this setting.')}
          </p>
        </div>
      )}
    </Section>
  )
}

// ── 3. Collaboration ──

function CollaborationSection({ team, readOnly }: { team: TeamDetail['team']; readOnly?: boolean }) {
  const updateTeam = useTeamStore(s => s.updateTeam)
  const { t } = useTranslation()

  return (
    <Section title={t('Team Collaboration')}>
      {/* Coordination style */}
      <div className="space-y-2">
        <span className="text-xs font-medium text-muted-foreground">{t('Coordination')}</span>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <OptionCard
            icon={<GitBranch className="h-4 w-4" />}
            label={t('Managed mode')}
            description={t('The Lead assigns tasks and reviews results. Members communicate through the defined reporting hierarchy.')}
            selected={team.collabMode === 'structured'}
            onClick={() => void updateTeam(team.id, { collabMode: 'structured' })}
            disabled={readOnly}
          />
          <OptionCard
            icon={<RefreshCw className="h-4 w-4" />}
            label={t('Free mode')}
            description={t('All members communicate freely without restrictions.')}
            selected={team.collabMode === 'free'}
            onClick={() => void updateTeam(team.id, { collabMode: 'free' })}
            disabled={readOnly}
          />
        </div>
      </div>

      {/* Escalation */}
      <div className="mt-4 space-y-2">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">{t('When members need help')}</span>
          <Tooltip text={t('Who members are asked to turn to first when they are stuck. This guides them — a member can still reach you directly when the decision is clearly yours.')} />
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <OptionCard
            icon={<Bot className="h-4 w-4" />}
            label={t('Ask the Lead first')}
            description={t('Members are asked to bring blockers to the Lead before involving you.')}
            selected={team.escalationRouting === 'lead'}
            onClick={() => void updateTeam(team.id, { escalationRouting: 'lead' })}
            badge={t('Recommended')}
            disabled={readOnly}
          />
          <OptionCard
            icon={<UserCircle className="h-4 w-4" />}
            label={t('Notify me directly')}
            description={t('Members are asked to bring blockers straight to you.')}
            selected={team.escalationRouting === 'user'}
            onClick={() => void updateTeam(team.id, { escalationRouting: 'user' })}
            disabled={readOnly}
          />
        </div>
      </div>
    </Section>
  )
}

// ── 3b. Office appearance (client-local view preference) ──

function OfficeSkinSection({ teamId }: { teamId: string }) {
  const { t } = useTranslation()
  const skin = useOfficeSkin(teamId)
  const setOfficeSkin = useTeamViewPrefsStore(s => s.setOfficeSkin)

  return (
    <Section title={t('Office appearance')}>
      <p className="mb-2 text-xs text-muted-foreground/70">
        {t('How this office looks on your screen. Only affects your view.')}
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <OptionCard
          icon={<Users className="h-4 w-4" />}
          label={t('Office cartoon')}
          description={t('Members appear as characters at their workstations, showing what each is doing.')}
          selected={skin === 'cartoon'}
          onClick={() => setOfficeSkin(teamId, 'cartoon')}
          badge={t('Default')}
        />
        <OptionCard
          icon={<Network className="h-4 w-4" />}
          label={t('Plain topology')}
          description={t('A compact status card per member, connected by the reporting lines.')}
          selected={skin === 'default'}
          onClick={() => setOfficeSkin(teamId, 'default')}
        />
      </div>
    </Section>
  )
}

// ── 4. Members ──

function MembersSection({ detail, readOnly, onOpenMember }: {
  detail: TeamDetail
  readOnly?: boolean
  onOpenMember: (appId: string) => void
}) {
  const { t } = useTranslation()
  const addMember = useTeamStore(s => s.addMember)
  const removeMember = useTeamStore(s => s.removeMember)
  const updateTeam = useTeamStore(s => s.updateTeam)
  const allApps = useAppsStore(s => s.apps)
  const appMap = useMemo(() => new Map(allApps.map(a => [a.id, a])), [allApps])
  const [showAdd, setShowAdd] = useState(false)
  const [promote, setPromote] = useState<{ appId: string; name: string } | null>(null)
  // What removal actually does decides what the confirmation may promise, and
  // it differs three ways: a member you added keeps everything; a member AI
  // built loses itself and its own space; the lead loses itself but not the
  // space, which is the team's owning space and therefore the user's own.
  const [remove, setRemove] = useState<{
    appId: string
    name: string
    aiProvisioned: boolean
    /**
     * The app lives in the team's owning space, so removal leaves the space
     * behind — the demoted lead's case. False when the app record cannot be
     * read at all: a member on a teammate's machine has none, and neither does
     * any member while the app list is still loading. Both are answered with
     * the more destructive wording rather than a promise that anything stays.
     */
    inOwningSpace: boolean
  } | null>(null)

  // Apps not already in this team (candidates for adding).
  const candidates = useMemo(() =>
    allApps.filter(a =>
      a.spec.type === 'automation' &&
      !detail.members.some(m => m.appId === a.id)
    ),
  [allApps, detail.members])

  return (
    <Section title={t('Members')}>
      <div className="space-y-2">
        {detail.members.map(member => {
          const app = appMap.get(member.appId)
          return (
            <MemberCard
              key={member.appId}
              memberName={member.memberName}
              duty={member.duty ?? ''}
              description={app?.spec.description ?? ''}
              isLead={member.isLead}
              aiProvisioned={member.aiProvisioned}
              onOpen={() => onOpenMember(member.appId)}
              onMakeLead={readOnly || member.isLead ? undefined : () => setPromote({ appId: member.appId, name: member.memberName })}
              onRemove={readOnly || member.isLead ? undefined : () => setRemove({
                appId: member.appId,
                name: member.memberName,
                aiProvisioned: member.aiProvisioned,
                // Spelled out rather than app?.spaceId === …, so that "we could
                // not tell" stays a decision made here instead of a value that
                // falls out of optional chaining somewhere else.
                inOwningSpace: app !== undefined && app.spaceId === detail.team.owningSpaceId,
              })}
            />
          )
        })}
      </div>

      {promote && (
        <ConfirmDialog
          title={t('Make {{name}} the lead?', { name: promote.name })}
          // Managed mode rebuilds the reporting lines around the new lead; in
          // free mode there are none to lose, so saying so would describe
          // something that does not exist.
          message={t('{{name}} will break the goal into tasks and hand them out. The current lead stays on the team as an ordinary member.', { name: promote.name })
            + (detail.team.collabMode === 'structured'
              ? ' ' + t('This team is in Managed mode, so the reporting lines are rebuilt around the new lead. Any connections you drew by hand are replaced.')
              : '')}
          confirmLabel={t('Make lead')}
          cancelLabel={t('Cancel')}
          variant="default"
          onConfirm={() => { const p = promote; setPromote(null); void updateTeam(detail.team.id, { leadAppId: p.appId }) }}
          onCancel={() => setPromote(null)}
        />
      )}

      {remove && (
        <ConfirmDialog
          // The verb names the worst outcome the press authorises, not the one
          // that is certain — the worst outcome always has a single value,
          // "what actually happens" does not.
          title={!remove.aiProvisioned
            ? t('Remove {{name}} from this team?', { name: remove.name })
            : remove.inOwningSpace
              ? t('Delete {{name}}?', { name: remove.name })
              : t('Delete {{name}} permanently?', { name: remove.name })}
          message={!remove.aiProvisioned
            ? t('{{name}} stays yours — the digital human, its own instructions, and everything in its space are untouched. What it loses is what it had here: the duty you wrote for this team, and what this team was allowed to ask of it. Add it back later and you write those again.', { name: remove.name })
            : remove.inOwningSpace
              ? t('{{name}} is the lead this team was given when it was created. Removing it deletes the digital human itself, and that cannot be undone. The space it works in is yours and stays, along with everything in it.', { name: remove.name })
              : t('Removing it from this team deletes the digital human, its space, and every file it produced, and that cannot be undone. If there is anything you want to keep, close this and copy it out first.')}
          // Lighter for the demoted lead: the space survives, so one rung down.
          confirmLabel={!remove.aiProvisioned
            ? t('Remove')
            : remove.inOwningSpace ? t('Delete') : t('Delete permanently')}
          cancelLabel={t('Cancel')}
          variant={remove.aiProvisioned ? 'danger' : 'default'}
          onConfirm={() => { const r = remove; setRemove(null); void removeMember(detail.team.id, r.appId) }}
          onCancel={() => setRemove(null)}
        />
      )}

      {!readOnly && (showAdd ? (
        <div className="mt-3 rounded-lg border border-border bg-secondary/30 p-3">
          <p className="mb-2 text-xs font-medium text-muted-foreground">{t('Add a digital human to the team')}</p>
          {candidates.length === 0 ? (
            <p className="text-xs text-muted-foreground/70">{t('No available digital humans to add.')}</p>
          ) : (
            <div className="flex max-h-40 flex-col gap-1 overflow-y-auto">
              {candidates.map(a => (
                <button
                  key={a.id}
                  onClick={async () => {
                    const ok = await addMember(detail.team.id, { appId: a.id })
                    setShowAdd(false)
                    if (ok) onOpenMember(a.id)
                  }}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-secondary"
                >
                  <span className="font-medium">{a.spec.name}</span>
                  {a.spec.description && (
                    <span className="truncate text-xs text-muted-foreground">{a.spec.description}</span>
                  )}
                </button>
              ))}
            </div>
          )}
          <button onClick={() => setShowAdd(false)} className="mt-2 text-xs text-muted-foreground hover:text-foreground">
            {t('Cancel')}
          </button>
        </div>
      ) : (
        <button
          onClick={() => setShowAdd(true)}
          className="mt-3 flex items-center gap-1.5 rounded-lg border border-dashed border-border px-3 py-2 text-sm text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
        >
          <Plus className="h-4 w-4" />
          {t('Add member')}
        </button>
      ))}

      {!readOnly && (
        <p className="mt-3 text-xs text-muted-foreground/60">
          {t('A duty applies only inside this team. Changing the digital human itself affects it everywhere.')}
        </p>
      )}
    </Section>
  )
}

function MemberCard({ memberName, duty, description, isLead, aiProvisioned, onOpen, onMakeLead, onRemove }: {
  memberName: string
  duty: string
  description: string
  isLead: boolean
  /** Decides the delete button's wording: this is the only text read before pressing. */
  aiProvisioned: boolean
  onOpen: () => void
  onMakeLead?: () => void
  onRemove?: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="group rounded-lg border border-border bg-background p-3">
      <div className="flex items-start justify-between gap-2">
        <button onClick={onOpen} className="min-w-0 flex-1 text-left">
          <div className="flex items-center gap-1.5">
            {isLead && <Star className="h-3.5 w-3.5 flex-shrink-0 fill-current text-amber-500" />}
            <span className="text-sm font-medium text-foreground">{memberName}</span>
            {isLead && <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-400">{t('Lead')}</span>}
          </div>
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
            {duty || description || t('No duty written yet — tap to write one.')}
          </p>
        </button>
        <div className="flex flex-shrink-0 items-center gap-1">
          {onMakeLead && (
            <button
              onClick={onMakeLead}
              className="rounded p-1 text-muted-foreground/50 transition-colors hover:text-amber-500"
              title={t('Make lead')}
              aria-label={t('Make lead')}
            >
              <Crown className="h-3.5 w-3.5" />
            </button>
          )}
          {onRemove && (
            <button
              onClick={onRemove}
              className="rounded p-1 text-muted-foreground/50 transition-colors hover:text-destructive"
              title={aiProvisioned ? t('Delete member') : t('Remove member')}
              aria-label={aiProvisioned ? t('Delete member') : t('Remove member')}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── 5. Danger zone ──

function DangerSection({ detail }: { detail: TeamDetail }) {
  const dissolveTeam = useTeamStore(s => s.dissolveTeam)
  const { t } = useTranslation()
  const [confirm, setConfirm] = useState(false)

  // The members dissolve actually deletes. The lead is excluded on purpose: it
  // is hidden from the Digital Humans list, so naming it here would show a name
  // the user has never seen, inside an irreversible confirmation.
  const doomed = useMemo(
    () => detail.members.filter(m => !m.isLead && m.aiProvisioned),
    [detail.members]
  )
  // One source for both the count and the names, so the two can never disagree.
  const names = doomed.map(m => m.memberName).join(', ')

  return (
    <>
      <div className="rounded-lg border border-destructive/30 p-3">
        <button
          onClick={() => setConfirm(true)}
          className="text-sm text-destructive transition-opacity hover:opacity-80"
        >
          {t('Dissolve team')}
        </button>
        <p className="mt-1 text-xs text-muted-foreground/60">
          {t('Removes the team and its run history. Member digital humans are not deleted.')}
        </p>
      </div>

      {confirm && (
        <ConfirmDialog
          title={doomed.length > 0
            ? t('Dissolve {{name}} and delete {{count}} digital humans?', { name: detail.team.name, count: doomed.length })
            : t('Dissolve {{name}}?', { name: detail.team.name })}
          message={doomed.length > 0
            ? t('{{names}} were created by AI for this team. Dissolving deletes them, and deletes their spaces from your space list — including any files you put there yourself. This cannot be undone. If you need anything out of those spaces, close this and copy it first.', { names })
            : t('The team and its whole run history are deleted, along with the team\u2019s own lead, and that cannot be undone. The digital humans you added are not deleted — they go back to being ordinary digital humans, with everything they have made.')}
          // Even with no AI members, the team's own lead is a digital human
          // being deleted, so the verb cannot be a bare "Dissolve".
          confirmLabel={doomed.length > 0 ? t('Dissolve and delete permanently') : t('Dissolve and delete')}
          cancelLabel={t('Cancel')}
          variant="danger"
          onConfirm={() => { setConfirm(false); void dissolveTeam(detail.team.id) }}
          onCancel={() => setConfirm(false)}
        />
      )}
    </>
  )
}

// ── 5b. Leave (joined office) ──

function LeaveSection({ teamId, teamName }: { teamId: string; teamName: string }) {
  const leaveOffice = useTeamStore(s => s.leaveOffice)
  const { t } = useTranslation()
  const [confirm, setConfirm] = useState(false)
  return (
    <>
      <div className="rounded-lg border border-border p-3">
        <button
          onClick={() => setConfirm(true)}
          className="flex items-center gap-1.5 text-sm text-foreground transition-opacity hover:opacity-80"
        >
          <LogOut className="h-4 w-4" />
          {t('Leave office')}
        </button>
        <p className="mt-1 text-xs text-muted-foreground/60">
          {t('Stop taking part. Your digital humans stay yours.')}
        </p>
      </div>

      {confirm && (
        <ConfirmDialog
          title={t('Leave {{name}}?', { name: teamName })}
          message={t('Your digital humans stop working in this team and go back to being just yours — they, their spaces, and everything in them are untouched. What is deleted is this team\u2019s record on your computer: what it did, and any periodic checks teammates set on your digital humans. To take part again you will need an invite link.')}
          confirmLabel={t('Leave')}
          cancelLabel={t('Cancel')}
          // Not danger: leaving takes nothing of the user's away. The record it
          // does delete is the team's, and losing it is what someone already
          // expects when they leave — that is worth a sentence, not a colour.
          variant="default"
          onConfirm={() => { setConfirm(false); void leaveOffice(teamId) }}
          onCancel={() => setConfirm(false)}
        />
      )}
    </>
  )
}

// ── Advanced (folded) ──

function AdvancedSection({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <div className="border-t border-border pt-6">
      <button
        onClick={() => setOpen(v => !v)}
        className="flex w-full items-center gap-2 text-left"
      >
        <Settings2 className="h-4 w-4 text-muted-foreground" />
        <span className="flex-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('Advanced')}</span>
        <ChevronRight className={`h-4 w-4 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && <div className="mt-4 space-y-6">{children}</div>}
    </div>
  )
}

// ── Shared primitives ──

function Section({ title, children, first }: { title: string; children: React.ReactNode; first?: boolean }) {
  return (
    <div className={first ? '' : 'border-t border-border pt-6'}>
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </div>
  )
}

function OptionCard({ icon, label, description, selected, onClick, badge, disabled }: {
  icon: React.ReactNode
  label: string
  description: string
  selected: boolean
  onClick: () => void
  badge?: string
  disabled?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex items-start gap-3 rounded-lg border p-3 text-left transition-colors disabled:cursor-default disabled:opacity-70 disabled:hover:border-border disabled:hover:bg-transparent ${
        selected
          ? 'border-primary bg-primary/5'
          : 'border-border hover:border-primary/40 hover:bg-secondary/30'
      }`}
    >
      <div className={`mt-0.5 flex-shrink-0 ${selected ? 'text-primary' : 'text-muted-foreground'}`}>
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={`text-sm font-medium ${selected ? 'text-foreground' : 'text-muted-foreground'}`}>{label}</span>
          {badge && <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">{badge}</span>}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground/70">{description}</p>
      </div>
    </button>
  )
}


function Tooltip({ text }: { text: string }) {
  return (
    <span className="group relative cursor-help">
      <Info className="h-3.5 w-3.5 text-muted-foreground/50" />
      <span className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-1.5 w-56 -translate-x-1/2 rounded-lg border border-border bg-popover px-3 py-2 text-xs text-foreground opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
        {text}
      </span>
    </span>
  )
}
