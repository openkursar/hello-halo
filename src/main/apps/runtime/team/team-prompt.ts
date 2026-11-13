/**
 * Team prompt Entry + Constraint layers for team-channel turns.
 * Orchestration builds TeamPromptContext; app-chat renders it into the prompt.
 */

import type { CollabMode, EscalationRouting } from '../../../../shared/apps/team-types'
import { TEAM_LEAD_ADDRESS, teamMemberAddress } from '../../../../shared/apps/team-types'
import type { TeamFolderPaths } from './team-folder'

export interface TeamPromptRosterEntry {
  appId: string
  memberName: string
  role: string
  /**
   * What this teammate is in its own right, as its owner described the digital
   * human itself. Absent when its owner wrote none, or when it runs on another
   * machine (the app record lives there) — never an empty string, so rendering
   * can key off presence alone.
   */
  description?: string
  /**
   * What this teammate is responsible for in this team, written by its owner.
   * Carried in full — deciding who to hand work to, and what they will hand back,
   * is exactly what this text is for, so truncating it defeats the purpose.
   */
  duty?: string | null
  isLead: boolean
  contactable: boolean
  /**
   * Display name of the person who owns/brought this teammate. Null when the
   * member runs on the SAME machine as you. Stable for the life of a run, so it
   * belongs in the (cached) system prompt; live reachability does NOT — read it
   * from `team_read_board` at dispatch time.
   */
  owner?: string | null
  /** True when this teammate runs on the same machine as you (shared filesystem). */
  sameMachine?: boolean
}

/**
 * INVARIANT: every field here must be stable for a (team, member) pair across
 * consecutive turns. The rendered Entry is baked into the session's system
 * prompt, which is part of the agent session's reuse fingerprint — a field that
 * changes per turn rebuilds the CC subprocess on every turn (killing the one
 * that is still streaming). Per-turn facts (who started this turn, whether the
 * sender is blocking on the reply) belong in the message body instead.
 */
export interface TeamPromptContext {
  teamName: string
  goal: string
  temporaryCollaboration?: boolean
  collabMode: CollabMode
  escalationRouting: EscalationRouting
  selfMemberName: string
  selfRole: string
  /** What YOU are responsible for in this team, written by your owner. */
  selfDuty?: string | null
  selfIsLead: boolean
  /**
   * The app running this turn exists for THIS collaboration alone (ephemeral
   * team, AI-provisioned member). app-chat reads it to withhold the surfaces
   * that only make sense for a digital human that outlives the work — its
   * memory and digital-human management. Never rendered into the Entry.
   * Flips only via "save as team", which rebuilds the session once — from then
   * on the member does have a life to remember.
   */
  selfIsDisposable: boolean
  roster: TeamPromptRosterEntry[]
  /**
   * This member's team folder for the piece of work the session serves. Stable
   * for the session: a team session is per epoch, and so is the folder. Null
   * when it could not be prepared — the Entry then points only at the working
   * directory, never at a folder the member cannot write to.
   */
  teamFolder: TeamFolderPaths | null
  /**
   * The conversation the session serves, when it is an IM chat's — whose guest
   * settings bound a guest's request reaching this member. Never rendered.
   */
  chatKey: string | null
}

// ── Entry layer ──

