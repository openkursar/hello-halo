import { test, expect } from '../fixtures/acceptance-remote'
import { acceptance } from '../fixtures/acceptance-app'
import { aiTabs, createdSession, endAllTerminals, expandHandle, scriptedTurn, tabTitled } from '../fixtures/acceptance-ai-work'
import { navigateToChat } from '../fixtures/helpers'
import type { HaloAPI } from '../../../src/preload'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

async function localPages() {
  const server = createServer((request, response) => {
    const title = request.url === '/old' ? 'Initial AI page' : 'Replacement AI page'
    response.writeHead(200, { 'content-type': 'text/html' }).end(`<title>${title}</title><h1>${title}</h1>`)
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { origin, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }) }
}

test('a late remote client sees active work and replaces missed browser tabs after reconnecting', acceptance('files.ai-work.remote-reconnect'), async ({ window, model, remote }, info) => {
  test.setTimeout(180000)
  const site = await localPages()
  let running: ReturnType<typeof scriptedTurn> | undefined
  try {
    await navigateToChat(window)
    let terminalId = ''
    running = scriptedTurn(window, model, 'Open a page and wait for the terminal marker.', [
      { name: 'browser_tab', input: { action: 'new', url: `${site.origin}/old` } },
      { name: 'terminal_create', input: { title: 'Remote terminal' } },
      { name: 'terminal_wait_for', input: results => {
        terminalId = createdSession(results[1])
        return { session: terminalId, text: 'remote-acceptance-ready', timeout: 60 }
      } },
    ])
    void running.catch(() => {})
    await expect.poll(() => window.evaluate(async () => {
      const listed = await (globalThis as unknown as { halo: HaloAPI }).halo.listTerminals()
      const terminal = listed.data?.find(session => session.title === 'Remote terminal')
      return !!terminal?.operating && !!terminal.conversationId
    }), { timeout: 15000 }).toBe(true)
    await remote.login()
    await navigateToChat(remote.page)
    await expandHandle(remote.page).click()
    const terminal = tabTitled(remote.page, 'Remote terminal')
    await expect(terminal.locator('[data-ai-operating="true"]')).toHaveCount(1)
    const old = tabTitled(remote.page, 'Initial AI page')
    await old.click()
    await expect(old.getByRole('img', { name: 'Can only be closed on the computer' })).toHaveCount(1)
    await expect(old.locator('button.canvas-tab-close')).toHaveCount(0)
    await expect(remote.page.getByText('Browser features are only available in the desktop client')).toBeVisible()
    await info.attach('remote-late-client', { body: await remote.page.screenshot(), contentType: 'image/png' })

    await window.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.terminalInput({ sessionId: id, data: 'echo remote-acceptance-ready\r' }), terminalId)
    const initial = await running
    expect(initial.results[2]).toMatch(/Found "remote-acceptance-ready"/)
    const row = remote.page.getByText(/Open a page and wait for the terminal marker/).first()
    if (!(await remote.page.locator('.message-user').filter({ hasText: 'Open a page and wait for the terminal marker' }).count())) await row.click()
    await expect(remote.page.locator('.message-user').filter({ hasText: 'Open a page and wait for the terminal marker' })).toBeVisible()
    const remoteReply = remote.page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/canvas/show-reply')
    const show = await scriptedTurn(window, model, 'Show the current page.', [{ name: 'canvas_show', input: { target: 'page' } }])
    expect(show.results[0]).toMatch(/^Shown:|^Added, not switched:/)
    expect((await remoteReply).postDataJSON()).toMatchObject({ outcome: 'added' })

    remote.disconnect()
    await expect(remote.page.getByText('Reconnecting...', { exact: true })).toBeVisible()
    const replaced = await scriptedTurn(window, model, 'Open a replacement and close the old page while the remote client is offline.', [
      { name: 'browser_tab', input: { action: 'new', url: `${site.origin}/new` } },
      { name: 'browser_tab', input: { action: 'list' } },
      { name: 'browser_tab', input: results => {
        const line = results[1].split('\n').find(item => item.endsWith(`${site.origin}/old`))
        return { action: 'close', pageIdx: Number(line?.match(/^\[(\d+)\]/)?.[1] ?? -1) }
      } },
      { name: 'terminal_kill', input: { session: terminalId } },
    ])
    expect(replaced.results[2]).toMatch(/^Closed page/)
    expect(replaced.results[3]).toMatch(/^Killed session/)
    await expect(old).toHaveCount(1)
    await expect(tabTitled(remote.page, 'Replacement AI page')).toHaveCount(0)
    remote.reconnect()
    await expect(remote.page.getByText('Reconnecting...', { exact: true })).toHaveCount(0, { timeout: 30000 })
    await expect(old).toHaveCount(0)
    await expect(tabTitled(remote.page, 'Replacement AI page')).toHaveCount(1)
    await expect(terminal.locator('.canvas-tab-ai-dot')).toHaveCount(0)
    await expect(aiTabs(remote.page)).toHaveCount(1)
    await info.attach('remote-reconnected', { body: await remote.page.screenshot(), contentType: 'image/png' })
  } finally {
    remote.reconnect()
    try { await endAllTerminals(window) }
    finally { await site.close() }
  }
})
