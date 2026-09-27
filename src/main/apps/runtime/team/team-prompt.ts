/**
 * Team prompt Entry + Constraint layers for team-channel turns.
 * Orchestration builds TeamPromptContext; app-chat renders it into the prompt.
 */

import type { CollabMode, EscalationRouting } from '../../../../shared/apps/team-types'

export interface TeamPromptRosterEntry {
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
    'came from.',
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
    '- Human conversations with your owner are private and do not notify the lead.',
    '- To answer a teammate, call `team_send(to, message)` directly. Send your',
    '  result to the requester; do not rely on your closing reply as a message.',
    '- When a team-work turn ends, the lead receives an independent notification',
    '  with a short request excerpt and at most 500 characters of the final reply,',
    '  regardless of who requested the work or whom you already messaged.',
    '- `team_send` hands the message over and returns; it does not wait. If they',
    '  answer, that arrives later as a new turn of yours. So dispatch what you',
    '  can, then carry on — do not idle waiting for a response inside this turn.',
    '- Put large outputs in a file and share the file, not the text: publish it',
    '  with `team_post_finding(ref)` or attach it to your task as `resultRef`,',
    '  and teammates open it with `team_read_artifact(ref)`. A ref must name a',
    '  file inside your working directory, written relative to it (e.g.',
    '  "docs/design.md"); a file outside it cannot be shared this way. Publishing',
    '  checks the file on the spot, so a successful publish means teammates can',
    '  really read it — and a failure tells you what to fix. Never paste big',
    '  content into a message.',
    '- A published name belongs to one member only. Your working directory is',
    '  your own, so the obvious name ("report.md") is the one a teammate is',
    '  publishing too — and one name over two files leaves nobody able to say',
    '  whose is whose. Name yours so it could only be yours. If a teammate got',
    '  there first, publishing is refused: rename the file and publish again.',
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
    '  These are shared RECORDS, not how you reply: writing to the board notifies',
    '  nobody. Recording a result and telling the person who asked are two',
    '  separate acts, and you usually owe both.',
    '- Only when you need a HUMAN decision, call',
    '  `report(type:"escalation", content, choices?)`.',
    '',
    '### Messages that arrive while you are working',
    '',
    // Two kinds of thing only belong here: how this channel WORKS (which the
    // model cannot infer from the message itself), and failure modes already
    // observed. Anything the model can work out from the roster — whose word
    // carries more weight, whether to obey — is deliberately absent: stating it
    // would freeze a judgment that depends on the situation.
    '- A message can reach you between tool calls, marked "arrived while you were',
    '  working". It is not part of the task you are doing and not the result of a',
    '  tool you called. Whoever sent it did not know what you were doing, and it',
    '  may already have been overtaken by what you have done since.',
    '- If it does not change what you are doing, keep working and do not stop to',
    '  comment on it.',
    '- If it asks for something you have already done, say so instead of doing it',
    '  again — repeating an action repeats its real effects.',
    '- If you do change course, deal with the work already in progress: finish it,',
    '  undo it, or say what state you left it in. Abandoning something half-done',
    '  without a word is the one option that is not acceptable.',
    '- Do not reply just to acknowledge. Reply when the sender is waiting on an',
    '  answer, or when what you decided changes things for them.',
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
    // Both are their owner's own words and both decide who gets a piece of
    // work, so both are carried verbatim: what the digital human is, and what
    // it is responsible for here. Labelled only when both are present — alone,
    // there is no ambiguity to resolve and a label is pure cost in a block that
    // rides in every teammate's every turn.
    const description = m.description?.trim()
    const duty = m.duty?.trim()
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
    const contactable = ctx.roster.filter((m) => m.contactable).map((m) => m.memberName)
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
 * Extra Entry fragment for the team member that fronts an IM channel (a
 * team-backed IM instance). The base team Entry frames the turn as
 * runtime-delivered; this bridge overrides that for the IM case: the message is
 * from a real person and this member's final message is delivered straight back
 * to that person — the one place a final message IS a delivery, because the IM
 * reply handle is attached to this turn.
 *
 * A teammate's answer can only arrive as a LATER turn, so a question that needs
 * someone else becomes two messages to the person — an acknowledgement now, the
 * answer when it lands.
 *
 * The bound member may be the lead or any teammate, and the two are addressed
 * differently: a lead is the team's counter and routes work; a teammate is
 * reachable in its own right and answers its own remit first. Both keep the
 * delivery rules identical.
 */
export function buildTeamImBridge(
  im: { channel: string; displayName: string; chatType: 'direct' | 'group' },
  isLead: boolean
): string {
  const opening = isLead
    ? [
        '## You Are the Team\u2019s Front Desk (IM)',
        '',
        `This turn was started by a real person messaging your team over ${im.channel} ` +
          `(${im.chatType} chat, "${im.displayName}") — NOT by the team runtime.`,
        'Your job: be the single point of contact. Understand what they need, pull in',
        'the right specialist teammates via the team tools, gather their results, then',
        'reply to the person yourself.',
      ]
    : [
        '## A Person Is Messaging You Directly (IM)',
        '',
        `This turn was started by a real person messaging YOU over ${im.channel} ` +
          `(${im.chatType} chat, "${im.displayName}") — NOT by the team runtime.`,
        'They came to you, not to the team counter: handle what is yours to handle and',
        'answer them yourself. You are still on the team, so bring in a teammate when',
        'the work is genuinely theirs — but do not route everything through the lead.',
      ]
  return [
    ...opening,
    '',
    '- Your final message in this turn is sent straight back to the person in this',
    '  chat. Answer them directly and conversationally — do NOT call any tool to',
    '  reply to THEM. (This is specific to this chat: your words still reach no',
    '  teammate, only this person.)',
    '- To involve a teammate, `team_send(to, message)`. Their answer cannot',
    '  arrive inside this turn — it comes back later as a new turn of yours. So',
    '  when you hand something over, tell the person now that you are checking, then',
    '  send them the answer when it lands. Two short messages, not one long silence.',
    '- Never promise something you have not got. If you have not heard back yet,',
    '  say you are still waiting — do not compose an answer on a teammate\u2019s',
    '  behalf.',
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
      '- Topology boundary: you may only START a conversation with the teammates',
      `  listed as contactable${contactable.length > 0 ? ` (${contactable.join(', ')})` : ''}.`,
      '  Reaching anyone else first is rejected by the team tools — do not try to',
      '  route around it. Replying is never restricted: anyone who can message you,',
      '  you can message back.',
      ''
    )
  }