export function buildTeamEntry(ctx: TeamPromptContext): string {
  const lines: string[] = [
    '## Team work',
    '',
    `Here you are known as ${ctx.selfIsLead ? TEAM_LEAD_ADDRESS : ctx.selfMemberName}; your role is ${ctx.selfRole || 'member'}${ctx.selfIsLead ? ' (team lead)' : ''}.`,
    '',
    // The owner's own words about this member's part in this team. It layers on
    // top of the digital human's persona and applies ONLY inside team turns.
    ...(ctx.selfDuty && ctx.selfDuty.trim()
      ? ['### What you are responsible for here', '', quoteOwnerText(ctx.selfDuty), '']
      : []),
    'Each message identifies its sender;',
    'follow the current instruction and its permission boundaries.',
    'Use collaborators for independent parallel work, a separate context or review, not a simple read or search.',
    'Add one with spawn_agent. No team setup or fixed goal is required.',
    'End your turn when your work is done. No team-completion tool call is required.',
    'These runtime facts apply even if an older stored role prompt describes a different workflow.',
    '',
    ...(!ctx.temporaryCollaboration && ctx.goal.trim() ? ['### Standing Team Goal', quoteOwnerText(ctx.goal), 'The current instruction specifies the work to do now.', ''] : []),
    '### Known standing members',
    '',
    ...renderRoster(ctx),
    'Temporary collaborators for this work are listed by team_read_board; they are not part of the standing roster.',
    '',
    '## Team communication',
    '',
    '- Send teammate replies/results to the actual requester with `team_send(to, message)`; use to:"lead" for the lead.',
    '  A final reply is not a team message; do not redirect every reply to the lead.',
    '- Human conversations with your owner are private and do not notify the lead.',
    '- When a team-work turn ends, the lead receives an independent notification',
    '  with a short request excerpt and at most 500 characters of the final reply,',
    '  regardless of who requested the work or whom you already messaged.',
    '- `team_send` hands the message over and returns. Permission-compatible',
    '  messages reach you after your current tool call, while you keep working.',
    '  Messages with different permissions run in a separate turn after this one.',
    '  Do not poll or end your turn to receive them. End when your own work is finished.',
    ...renderFileSharing(ctx.teamFolder),
    '- Recover tasks, findings and collaborators with `team_read_board()`, including after compaction.',
    '  It records what was written down: reliable entries, but silence proves nothing. Ask whoever did the work.',
    '- Use team_post_task / team_update_task when ownership tracking helps. Posting a task does not dispatch it;',
    '  send instructions with team_send. Each collaborator has separate history: supply self-contained context,',
    '  permitted actions and required evidence.',
    '- Findings are reusable knowledge or artifacts, not requests, replies, acknowledgements or progress messages.',
    '  Publishing does not notify a teammate. With one collaborator, direct messages usually suffice.',
    '- Only when you need a HUMAN decision, call',
    '  `report_to_user({type:"escalation", message:"Your question", choices:["Option A", "Option B"]})`.',
    '',
    '### Messages that arrive while you are working',
    '',
    '- "Arrived while you were working" marks new input, not a tool result or part of your current task;',
    '  it may already be overtaken by your work. Continue unless it changes the task; do not merely acknowledge.',
    '- If already done, report that instead of repeating real effects. If changing course, finish, undo or',
    '  describe the work left in progress. Reply when someone needs an answer or your decision affects them.',
  ]

  return lines.filter((l) => l !== '').join('\n')
}

function renderFileSharing(folder: TeamFolderPaths | null): string[] {
  return [
    ...(folder ? [`- Scratch folder for this piece of work: ${folder.self}. Put temporary collaboration files there, not in your working directory.`] : []),
    '- Share large outputs as files, not message text: publish with `team_post_finding(ref)` or a task’s `resultRef`;',
    '  teammates read with `team_read_artifact(ref)`. Publishing validates the file and access; fix a failed publish before sharing.',
    `  Refs must name files inside your working directory, relative to it (e.g. "docs/design.md")${folder ? ' or inside your scratch folder' : ''}; files elsewhere cannot be shared.`,
    '- A published name belongs to one member only. Use a producer-unique name; if another member owns it, rename and republish.',
  ]
}

function quoteOwnerText(text: string): string {
  return text.trim().split('\n').map((line) => `> ${line}`).join('\n')
}

