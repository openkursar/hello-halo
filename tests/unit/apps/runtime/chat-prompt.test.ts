import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../../src/main/services/agent', async () => {
  const prompt = await import('../../../../src/main/services/agent/system-prompt')
  return { buildSystemPrompt: prompt.buildSystemPrompt, buildSystemPromptWithAIBrowser: prompt.buildSystemPromptWithAIBrowser }
})
vi.mock('../../../../src/main/services/tlon', () => ({
  getKBReferencesForApp: () => [{ id: 'kb-fixture', name: 'Support handbook', indexContent: 'handbook-document-marker' }],
}))
vi.mock('../../../../src/main/services/ai-browser', () => ({ AI_BROWSER_SYSTEM_PROMPT: 'browser-guide-marker' }))
vi.mock('../../../../src/main/services/api-ref', () => ({ HALO_API_USAGE_GUIDE: 'operate-halo-guide-marker' }))

import { buildDigitalHumanChatPrompt, type DigitalHumanChatPromptInput } from '../../../../src/main/apps/runtime/prompt/chat'
import { buildAppSystemPrompt } from '../../../../src/main/apps/runtime/prompt'
import { toEngineSystemPrompt, hostSystemPromptText } from '../../../../src/main/services/agent/system-prompt'
import { COLLABORATION_GUIDANCE as TEAM_TOOLSET_GUIDE } from '@hello-halo/agent-sdk/collaboration'
import type { TeamPromptContext } from '../../../../src/main/apps/runtime/team/team-prompt'

const spec = { type: 'automation' as const, name: 'Scout', system_prompt: 'Persona marker: support specialist with a calm voice.' }
const membership = { teamId: 'team-support', name: 'Support', role: 'Specialist', isLead: false, hostedElsewhere: false }
const im = { channel: 'wecom-bot', chatType: 'direct' as const, displayName: 'Owner', sessionId: 'bot:owner', senderIdentity: { id: 'owner-control', name: 'Owner' } }
const team: TeamPromptContext = {
  teamName: 'Support', goal: 'Resolve the customer question.\n## Full owner instructions\nPreserve every line.',
  collabMode: 'free', escalationRouting: 'lead', selfMemberName: 'Scout', selfRole: 'Specialist',
  selfDuty: 'Own-duty-marker: answer support requests.', selfIsLead: false, selfIsDisposable: false,
  roster: [
    { appId: 'app-scout', memberName: 'Scout', role: 'Specialist', duty: 'Own-duty-marker: answer support requests.', isLead: false, contactable: true },
    { appId: 'app-lead', memberName: 'Lead', role: 'Lead', duty: 'Lead-duty-marker', isLead: true, contactable: true },
  ],
  teamFolder: null, chatKey: null,
}
const base: DigitalHumanChatPromptInput = {
  appId: 'app-scout', appName: 'Scout', appSpec: spec as DigitalHumanChatPromptInput['appSpec'],
  memoryInstructions: '## Memory\nMemory-instructions-marker', userConfig: { region: 'config-region-marker' },
  workDir: '/tmp/prompt-workspace', standingTeams: [], includeAppId: true,
  usesAIBrowser: true, usesHaloApi: true,
}
const current = { teamId: membership.teamId, teamName: team.teamName, epochId: 'conversation-support', viaIm: false }

function ordered(prompt: string, markers: string[]): void {
  let previous = -1
  for (const marker of markers) {
    const index = prompt.indexOf(marker)
    expect(index, `missing or out of order: ${marker}`).toBeGreaterThan(previous)
    previous = index
  }
}

function once(prompt: string, marker: string): void {
  expect(prompt.split(marker), marker).toHaveLength(2)
}

const scenes = [
  { name: 'no-team native chat', input: { ...base, collaborationGuide: TEAM_TOOLSET_GUIDE } },
  { name: 'member own native chat', input: { ...base, standingTeams: [membership], collaborationGuide: TEAM_TOOLSET_GUIDE } },
  { name: 'member own IM chat', input: { ...base, standingTeams: [membership], imSession: im, ownerIds: ['owner-control'], collaborationGuide: TEAM_TOOLSET_GUIDE } },
  { name: 'standing-team member chat', input: { ...base, standingTeams: [membership], team: { context: team, conversation: current } } },
  { name: 'standing-team member IM chat', input: { ...base, standingTeams: [membership], imSession: im, ownerIds: ['owner-control'], team: { context: team, conversation: { ...current, viaIm: true } } } },
] satisfies Array<{ name: string; input: DigitalHumanChatPromptInput }>

