/**
 * A folder opened while it could not be read (in use by antivirus or sync on
 * Windows, not yet allowed on macOS) opens empty. Once it can be read, its
 * files appear when the user refreshes or comes back to the window — the main
 * process reads it again and sends its listing — and when the tree re-lists
 * what it shows after changes were lost. A folder closed again waits for its
 * next expand, like any closed folder (#458).
 *
 * No DOM here: React's hooks are replaced by a small runner that keeps memos
 * and callbacks by their dependencies and runs the effects whose dependencies
 * changed. react-arborist is stood in for by its props: a row is clicked
 * through the node renderer the tree is given, and what the tree shows is read
 * from the data it is given.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactTreeNode } from '../../../src/renderer/types'

const env = vi.hoisted(() => {
  const listeners = {
    treeUpdate: new Set<(data: unknown) => void>(),
    changedBatch: new Set<(data: unknown) => void>(),
  }
  const subscribe = (set: Set<(data: unknown) => void>) => (listener: (data: unknown) => void) => {
    set.add(listener)
    return () => { set.delete(listener) }
  }
  return {
    runner: null as any,
    contexts: new Map<unknown, unknown>(),
    listeners,
    /** Folders that can be read, with what they hold; listing any other folder fails. */
    readable: {} as Record<string, () => ArtifactTreeNode[]>,
    api: {
      isRemoteMode: () => false,
      listArtifactsTree: vi.fn(),
      loadArtifactChildren: vi.fn(),
      reconcileArtifacts: vi.fn(async () => ({ success: true })),
      onArtifactTreeUpdate: subscribe(listeners.treeUpdate),
      onArtifactChangedBatch: subscribe(listeners.changedBatch),
    },
    fileOps: {
      createNewArtifact: vi.fn(),
      renameExistingArtifact: vi.fn(),
      deleteArtifact: vi.fn(),
      moveArtifact: vi.fn(),
      recentlyCreatedPaths: { current: new Map<string, number>() },
      cleanup: vi.fn(),
    },
  }
})

