import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({
  effect: null as null | (() => void | (() => void)),
  resolve: vi.fn(),
  open: vi.fn(),
}))
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useEffect: (effect: () => void | (() => void)) => { env.effect = effect },
}))
vi.mock('../../../../src/renderer/api', () => ({ api: { resolveArtifactPaths: env.resolve } }))
vi.mock('../../../../src/renderer/services/canvas-lifecycle', () => ({ canvasLifecycle: { openFile: env.open } }))
vi.mock('../../../../src/renderer/i18n', () => ({ default: { t: (key: string) => key } }))

import { fileLinkHandlers, useFileMentionLinks } from '../../../../src/renderer/components/references/file-links'

function element(tagName: string, raw: string) {
  const attributes = new Map<string, string>()
  return {
    tagName,
    dataset: { fileMention: raw } as Record<string, string>,
    attributes,
    isConnected: true,
    title: '',
    tabIndex: -1,
    setAttribute: (key: string, value: string) => attributes.set(key, value),
    removeAttribute: (key: string) => attributes.delete(key),
  }
}

type TestElement = ReturnType<typeof element>
function prepare(nodes: TestElement[], spaceId: string, active = true) {
  const query = vi.fn((selector: string) => selector === '[data-file-link]'
    ? nodes.filter(node => node.dataset.fileLink) : nodes)
  const root = { querySelectorAll: query }
  useFileMentionLinks({ current: root as unknown as HTMLElement }, 'reply', active ? { spaceId } : null)
  const cleanup = env.effect?.()
  return { query, cleanup }
}
const finishBatch = async () => { await vi.runAllTimersAsync() }
let space = 0

beforeEach(() => {
  vi.useFakeTimers()
  env.resolve.mockReset()
  env.open.mockReset()
})
afterEach(() => { vi.useRealTimers() })

describe('file links in completed replies', () => {
  it('batches named and inline paths, and checks repeated paths only once', async () => {
    const spaceId = `files-${++space}`
    const nodes = [element('SPAN', '.halo/tmp/report.md'), element('CODE', '.halo/tmp/report.md'), element('SPAN', 'src/app.ts:3')]
    env.resolve.mockImplementation(async (_space: string, paths: string[]) => ({
      success: true, data: paths.map(path => ({ path, absolutePath: `/repo/${path}`, isDirectory: false })),
    }))
    prepare(nodes, spaceId)
    await finishBatch()
    expect(env.resolve).toHaveBeenCalledTimes(1)
    expect(env.resolve).toHaveBeenCalledWith(spaceId, ['.halo/tmp/report.md', 'src/app.ts'], undefined)
    expect(nodes.map(node => node.dataset.fileLink)).toEqual(['/repo/.halo/tmp/report.md', '/repo/.halo/tmp/report.md', '/repo/src/app.ts'])
    expect(nodes[2].dataset.fileLines).toBe('3-3')
    prepare(nodes, spaceId)
    await finishBatch()
    expect(env.resolve).toHaveBeenCalledTimes(1)
  })

  it('links inline names in any script only when the space has the file', async () => {
    const spaceId = `unicode-${++space}`
    const nodes = [element('CODE', '报告.docx'), element('CODE', 'docs/设计.md:3'), element('CODE', '不存在.md')]
    env.resolve.mockImplementation(async (_space: string, paths: string[]) => ({
      success: true, data: paths.map(path => ({ path, absolutePath: path === '不存在.md' ? null : `/repo/${path}`, isDirectory: false })),
    }))
    prepare(nodes, spaceId)
    await finishBatch()
    expect(env.resolve).toHaveBeenCalledWith(spaceId, ['报告.docx', 'docs/设计.md', '不存在.md'], undefined)
    expect(nodes.map(node => node.dataset.fileLink)).toEqual(['/repo/报告.docx', '/repo/docs/设计.md', undefined])
    expect(nodes[1].dataset.fileLines).toBe('3-3')
    expect(nodes[2].attributes.has('role')).toBe(false)
  })

  it('keeps missing, directory and rejected paths inert; streaming performs no DOM or file checks', async () => {
    const nodes = [element('SPAN', 'missing.md'), element('SPAN', 'folder.md'), element('SPAN', '../outside.md')]
    env.resolve.mockResolvedValue({ success: true, data: [
      { path: 'missing.md', absolutePath: null, isDirectory: false },
      { path: 'folder.md', absolutePath: '/repo/folder.md', isDirectory: true },
      { path: '../outside.md', absolutePath: null, isDirectory: false },
    ] })
    const inactive = prepare(nodes, `stream-${++space}`, false)
    expect(inactive.query).not.toHaveBeenCalled()
    expect(env.resolve).not.toHaveBeenCalled()
    prepare(nodes, `missing-${++space}`)
    await finishBatch()
    expect(nodes.every(node => !node.dataset.fileLink && !node.attributes.has('role'))).toBe(true)
  })

  it('does not apply obsolete asynchronous answers, and removes old targets when context changes', async () => {
    const node = element('SPAN', 'report.md')
    let respond!: (value: unknown) => void
    env.resolve.mockReturnValue(new Promise(resolve => { respond = resolve }))
    const pending = prepare([node], `obsolete-${++space}`)
    await vi.advanceTimersByTimeAsync(0)
    pending.cleanup?.()
    respond({ success: true, data: [{ path: 'report.md', absolutePath: '/old/report.md', isDirectory: false }] })
    await finishBatch()
    expect(node.dataset.fileLink).toBeUndefined()
    node.dataset.fileLink = '/old/report.md'
    node.attributes.set('role', 'link')
    env.resolve.mockResolvedValue({ success: true, data: [{ path: 'report.md', absolutePath: null, isDirectory: false }] })
    prepare([node], `new-${++space}`)
    await finishBatch()
    expect(node.dataset.fileLink).toBeUndefined()
    expect(node.attributes.has('role')).toBe(false)
  })

  it('opens only confirmed targets on click or Enter, including clicks on formatted labels', () => {
    const handlers = fileLinkHandlers({ spaceId: 'activation' })
    const node = element('SPAN', 'src/app.ts:3')
    node.dataset.fileLink = '/repo/src/app.ts'
    node.dataset.fileLines = '3-3'
    const event = { target: { closest: () => node }, preventDefault: vi.fn() }
    handlers.onClick?.(event as any)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(env.open).toHaveBeenCalledWith('/repo/src/app.ts', { reveal: { range: { startLine: 3, endLine: 3 } } })
    env.open.mockClear()
    handlers.onKeyDown?.({ ...event, key: 'Enter' } as any)
    expect(env.open).toHaveBeenCalledOnce()
    handlers.onKeyDown?.({ ...event, key: 'Tab' } as any)
    expect(env.open).toHaveBeenCalledOnce()
    expect(fileLinkHandlers(null)).toEqual({})
  })
})
