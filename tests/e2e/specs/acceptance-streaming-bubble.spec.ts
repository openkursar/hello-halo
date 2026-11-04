import { test, expect } from '@playwright/test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'

let script: string

test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `
        import React from 'react'
        import { createRoot } from 'react-dom/client'
        import { act } from 'react-dom/test-utils'
        import { StreamingBubble } from './src/renderer/components/chat/StreamingBubble'
        import { ExecutionStatus } from './src/renderer/components/team/workbench/ExecutionStatus'
        import { TaskExecutionView } from './src/renderer/components/team/workbench/TaskExecutionView'
        globalThis.IS_REACT_ACT_ENVIRONMENT = true
        window.renderWorkbench = async (surface, live) => {
          window.executionState = { active: true, available: true, failed: false, now: Date.now(), thoughts: live.thoughts, live }
          await act(async () => { root.render(React.createElement(surface === 'status' ? ExecutionStatus : TaskExecutionView, {
            teamId: 'team', epochId: 'epoch', appId: 'app', spaceId: 'space', remote: false, busy: true, onOpen() {}
          })) })
        }
        const root = createRoot(document.getElementById('root'))
        window.renderBubble = async props => {
          await act(async () => { root.render(React.createElement(StreamingBubble, props)) })
        }
      `,
      resolveDir: fileURLToPath(new URL('../../../', import.meta.url)),
      loader: 'tsx',
    },
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"test"' },
    plugins: [{
      name: 'bubble-leaves',
      setup(build) {
        if (process.env.STREAMING_BASELINE_DIR) build.onLoad({ filter: /(StreamingBubble|ExecutionStatus|TaskExecutionView)\.tsx$/ }, async args => ({
          contents: await readFile(`${process.env.STREAMING_BASELINE_DIR}/${args.path.split('/').at(-1)}`, 'utf8'), loader: 'tsx',
        }))
        build.onResolve({ filter: /^(\.\/useExecutionState|\.\.\/session-history|\.\.\/\.\.\/\.\.\/api|\.\.\/\.\.\/\.\.\/i18n|\.\/TaskTimestamp|\.\.\/\.\.\/chat\/(MessageRow|useBrowserToolCalls))$/ }, args => ({ path: args.path, namespace: 'workbench-leaves' }))
        build.onLoad({ filter: /.*/, namespace: 'workbench-leaves' }, () => ({ contents: `
          export const useExecutionState = () => window.executionState
          export const useTranslation = () => ({t: text => text})
          export const useBrowserToolCalls = () => []
          export const MessageRow = () => null
          export const TaskTimestamp = () => null
          export const api = { onTeamMemberHistory: () => () => {} }
          export const retainTeamSessionHistory = () => () => {}
          export const invalidateTeamSessionHistory = () => {}
          export const matchesTeamHistory = () => false
          export const loadTeamSessionHistory = async () => ({success: true, data: []})
        `, loader: 'js' }))
        build.onLoad({ filter: /StreamingSection\.tsx$/ }, async args => {
          const source = await readFile(args.path, 'utf8')
          const binding = source.match(/textBlockVersion=\{textBlockVersion\}/)?.[0]
          if (!binding) throw new Error('StreamingSection must forward the text block version')
          return { contents: `import React from 'react'; import { StreamingBubble } from './StreamingBubble'; export const StreamingSection = ({ streamingContent, ...props }) => <StreamingBubble content={streamingContent} {...props} />`, loader: 'tsx' }
        })
        build.onResolve({ filter: /^\.\/MarkdownRenderer$/ }, () => ({ path: 'markdown', namespace: 'bubble-leaves' }))
        build.onResolve({ filter: /^\.\.\/\.\.\/i18n$/ }, () => ({ path: 'i18n', namespace: 'bubble-leaves' }))
        build.onLoad({ filter: /.*/, namespace: 'bubble-leaves' }, args => ({
          contents: args.path === 'markdown'
            ? 'export const MarkdownRenderer = ({content}) => content'
            : 'export const useTranslation = () => ({t: text => text})',
          loader: 'js',
        }))
      },
    }],
  })
  script = result.outputFiles[0].text
})

