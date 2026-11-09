import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { build } from 'esbuild'
import { resolve } from 'node:path'
import postcss from 'postcss'
import tailwindcss from 'tailwindcss'

const root = resolve(__dirname, '../../..')
let browser: Browser
let page: Page
let script: string
let css: string

beforeAll(async () => {
  const bundle = await build({
    stdin: { contents: `
      import React, { useEffect, useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { MemberRail } from './src/renderer/components/team/workbench/MemberRail';
      const members = [{ appId: 'local', memberName: 'Investigator', role: 'Research', sameMachine: true, spaceId: 'space', status: 'idle' },
        { appId: 'remote', memberName: 'Remote', role: 'Review', sameMachine: false, spaceId: null, status: 'idle', owner: 'Taylor' }];
      const detail = { team: { name: 'Work' }, members, roster: members };
      window.calls = [];
      function View() {
        const [selected, setSelected] = useState('remote');
        const [wide, setWide] = useState(() => matchMedia('(min-width: 640px)').matches);
        useEffect(() => { const query = matchMedia('(min-width: 640px)'); const change = () => setWide(query.matches); query.addEventListener('change', change); return () => query.removeEventListener('change', change); }, []);
        return <MemberRail detail={detail} showSummary={wide} selectedAppId={selected} writableAppIds={['local']}
          onMember={member => { setSelected(member.appId); window.calls.push(['member', member.appId]); }}
          onDetails={member => window.calls.push(['details', member.appId])} onTask={() => {}} />;
      }
      createRoot(document.getElementById('root')).render(<View />);
    `, resolveDir: root, loader: 'tsx' },
    bundle: true, write: false, format: 'iife', jsx: 'automatic',
    plugins: [{ name: 'member-rail-translation', setup(builder) {
      builder.onResolve({ filter: /^(\.\.\/)+i18n$/ }, () => ({ path: 'i18n', namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const useTranslation = () => ({ t: (key, values = {}) => key.replace(/\\{\\{(\\w+)\\}\\}/g, (_, name) => values[name] ?? '') });` }))
    } }],
  })
  script = bundle.outputFiles[0].text
  css = (await postcss([tailwindcss({ config: resolve(root, 'tailwind.config.cjs'), content: [resolve(root, 'src/renderer/components/team/workbench/MemberRail.tsx')] })])
    .process('@tailwind base; @tailwind components; @tailwind utilities;', { from: undefined })).css
  browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined })
}, 30_000)

beforeEach(async () => {
  page = await browser.newPage({ viewport: { width: 375, height: 812 }, hasTouch: true })
  await page.setContent('<style>body{margin:0}#root{width:192px;margin-left:auto}@media(max-width:639px){#root{width:100%}}</style><div id="root"></div>')
  await page.addStyleTag({ content: css })
  await page.addScriptTag({ content: script })
  await page.getByRole('button', { name: 'View Investigator’s work in this task', exact: true }).waitFor()
})
afterEach(async () => { await page?.close() })
afterAll(async () => { await browser?.close() })

describe('member selection in a narrow task drawer', () => {
  it.each(['click', 'tap'] as const)('selects on the first %s without a summary intercepting it', async action => {
    const target = page.getByRole('button', { name: 'View Investigator’s work in this task', exact: true })
    await target[action]()
    expect(await target.getAttribute('aria-pressed')).toBe('true')
    expect(await page.getByRole('dialog', { name: 'Investigator member summary', exact: true }).count()).toBe(0)
    expect(await page.evaluate(() => (window as any).calls)).toEqual([['member', 'local']])
    await page.getByRole('button', { name: 'View Investigator’s member details', exact: true }).click()
    expect(await page.evaluate(() => (window as any).calls)).toEqual([['member', 'local'], ['details', 'local']])
  })

  it('keeps keyboard selection available and removes a desktop summary when the layout narrows', async () => {
    const target = page.getByRole('button', { name: 'View Investigator’s work in this task', exact: true })
    await page.setViewportSize({ width: 1280, height: 812 })
    await target.hover()
    await page.getByRole('dialog', { name: 'Investigator member summary', exact: true }).waitFor()
    await page.setViewportSize({ width: 375, height: 812 })
    await page.getByRole('dialog', { name: 'Investigator member summary', exact: true }).waitFor({ state: 'detached' })
    await target.focus()
    await target.press('Enter')
    expect(await target.getAttribute('aria-pressed')).toBe('true')
    expect(await page.getByRole('dialog', { name: 'Investigator member summary', exact: true }).count()).toBe(0)
  })
})
