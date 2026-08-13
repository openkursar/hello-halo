/**
 * Team prompt Entry + Constraint layers for team-channel turns.
 * Orchestration builds TeamPromptContext; app-chat renders it into the prompt.
 */

import type { CollabMode, EscalationRouting } from '../../../../shared/apps/team-types'

export interface TeamPromptRosterEntry {
  memberName: string
  role: string
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
  collabMode: CollabMode
  escalationRouting: EscalationRouting
  selfMemberName: string
  selfRole: string
  /** What YOU are responsible for in this team, written by your owner. */
  selfDuty?: string | null
  selfIsLead: boolean
  roster: TeamPromptRosterEntry[]
}

// ── Entry layer ──

export function buildTeamEntry(ctx: TeamPromptContext): string {
  const lines: string[] = [
    '## Team Session Context',
    '',
    `You are a member of the team "${ctx.teamName}".`,
    `Your role: ${ctx.selfRole || 'member'}.`,
    `Your member name (how teammates address you): ${ctx.selfMemberName}.`,
    ctx.selfIsLead ? 'You are the team LEAD.' : '',
    '',
    // The owner's own words about this member's part in this team. It layers on
    // top of the digital human's persona and applies ONLY inside team turns.
    ...(ctx.selfDuty && ctx.selfDuty.trim()
      ? ['### What you are responsible for here', '', ctx.selfDuty.trim(), '']
      : []),
    'This is a team-channel turn. The message below was delivered to you by the',
    'team runtime, not by a human user. Acting in this turn means coordinating',
    'with your teammates through the team tools. The message itself says who it',
    'came from and whether the sender is waiting on you.',
    '',
    '### Team Goal',
    '',
    ctx.goal,
    '',
    '### Roster',
    '',
    ...renderRoster(ctx),
    '',
    '### Communication',
    '',
    '- Your reply/result IS your final message this turn. Just state your answer',
    '  or conclusion as the last thing you write — the runtime delivers it back',
    '  to whoever messaged you automatically. You do NOT call any tool to reply.',
    '- Use `team_send(to, message)` to contact a teammate. The message becomes',
    '  the input of their next turn. Default is async (wait=false): you get a',
    '  message id now and their reply arrives later as a new turn. Use wait=true',
    '  only when you truly need just that one reply and nothing else to do.',
    '- Put large outputs in a file and share the file, not the text: publish it',
    '  with `team_post_finding(ref)` or attach it to your task as `resultRef`,',
    '  and teammates open it with `team_read_artifact(ref)`. A ref must name a',
    '  file inside your working directory, written relative to it (e.g.',
    '  "docs/design.md"); a file outside it cannot be shared this way. Publishing',
    '  checks the file on the spot, so a successful publish means teammates can',
    '  really read it — and a failure tells you what to fix. Never paste big',
    '  content into a message.',
    '- Use `team_read_board()` to reconcile shared state (tasks, findings,',
    '  roster, and the record of what has happened). Your own context may have',
    '  been compacted, and the board is where you recover facts from — but it is',
    '  a record of what was WRITTEN DOWN, not of everything that happened. What',
    '  is on it is reliable; what is missing from it proves nothing. Someone may',
    '  have finished the work and not recorded it. To find out whether something',
    '  happened, ask the person — never conclude it did not because the board is',
    '  silent.',
    '- Keep the record straight as you go: `team_post_task` / `team_update_task`',
    '  for work, `team_post_finding(...)` for an observation or artifact. In',
    '  particular, when you get an answer you were waiting on, update the task it',
    '  belongs to — otherwise the rest of the team cannot tell the answer arrived.',
    '  These are shared RECORDS, not how you reply.',
    '- Only when you need a HUMAN decision, call',
    '  `report(type:"escalation", content, choices?)`.',
  ]

  return lines.filter((l) => l !== '').join('\n')
}

