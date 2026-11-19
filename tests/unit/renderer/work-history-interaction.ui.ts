/**
 * What the person opened in a reply's work stays where they left it, in a real
 * browser: a step they are reading is not folded away when the next step
 * arrives, a saved reply's work is read once however it is opened, and a
 * command a narrow window cut short is shown whole when opened.
 *
 * Run: node scripts/run-vitest.mjs run --config tests/unit/renderer/work-history.config.ts
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
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

/** Modules outside the work history, replaced by what the scenes need of them. */
const STUBS: Record<string, string> = {
  i18n: `export const useTranslation = () => ({ t: (key, values = {}) => key.replace(/\\{\\{(\\w+)\\}\\}/g, (_, name) => values[name] ?? '') }); export const getCurrentLanguage = () => 'en'; export default { t: key => key };`,
  'chat.store': `export const holdOpenThoughts = () => () => {};`,
  'team-collab': `export const readTeamProvenance = () => null;`,
  ArrivalCard: `export const ArrivalCard = () => null;`,
  references: `export const useFileLinkOptions = () => ({ baseDir: '/repo' });`,
  'tool-result': `import { createElement } from 'react'; export const ToolResultViewer = ({ output }) => createElement('output', null, output);`,
  NestedToolTimeline: `export const NestedToolTimeline = () => null;`,
  MarkdownRenderer: `import { createElement } from 'react'; export const MarkdownRenderer = ({ content }) => createElement('p', null, content);`,
  TodoCard: `export const TodoCard = () => null;`,
  SkillNotice: `export const SkillNotice = () => null;`,
  ErrorContent: `import { createElement } from 'react'; export const ErrorContent = ({ content }) => createElement('p', null, content);`,
}
const STUBBED = new RegExp(`(^|/)(${Object.keys(STUBS).map(name => name.replace('.', '\\.')).join('|')})$`)

beforeAll(async () => {
  const bundle = await build({
    stdin: { contents: `
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { ThoughtProcess } from './src/renderer/components/chat/ThoughtProcess';
      import { LazyCollapsedThoughtProcess } from './src/renderer/components/chat/CollapsedThoughtProcess';
      import { WorkViewMemory, WorkViewMemoryProvider } from './src/renderer/components/chat/work-history/view-memory';
      const at = n => new Date(Date.UTC(2026, 10, 19, 9, 0, n)).toISOString();
      const tool = (id, command, n) => ({ id, type: 'tool_use', toolName: 'Bash', toolInput: { command }, isReady: true, content: '', timestamp: at(n), toolResult: { output: 'output of ' + id, isError: false, timestamp: at(n) } });
      const say = (id, content, n) => ({ id, type: 'text', content, timestamp: at(n) });
      window.reads = 0;
      function Live() {
        const [steps, setSteps] = useState([say('s1', 'Checking the edges.', 1), tool('t1', 'npm run test:architecture', 2)]);
        window.addStep = () => setSteps(current => [...current, tool('t2', 'npm run test:handoff', 3)]);
        return <ThoughtProcess thoughts={steps} isThinking={true} />;
      }
      function Saved({ open }) {
        const [memory] = useState(() => { const memory = new WorkViewMemory(); if (open) memory.view('reply-1').open = true; return memory; });
        const load = () => { window.reads++; return new Promise(done => setTimeout(() => done([say('s1', 'Checking the edges.', 1), tool('t1', 'npm test', 2), tool('t2', 'npm run lint', 3)]), 150)); };
        return <WorkViewMemoryProvider memory={memory}>
          <LazyCollapsedThoughtProcess messageId="reply-1" answer="Done." thoughtsSummary={{ count: 3, types: { text: 1, tool_use: 2 }, duration: 2 }} onLoadThoughts={load} />
        </WorkViewMemoryProvider>;
      }
      function Narrow() {
        return <ThoughtProcess isThinking={false} thoughts={[say('s1', 'Checking.', 1), tool('t1', 'grep -rn "handOff" src/main/apps/runtime/x.ts', 2)]} />;
      }
      const scene = window.scene;
      createRoot(document.getElementById('root')).render(scene === 'live' ? <Live /> : scene === 'narrow' ? <Narrow /> : <Saved open={scene === 'reopen'} />);
    `, resolveDir: root, loader: 'tsx' },
    bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'work-history-scenes', setup(builder) {
      builder.onResolve({ filter: STUBBED }, args => {
        const name = args.path.split('/').pop()!
        return STUBS[name] ? { path: name, namespace: 'stub' } : undefined
      })
      builder.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: STUBS[args.path], loader: 'jsx', resolveDir: root }))
    } }],
  })
  script = bundle.outputFiles[0].text
  css = (await postcss([tailwindcss({ config: resolve(root, 'tailwind.config.cjs'), content: [resolve(root, 'src/renderer/components/chat/**/*.tsx'), resolve(root, 'src/renderer/components/chat/process-line.ts')] })])
    .process('@tailwind base; @tailwind components; @tailwind utilities;', { from: undefined })).css
  browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined })
}, 60_000)

async function open(scene: string, width = 1100) {
  page = await browser.newPage({ viewport: { width, height: 800 } })
  await page.setContent(`<div id="root" style="width:${Math.min(width, 720) - 40}px;margin:20px"></div>`)
  await page.addStyleTag({ content: css })
  await page.evaluate(value => { (window as any).scene = value }, scene)
  await page.addScriptTag({ content: script })
}
afterEach(async () => { await page?.close() })
afterAll(async () => { await browser?.close() })

describe('what the person opened stays open', () => {
  it('keeps a step they are reading in view when the next step joins it into a stretch', async () => {
    await open('live')
    await page.getByRole('button', { name: /^Executing / }).click()
    await page.getByRole('button', { name: /^Command · npm run test:architecture/ }).click()
    await page.getByText('output of t1').waitFor()
    await page.evaluate(() => (window as any).addStep())
    const stretch = page.getByRole('button', { name: /^Ran 2 commands/ })
    await stretch.waitFor()
    expect(await stretch.getAttribute('aria-expanded')).toBe('true')
    expect(await page.getByText('output of t1').isVisible()).toBe(true)
    // Folding the stretch is still the person's choice.
    await stretch.click()
    expect(await page.getByText('output of t1').count()).toBe(0)
  })

  it('reads a saved reply’s work once when it is opened', async () => {
    await open('saved')
    await page.getByRole('button', { name: /^Work process/ }).click()
    await page.getByRole('button', { name: /^Ran 2 commands/ }).waitFor()
    expect(await page.evaluate(() => (window as any).reads)).toBe(1)
  })

  it('reads work left open once, as soon as it is drawn again', async () => {
    await open('reopen')
    await page.getByRole('button', { name: /^Ran 2 commands/ }).waitFor()
    await page.waitForTimeout(300)
    expect(await page.evaluate(() => (window as any).reads)).toBe(1)
  })

  it('shows a command whole when a narrow window cut its line short', async () => {
    await open('narrow', 390)
    await page.getByRole('button', { name: /^Work process/ }).click()
    await page.getByRole('button', { name: /^Command · grep/ }).click()
    await page.locator('pre', { hasText: 'grep -rn "handOff" src/main/apps/runtime/x.ts' }).waitFor()
  })
})