function renderRoster(ctx: TeamPromptContext): string[] {
  if (ctx.roster.length === 0) {
    return ['No other standing members are listed here. Read team_read_board for current collaborators.']
  }
  const rows = ctx.roster.map((m) => {
    // Owner label: a teammate on another machine is "brought by <person>";
    // same-machine teammates need no label (they are yours, on this machine).
    const ownership =
      m.sameMachine === false ? ` — ${m.owner ? `${m.owner}\u2019s digital human` : 'a teammate\u2019s digital human'}` : ''
    const head = `- ${m.isLead ? TEAM_LEAD_ADDRESS : m.memberName} — ${m.role || 'member'}; to=${JSON.stringify(teamMemberAddress(m))}${ownership}`
    // Both are their owner's own words and both decide who gets a piece of
    // work, so both are carried verbatim: what the digital human is, and what
    // it is responsible for here. Labelled only when both are present — alone,
    // there is no ambiguity to resolve and a label is pure cost in a block that
    // rides in every teammate's every turn.
    const description = m.description?.trim()
    const isSelf = ctx.selfIsLead ? m.isLead : !m.isLead && m.memberName === ctx.selfMemberName
    const rosterDuty = m.duty?.trim()
    const selfDuty = ctx.selfDuty?.trim()
    const duty = isSelf && selfDuty && rosterDuty === selfDuty ? undefined : rosterDuty
    if (!description && !duty) return head
    const body: string[] = []
    if (description) body.push(duty ? `About: ${description}` : description)
    if (duty) body.push(description ? `Duty here: ${duty}` : duty)
    const indented = body
      .join('\n')
      .split('\n')
      .map((line) => `    ${line}`)
      .join('\n')
    return `${head}\n${indented}`
  })

  if (ctx.collabMode === 'structured') {
    const contactable = ctx.roster.filter((m) => m.contactable).map(teamMemberAddress)
    rows.push('')
    rows.push(
      contactable.length > 0
        ? `You may start a conversation with: ${contactable.join(', ')}.`
        : 'You may not start a conversation with anyone here; wait to be contacted.'
    )
    // Without this the topology reads as "I cannot reply", and a member handed
    // work by a lead it has no outgoing edge to concludes it cannot answer.
    rows.push(
      'You can ALWAYS reply to whoever messages you, whether or not they are ' +
        'listed above — `team_send` back to them is never blocked.'
    )
  }

  // Cross-machine guidance only when the team actually spans machines — keeps a
  // pure single-machine team's prompt lean.
  if (ctx.roster.some((m) => m.sameMachine === false)) {
    rows.push('')
    rows.push('### Working across machines')
    rows.push(
      '',
      '- Before dispatch, check `presence` on `team_read_board()`; skip or reassign `offline` teammates.',
      '- File paths do NOT cross machines, even for the same project. Publish a ref, not a bare local path;',
      '  teammates use `team_read_artifact(ref)` to fetch the file from its machine.'
    )
  }

  return rows
}

// ── IM front-desk bridge ──

/** Stable team responsibilities alongside the IM channel's delivery instructions. */
export function buildTeamImBridge(
  _im: { channel: string; displayName: string; chatType: 'direct' | 'group' },
  isLead: boolean
): string {
  const opening = isLead
    ? [
        '### Team replies',
        '',
        'You serve as the team’s front desk in this IM chat.',
        'Your job: be the single point of contact. Understand what they need, pull in',
        'the right specialist teammates via the team tools, gather their results, then',
        'reply to the person yourself.',
      ]
    : [
        '### Team replies',
        '',
        'People can address you directly in this IM chat, not just the team counter.',
        'Handle what is yours to handle and',
        'answer them yourself. You are still on the team, so bring in a teammate when',
        'the work is genuinely theirs — but do not route everything through the lead.',
      ]
  return [
    ...opening,
    '',
    '- If a teammate’s result is pending when you end, tell the person you are checking; answer when the result arrives.',
    '  Never invent or promise an unheard result on a teammate’s behalf.',
    '- Keep internal team chatter out of the reply: give the person the answer, not the coordination.',
  ].join('\n')
}

// ── Constraint layer ──

export function buildTeamConstraints(ctx: TeamPromptContext): string[] {
  return [buildTeamRules(ctx)]
}

