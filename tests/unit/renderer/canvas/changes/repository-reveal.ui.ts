import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { build } from 'esbuild'
import { resolve } from 'node:path'

let browser: Browser
let page: Page
let script: string

beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { GitChangesView } from './src/renderer/components/canvas/viewers/changes/GitChangesView';
        import { createViewMemory } from './src/renderer/components/canvas/viewers/changes/state/view-memory';
        const root = createRoot(document.getElementById('root'));
        const entry = root => ({ root, name: root, relativePath: root, remembered: true });
        const repo = root => ({ root, name: root, relativePath: root, branch: 'main', head: 'abc', unborn: false, upstream: null, ahead: 0, behind: 0 });
        const file = { path: 'target.ts', state: 'modified', additions: 1, deletions: 0, binary: false };
        const ok = data => ({ success: true, data });
        const list = (root, scope) => ({ repoRoot: root, scope, beforeRevision: 'abc', files: [file], truncated: false });
        window.calls = [];
        window.api = {
          gitListRepositories: async () => ok({ git: { available: true }, repositories: [entry('/a'), entry('/b')] }),
          gitGetStatus: async (space, root) => window.failStatus && root === '/b'
            ? { success: false, code: 'GIT_FAILED' }
            : ok({ repo: repo(root), staged: [], unstaged: [file], conflicted: [], operation: null, truncated: false }),
          gitGetChanges: async (space, root, scope) => {
            window.calls.push(['list', root]);
            if (root === '/b') return new Promise(resolve => { window.finishList = fail => resolve(fail ? { success: false, code: 'GIT_FAILED' } : ok(list(root, scope))) });
            return ok(list(root, scope));
          },
          codeReviewGetLatest: async () => ok(null),
          onArtifactChangedBatch: () => () => {},
        };
        let tab = { id: 'tab', view: { changes: createViewMemory() } };
        const render = () => root.render(React.createElement(GitChangesView, { tab, source: { kind: 'git', spaceId: 'space' } }));
        window.actions = {
          setTabTitle: () => {}, setRefreshHandler: () => () => {}, openFile: () => {},
          consumeReveal: (id, seq) => {
            window.calls.push(['consume', seq]);
            if (tab.reveal?.seq === seq) { tab = { ...tab, reveal: undefined }; render() }
          },
        };
        window.reveal = (seq, path = '/b/target.ts') => { tab = { ...tab, reveal: { seq, path, side: 'before', range: { startLine: 7, endLine: 7 } } }; render() };
        window.failCurrent = () => { window.api.gitGetStatus = async (space, root) => root === '/a' ? { success: false, code: 'GIT_NOT_A_REPOSITORY' } : ok({ repo: repo(root), staged: [], unstaged: [file], conflicted: [], operation: null, truncated: false }); window.dispatchEvent(new Event('focus')); };
        window.unmount = () => root.unmount();
        render();
      `,
      resolveDir: resolve(__dirname, '../../../../..'), loader: 'tsx',
    },
    bundle: true, write: false, format: 'iife', jsx: 'automatic',
    plugins: [{
      name: 'view-fixtures',
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, ({ path, importer }) => {
          if (/\/(api|i18n)$/.test(path)) return { path: path.endsWith('/api') ? 'api' : 'i18n', namespace: 'fixture' }
          if (path.endsWith('/git-discovery')) return { path: 'discovery', namespace: 'fixture' }
          if (!importer.endsWith('/GitChangesView.tsx')) return
          if (['./state/git-changes-store', './shared/use-view-memory'].includes(path) || path.startsWith('./model/') || path.startsWith('./panel/panel-rows') || path.startsWith('./overview/detail-nav')) return
          if (path.startsWith('.') && !path.endsWith('/types/changes-view')) return { path, namespace: 'fixture' }
        })
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => {
          let contents: string
          if (path === 'api') contents = 'export const api = window.apiProxy ??= new Proxy({}, { get: (_, key) => (...args) => window.api[key](...args) });'
          else if (path === 'i18n') contents = 'const t = key => key; export const useTranslation = () => ({ t });'
          else if (path === 'discovery') contents = 'export const gitDiscovery = { subscribe: () => () => {} };'
          else if (path.endsWith('useCanvasLifecycle')) contents = 'export const useCanvasActions = () => window.actions;'
          else if (path.endsWith('useConfirmDialog')) contents = 'export const useConfirmDialog = () => ({ showConfirm: async () => true, DialogComponent: null });'
          else if (path.endsWith('viewer-resources')) contents = 'const resources = { scope: () => { const disposers = []; return { add: fn => disposers.push(fn), dispose: () => disposers.reverse().forEach(fn => fn()) } } }; export const useViewerResources = () => resources;'
          else if (path.endsWith('artifact-space-holds')) contents = 'export const holdArtifactSpace = () => () => {};'
          else if (path.endsWith('changes-view-prefs.store')) contents = 'const prefs = { panelOpen: false, panelWidth: 260, tree: false, hideGenerated: false }; export const useChangesViewPrefs = () => prefs;'
          else if (path.endsWith('notification.store')) contents = 'export const useNotificationStore = select => select({ show: () => {} });'
          else if (path.endsWith('space.store')) contents = 'export const useSpaceStore = select => select({ currentSpace: null });'
          else if (path.endsWith('/references')) contents = `export const focusCommentCard = () => {}; export const notifyRevealOutcome = () => {}; export const referenceExtension = () => []; export const relocateLines = () => ({}); export const revealFileAt = (path, target) => window.calls.push(['fallback', path, target]); export const revealInEditor = (_, target) => { window.calls.push(['diff', target]); return 'found' };`
          else if (path === './diff/DiffStack') contents = `import React, { useImperativeHandle } from 'react'; export const DiffStack = React.forwardRef((props, ref) => { useImperativeHandle(ref, () => ({ withEditors: (key, show) => { if (!props.files.some(file => file.key === key)) return false; window.calls.push(['editor', props.files.find(file => file.key === key).absPath]); show([{ editorFor: side => ({ side }) }]); return true } })); return React.createElement('div', { 'data-testid': 'stack' }, props.files.map(file => file.absPath).join(',')); });`
          else if (path === './diff/diff-editor') contents = 'export const expandCollapsedAt = () => {}; export const originalLines = () => []; export const revealBeforeInUnified = () => {}; export const unfoldReferencedLines = () => {};'
          else if (path === './diff/diff-content') contents = 'export const diffFromGit = value => value;'
          else if (path === './shared/use-container-width') contents = 'export const changesLayout = () => ({ dockedPanel: false }); export const layoutStep = () => 0; export const mainWidth = w => w; export const MIN_SIDE_BY_SIDE_WIDTH = 640; export const useContainerWidth = () => 390;'
          else if (path === './shared/use-changes-keys') contents = 'export const useChangesKeys = () => {};'
          else if (path === './review/changed-since') contents = 'export class ChangedSinceCounter {}'
          else if (path === './state/git-errors') contents = 'export const describeGitError = () => ({}); export const gitErrorMessage = () => "failed";'
          else if (path === './shared/EmptyStates') contents = 'export const LoadErrorState = () => null; export const LoadingState = () => null; export const NoChangesState = () => null; export const NoGitState = () => null; export const NoRepositoryState = () => null;'
          else if (path === './shared/parts') contents = 'export const IconButton = () => null;'
          else contents = `export const ${path.split('/').pop()} = () => null;`
          return { contents, loader: 'jsx', resolveDir: resolve(__dirname, '../../../../..') }
        })
      },
    }],
  })
  script = result.outputFiles[0].text
  browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined })
}, 30_000)

beforeEach(async () => {
  page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  await page.setContent('<div id="root"></div>')
  const errors: string[] = []
  page.on('console', (message) => { if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text()) })
  const pageFailure = new Promise<never>((_, reject) => page.once('pageerror', reject))
  await Promise.race([
    page.addScriptTag({ content: script }).then(() => page.getByTestId('stack').filter({ hasText: '/a/target.ts' }).waitFor({ timeout: 5000 })),
    pageFailure,
  ]).catch(async (error) => { throw new Error(`${String(error)}\n${errors.join('\n')}\n${JSON.stringify(await page.evaluate(() => ({ calls: (window as any).calls, body: document.body.innerText })))}`) })
})
afterEach(async () => { await page?.close() })
afterAll(async () => { await browser?.close() })
const calls = () => page.evaluate(() => (window as any).calls)
const drain = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
async function revealTarget() {
  await page.evaluate(() => (window as any).reveal(1))
  await page.waitForFunction(() => typeof (window as any).finishList === 'function')
  await drain()
}

describe('cross-repository reveal (real view/controller, stubbed API and diff editor)', () => {
  it('leaves a held target list pending, then reveals its diff without opening a normal file', async () => {
    await revealTarget()
    expect((await calls()).filter(([kind]: string[]) => ['consume', 'fallback', 'editor'].includes(kind))).toEqual([])
    await page.evaluate(() => (window as any).finishList(false))
    await page.waitForFunction(() => (window as any).calls.some(([kind]: string[]) => kind === 'diff'))
    expect((await calls()).filter(([kind]: string[]) => kind === 'consume')).toEqual([['consume', 1]])
    expect((await calls()).filter(([kind]: string[]) => kind === 'fallback')).toEqual([])
    expect((await calls()).find(([kind]: string[]) => kind === 'editor')[1]).toContain('/b/')
    expect((await calls()).find(([kind]: string[]) => kind === 'diff')[1].range).toEqual({ startLine: 7, endLine: 7 })
  })

  it('loads a healthy target diff even when the previously selected repository is unavailable', async () => {
    await page.waitForTimeout(2100)
    await page.evaluate(() => (window as any).failCurrent())
    await page.getByTestId('stack').waitFor({ state: 'detached' })
    await revealTarget()
    expect((await calls()).filter(([kind]: string[]) => kind === 'fallback')).toEqual([])
    await page.evaluate(() => (window as any).finishList(false))
    await page.waitForFunction(() => (window as any).calls.some(([kind]: string[]) => kind === 'diff'))
    expect((await calls()).filter(([kind]: string[]) => kind === 'consume')).toEqual([['consume', 1]])
    expect((await calls()).filter(([kind]: string[]) => kind === 'fallback')).toEqual([])
  })

  it.each(['status', 'list'])('falls back once when the target %s fails instead of keeping a pending reference', async (failure) => {
    if (failure === 'status') await page.evaluate(() => { (window as any).failStatus = true })
    await revealTarget()
    await page.evaluate(fail => (window as any).finishList(fail), failure === 'list')
    await page.waitForFunction(() => (window as any).calls.some(([kind]: string[]) => kind === 'fallback'))
    await drain()
    expect((await calls()).filter(([kind]: string[]) => kind === 'consume')).toEqual([['consume', 1]])
    expect((await calls()).filter(([kind]: string[]) => kind === 'fallback')).toHaveLength(1)
    expect((await calls()).filter(([kind]: string[]) => kind === 'editor')).toEqual([])
  })

  it('does not revive an old reveal after a newer request switches back', async () => {
    await revealTarget()
    await page.evaluate(() => (window as any).reveal(2, '/a/target.ts'))
    await page.evaluate(() => (window as any).finishList(false))
    await page.waitForFunction(() => (window as any).calls.some(([kind, seq]: [string, number]) => kind === 'consume' && seq === 2))
    await drain()
    expect((await calls()).filter(([kind]: string[]) => kind === 'consume')).toEqual([['consume', 2]])
    expect((await calls()).filter(([kind]: string[]) => kind === 'fallback')).toEqual([])
    expect((await calls()).filter(([kind]: string[]) => kind === 'editor').every(([, key]: string[]) => key.includes('/a/'))).toBe(true)
  })

  it('ignores a target load finishing after unmount', async () => {
    await revealTarget()
    await page.evaluate(() => { (window as any).unmount(); (window as any).finishList(true) })
    await drain()
    expect((await calls()).filter(([kind]: string[]) => ['consume', 'fallback', 'editor'].includes(kind))).toEqual([])
  })
})
