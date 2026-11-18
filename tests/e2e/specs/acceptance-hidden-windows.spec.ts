import { test, expect } from '../fixtures/acceptance-app'

test.use({ diagnoseShutdown: true })
test('hidden test windows retain the native window enumeration contract', async ({ acceptanceApp }, info) => {
  expect(process.env.HALO_E2E_HIDDEN_WINDOWS).toBe('1')
  const observed = await acceptanceApp.app.evaluate(({ BrowserWindow, BaseWindow }) => {
    const describe = (window: Electron.BaseWindow) => ({ id: window.id, constructor: window.constructor.name, visible: window.isVisible(), focused: window.isFocused(), destroyed: window.isDestroyed() })
    return {
      browser: BrowserWindow.getAllWindows().map(describe),
      base: BaseWindow.getAllWindows().map(describe),
      state: (globalThis as unknown as { acceptanceHiddenWindows: unknown }).acceptanceHiddenWindows,
    }
  })
  await info.attach('hidden-native-window-contract', { body: JSON.stringify(observed, null, 2), contentType: 'application/json' })
  expect(observed.base.length).toBeGreaterThan(0)
  expect(observed.browser.map(window => window.id)).toEqual(observed.base.map(window => window.id))
  for (const window of observed.base) expect(window).toMatchObject({ visible: false, focused: false, destroyed: false })
})
