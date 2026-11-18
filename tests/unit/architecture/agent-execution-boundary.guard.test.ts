/**
 * Who owns an agent's delegated work.
 *
 * `services/agent/execution` owns when an execution may finish, the input that
 * reaches it, its stop order and its cost; the team runtime supplies the work it
 * delegates through the `app-bridge` seam. An entry opens an execution and
 * describes its context — it never waits for, stops, feeds or counts collaborators,
 * and never binds a collaboration endpoint itself.
 */

import { describe, it, expect } from 'vitest'
import { dirname, resolve } from 'path'
import { listSourceFiles, readSource, REPO_ROOT } from './lib/source-scan'

const importsOf = (file: string): string[] =>
  [...readSource(file).matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/g)].map(match => match[1])

const resolved = (file: string, specifier: string): string | null =>
  specifier.startsWith('.') ? resolve(dirname(resolve(REPO_ROOT, file)), specifier) : null

const codeOf = (file: string) => readSource(file).split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n')

const APPS = resolve(REPO_ROOT, 'src/main/apps')
const hostModules = ['team/tool-session', 'team/run-work', 'team/chat-work', 'team/execution-work', 'team/conversation-work', 'team/source-delivery', 'team/participant-source']

/** Every place an agent session is given collaboration tools. */
const ENTRIES = [
  'src/main/apps/runtime/execute.ts',
  'src/main/apps/runtime/app-chat.ts',
]

describe('agent execution boundary', () => {
  it('the execution layer reaches the application layer only through the bridge', () => {
    for (const file of listSourceFiles('src/main/services/agent/execution')) {
      for (const specifier of importsOf(file)) {
        const target = resolved(file, specifier)
        expect(target !== null && target.startsWith(APPS), `${file} imports ${specifier}`).toBe(false)
        expect(specifier, `${file} reaches into the team runtime`).not.toMatch(/\/team(\/|$)/)
      }
    }
  })

  it('nothing in services/agent imports an application value', () => {
    const offenders: string[] = []
    for (const file of listSourceFiles('src/main/services/agent')) {
      const source = readSource(file)
      for (const match of source.matchAll(/(?:^|\n)\s*import\s+(type\s+)?[^'"]*?from\s+['"]([^'"]+)['"]/g)) {
        const target = resolved(file, match[2])
        if (!match[1] && target?.startsWith(APPS)) offenders.push(`${file}: ${match[2]}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('every entry that gives a session collaboration tools gets them from an execution', () => {
    for (const file of ENTRIES) {
      expect(codeOf(file), `${file} does not open an agent execution`).toMatch(/\bopenAgentExecution\(/)
    }
    // The capability broker mounts a space conversation's server for the session's
    // lifetime; that server has no execution of its own.
    expect(codeOf('src/main/apps/runtime/index.ts')).not.toMatch(/\bopenAgentExecution\(/)
    expect(codeOf('src/main/apps/runtime/index.ts')).toMatch(/createSpaceTeamMcpServer\(scope\)/)
  })

  it('entries hold no collaboration lifecycle: no endpoints, waiting, stopping, engine stops or usage of delegated work', () => {
    const forbidden = /\b(bindSourceToolSession|bindTeamToolSession|bindImCollaborationSource|deliverRunCollaborationSource|createExecutionWorkHost|openRunWork|openConversationWork|openMemberWork|createSpaceTeamMcpServer|hasPendingWork|onWorkChanged|stopSource|releaseRunSource|waitForContinuation|takeUsage|stopEngineOnAbort|createEngineStop)\b/
    const entries = [
      ...ENTRIES,
      'src/main/services/agent/send-message.ts',
      'src/main/services/agent/session-manager.ts',
      'src/main/services/agent/session-consumer.ts',
    ]
    for (const file of entries) {
      expect(codeOf(file).match(forbidden)?.[0], `${file} manages delegated work itself`).toBeUndefined()
    }
  })

  it('an automation run knows nothing of the team runtime', () => {
    for (const specifier of importsOf('src/main/apps/runtime/execute.ts')) {
      expect(specifier, 'execute.ts must reach delegated work through its execution').not.toMatch(/(^|\/)team(\/|$)|run-work|run-collaboration/)
    }
    expect(readSource('src/main/apps/runtime/execute.ts')).not.toMatch(/\b(getTeamService|getActiveTeamRuntime|getTeamStore|participants|beginRequest)\b/)
  })

  it('a digital human’s chat reaches collaboration only through its execution', () => {
    const chatImports = importsOf('src/main/apps/runtime/app-chat.ts')
    expect(chatImports.filter(specifier => hostModules.some(module => specifier.endsWith(module)))).toEqual([])
  })

  it('only the team runtime and the runtime registration touch the host modules', () => {
    const allowed = (file: string) => file.startsWith('src/main/apps/runtime/team/') || file === 'src/main/apps/runtime/index.ts'
    for (const file of listSourceFiles('src/main')) {
      for (const specifier of importsOf(file)) {
        if (!hostModules.some(module => specifier.endsWith(module))) continue
        expect(allowed(file), `${file} imports ${specifier}`).toBe(true)
      }
    }
  })

  it('a conversation’s stop and admission are bound by the agent service, not by an application module listening to it', () => {
    for (const file of listSourceFiles('src/main/apps')) {
      expect(codeOf(file), `${file} listens to the agent service's conversation boundary itself`).not.toMatch(/\bonUserStop\b|\bonHumanRequest\b/)
    }
    const lifecycle = readSource('src/main/services/agent/execution/conversation-lifecycle.ts')
    expect(lifecycle).toMatch(/onUserStop\(conversationId => \{/)
    expect(lifecycle).toMatch(/onHumanRequest\(event =>/)
    expect(lifecycle).toMatch(/bindConversationLifecycle\(host: ConversationWorkHost\)/)
    expect(readSource('src/main/apps/runtime/team/conversation-work.ts')).toContain('createConversationWorkHost')
    expect(readSource('src/main/bootstrap/extended.ts')).toMatch(/bindConversationLifecycle\(createConversationWorkHost\(\)\)/)
  })

  it('the work host is registered once, on the bridge', () => {
    const registration = readSource('src/main/apps/runtime/index.ts')
    expect(registration.match(/executionWork:\s*createExecutionWorkHost\(/g)).toHaveLength(1)
    expect(readSource('src/main/services/app-bridge.ts')).toMatch(/executionWork\?:\s*ExecutionWorkHost/)
    expect(readSource('src/main/services/app-bridge.ts')).not.toContain('conversationWork')
  })
})
