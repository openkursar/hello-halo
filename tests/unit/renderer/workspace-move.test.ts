import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Space } from '../../../src/renderer/types'
import type { AppSpaceChangePreview } from '../../../src/shared/apps/app-environment'

const env = vi.hoisted(() => ({
  runner: null as unknown as HookRunner,
  preview: vi.fn(),
  move: vi.fn(),
  notify: vi.fn(),
  getSpace: vi.fn(),
  deleteSpace: vi.fn(),
  confirm: vi.fn(),
}))

class HookRunner {
  values: unknown[] = []
  index = 0
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
  render<T>(component: () => T): T {
    this.index = 0
    env.runner = this
    return component()
  }
}

vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => env.runner.state(initial),
  useRef: (initial: unknown) => env.runner.ref(initial),
  useCallback: (fn: unknown) => fn,
  useEffect: () => {},
}))
vi.mock('../../../src/renderer/api', () => ({ api: { appPreviewSpaceChange: env.preview, getSpace: env.getSpace } }))
vi.mock('../../../src/renderer/i18n', () => ({
  useTranslation: () => ({ t: (text: string, values?: Record<string, unknown>) => text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values?.[name] ?? '')) }),
}))
vi.mock('../../../src/renderer/stores/apps.store', () => ({ useAppsStore: (select: (state: unknown) => unknown) => select({ moveAppToSpace: env.move }) }))
vi.mock('../../../src/renderer/stores/space.store', () => ({
  useSpaceStore: (select?: (state: unknown) => unknown) => {
    const state = {
      spaces: [{ id: 'origin', name: 'Origin' }, { id: 'destination', name: 'Destination' }],
      haloSpace: { id: 'halo-temp', name: 'Halo Workspace' },
      deleteSpace: env.deleteSpace,
      forgetSpace: vi.fn(),
      openSpaceFolder: vi.fn(),
    }
    return select ? select(state) : state
  },
}))
vi.mock('../../../src/renderer/stores/notification.store', () => ({ useNotificationStore: { getState: () => ({ show: env.notify }) } }))
vi.mock('../../../src/renderer/hooks/useConfirmDialog', () => ({ useConfirmDialog: () => ({ showConfirm: env.confirm, DialogComponent: null }) }))
vi.mock('../../../src/renderer/components/space/SpaceAvatar', () => ({ SpaceAvatar: () => null }))
vi.mock('../../../src/renderer/components/space/EditSpaceDialog', () => ({ EditSpaceDialog: () => null }))
vi.mock('../../../src/renderer/services/home-telemetry', () => ({ trackHome: vi.fn() }))

import { WorkspaceMigrationDialog } from '../../../src/renderer/components/apps/WorkspaceMigrationDialog'
import { SpaceCard } from '../../../src/renderer/components/space/SpaceCard'

type Node = { type?: unknown; props?: Record<string, any> }
function nodes(tree: unknown): Node[] {
  if (!tree || typeof tree !== 'object') return []
  const node = tree as Node
  return [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)]
}
function text(tree: unknown): string {
  return nodes(tree).flatMap(node => [node.props?.children].flat(Infinity)).filter(child => typeof child === 'string').join(' ')
}
function button(tree: unknown, label: string): Node {
  const found = nodes(tree).find(node => node.type === 'button' && text(node).trim() === label)
  if (!found) throw new Error(`Button not found: ${label}`)
  return found
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0))
const preview = (counts: Partial<AppSpaceChangePreview> = {}) => ({
  toSpaceId: 'destination', activeRunCount: 1, activeChatCount: 2, pendingDecisionCount: 4, retainedSessionCount: 5,
  addedSkills: ['Destination skill'], removedSkills: ['Origin skill'], addedConnections: [], removedConnections: [],
  addedChatConnections: [], removedChatConnections: [], warnings: [], ...counts,
})