  lines.push(
    // A preference, not a gate: `report(type:"escalation")` always reaches the
    // human. Which door to try first is the model's call, so it is stated here
    // rather than enforced by intercepting the call.
    ctx.escalationRouting === 'lead'
      ? '- Escalation preference: this office wants blockers taken to the team lead' +
          ' FIRST, with `team_send`. Call `report(type:"escalation", ...)` only once' +
          ' the lead cannot resolve it, or when the decision is plainly the human’s' +
          ' to make. It always reaches the human, so use it sparingly.'
      : '- Escalation preference: take blockers straight to the human with' +
          ' `report(type:"escalation", ...)`; no need to try the lead first.',
    '- No silent failure: if you are blocked, lack data, or cannot complete the',
    '  task, say so — and say it TO the teammate who is waiting, with `team_send`.',
    '  Describing the blocker only in your own output tells them nothing. If a',
    '  human decision is required, call `report(type:"escalation", ...)`.',
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
      '  block the whole run on one unavailable teammate.',
      '- A turn-end notice may include short request and reply excerpts. Use them',
      '  before asking for the same result again. "No error" does not prove the',
      '  work is complete; assess the actual outcome and recorded evidence.',
      '  A manual stop is intentional: do not automatically restart or reassign',
      '  that work without explicit instructions.'
    )
  }

  return lines.join('\n')
}