function buildTeamRules(ctx: TeamPromptContext): string {
  const lines: string[] = ['### Team', '']

  if (ctx.collabMode === 'structured') {
    const contactable = ctx.roster.filter((m) => m.contactable).map(teamMemberAddress)
    lines.push(
      '- Topology boundary: contact only teammates allowed by the current work context.',
      `  Known standing contacts${contactable.length > 0 ? `: ${contactable.join(', ')}` : ': none listed here'}.`,
      '  Temporary collaborators inherit their creator’s contact limits; discover them on the board.',
      '  Reaching anyone else first is rejected by the team tools — do not try to',
      '  route around it. Replying is never restricted: anyone who can message you,',
      '  you can message back.',
      ''
    )
  }

  lines.push(
    // A preference, not a gate: `report_to_user(type:"escalation")` always reaches the
    // human. Which door to try first is the model's call, so it is stated here
    // rather than enforced by intercepting the call.
    ctx.escalationRouting === 'lead'
      ? '- Escalation preference: this office wants blockers taken to the team lead' +
          ' FIRST, with `team_send`. Call `report_to_user({type:"escalation", message:"Your question"})` only once' +
          ' the lead cannot resolve it, or when the decision is plainly the human’s' +
          ' to make. It always reaches the human, so use it sparingly.'
      : '- Escalation preference: take blockers straight to the human with' +
          ' `report_to_user({type:"escalation", message:"Your question"})`; no need to try the lead first.',
    '- No silent failure: send blockers or missing data to the requester with `team_send`; your own output is not delivery.',
    '- Claim completion only for results actually produced and verified; reference files and evidence.',
    '- No inference from silence: an open task or absent board entry does not prove work was not done. Ask the teammate.'
  )

  // Side-effect discipline (all members). A "not delivered" receipt means the
  // message did not reach the teammate — it does NOT mean an already-started
  // external action was undone. Re-running such actions can double-charge the user.
  lines.push(
    '- Side-effect safety: before repeating an external action with real-world',
    '  consequences (sending email/messages, placing orders, submitting forms,',
    '  making payments), reconcile with `team_read_board()` first. If the task is',
    '  already `done` or its result is recorded, do NOT run the action again. Treat',
    '  a "not delivered" reply as a COORDINATION failure to retry — never as a',
    '  signal to redo an action that may have already taken effect.'
  )

  if (ctx.selfIsLead) {
    lines.push(
      '- Dispatch to who is available: before assigning or messaging a teammate,',
      '  check their `presence` on `team_read_board()`. If a teammate is `offline`,',
      '  reassign the work to an available teammate, or hold the task (leave a note',
      '  on the board) — do not send it and sit waiting for a reply that cannot come.',
      '- If a teammate goes offline mid-run, you will be told promptly instead of',
      '  waiting out a long timeout. Reassign or hold their in-flight task; never',
      '  block the whole run on one unavailable teammate.',
      '- A turn-end notice may include short request and reply excerpts. Use them',
      '  before asking for the same result again. "No error" does not prove the',
      '  work is complete; assess the actual outcome and recorded evidence.',
      '  A manual stop is intentional: do not automatically restart or reassign',
      '  that work without explicit instructions.',
      '- To check what a teammate actually said and was told in this run — rather',
      '  than what it reported — read its record with `team_read_member(member)`',
      '  (newest page first; pass `before` for earlier ones). It shows messages,',
      '  not thinking or tool traces. Read only what the question needs.'
    )
  }

  return lines.join('\n')
}

// ── Restricted turn notice ──

/** Who the request a restricted turn serves came from. */
export type RestrictionRequester =
  | { origin: 'colleague'; member?: Pick<TeamPromptRosterEntry, 'memberName' | 'owner' | 'sameMachine'> }
  | { origin: 'guest' }

/**
 * What a turn serving a request from outside is told about its limits. Per turn,
 * so it opens the turn's message and never enters the system prompt (see the
 * INVARIANT on TeamPromptContext). Without it a digital human that finds a tool
 * missing reports a fault — a command tool that "hangs", hooks to repair —
 * instead of the setting it is, and nobody learns what to switch on.
 */
export function buildRestrictionNotice(requester: RestrictionRequester, withheld: readonly string[]): string {
  const setting = 'your owner\u2019s "What others can ask it to do" setting for you in this team'
  const lines = requester.origin === 'guest'
    ? [
        'This request comes from a guest in an IM chat your team answers, not from your owner.',
        `It may use only what both ${setting} and that chat\u2019s guest settings allow.`,
      ]
    : [
        `This request comes from ${describeColleague(requester.member)}.`,
        `It may use only what ${setting} allows.`,
      ]
  return [
    '[Limited permissions for this turn]',
    ...lines,
    ...(withheld.length > 0 ? ['Off for this request:', ...withheld.map((item) => `- ${item}`)] : []),
    'This is your owner\u2019s setting, not a fault. If the request needs something that is off, tell the ' +
      'requester which one, and that your owner can turn it on there. Do not guess at other causes, and do ' +
      'not ask anyone to change hooks or settings files.',
  ].join('\n')
}

function describeColleague(member: Pick<TeamPromptRosterEntry, 'memberName' | 'owner' | 'sameMachine'> | undefined): string {
  if (!member) return 'someone on another machine in this team'
  if (member.sameMachine !== false) return `${member.memberName}, passing on work that came from another machine`
  return member.owner
    ? `${member.memberName}, ${member.owner}\u2019s digital human on another machine`
    : `${member.memberName}, a teammate\u2019s digital human on another machine`
}