class Runner {
  values: unknown[] = []
  index = 0
  pending: Array<() => void> = []
  cleanups = new Map<number, () => void>()
  state(initial: unknown) {
    const index = this.index++
    if (!(index in this.values)) this.values[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial
    return [this.values[index], (update: unknown) => {
      this.values[index] = typeof update === 'function' ? (update as (value: unknown) => unknown)(this.values[index]) : update
    }]
  }
  ref(initial: unknown) {
    const index = this.index++
    this.values[index] ??= { current: initial }
    return this.values[index]
  }
  memo(compute: () => unknown, deps?: unknown[]) {
    const index = this.index++
    const previous = this.values[index] as { deps: unknown[]; value: unknown } | undefined
    if (deps && previous && deps.every((dep, i) => Object.is(dep, previous.deps[i]))) return previous.value
    const value = compute()
    this.values[index] = { deps, value }
    return value
  }
  effect(effect: () => void | (() => void), deps?: unknown[]) {
    const index = this.index++
    const previous = this.values[index] as unknown[] | undefined
    if (!deps || !previous || deps.some((dep, i) => !Object.is(dep, previous[i]))) {
      this.pending.push(() => {
        this.cleanups.get(index)?.()
        const cleanup = effect()
        if (typeof cleanup === 'function') this.cleanups.set(index, cleanup)
        else this.cleanups.delete(index)
      })
    }
    this.values[index] = deps
  }
  /** Render, then run the effects that fire. */
  render<T>(component: () => T): T {
    this.index = 0
    this.pending = []
    env.runner = this
    const tree = component()
    for (const run of this.pending) run()
    return tree
  }
}

vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => env.runner.state(initial),
  useRef: (initial: unknown) => env.runner.ref(initial),
  useMemo: (compute: () => unknown, deps?: unknown[]) => env.runner.memo(compute, deps),
  useCallback: (fn: unknown, deps?: unknown[]) => env.runner.memo(() => fn, deps),
  useEffect: (effect: () => void | (() => void), deps?: unknown[]) => env.runner.effect(effect, deps),
  useContext: (context: unknown) => env.contexts.get(context),
}))
vi.mock('react-arborist', () => ({ Tree: function Tree() { return null } }))
vi.mock('../../../src/renderer/api', () => ({ api: env.api }))
vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string) => text }) }))
vi.mock('../../../src/renderer/stores/canvas.store', () => ({
  useCanvasStore: (select: (state: object) => unknown) => select({ openFile: vi.fn(), isOpen: true }),
}))
vi.mock('../../../src/renderer/stores/notification.store', () => ({ useNotificationStore: { getState: () => ({ show: vi.fn() }) } }))
vi.mock('../../../src/renderer/stores/space.store', () => ({ useSpaceStore: { getState: () => ({ openSpaceFolder: vi.fn() }) } }))
vi.mock('../../../src/renderer/stores/onboarding.store', () => ({
  useOnboardingStore: Object.assign((select: (state: object) => unknown) => select({ isActive: false }), { getState: () => ({}) }),
}))
vi.mock('../../../src/renderer/hooks/useConversationTouchedFiles', () => ({ useConversationTouchedFiles: () => new Map() }))
vi.mock('../../../src/renderer/hooks/useConfirmDialog', () => ({ useConfirmDialog: () => ({ showConfirm: vi.fn(), DialogComponent: null }) }))
vi.mock('../../../src/renderer/hooks/useFileOperations', () => ({ useFileOperations: () => env.fileOps }))
vi.mock('../../../src/renderer/services/artifact-space-holds', () => ({ holdArtifactSpace: () => () => {} }))
vi.mock('../../../src/renderer/services/artifact-download', () => ({ downloadArtifact: vi.fn() }))
vi.mock('../../../src/renderer/services/home-telemetry', () => ({ trackHome: vi.fn() }))
vi.mock('../../../src/renderer/utils/clipboard', () => ({ copyToClipboard: vi.fn() }))
vi.mock('../../../src/renderer/components/icons/ToolIcons', () => ({ FileIcon: () => null }))
vi.mock('../../../src/renderer/components/ui/ContextMenu', () => ({ ContextMenu: function ContextMenu() { return null } }))
vi.mock('../../../src/renderer/components/onboarding/onboardingData', () => ({ ONBOARDING_ARTIFACT_NAME: 'halo-intro.html' }))

import { Tree } from 'react-arborist'
import { ArtifactTree } from '../../../src/renderer/components/artifact/ArtifactTree'

const SPACE = 'space-1'
const ROOT = '/space'
const LOCKED = `${ROOT}/locked`
const CLOSED = `${ROOT}/closed`

function entry(path: string, type: 'file' | 'folder' = 'file'): ArtifactTreeNode {
  return {
    id: `id:${path}`, name: path.split('/').pop()!, type, path, relativePath: path.slice(ROOT.length + 1), extension: '', icon: '',
    depth: path.split('/').length - 3, children: type === 'folder' ? [] : undefined, childrenLoaded: false,
  }
}
const rootListing = () => [entry(CLOSED, 'folder'), entry(LOCKED, 'folder'), entry(`${ROOT}/readme.md`)]
const names = (folder: ArtifactTreeNode) => (folder.children ?? []).map(child => child.name)
const settle = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setTimeout(resolve, 0)) }