beforeEach(() => {
  vi.clearAllMocks()
  env.preview.mockResolvedValue({ success: true, data: preview() })
  env.move.mockResolvedValue(true)
  env.confirm.mockResolvedValue(true)
  env.deleteSpace.mockResolvedValue('deleted')
  env.getSpace.mockResolvedValue({ success: true, data: { deletionEffect: 'halo-data-only', deletionImpact: { digitalHumans: [{ id: 'person', name: 'Analyst' }], activeWorkCount: 3 } } })
})

function migration() {
  const runner = new HookRunner()
  const onClose = vi.fn()
  const render = () => runner.render(() => WorkspaceMigrationDialog({ appId: 'person', spaceId: 'origin', onClose }))
  const choose = (value = 'destination') => nodes(render()).find(node => node.type === 'select')!.props!.onChange({ target: { value } })
  const check = async () => { choose(); button(render(), 'Preview change').props!.onClick(); await settle() }
  return { render, onClose, choose, check }
}

describe('workspace migration confirmation', () => {
  it('describes a full move and counts active chats and runs separately from decisions and sessions', async () => {
    const view = migration()
    expect(view.render().props.title).toBe('Change workspace')
    expect(text(view.render())).toContain('Memory and all conversations move to the new workspace together. Files in the project folder stay where they are.')
    expect(button(view.render(), 'Preview change').props!.disabled).toBe(true)
    await view.check()
    expect(env.preview).toHaveBeenCalledWith('person', 'destination')
    expect(text(view.render())).toContain('Ongoing work that will stop when you confirm: 3.')
    expect(text(view.render())).toContain('Pending decisions to keep: 4. Conversations to move: 5.')
    expect(text(view.render())).toContain('Destination skill')
    expect(text(view.render())).toContain('Origin skill')
    expect(text(view.render())).not.toContain('original environment')
    button(view.render(), 'Cancel').props!.onClick()
    expect(view.onClose).toHaveBeenCalledOnce()
    expect(env.move).not.toHaveBeenCalled()
  })

  it('does not warn that idle work will stop and resets the preview when the destination changes', async () => {
    env.preview.mockResolvedValue({ success: true, data: preview({ activeRunCount: 0, activeChatCount: 0 }) })
    const view = migration()
    await view.check()
    expect(text(view.render())).not.toContain('Ongoing work that will stop when you confirm:')
    view.choose('halo-temp')
    expect(text(view.render())).not.toContain('Conversations to move:')
    expect(button(view.render(), 'Preview change').props!.disabled).toBe(false)
    expect(env.move).not.toHaveBeenCalled()
  })

  it('moves only after confirmation and keeps an accurate success notice after closing', async () => {
    const view = migration()
    await view.check()
    expect(env.move).not.toHaveBeenCalled()
    button(view.render(), 'Move here').props!.onClick()
    await settle()
    expect(env.move).toHaveBeenCalledWith('person', 'destination')
    expect(view.onClose).toHaveBeenCalledOnce()
    expect(env.notify).toHaveBeenCalledWith(expect.objectContaining({ variant: 'success', body: 'Memory and all conversations moved to the new workspace. Project files stayed where they were.' }))
  })

  it('keeps failures retryable without claiming that ongoing work is unchanged', async () => {
    env.move.mockResolvedValue(false)
    const view = migration()
    await view.check()
    button(view.render(), 'Move here').props!.onClick()
    await settle()
    expect(view.onClose).not.toHaveBeenCalled()
    expect(env.notify).not.toHaveBeenCalled()
    expect(text(view.render())).toContain('Running work may have stopped.')
    expect(text(view.render())).not.toContain('Existing work is unchanged')
    expect(button(view.render(), 'Move here').props!.disabled).toBe(false)
  })

  it('does not close or allow another action while the move is pending', async () => {
    let finish!: (result: boolean) => void
    env.move.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const view = migration()
    await view.check()
    button(view.render(), 'Move here').props!.onClick()
    const pending = view.render()
    expect(button(pending, 'Move here').props!.disabled).toBe(true)
    expect(button(pending, 'Cancel').props!.disabled).toBe(true)
    pending.props.onClose()
    expect(view.onClose).not.toHaveBeenCalled()
    finish(true)
    await settle()
    expect(view.onClose).toHaveBeenCalledOnce()
  })

  it('leaves the dialog open and never moves when preview fails', async () => {
    env.preview.mockResolvedValue({ success: false, error: 'Destination unavailable' })
    const view = migration()
    await view.check()
    expect(text(view.render())).toContain('Destination unavailable')
    expect(env.move).not.toHaveBeenCalled()
    expect(view.onClose).not.toHaveBeenCalled()
    expect(button(view.render(), 'Preview change').props!.disabled).toBe(false)
  })
})