for (const width of [390, 1280]) {
  for (const surface of ['status', 'history']) {
    test(`workbench ${surface} keeps new block prefixes at ${width}px`, {
      annotation: { type: 'acceptance', description: JSON.stringify({ caseId: 'chat.streaming.workbench-prefix', evidence: 'ui', mode: 'none', variant: { viewport: String(width), surface } }) },
    }, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 })
      await page.setContent('<div id="root"></div>')
      await page.addScriptTag({ content: script })
      const render = async (streamingContent: string, textBlockVersion: number, tool: boolean) => {
        await page.evaluate(async ({ surface, live }) => {
          await (window as unknown as { renderWorkbench: (surface: string, live: unknown) => Promise<void> }).renderWorkbench(surface, live)
        }, { surface, live: { streamingContent, textBlockVersion, isStreaming: true, isThinking: false, thoughts: [
          { id: 'text', type: 'text', content: 'Checking', timestamp: 'now' },
          ...(tool ? [{ id: 'tool', type: 'tool_use', content: '', timestamp: 'now' }] : []),
        ] } })
      }
      await render('Checking', 0, false)
      await render('Checking', 0, true)
      await render('', 1, true)
      const next = 'The new workbench reply retains every opening character.'
      await render(next, 1, true)
      await expect(page.locator('.break-words').last()).toHaveText(next)
      await expect(page.locator('.message-working .break-words')).toHaveCount(1)
    })
  }
  test(`a reused bubble clears pending text at ${width}px`, {
    annotation: { type: 'acceptance', description: JSON.stringify({ caseId: 'chat.streaming.reused-bubble', evidence: 'ui', mode: 'none', variant: { viewport: String(width) } }) },
  }, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({ content: script })
    for (const props of [
      { content: 'Checking', thoughts: [] },
      { content: 'Checking', thoughts: [{ id: 'tool', type: 'tool_use' }] },
      { content: '', thoughts: [] },
      { content: 'A completely new reply must retain its opening.', thoughts: [] },
    ]) {
      await page.evaluate(async props => {
        await (window as unknown as { renderBubble: (props: unknown) => Promise<void> }).renderBubble(props)
      }, { ...props, isStreaming: true })
    }
    await expect(page.locator('.break-words').last()).toHaveText('A completely new reply must retain its opening.')
    await expect(page.locator('.break-words')).toHaveCount(1)
  })
  test(`new text blocks retain their prefix at ${width}px`, {
    annotation: { type: 'acceptance', description: JSON.stringify({ caseId: 'chat.streaming.block-prefix', evidence: 'ui', mode: 'none', variant: { viewport: String(width) } }) },
  }, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({ content: script })
    const render = async (content: string, textBlockVersion: number, toolCount: number) => {
      await page.evaluate(async props => {
        await (window as unknown as { renderBubble: (props: unknown) => Promise<void> }).renderBubble(props)
      }, {
        content, textBlockVersion, isStreaming: true,
        thoughts: Array.from({ length: toolCount }, (_, index) => ({ id: `tool-${index}`, type: 'tool_use', content: '', timestamp: 'now' })),
      })
    }
    const current = page.locator('.break-words').last()
    await render('Checking', 0, 0)
    await render('Checking', 0, 1)
    await render('新段', 1, 1)
    await expect(current).toHaveText('新段')
    await render('新段开头必须完整保留，而不是只剩下后半句。', 1, 1)
    await expect(current).toHaveText('新段开头必须完整保留，而不是只剩下后半句。')
    await expect(page.locator('.break-words')).toHaveCount(1)

    await render('新段开头必须完整保留，而不是只剩下后半句。', 1, 2)
    const next = 'The first chunk of the next block is already longer than the previous reply.'
    await render(next, 2, 2)
    await expect(current).toHaveText(next)
    await expect(page.locator('.break-words')).toHaveCount(1)

    await render(next, 2, 3)
    await render(`${next} Continued in the same block.`, 2, 3)
    await expect(current).toHaveText(' Continued in the same block.')
    await expect(page.locator('.break-words')).toHaveCount(2)
    await render('A clean subsequent block.', 3, 3)
    await expect(current).toHaveText('A clean subsequent block.')
    await expect(page.locator('.break-words')).toHaveCount(1)
  })
}
