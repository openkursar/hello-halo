import { randomUUID } from 'node:crypto'
import { expect, type Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import { sendAcceptanceMessage, waitForAcceptanceIdle } from './acceptance-app'
import type { AcceptanceModel, ModelReply, ModelRequest } from './acceptance-model'
import { planModelTool } from './acceptance-tool-discovery'

export interface ScriptStep {
  name: string
  input: Record<string, unknown> | ((results: string[]) => Record<string, unknown>)
  /** Holds the reply carrying this call open until released, so the test can act before it runs. */
  hold?: Promise<void>
  /** Called when the model sends this call (before a hold is released). */
  onCall?: () => void
}

export interface ScriptedTurn {
  turn: { conversationId: string; spaceId: string }
  answer: string
  results: string[]
  /** When each tool result first reached the model (ms epoch): about when the call ended. */
  resultAt: number[]
}

/**
 * Sends `instruction` through the composer and answers with `steps`, one tool
 * call per model request (discovering tools the way the engine offers them),
 * then a final text. Resolves once the turn is idle.
 */
export async function scriptedTurn(
  window: Page, model: AcceptanceModel, instruction: string, steps: ScriptStep[],
  options: { leavesScreen?: boolean } = {},
): Promise<ScriptedTurn> {
  const reference = randomUUID()
  const question = `${instruction} Request reference: ${reference}.`
  const answer = `Scripted steps recorded for ${reference}.`
  const ids = steps.map((_step, index) => `step-${reference}-${index}`)
  const results: string[] = []
  const resultAt: number[] = []
  const issues: string[] = []
  model.respond((request: ModelRequest): ModelReply => {
    if (!request.text.includes(reference)) {
      issues.push('A model request arrived without this turn\'s reference')
      return { text: answer }
    }
    for (const [index, step] of steps.entries()) {
      const result = request.toolResults.find(item => item.id === ids[index])
      if (result) {
        if (results[index] === undefined) {
          results[index] = result.text
          resultAt[index] = Date.now()
        }
        continue
      }
      try {
        const input = typeof step.input === 'function' ? step.input(results) : step.input
        const plan = planModelTool(request, step.name, input, ids[index])
        if ('error' in plan) {
          issues.push(plan.error)
          return { text: answer }
        }
        const isTheCall = plan.call.id === ids[index]
        if (isTheCall) step.onCall?.()
        return { tools: [plan.call], ...(isTheCall && step.hold ? { hold: step.hold } : {}) }
      } catch (error) {
        issues.push(error instanceof Error ? error.message : String(error))
        return { text: answer }
      }
    }
    return { text: answer }
  })
  const turn = await sendAcceptanceMessage(window, question)
  // A test that moves to another conversation mid-turn cannot read this one's reply on screen.
  if (!options.leavesScreen) await expect(window.locator('.message-assistant').last()).toContainText(answer, { timeout: 90000 })
  await waitForAcceptanceIdle(window, turn.conversationId, { timeout: 90000 })
  expect(issues, 'Script problems must stay visible as failures').toEqual([])
  expect(results).toHaveLength(steps.length)
  return { turn, answer, results, resultAt }
}

/** The session id in a terminal_create result. */
export function createdSession(result: string): string {
  const id = result.match(/\(id: ([^)]+)\)/)?.[1]
  if (!id) throw new Error(`terminal_create returned no session id: ${result}`)
  return id
}

export const expandHandle = (page: Page) => page.getByRole('button', { name: 'Expand canvas', exact: true })
export const collapseButton = (page: Page) => page.getByRole('button', { name: 'Collapse canvas', exact: true })
export const closeCanvasButton = (page: Page) => page.getByRole('button', { name: /^Close canvas \(/ })
export const statusLine = (page: Page) => page.getByTestId('ai-work-status')
export const aiTabs = (page: Page) => page.locator('.canvas-tab').filter({ has: page.locator('.canvas-tab-ai-dot') })
export const operatingDot = (page: Page) => page.getByRole('img', { name: 'AI is operating', exact: true })

/** The canvas tab whose title is exactly `title`. */
export function tabTitled(page: Page, title: string) {
  return page.locator('.canvas-tab').filter({ has: page.locator('.canvas-tab-title').filter({ hasText: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) })
}

/** The handle while the canvas is collapsed, with the number of tabs it shows. */
export async function expectHandleCount(page: Page, count: number) {
  await expect(expandHandle(page)).toBeVisible()
  await expect(expandHandle(page).locator('span').first()).toHaveText(String(count))
}

export async function setWindowSize(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height })
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width)
}

/**
 * Ends every terminal still listed and waits until none is. The terminal
 * fixture accounts for the exit of each process it started; a shell the AI
 * opened is ended here, through the real registry, before that accounting.
 */
export async function endAllTerminals(page: Page) {
  const listed = async () => {
    const result = await page.evaluate(() => (window as unknown as { halo: HaloAPI }).halo.listTerminals())
    expect(result.success).toBe(true)
    return (result.data ?? []) as Array<{ id: string }>
  }
  for (const session of await listed()) {
    const result = await page.evaluate(id => (window as unknown as { halo: HaloAPI }).halo.killTerminal({ sessionId: id }), session.id)
    if (!result.success && result.code !== 'TERMINAL_NOT_FOUND') throw new Error(`The terminal registry refused to end ${session.id}`)
  }
  await expect.poll(async () => (await listed()).length, { timeout: 15000, message: 'Every terminal must actually end' }).toBe(0)
}