function card() {
  const runner = new HookRunner()
  const space = { id: 'origin', name: 'Origin', path: '/fixture/origin', isTemp: false } as Space
  const render = () => runner.render(() => SpaceCard({ space, onOpen: vi.fn() }))
  const openMenu = () => nodes(render()).find(node => node.type === 'button' && node.props?.title === 'More')!.props!.onClick({ stopPropagation: vi.fn() })
  const remove = async () => { openMenu(); await button(render(), 'Delete').props!.onClick() }
  return { render, remove }
}

describe('workspace deletion confirmation', () => {
  it('loads impact only on deletion and names rescued people, retained history and stopped work', async () => {
    const view = card()
    view.render()
    expect(env.getSpace).not.toHaveBeenCalled()
    await view.remove()
    expect(env.getSpace).toHaveBeenCalledWith('origin', { includeDeletionImpact: true })
    expect(env.confirm).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('These digital humans will move to Halo Workspace with their memory and all conversations: Analyst.'),
    }))
    const message = env.confirm.mock.calls[0][0].message
    expect(message).toContain('Your project files will be kept in the current project folder.')
    expect(message).toContain('Ongoing work that will stop when you confirm: 3.')
    expect(env.deleteSpace).toHaveBeenCalledWith('origin')
  })

  it('does not stop work or delete anything when confirmation is cancelled', async () => {
    env.confirm.mockResolvedValue(false)
    await card().remove()
    expect(env.deleteSpace).not.toHaveBeenCalled()
    expect(env.notify).not.toHaveBeenCalled()
  })

  it('states workspace-file deletion without claiming that rescued conversations are deleted', async () => {
    env.getSpace.mockResolvedValue({ success: true, data: { deletionEffect: 'workspace-files', deletionImpact: { digitalHumans: [], activeWorkCount: 0 } } })
    await card().remove()
    const message = env.confirm.mock.calls[0][0].message
    expect(message).toBe('Workspace conversations and files will be deleted.')
    expect(message).not.toContain('All conversations')
    expect(message).not.toContain('Ongoing work that will stop when you confirm:')
  })

  it.each([
    { success: false },
    { success: true, data: { deletionEffect: 'halo-data-only' } },
    { success: true, data: { deletionEffect: 'halo-data-only', deletionImpact: { digitalHumans: [], activeWorkCount: -1 } } },
  ])('refuses to confirm when deletion impact is unavailable: %j', async response => {
    env.getSpace.mockResolvedValue(response)
    await card().remove()
    expect(env.confirm).not.toHaveBeenCalled()
    expect(env.deleteSpace).not.toHaveBeenCalled()
    expect(env.notify).toHaveBeenCalledWith(expect.objectContaining({ variant: 'error', title: 'Could not delete this workspace. Please try again.' }))
  })

  it.each(['failed', 'busy'])('reports a failed delete without telling users to wait for work: %s', async result => {
    env.deleteSpace.mockResolvedValue(result)
    await card().remove()
    expect(env.notify).toHaveBeenCalledWith(expect.objectContaining({ variant: 'error', title: 'Could not delete this workspace. Some work may have stopped. Please try again.' }))
  })
})