describe('digital-human context composition', () => {
  it.each(scenes)('retains shared content once and in order in $name', ({ input }) => {
    const prompt = buildDigitalHumanChatPrompt(input)
    for (const marker of ['# Halo\n', spec.system_prompt, 'Memory-instructions-marker', 'config-region-marker', 'handbook-document-marker']) once(prompt, marker)
    ordered(prompt, ['# Halo\n', '## App Instructions', '## Memory', '## User Configuration', '## Digital human and place'])
    for (const marker of ['browser-guide-marker', 'operate-halo-guide-marker']) once(prompt, marker)
    expect(prompt).not.toContain('## AI Terminal')
    expect(prompt).toContain('Your role, voice and duties come from App Instructions.')
    expect(prompt).not.toContain('Current identity')
    expect(prompt).not.toContain('Team Session Context')
    if (input.standingTeams?.length) ordered(prompt, ['## Digital human and place', '## Teams\n', '## Channel'])
    else {
      expect(prompt).not.toContain('## Teams\n')
      expect(prompt).not.toContain('You do not belong to a standing team.')
    }
    if (input.team) {
      ordered(prompt, ['## Teams\n', '## Team work', '## Team communication', '## Channel', '## Rules'])
      once(prompt, 'Own-duty-marker')
      expect(prompt).toContain('> ## Full owner instructions\n> Preserve every line.')
      expect(prompt).toContain('Lead-duty-marker')
      expect(prompt).not.toMatch(/^## Full owner instructions$/m)
    } else expect(prompt).not.toContain('## Team work')
    if (input.collaborationGuide) once(prompt, TEAM_TOOLSET_GUIDE)
  })

  it.each(scenes)('hands the identical Halo context to every engine in $name', ({ input }) => {
    const prompt = buildDigitalHumanChatPrompt(input)
    for (const engine of ['halo', 'anthropic', 'codex', 'dsh'] as const) {
      expect(hostSystemPromptText(toEngineSystemPrompt(prompt, engine))).toBe(prompt)
      expect(toEngineSystemPrompt(prompt, engine)).toEqual({ type: 'preset', preset: 'default', append: prompt })
    }
  })

  it('keeps withheld membership distinct from a verified empty list for an IM guest', () => {
    const prompt = buildDigitalHumanChatPrompt({ ...base, usesHaloApi: false, standingTeams: undefined, includeAppId: false,
      imSession: { ...im, senderIdentity: { id: 'guest-control', name: 'Guest' } }, ownerIds: ['owner-control'] })
    expect(prompt).toContain('This sender is a guest.')
    expect(prompt).toContain('## Digital human and place')
    for (const marker of ['app-scout', membership.teamId, '## Teams\n', 'operate-halo-guide-marker', 'You do not belong to a standing team']) expect(prompt).not.toContain(marker)
  })

  it('does not invent App Instructions or file delivery for unavailable capabilities', () => {
    const prompt = buildDigitalHumanChatPrompt({ ...base, appSpec: { ...spec, system_prompt: '' } as DigitalHumanChatPromptInput['appSpec'], imSession: im,
      usesAIBrowser: false, usesHaloApi: false })
    for (const marker of ['App Instructions', 'browser-guide-marker', 'terminal-guide-marker', 'operate-halo-guide-marker', 'send_file_to_chat']) expect(prompt).not.toContain(marker)
    expect(prompt).not.toContain('You are Halo,')
    expect(prompt).toContain('You run in Halo.')
    const available = buildDigitalHumanChatPrompt({ ...base, imSession: im, notifications: { channelsConfigured: false, notifyBotAvailable: false, fileSendAvailable: true } })
    expect(available).toContain('send_file_to_chat')
  })

  it('gives a temporary collaborator a work identity without permanent membership or memory', () => {
    const prompt = buildDigitalHumanChatPrompt({ ...base, memoryInstructions: '', standingTeams: undefined, usesHaloApi: false,
      team: { context: { ...team, temporaryCollaboration: true, selfIsDisposable: true }, conversation: { ...current, temporary: true } } })
    expect(prompt).toContain('## Collaborator and place')
    expect(prompt).toContain('a temporary collaborator in Halo')
    expect(prompt).toContain('## Team work')
    for (const marker of ['a digital human in Halo', '## Teams\n', 'Memory-instructions-marker', 'operate-halo-guide-marker']) expect(prompt).not.toContain(marker)
  })

  it('keeps scheduled work out of chat and standing-team context', () => {
    const prompt = buildAppSystemPrompt({ appId: base.appId, appSpec: spec as Parameters<typeof buildAppSystemPrompt>[0]['appSpec'],
      memoryInstructions: base.memoryInstructions, workDir: base.workDir, triggerContext: 'Scheduled fixture' })
    ordered(prompt, ['## App Instructions', '## Memory', '## Digital human and place', '## Automation Mode', '## Reporting'])
    expect(prompt).toContain('running a scheduled or triggered task')
    once(prompt, '## Digital human and place')
    for (const marker of ['## Teams\n', '## Channel', TEAM_TOOLSET_GUIDE, 'chatting with the person']) expect(prompt).not.toContain(marker)
  })
})