function renderRoster(ctx: TeamPromptContext): string[] {
  if (ctx.roster.length === 0) {
    return ['(You are the only member listed.)']
  }
  const rows = ctx.roster.map((m) => {
    const tags = [m.isLead ? 'lead' : null].filter(Boolean).join(', ')
    // Owner label: a teammate on another machine is "brought by <person>";
    // same-machine teammates need no label (they are yours, on this machine).
    const ownership =
      m.sameMachine === false ? ` — ${m.owner ? `${m.owner}\u2019s digital human` : 'a teammate\u2019s digital human'}` : ''
    const head = `- ${m.memberName} — ${m.role || 'member'}${tags ? ` (${tags})` : ''}${ownership}`
    // Their owner's own description of what they do here — the basis for
    // deciding who to hand a piece of work to, so it is carried verbatim.
    const duty = m.duty?.trim()
    if (!duty) return head
    const indented = duty.split('\n').map((line) => `    ${line}`).join('\n')
    return `${head}\n${indented}`
  })

  if (ctx.collabMode === 'structured') {
    const contactable = ctx.roster.filter((m) => m.contactable).map((m) => m.memberName)
    rows.push('')
    rows.push(
      contactable.length > 0
        ? `You may directly contact: ${contactable.join(', ')}.`
        : 'You have no outgoing contacts in the team topology; wait to be contacted.'
    )
  }

  // Cross-machine guidance only when the team actually spans machines — keeps a
  // pure single-machine team's prompt lean.
  if (ctx.roster.some((m) => m.sameMachine === false)) {
    rows.push('')
    rows.push('### Working across machines')
    rows.push(
      '',
      '- Some teammates run on another person\u2019s machine. Their reachability can',
      '  change (a teammate\u2019s machine may go offline). Before you dispatch work,',
      '  call `team_read_board()` and check each teammate\u2019s `presence` — skip or',
      '  reassign anyone shown `offline` instead of waiting on them.',
      '- File paths do NOT cross machines. A path you write here is unreadable on a',
      '  teammate\u2019s machine (and vice versa) — even for the same project, whose',
      '  directory sits somewhere else on theirs. Never pass a bare local path',
      '  across machines and assume they can open it: publish the file as a ref',
      '  (see above) and let them read it with `team_read_artifact(ref)`, which',
      '  fetches it from wherever it lives.'
    )
  }

  return rows
}

// ── IM front-desk bridge ──

/**
 * Extra Entry fragment for a team LEAD serving an IM channel (a team-backed IM
 * instance). The base team Entry frames the turn as runtime-delivered; this
 * bridge overrides that for the IM case: the message is from a real person and
 * the lead's final message is delivered straight back to that person. The lead
 * stays the front desk — it delegates to specialists via team tools, gathers
 * their results (prefer `team_send(..., wait=true)` so results arrive within
 * this turn), then answers the person itself.
 */
export function buildTeamImBridge(im: { channel: string; displayName: string; chatType: 'direct' | 'group' }): string {
  return [
    '## You Are the Team\u2019s Front Desk (IM)',
    '',
    `This turn was started by a real person messaging your team over ${im.channel} ` +
      `(${im.chatType} chat, "${im.displayName}") — NOT by the team runtime.`,
    'Your job: be the single point of contact. Understand what they need, pull in',
    'the right specialist teammates via the team tools, gather their results, then',
    'reply to the person yourself.',
    '',
    '- Your final message in this turn is sent straight back to the person in this',
    '  chat. Answer them directly and conversationally — do NOT call any tool to reply.',
    '- To involve a specialist, use `team_send(to, message, wait=true)` so their',
    '  result comes back within this turn and you can fold it into your answer. Only',
    '  use wait=false for genuinely background work — async results do NOT auto-reach',
    '  this chat; if you promise a follow-up, you must deliver it via a later message.',
    '- Keep internal team chatter out of your reply. The person sees only what you',
    '  write back — give them the answer, not the coordination.',
  ].join('\n')
}

// ── Constraint layer ──

export function buildTeamConstraints(ctx: TeamPromptContext): string[] {
  return [buildTeamRules(ctx)]
}

function buildTeamRules(ctx: TeamPromptContext): string {
  const lines: string[] = ['## Team Rules', '']

  if (ctx.collabMode === 'structured') {
    const contactable = ctx.roster.filter((m) => m.contactable).map((m) => m.memberName)
    lines.push(
      '- Topology boundary: you may only contact the teammates listed as',
      `  contactable${contactable.length > 0 ? ` (${contactable.join(', ')})` : ''}.`,
      '  Attempts to contact anyone else are rejected by the team tools — do not',
      '  try to route around it.',
      ''
    )
  }

  lines.push(
    ctx.escalationRouting === 'lead'
      ? '- Escalation routing: a `report(type:"escalation")` is routed to the team' +
          ' lead first. The lead will try to resolve it and only involve the human' +
          ' if it cannot.'
      : '- Escalation routing: a `report(type:"escalation")` is routed directly to' +
          ' the human user for a decision.',
    '- No silent failure: if you are blocked, lack data, or cannot complete the',
    '  task, say so explicitly in your final message (describe the blocker), or',
    '  call `report(type:"escalation", ...)` if a human decision is required.',
    '  Never end the turn empty.',
    '- No fabricated completion: never claim a task is done unless you actually',
    '  produced and verified the result. If you wrote a file, reference its path;',
    '  do not invent outcomes you did not produce.',
    '- No inference from silence: a task still open, or a teammate with nothing',
    '  on the board, tells you what has been recorded — not what has been done.',
    '  If you need to know whether something happened, ask that teammate directly',
    '  instead of treating the gap as an answer.'
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
      '  block the whole run on one unavailable teammate.'
    )
  }

  return lines.join('\n')
}
