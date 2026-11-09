import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { build } from 'esbuild'
import { resolve } from 'node:path'
import postcss from 'postcss'
import tailwindcss from 'tailwindcss'

const root = resolve(__dirname, '../../../../..')
let browser: Browser
let page: Page
let script: string
let css: string

beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { RepositoryPicker } from './src/renderer/components/canvas/viewers/changes/top-bar/RepositoryPicker';
        import { TopBar } from './src/renderer/components/canvas/viewers/changes/top-bar/TopBar';
        const root = createRoot(document.getElementById('root'));
        window.mountPicker = (options = {}) => {
          window.calls = [];
          window.pick = { success: true, data: '/space/deep/repo' };
          window.failure = null;
          window.remote = !!options.remote;
          const repo = { root: '/space/repo', name: 'repo', branch: 'main', head: 'abc', unborn: false, relativePath: '', upstream: null, ahead: 0, behind: 0 };
          const entry = { root: repo.root, name: repo.name, relativePath: repo.relativePath, remembered: !!options.remembered };
          const repositories = options.repositories ?? (options.empty ? [] : [entry]);
          const props = {
            repositories, selectedRepository: options.empty ? null : repositories[0],
            repo: options.empty || options.noStatus ? null : options.summary ?? repo,
            unavailableRoots: new Set(options.unavailable ?? []), disabled: !!options.disabled,
            onSelectRepository: path => window.calls.push(['select', path]),
            onOpenRepository: async path => { window.calls.push(['open', path]); return window.failure },
          };
          const topBar = { spaceId: 'space', scope: { kind: 'uncommitted' }, review: null, snapshotMissing: false,
            onScope: scope => window.calls.push(['scope', scope]), totals: null, page: 'changes', onPage: () => {},
            tools: null, toolsShown: false, panelToggle: null, layout: { stacked: true, hideMinorStats: true } };
          root.render(React.createElement(options.topBar ? TopBar : RepositoryPicker, { ...props, ...topBar, key: Math.random() }));
        };
        window.unmountPicker = () => root.render(null);
      `,
      resolveDir: root,
      loader: 'tsx',
    },
    bundle: true, write: false, format: 'iife', jsx: 'automatic',
    plugins: [{
      name: 'picker-fixtures',
      setup(builder) {
        builder.onResolve({ filter: /^(\.\.\/)+(api|i18n)$/ }, ({ path }) => ({ path: path.endsWith('/api') ? 'api' : 'i18n', namespace: 'fixture' }))
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'api'
          ? `export const api = { isRemoteMode: () => window.remote, selectFolder: async () => { window.calls.push(['picker']); return window.pick } };`
          : `const t = (key, values = {}) => key.replace(/\\{\\{(\\w+)\\}\\}/g, (_, name) => values[name] ?? ''); export default { t }; export const useTranslation = () => ({ t, i18n: { language: 'en' } });` }))
      },
    }],
  })
  script = result.outputFiles[0].text
  css = (await postcss([tailwindcss({
    config: resolve(root, 'tailwind.config.cjs'),
    content: [resolve(root, 'src/renderer/components/canvas/viewers/changes/top-bar/*.tsx'), resolve(root, 'src/renderer/components/canvas/viewers/changes/shared/Menu.tsx')],
  })]).process('@tailwind base; @tailwind components; @tailwind utilities;', { from: undefined })).css
  browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined })
}, 30_000)
beforeEach(async () => {
  page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  await page.setContent('<div id="root"></div>')
  await page.addStyleTag({ content: css })
  await page.addScriptTag({ content: script })
})
afterEach(async () => { await page?.close() })
afterAll(async () => { await browser?.close() })

async function mount(options: Record<string, unknown> = {}) {
  await page.evaluate((options) => (window as any).mountPicker(options), options)
  await page.getByRole('button').first().waitFor()
}
async function menu() {
  await page.getByRole('button', { name: /Repository:|Open repository…/ }).click()
  await page.getByRole('menu').waitFor()
}
const calls = () => page.evaluate(() => (window as any).calls)

describe('repository picker (isolated browser UI, mocked application API)', () => {
  it.each([false, true])('always offers open with empty=%s, and opens the exact picked directory', async (empty) => {
    await mount({ empty })
    await menu()
    await page.getByRole('menuitem', { name: 'Open repository…', exact: true }).click()
    await page.waitForFunction(() => (window as any).calls.some((call: string[]) => call[0] === 'open'))
    expect(await calls()).toEqual([['picker'], ['open', '/space/deep/repo']])
    expect(await page.getByRole('menu').count()).toBe(0)
  })

  it('cancels native selection without changing repositories, then restores trigger focus on Escape', async () => {
    await mount()
    await page.evaluate(() => { (window as any).pick = { success: true, data: null } })
    await menu()
    await page.getByRole('menuitem', { name: 'Open repository…', exact: true }).click()
    expect(await calls()).toEqual([['picker']])
    await page.getByRole('menu').press('Escape')
    expect(await page.getByRole('menu').count()).toBe(0)
    expect(await page.getByRole('button', { name: 'Repository: repo' }).evaluate((button) => button === document.activeElement)).toBe(true)
  })

  it('keeps invalid-repository and folder-picker failures inline', async () => {
    await mount()
    await page.evaluate(() => { (window as any).failure = { code: 'GIT_NOT_A_REPOSITORY' } })
    await menu()
    await page.getByRole('menuitem', { name: 'Open repository…', exact: true }).click()
    await page.getByRole('alert').waitFor()
    expect(await page.getByRole('alert').innerText()).toContain('Git repository')
    await page.evaluate(() => { (window as any).pick = { success: false } })
    await page.getByRole('menuitem', { name: 'Open repository…', exact: true }).click()
    expect(await page.getByRole('alert').innerText()).toContain('folder picker')
  })

  it.each([390, 960])('keeps unavailable rows selectable without removal controls at %s px', async (width) => {
    await page.setViewportSize({ width, height: 844 })
    await mount({ repositories: [{ root: '/space/gone', name: 'gone', relativePath: 'gone', remembered: true }], unavailable: ['/space/gone'], noStatus: true })
    await menu()
    const group = page.getByRole('group', { name: '/space/gone' })
    expect(await group.innerText()).toContain('Unavailable')
    expect(await group.innerText()).toContain('/space/gone')
    expect(await page.getByRole('menuitem', { name: /Remove|Delete|Hide/ }).count()).toBe(0)
    expect(await page.locator('button button').count()).toBe(0)
    await group.getByRole('menuitemradio').click()
    expect(await calls()).toEqual([['select', '/space/gone']])
  })

  it('keeps unavailable paths selectable for a retry and retains the selected path label without a branch', async () => {
    await page.setViewportSize({ width: 800, height: 844 })
    await mount({ noStatus: true, unavailable: ['/space/repo'] })
    const trigger = page.getByRole('button', { name: 'Repository: repo' })
    expect(await trigger.innerText()).toBe('repo')
    expect(await trigger.getAttribute('title')).toBe('/space/repo')
    await menu()
    const group = page.getByRole('group', { name: '/space/repo' })
    const retry = group.getByRole('menuitemradio')
    expect(await retry.isEnabled()).toBe(true)
    expect(await retry.innerText()).toContain('Unavailable')
    await retry.click()
    expect(await calls()).toEqual([['select', '/space/repo']])
  })

  it('does not invent a branch or show the previous repository summary for a selected path', async () => {
    await page.setViewportSize({ width: 800, height: 844 })
    await mount({ summary: { root: '/space/previous', branch: 'previous-branch', head: 'abc' } })
    expect(await page.getByRole('button', { name: 'Repository: repo' }).innerText()).toBe('repo')
    await mount()
    expect(await page.getByRole('button', { name: 'Repository: repo' }).innerText()).toContain('main')
  })

  it.each([false, true])('offers only selection and opening for remembered=%s', async (remembered) => {
    await mount({ remembered })
    await menu()
    expect(await page.getByRole('menuitemradio').count()).toBe(1)
    expect(await page.getByRole('menuitem').allTextContents()).toEqual(['Open repository…'])
    await page.getByRole('group', { name: '/space/repo' }).getByRole('menuitemradio').click()
    expect(await calls()).toEqual([['select', '/space/repo']])
  })

  it('keeps scope choices disabled until a real selected repository status is available', async () => {
    await mount({ topBar: true, noStatus: true })
    expect(await page.getByRole('button', { name: /Compare:/ }).isDisabled()).toBe(true)
    expect(await page.getByRole('button', { name: 'Repository: repo' }).isEnabled()).toBe(true)
    await mount({ topBar: true })
    expect(await page.getByRole('button', { name: /Compare:/ }).isEnabled()).toBe(true)
  })

  it('drops a folder-picker result when its viewer is unmounted', async () => {
    await mount()
    await page.evaluate(() => { (window as any).pick = new Promise((resolve) => { (window as any).finishPick = resolve }) })
    await menu()
    await page.getByRole('menuitem', { name: 'Open repository…', exact: true }).click()
    await page.evaluate(() => (window as any).unmountPicker())
    await page.getByRole('menu').waitFor({ state: 'detached' })
    await page.evaluate(() => (window as any).finishPick({ success: true, data: '/space/late' }))
    expect(await calls()).toEqual([['picker']])
  })

  it('disables manual operations while mutations are busy', async () => {
    await mount({ disabled: true })
    expect(await page.getByRole('button', { name: 'Repository: repo' }).isDisabled()).toBe(true)
    expect(await calls()).toEqual([])
  })

  it('uses a host-path dialog remotely, validates absolute paths and preserves errors', async () => {
    await mount({ remote: true, empty: true })
    await menu()
    await page.getByRole('menuitem', { name: 'Open repository…', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.waitFor()
    expect(await dialog.innerText()).toContain('computer hosting Halo, not on this device')
    const input = page.getByRole('textbox', { name: 'Repository directory on host' })
    expect(await input.evaluate((element) => element === document.activeElement)).toBe(true)
    await input.fill('relative/repo')
    await input.press('Enter')
    expect(await page.getByRole('alert').innerText()).toContain('absolute directory path')
    expect(await calls()).toEqual([])
    await input.fill('/space/deep/repo')
    await page.evaluate(() => { (window as any).failure = { code: 'GIT_NOT_A_REPOSITORY' } })
    await input.press('Enter')
    await page.waitForFunction(() => (window as any).calls.length === 1)
    expect(await dialog.innerText()).toContain('Git repository')
    await page.evaluate(() => { (window as any).failure = null })
    await input.press('Enter')
    await dialog.waitFor({ state: 'detached' })
    expect(await calls()).toEqual([['open', '/space/deep/repo'], ['open', '/space/deep/repo']])
  })

  it('contains focus, cancels without API work, and fits a phone viewport', async () => {
    await mount({ remote: true })
    await menu()
    const bounds = await page.getByRole('menu').boundingBox()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
    expect((await page.getByRole('menuitem', { name: 'Open repository…', exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(40)
    await page.getByRole('menuitem', { name: 'Open repository…', exact: true }).click()
    const input = page.getByRole('textbox')
    await input.press('Shift+Tab')
    expect(await page.getByRole('button', { name: 'Cancel', exact: true }).evaluate((element) => element === document.activeElement)).toBe(true)
    await page.getByRole('button', { name: 'Cancel', exact: true }).press('Enter')
    expect(await page.getByRole('dialog').count()).toBe(0)
    expect(await page.getByRole('button', { name: 'Repository: repo' }).evaluate((element) => element === document.activeElement)).toBe(true)
    await menu()
    await page.getByRole('menuitem', { name: 'Open repository…', exact: true }).click()
    await input.press('Escape')
    expect(await page.getByRole('dialog').count()).toBe(0)
    expect(await calls()).toEqual([])
  })
})
