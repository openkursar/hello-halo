import type { Page } from '@playwright/test'
import { expect, readAutomationState, readAutomationTranscript } from './acceptance-automation'

export async function openAttentionPanel(window: Page) {
  const toggle = window.getByRole('button', { name: 'Tasks', exact: true })
  if (await toggle.getAttribute('aria-current') !== 'page') await toggle.click()
  const close = window.getByRole('button', { name: 'Close', exact: true })
  await expect(close).toHaveCount(1)
  const panel = close.locator('xpath=../..')
  await expect(panel.getByText('Tasks', { exact: true })).toBeVisible()
  return panel
}

export async function attentionPhase(window: Page, name: string, phase: 'running' | 'waiting' | 'idle') {
  const panel = await openAttentionPanel(window)
  const cards = panel.locator('[class~="group/tk"]')
  const toggle = window.getByRole('button', { name: 'Tasks', exact: true })
  if (phase === 'idle') {
    await expect(cards).toHaveCount(0)
    await expect(panel.getByText('No active tasks', { exact: true })).toBeVisible()
    await expect(toggle.locator(':scope > span').filter({ hasText: /^\d+\+?$/ })).toHaveCount(0)
    await expect(toggle.getByRole('tooltip')).toHaveText('Tasks')
  } else {
    await expect(cards).toHaveCount(1)
    const card = cards.filter({ has: window.getByText(name, { exact: true }) })
    await expect(card).toHaveCount(1)
    await expect(card.getByText(name, { exact: true })).toBeVisible()
    await expect(card.getByText(phase === 'running' ? 'Running' : 'Waiting for your input', { exact: true })).toBeVisible()
    await expect(panel.getByText(phase === 'running' ? 'Running 1' : 'Needs you 1', { exact: true })).toBeVisible()
    await expect(panel.getByText(phase === 'running' ? 'Needs you 1' : 'Running 1', { exact: true })).toHaveCount(0)
    await expect(toggle.locator(':scope > span').filter({ hasText: /^1$/ })).toHaveCount(1)
    await expect(toggle.getByRole('tooltip')).toHaveText('Tasks · 1')
  }
  return { phase, text: await panel.innerText(), badge: await toggle.locator(':scope > span').filter({ hasText: /^\d+\+?$/ }).allTextContents() }
}

export async function openAttentionWork(window: Page, name: string) {
  const panel = await openAttentionPanel(window)
  const card = panel.locator('[class~="group/tk"]').filter({ has: window.getByText(name, { exact: true }) })
  await expect(card).toHaveCount(1)
  await card.click()
  await expect(window.getByRole('heading', { name, exact: true, level: 2 })).toBeVisible()
  await expect(window.getByRole('heading', { name: 'Recent activity', exact: true })).toBeVisible()
}

export async function inspectAttentionRun(window: Page, appId: string, run: { runId: string; sessionKey: string }, marker: string) {
  const state = await readAutomationState(window, appId)
  expect(state).toMatchObject({ status: 'running', runningRunId: run.runId, runningSessionKey: run.sessionKey })
  const active = window.locator('section').filter({ has: window.getByRole('heading', { name: 'Independent execution in progress', exact: true }) })
  await expect(active).toHaveCount(1)
  await active.getByRole('button', { name: 'View process', exact: true }).click()
  await expect(window.getByText(`Run ${run.runId.slice(0, 8)}`, { exact: true })).toBeVisible()
  await expect(window.getByText('Running — live', { exact: true })).toBeVisible()
  await expect.poll(async () => (await readAutomationTranscript(window, appId, run.runId)).filter(message => message.content.includes(marker)).length, { timeout: 15000 }).toBe(1)
  const transcript = await readAutomationTranscript(window, appId, run.runId)
  const [message] = transcript.filter(message => message.content.includes(marker))
  await expect(window.locator(`[data-message-id="${message.id}"]`).first()).toContainText(marker)
  return { appId, runId: run.runId, sessionKey: run.sessionKey, messageId: message.id, content: message.content }
}
