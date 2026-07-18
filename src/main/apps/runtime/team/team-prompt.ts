/**
 * Team prompt Entry + Constraint layers for team-channel turns.
 * Orchestration builds TeamPromptContext; app-chat renders it into the prompt.
 */

import type { CollabMode, EscalationRouting } from '../../../../shared/apps/team-types'

export interface TeamPromptRosterEntry {
  memberName: string
  role: string
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

export interface TeamPromptContext {
  teamName: string
  goal: string
  collabMode: CollabMode
  escalationRouting: EscalationRouting
  selfMemberName: string
  selfRole: string
  selfIsLead: boolean
  roster: TeamPromptRosterEntry[]
  source: {
    fromMemberName: string | null
    expectsReply: boolean
  }
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
    'This is a team-channel turn. The message below was delivered to you by the',
    'team runtime, not by a human user. Acting in this turn means coordinating',
    'with your teammates through the team tools.',
    '',
    '### Where this message came from',
    '',
    ctx.source.fromMemberName
      ? `This turn was started by "${ctx.source.fromMemberName}".`
      : 'This turn was started by the team runtime (a run/start signal).',
    ctx.source.expectsReply
      ? 'The sender is waiting for your reply — finish the requested work; your ' +
        'final message in this turn is automatically delivered back to them.'
      : 'When you finish, your final message is automatically delivered back to ' +
        'whoever messaged you. Just answer normally — you do NOT need any tool to reply.',
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
    '- Put large outputs on disk and pass the file PATH on the board / in the',
    '  message — never paste big content into a message.',
    '- Use `team_read_board()` to reconcile shared state (tasks, findings,',
    '  roster). Trust the board over your own memory — your context may have',
    '  been compacted. Use `team_post_task` / `team_update_task` to record work',
    '  and `team_post_finding(...)` to share an observation/artifact — these are',
    '  shared RECORDS, not how you reply.',
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
    return `- ${m.memberName} — ${m.role || 'member'}${tags ? ` (${tags})` : ''}${ownership}`
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
      '  teammate\u2019s machine (and vice versa). To hand a file to a teammate on',
      '  another machine, publish it with `team_post_finding(ref, content)` (or set',
      '  a task\u2019s `resultRef`) and let them read it with `team_read_artifact(ref)`.',
      '  Never pass a bare local path across machines and assume they can open it.',
      '- When you receive a deliverable from a teammate, read it with',
      '  `team_read_artifact(ref)` — it fetches the file wherever it lives.'
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
    "  do not invent outcomes you did not produce."
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
