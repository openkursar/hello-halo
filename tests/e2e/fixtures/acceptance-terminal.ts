import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { Thought } from '../../../src/shared/types/transcript'
import { test as base, expect, readAcceptanceConversation } from './acceptance-app'
import { navigateToWorkspaces } from './helpers'

interface CommandEnvironment { name: string; value: string }
interface CommandWorkspace { id: string; path: string; workingDir: string; name: string }

export const test = base.extend<{ commandEnvironment: CommandEnvironment }>({
  commandEnvironment: [async ({}, use) => {
    const name = 'ACCEPTANCE_COMMAND_MARKER'
    const value = randomUUID()
    const keys = [name, 'BASH_ENV', 'ENV', 'ZDOTDIR', ...(process.platform === 'darwin' ? ['SHELL'] : [])]
    const previous = new Map(keys.map(key => [key, process.env[key]]))
    process.env[name] = value
    for (const key of ['BASH_ENV', 'ENV', 'ZDOTDIR']) delete process.env[key]
    if (process.platform === 'darwin') process.env.SHELL = '/bin/bash'
    try { await use({ name, value }) }
    finally {
      for (const [key, original] of previous) {
        if (original === undefined) delete process.env[key]
        else process.env[key] = original
      }
    }
  }, { auto: true }],
})

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export function commandScript(directory: string, name: string, program: string): string {
  mkdirSync(directory, { recursive: true })
  const file = join(directory, `${name}.cjs`)
  writeFileSync(file, program)
  const shellPath = (value: string) => process.platform === 'win32' ? value.replaceAll('\\', '/') : value
  return `${shellQuote(shellPath(process.execPath))} ${shellQuote(shellPath(file))}`
}

export async function commandWorkspace(page: Page, profile: string, name: string): Promise<CommandWorkspace> {
  const workingDir = join(profile, `${name} project files`)
  mkdirSync(workingDir, { recursive: true })
  const result = await page.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.createSpace(input), { name, icon: 'folder', customPath: workingDir })
  expect(result.success, 'Command preconditions require a real registered workspace').toBe(true)
  const space = result.data as CommandWorkspace
  expect(space.workingDir).toBe(workingDir)
  return space
}

export async function openCommandWorkspace(page: Page, space: CommandWorkspace): Promise<void> {
  await navigateToWorkspaces(page)
  await page.getByRole('heading', { name: space.name, level: 3, exact: true }).click()
  await expect(page.locator('textarea').first()).toBeVisible()
}

export async function commandThoughts(page: Page, spaceId: string, conversationId: string): Promise<Thought[]> {
  const conversation = await readAcceptanceConversation(page, spaceId, conversationId)
  const assistant = conversation.messages.findLast(message => message.role === 'assistant')
  expect(assistant, 'The completed command turn must persist an assistant message').toBeTruthy()
  const result = await page.evaluate(({ spaceId, conversationId, messageId }) => (window as unknown as { halo: HaloAPI }).halo.getMessageThoughts(spaceId, conversationId, messageId), { spaceId, conversationId, messageId: assistant!.id })
  expect(result.success).toBe(true)
  return (result.data as Thought[]).filter(thought => thought.type === 'tool_use' && thought.toolName?.endsWith('Bash'))
}

export async function waitForCommandIdleAfterStop(page: Page, turn: { spaceId: string; conversationId: string }): Promise<void> {
  await expect.poll(() => page.evaluate(async turn => {
    const state = window as unknown as { halo: HaloAPI; acceptanceProbe: { errors: unknown[] } }
    const session = await state.halo.getSessionState(turn.conversationId)
    if (!session.success) throw new Error('Could not inspect the real command session')
    const expected = { type: 'error', errorType: 'interrupted', error: 'Stopped by user.', ...turn }
    const errors = state.acceptanceProbe.errors
    const cancellationOnly = errors.length === 1 && typeof errors[0] === 'object' && errors[0] !== null &&
      Object.keys(errors[0]).length === Object.keys(expected).length &&
      Object.entries(expected).every(([key, value]) => (errors[0] as Record<string, unknown>)[key] === value)
    return { active: (session.data as { isActive: boolean }).isActive, unexpectedErrors: cancellationOnly ? [] : errors }
  }, turn), { timeout: 30000 }).toEqual({ active: false, unexpectedErrors: [] })
  await expect(page.getByTitle('Stop generation (Esc)', { exact: true })).toHaveCount(0)
}

export function ownedCommandTree(profile: string) {
  const directory = join(profile, `owned-command-${randomUUID()}`)
  mkdirSync(directory)
  const tag = randomUUID()
  const parentFile = join(directory, 'parent.json'), childFile = join(directory, 'child.json')
  const parentScript = join(directory, 'parent.cjs'), childScript = join(directory, 'child.cjs')
  const receipt = (file: string) => `fs.writeFileSync(${JSON.stringify(file + '.tmp')},JSON.stringify({pid:process.pid,tag:${JSON.stringify(tag)}}));fs.renameSync(${JSON.stringify(file + '.tmp')},${JSON.stringify(file)});`
  writeFileSync(childScript, `const fs=require('node:fs');${receipt(childFile)}setInterval(()=>{},1000);setTimeout(()=>process.exit(0),60000);`)
  const command = commandScript(directory, 'parent', `const fs=require('node:fs');const {spawn}=require('node:child_process');spawn(process.execPath,[${JSON.stringify(childScript)},${JSON.stringify(tag)}],{stdio:'ignore'});${receipt(parentFile)}setInterval(()=>{},1000);setTimeout(()=>process.exit(0),60000);`)
  const records = () => [
    { file: parentFile, script: parentScript }, { file: childFile, script: childScript },
  ].flatMap(({ file, script }) => {
    if (!existsSync(file)) return []
    const record = JSON.parse(readFileSync(file, 'utf8')) as { pid: number; tag: string }
    if (record.tag !== tag || !Number.isInteger(record.pid) || record.pid <= 1) throw new Error('Owned command receipt is invalid')
    return [{ pid: record.pid, script }]
  })
  const running = () => records().filter(({ pid, script }) => {
    try {
      const command = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 2000 })
      return command.includes(script)
    } catch (error) {
      if ((error as { status?: number }).status === 1) return false
      throw error
    }
  }).map(record => record.pid)
  return {
    command,
    receiptCount: () => records().length,
    running,
    cleanup() {
      for (const pid of running().reverse()) {
        try { process.kill(pid, 'SIGKILL') }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
      }
    },
  }
}

export { expect, acceptance, sendAcceptanceMessage, waitForAcceptanceIdle } from './acceptance-app'