/** Every element in the tree, without rendering child components. */
function elements(tree: any): any[] {
  if (!tree || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap(elements)
  return [tree, ...[tree.props?.children].flat(Infinity).flatMap(elements)]
}

/** The files panel of SPACE, loaded, with react-arborist's open/closed state kept here. */
async function openFilesPanel() {
  const open = new Set<string>()
  const arborist = { isOpen: (id?: string) => !!id && open.has(id), deselectAll: () => {}, get: () => null }
  const runner = new Runner()
  const render = () => {
    const view = runner.render(() => ArtifactTree({ spaceId: SPACE }))
    for (const element of elements(view)) {
      if (element.type?._context) env.contexts.set(element.type._context, element.props.value)
    }
    return elements(view).find(element => element.type === Tree)
  }
  render()
  await settle()
  render().ref.current = arborist

  /** The folder as the tree shows it now. */
  const folder = (path: string): ArtifactTreeNode => render().props.data.find((node: ArtifactTreeNode) => node.path === path)
  return {
    folder,
    isOpen: (path: string) => arborist.isOpen(folder(path).id),
    /** Click the folder's row, as a person expanding or collapsing it. */
    async click(path: string) {
      const tree = render()
      const data: ArtifactTreeNode = tree.props.data.find((node: ArtifactTreeNode) => node.path === path)
      const node = {
        id: data.id, data, tree: arborist, isEditing: false, isSelected: false, isLeaf: data.type !== 'folder',
        get isOpen() { return open.has(data.id) },
        open: () => { open.add(data.id) },
        close: () => { open.delete(data.id) },
        select: () => {},
        focus: () => {},
      }
      const row = new Runner().render(() => tree.props.children({ node, style: {} }))
      elements(row).find(element => element.props?.draggable).props.onClick({ stopPropagation: () => {} })
      await settle()
    },
  }
}

/** Main read these folders again (a refresh, or the window regaining focus) and sends what they hold. */
function mainSends(...dirs: string[]) {
  const data = { spaceId: SPACE, updatedDirs: dirs.map(dirPath => ({ dirPath, children: env.readable[dirPath]() })) }
  for (const listener of env.listeners.treeUpdate) listener(data)
}

/** Changes were lost (watcher overflow, a lapsed hold): the tree re-lists what it shows. */
async function changesLost() {
  for (const listener of env.listeners.changedBatch) listener({ spaceId: SPACE, changes: [], resync: true })
  await settle()
}

const listed = () => env.api.loadArtifactChildren.mock.calls.map(call => call[1])

/** LOCKED opened while unreadable; CLOSED opened while unreadable and closed again; both readable now. */
async function panelAfterFailedExpands() {
  const panel = await openFilesPanel()
  await panel.click(LOCKED)
  await panel.click(CLOSED)
  await panel.click(CLOSED)
  expect(listed()).toEqual([LOCKED, CLOSED])
  expect(panel.isOpen(LOCKED)).toBe(true)
  expect(names(panel.folder(LOCKED))).toEqual([])
  expect(panel.isOpen(CLOSED)).toBe(false)

  env.readable[LOCKED] = () => [entry(`${LOCKED}/a.txt`)]
  env.readable[CLOSED] = () => [entry(`${CLOSED}/b.txt`)]
  env.api.loadArtifactChildren.mockClear()
  return panel
}

beforeEach(() => {
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  env.contexts.clear()
  env.listeners.treeUpdate.clear()
  env.listeners.changedBatch.clear()
  env.readable = { [ROOT]: rootListing }
  env.api.listArtifactsTree.mockReset().mockImplementation(async () => ({ success: true, data: { workspaceRoot: ROOT, nodes: rootListing() } }))
  env.api.loadArtifactChildren.mockReset().mockImplementation(async (_spaceId: string, dirPath: string) => {
    const listing = env.readable[dirPath]
    return listing ? { success: true, data: listing() } : { success: false, error: `EACCES: permission denied, scandir '${dirPath}'` }
  })
})

afterEach(() => {
  vi.mocked(console.warn).mockRestore()
  vi.unstubAllGlobals()
})

describe('a folder opened while it could not be read', () => {
  it('shows its files when main sends its listing after a refresh or window focus; a folder closed again stays closed and empty', async () => {
    const panel = await panelAfterFailedExpands()

    mainSends(LOCKED, CLOSED)

    expect(names(panel.folder(LOCKED))).toEqual(['a.txt'])
    expect(panel.isOpen(CLOSED)).toBe(false)
    expect(names(panel.folder(CLOSED))).toEqual([])
  })

  it('is listed again with what the tree shows after changes were lost; a folder closed again is not', async () => {
    const panel = await panelAfterFailedExpands()

    await changesLost()

    expect(listed()).toEqual([ROOT, LOCKED])
    expect(names(panel.folder(LOCKED))).toEqual(['a.txt'])
    expect(names(panel.folder(CLOSED))).toEqual([])
  })
})
