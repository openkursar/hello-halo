import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test, expect } from '@playwright/test'

const run = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const crossProvider = 'replays saved Messages wrappers through Chat after reopening without repeating discovery or past effects'
const suites = [
  { protocol: 'messages', directory: join(root, 'src/sdk/halo-sdk'), file: 'core/tool-context-wire.test.ts', config: [], titles: [
    'keeps messages hook context inside the existing search result string',
    'keeps the messages tool table fixed and replays the original wrapper after permission edits',
    'keeps the wrapper and tool table through a genuine Anthropic stream-to-JSON fallback', crossProvider,
  ] },
  { protocol: 'chat', directory: join(root, 'src/sdk/halo-sdk'), file: 'core/tool-context-wire.test.ts', config: [], titles: [
    'keeps chat hook context inside the existing search result string',
    'keeps the chat tool table fixed and replays the original wrapper after permission edits',
    'uses the same wire representation from the one-shot query API', crossProvider,
  ] },
  { protocol: 'host-responses', directory: root, file: 'tests/unit/openai-compat-router/deferred-tool-context.test.ts',
    config: ['--config', 'tests/vitest.config.ts'], titles: ['uses ordinary responses wire requests while keeping discovery append-only'] },
]

for (const suite of suites) {
  test(`deferred tools retain their real ${suite.protocol} HTTP encoding and call semantics`, {
    annotation: { type: 'acceptance', description: JSON.stringify({
      caseId: 'capabilities.tool-discovery.native-wire', evidence: 'integration', mode: 'scripted', variant: { protocol: suite.protocol },
    }) },
  }, async ({}, info) => {
    test.setTimeout(90000)
    const reportPath = info.outputPath('native-wire-regressions.json')
    const pattern = suite.titles.map(title => title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
    let failure: unknown
    try {
      const output = await run(process.execPath, [join(suite.directory, 'node_modules/vitest/vitest.mjs'), 'run', suite.file,
        ...suite.config, '-t', pattern, '--reporter=json', '--outputFile', reportPath], {
        cwd: suite.directory, timeout: 60000, maxBuffer: 4 * 1024 * 1024,
      })
      await info.attach('native-wire-runner', { body: `${output.stdout}\n${output.stderr}`, contentType: 'text/plain' })
    } catch (error) {
      failure = error
      await info.attach('native-wire-runner-error', { body: String(error), contentType: 'text/plain' })
    }
    const bytes = await readFile(reportPath, 'utf8')
    await info.attach('native-wire-regressions', { body: bytes, contentType: 'application/json' })
    const report = JSON.parse(bytes) as { success: boolean; testResults: Array<{ assertionResults: Array<{ title: string; status: string }> }> }
    expect(failure).toBeUndefined()
    expect(report.success).toBe(true)
    const assertions = report.testResults.flatMap(result => result.assertionResults)
    for (const title of suite.titles) {
      const matches = assertions.filter(assertion => assertion.title === title)
      expect(matches, `The owning runner must execute ${title}`).toHaveLength(1)
      expect(matches[0].status, title).toBe('passed')
    }
  })
}
