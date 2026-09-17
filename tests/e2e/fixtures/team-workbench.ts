import type { ElectronApplication, Page } from '@playwright/test'
import { waitForHomePage, navigateToApps } from './helpers'

interface WorkbenchFixtureOptions {
  ownCount?: number
  withDecision?: boolean
  historyFailure?: boolean
  readonlyKind?: 'im' | 'run'
  allowCreate?: boolean
  sendFailure?: boolean
  sendFailureDelay?: number
  timestampAnomalies?: boolean
  provenanceMessages?: boolean
  collaborationJourney?: boolean
  remoteDecision?: boolean
}

/** Deterministic IPC boundary fixture; all rendering and interaction use the built app. */
export async function openTeamWorkbench(app: ElectronApplication, page: Page, options: WorkbenchFixtureOptions = {}) {
  await waitForHomePage(page)
  await app.evaluate(({ ipcMain }, { ownCount: count = 2, withDecision: decision, historyFailure, readonlyKind, allowCreate, sendFailure, sendFailureDelay = 500, timestampAnomalies, provenanceMessages, collaborationJourney, remoteDecision }) => {
    const now = Date.now() - 60_000
    const roster = [
      { appId: 'lead', memberName: 'Lead', sameMachine: count > 0, isLead: true },
      { appId: 'research', memberName: 'Research', sameMachine: count > 1, isLead: false },
      { appId: 'remote', memberName: 'Remote Analyst', sameMachine: false, isLead: false },
    ].map(member => ({
      ...member,
      spaceId: 'halo-temp', role: 'Analyst', status: remoteDecision && member.appId === 'remote' ? 'waiting_user' : 'idle', presence: 'online', busy: [],
      ...(member.sameMachine ? {} : { owner: member.appId === 'remote' ? 'Taylor' : 'Teammate' }),
    }))
    const members = roster.map(member => ({ ...member, id: member.appId, teamId: 'render-team', origin: member.sameMachine ? 'local' : 'remote', ownerNodeId: member.sameMachine ? 'self' : 'remote-node' }))
    const team = { id: 'render-team', name: 'Workbench review', goal: 'A focused task workspace', status: 'idle', leadAppId: 'lead', owningSpaceId: 'halo-temp', hostNodeId: null, currentEpochId: null, collabMode: 'mesh' }
    const tasks = ['Product research', 'Release notes'].map((label, index) => ({ epochId: `epoch-${index}`, workItemId: `work-${index}`, teamId: team.id, kind: 'native', label, readonly: false, startedAt: now, lastActivityAt: now + index, createdByMe: true, involvedMe: true, completed: false }))
    if (remoteDecision) Object.assign(tasks[0], { waitingUser: true, waitingForMe: false, waitingMemberAppIds: ['remote'] })
    if (readonlyKind) Object.assign(tasks[0], { kind: readonlyKind, readonly: true, memberAppId: 'lead' })
    const activities = [
      ...Array.from({ length: 100 }, (_, index) => ({ id: `coord-${index}`, epochId: 'epoch-0', actorAppId: 'research', targetAppId: 'lead', subject: `Research update ${index + 1}`, body: `Evidence from source ${index + 1}. Ready for review.`, kind: 'message', status: 'sent', createdAt: now + index * 100 })),
      { id: 'unrelated', epochId: 'epoch-0', actorAppId: 'remote', targetAppId: 'research', subject: 'Unrelated coordination record', body: 'This must stay out of the Lead conversation.', kind: 'message', status: 'sent', createdAt: now + 11000 },
      { id: 'other-task', epochId: 'epoch-1', actorAppId: 'remote', targetAppId: 'lead', subject: 'Release notes coordination', body: 'Only visible in the second task.', kind: 'message', status: 'sent', createdAt: now + 12000 },
      ...(remoteDecision ? [{ id: 'decision-request:remote-1', epochId: 'epoch-0', actorAppId: 'remote', targetAppId: null, subject: 'Approve the evidence?', body: 'Should Taylor approve the collected evidence before publication?', kind: 'decision', status: 'escalation', createdAt: now + 13000, refId: 'remote-1' }] : []),
    ].map(activity => ({ ...activity, teamId: team.id, refId: 'refId' in activity ? activity.refId : null }))
    if (timestampAnomalies) {
      const timestamps: Array<{ id: string; value?: unknown }> = [
        { id: 'iso', value: new Date(now).toISOString() },
        { id: 'milliseconds', value: now + 1000 },
        { id: 'invalid', value: 'not-a-timestamp' },
        { id: 'missing' },
        { id: 'null', value: null },
        { id: 'overflow', value: 9e15 },
        { id: 'underflow', value: -9e15 },
      ]
      activities.splice(0, activities.length, ...timestamps.map(({ id, value }) => Object.assign({}, activities[0], {
        id: `timestamp-${id}`, subject: `Timestamp case ${id}`, body: `Preserved collaboration content: ${id}`,
        createdAt: value,
      })))
    }
    const work = [
      { id: 'work-open', teamId: team.id, epochId: 'epoch-0', title: 'Compare product capabilities', status: 'in_progress', assigneeAppId: 'research', note: 'Reviewing source evidence', createdAt: now, updatedAt: now },
      { id: 'work-done', teamId: team.id, epochId: 'epoch-0', title: 'Collect product documentation', status: 'done', assigneeAppId: 'remote', note: '', createdAt: now, updatedAt: now },
    ]
    const findings = [{ id: 'finding-1', teamId: team.id, epochId: 'epoch-0', appId: 'research', ref: 'research-notes.md', content: 'Evidence and source links', createdAt: now }]
    const detail = { team, members, roster, edges: [], tasks: work, findings, activities, pendingEscalations: decision ? [{ entryId: 'decision-1', epochId: 'epoch-0', appId: 'lead', memberName: 'Lead', question: 'Approve the research scope?', entry: { id: 'decision-1', appId: 'lead', type: 'escalation', ts: now, content: { question: 'Approve the research scope?', choices: ['Approve scope', 'Revise scope'] } } }] : [], checks: [] }
    const apps = roster.filter(member => member.sameMachine).map(member => ({ id: member.appId, spaceId: 'halo-temp', status: 'active', permissions: { granted: [], denied: [] }, installedAt: now, userConfig: {}, spec: { name: member.memberName, type: 'automation', version: '1.0.0', description: 'Renderer fixture', system_prompt: 'Fixture', subscription: [], config_schema: [] } }))
    const bind = (channel: string, handler: (...args: any[]) => unknown) => {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, (_event, ...args) => handler(...args))
    }
    bind('app:list', () => ({ success: true, data: apps }))
    bind('team:list', () => ({ success: true, data: [{ ...team, memberCount: roster.length, hasWaitingUser: false, updatedAt: now, localMembers: roster.filter(member => member.sameMachine) }] }))
    bind('team:get-detail', () => ({ success: true, data: detail }))
    bind('team:list-conversations', () => ({ success: true, data: tasks }))
    bind('team:list-epochs', () => ({ success: true, data: [] }))
    bind('team:epoch-board', ({ epochId }) => ({ success: true, data: { epoch: { id: epochId, teamId: team.id }, members, tasks: work.filter(row => row.epochId === epochId), findings: findings.filter(row => row.epochId === epochId), activities: activities.filter(row => row.epochId === epochId) } }))
    bind('team:epoch-artifacts', ({ epochId }) => ({ success: true, data: epochId === 'epoch-0' ? [{ memberName: 'Research', artifacts: [{ name: 'research-notes.md', path: '/tmp/halo-render-fixture/research-notes.md' }] }] : [] }))
    let researchEngaged = false
    bind('team:chat-messages', ({ appId, epochId }) => {
      if (historyFailure && epochId === 'epoch-0' && appId === 'lead') { historyFailure = false; return { success: false, error: 'Fixture history unavailable' } }
      if (collaborationJourney && appId === 'research' && epochId === 'epoch-0') return { success: true, data: [
        { id: 'research-request', role: 'user', content: '[Team message from Lead] Investigate the product.', timestamp: new Date(now).toISOString(), metadata: { teamTriggerKind: 'message', correlationId: 'journey-request' } },
        { id: 'research-internal', role: 'assistant', content: 'Research completed before any human contacted me.', timestamp: new Date(now + 1000).toISOString(), metadata: { teamTriggerKind: 'message' } },
        ...(researchEngaged ? [
          { id: 'research-human', role: 'user', content: 'Explain your findings to me.', timestamp: new Date(now + 18000).toISOString(), metadata: { teamTriggerKind: 'human_message' } },
          { id: 'research-human-answer', role: 'assistant', content: 'Here is the explanation you requested.', timestamp: new Date(now + 19000).toISOString(), metadata: { teamTriggerKind: 'human_message' } },
          { id: 'research-system', role: 'user', content: '[System] Source validation finished.', timestamp: new Date(now + 20000).toISOString(), metadata: { teamTriggerKind: 'member_stopped' } },
          { id: 'research-followup', role: 'assistant', content: 'I have also validated those findings for you.', timestamp: new Date(now + 21000).toISOString(), metadata: { teamTriggerKind: 'member_stopped' } },
        ] : []),
      ] }
      return { success: true, data: appId === 'lead' && epochId === 'epoch-0' ? [
      { id: 'human-1', role: 'user', content: 'Please research this product.', timestamp: new Date(now - 2000).toISOString(), metadata: { teamTriggerKind: 'human_message' } },
      { id: 'assistant-1', role: 'assistant', content: 'I will coordinate the research.', timestamp: new Date(now - 1000).toISOString(), metadata: { teamTriggerKind: 'human_message' } },
      ...(collaborationJourney ? [
        { id: 'lead-reply-input', role: 'user', content: '[Team message from Research] The investigation is complete.', timestamp: new Date(now + 12000).toISOString(), metadata: { teamTriggerKind: 'message', correlationId: 'journey-reply' } },
        { id: 'lead-final', role: 'assistant', content: 'Final research conclusion after consulting Research.', timestamp: new Date(now + 12500).toISOString(), metadata: { teamTriggerKind: 'message' } },
      ] : []),
      ...(provenanceMessages ? [
        { id: 'stopped-system', role: 'user', content: '[System] A teammate stopped its work. Internal notification.', timestamp: new Date(now + 13000).toISOString(), metadata: { teamTriggerKind: 'member_stopped' } },
        { id: 'stopped-report', role: 'assistant', content: 'Internal response to the teammate stopping.', timestamp: new Date(now + 14000).toISOString() },
        { id: 'human-system-quote', role: 'user', content: '[System] This is my literal message, not a system event.', timestamp: new Date(now + 15000).toISOString(), metadata: { teamTriggerKind: 'human_message' } },
        { id: 'human-legacy-quote', role: 'user', content: '[System] This older human message has no origin metadata.', timestamp: new Date(now + 16000).toISOString() },
        { id: 'human-quote-answer', role: 'assistant', content: 'Your literal message is preserved.', timestamp: new Date(now + 17000).toISOString() },
      ] : []),
    ] : [] }
    })
    bind('app:chat-session-state', () => ({ success: true, data: null }))
    bind('app:respond-escalation', () => { detail.pendingEscalations = []; return { success: true } })
    bind('app:chat-status', () => ({ success: true, data: { isGenerating: false } }))
    bind('team:open-conversation', ({ title, memberAppId }) => {
      if (!allowCreate || memberAppId) throw new Error('Changing members must not create a conversation')
      const epochId = `created-${tasks.length}`
      tasks.push({ ...tasks[1], epochId, workItemId: epochId, label: title, lastActivityAt: Date.now() })
      return { success: true, data: { epochId } }
    })
    bind('team:rename-conversation', ({ epochId, title }) => {
      const task = tasks.find(item => item.epochId === epochId)
      if (!task) return { success: false, error: 'Unknown fixture task' }
      task.label = title
      return { success: true }
    })
    bind('app:chat-send', async ({ conversationId, appId }) => {
      if (collaborationJourney && appId === 'research') researchEngaged = true
      if (sendFailure) {
        sendFailure = false
        await new Promise(resolve => setTimeout(resolve, sendFailureDelay))
        return { success: false, error: 'Fixture send rejected' }
      }
      return { success: true, data: { conversationId } }
    })
  }, options)
  await page.evaluate(() => {
    localStorage.setItem('halo-locale', 'en')
    const preferences = JSON.parse(localStorage.getItem('halo-team-view-prefs') || '{"state":{}}')
    preferences.state = {
      ...preferences.state,
      defaultMemberByTeam: { ...preferences.state?.defaultMemberByTeam, 'render-team': 'lead' },
      memberByTask: { ...preferences.state?.memberByTask, 'render-team': {} },
      taskByTeam: { ...preferences.state?.taskByTeam, 'render-team': null },
    }
    localStorage.setItem('halo-team-view-prefs', JSON.stringify(preferences))
  })
  await page.reload()
  await navigateToApps(page)
  await page.getByRole('button', { name: /^Teams\b|^团队/ }).click()
  await page.getByRole('button', { name: /Workbench review/ }).click()
  await page.setViewportSize({ width: 1440, height: 1000 })
  const sidebar = page.getByRole('navigation', { name: 'Tasks', exact: true })
  if (options.readonlyKind) await sidebar.getByRole('searchbox', { name: 'Search tasks' }).fill('Product research')
  await sidebar.getByRole('button', { name: /Product research/ }).click()
  if (options.ownCount !== 0 && !options.historyFailure) await page.getByRole('region', { name: 'Task room' }).getByText('Please research this product.', { exact: true }).waitFor()
}
