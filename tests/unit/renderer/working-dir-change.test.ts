/**
 * Changing a workspace's folder from the renderer: a chat that could not start
 * because its folder is gone says which folder and offers to pick another one
 * right there; the workspace dialog shows the folder with the same action; a
 * remote page, which has no folder picker, says where to do it instead.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'

const env = vi.hoisted(() => ({
  runner: null as unknown as HookRunner,
  remote: false,
  selectFolder: vi.fn(),
  setSpaceWorkingDir: vi.fn(),
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
  render<T>(component: () => T): T {
    this.index = 0
    env.runner = this
    return component()
  }
}

vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => env.runner.state(initial),
  useCallback: (fn: unknown) => fn,
  useEffect: () => {},
}))
vi.mock('../../../src/renderer/api', () => ({
  api: {
    isRemoteMode: () => env.remote,
    selectFolder: env.selectFolder,
    getSpacePreferences: vi.fn(async () => ({ success: true, data: {} })),
  },
}))
vi.mock('../../../src/renderer/stores/space.store', () => {
  const state = () => ({ setSpaceWorkingDir: env.setSpaceWorkingDir, updateSpace: vi.fn(), updateSpacePreferences: vi.fn() })
  return { useSpaceStore: (select: (value: ReturnType<typeof state>) => unknown) => select(state()) }
})
vi.mock('../../../src/renderer/i18n', () => ({
  useTranslation: () => ({
    t: (text: string, values?: Record<string, unknown>) => text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values?.[name] ?? '')),
  }),
}))
vi.mock('../../../src/renderer/services/canvas-lifecycle', () => ({ canvasLifecycle: {} }))
vi.mock('../../../src/renderer/stores/team.store', () => ({ isRemoteMemberAppId: () => false }))
vi.mock('../../../src/renderer/components/space/SpaceColorSwatch', () => ({ SpaceColorSwatch: () => null }))
vi.mock('../../../src/renderer/components/ui/Disclosure', () => ({ Disclosure: () => null }))
vi.mock('../../../src/renderer/components/memory/MemorySettingsPanel', () => ({ MemorySettingsPanel: () => null }))

import { WorkingDirUnavailableNotice } from '../../../src/renderer/components/chat/WorkingDirUnavailableNotice'
import { EditSpaceDialog } from '../../../src/renderer/components/space/EditSpaceDialog'
import { SpaceColorSwatch } from '../../../src/renderer/components/space/SpaceColorSwatch'
import { SPACE_COLOR_CSS, spaceAvatarColor, type SpaceColorId } from '../../../src/renderer/components/space/spaceAvatarUtils'
import { createAgentEventsSlice } from '../../../src/renderer/stores/chat/agent-events'
import { createSessionSlice } from '../../../src/renderer/stores/chat/session'
import { createEmptySessionState, type ChatState } from '../../../src/renderer/stores/chat/internal'
import type { Space } from '../../../src/renderer/types'

type Node = { type?: unknown; props?: { children?: unknown; onClick?: () => unknown; disabled?: boolean } }

function nodes(tree: unknown): Node[] {
  if (!tree || typeof tree !== 'object') return []
  const node = tree as Node
  return [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)]
}

function text(tree: unknown): string {
  return nodes(tree).flatMap(node => [node.props?.children].flat(Infinity)).filter(child => typeof child === 'string').join(' ')
}

const buttons = (tree: unknown) => nodes(tree).filter(node => node.type === 'button')
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

const ISSUE = { spaceId: 'space-1', workDir: '/Users/me/Desktop/Halo folder' }

beforeEach(() => {
  env.remote = false
  env.selectFolder.mockReset().mockResolvedValue({ success: true, data: '/Users/me/Projects/halo' })
  env.setSpaceWorkingDir.mockReset().mockResolvedValue(null)
})

describe('the chat store', () => {
  it('keeps the folder a turn could not start in with its error', () => {
    const store = create<ChatState>((set, get) => ({
      sessions: new Map([['c', { ...createEmptySessionState(), isGenerating: true }]]),
      ...createAgentEventsSlice(set as never, get as never),
      ...createSessionSlice(set as never, get as never),
    }) as unknown as ChatState)

    store.getState().handleAgentError({
      spaceId: 'space-1', conversationId: 'c', error: 'Working directory does not exist',
      errorType: 'working_dir_unavailable', workDirIssue: ISSUE,
    })

    expect(store.getState().sessions.get('c')).toMatchObject({ errorType: 'working_dir_unavailable', workDirIssue: ISSUE, isGenerating: false })
  })
})

describe('WorkingDirUnavailableNotice', () => {
  it('names the folder and points the workspace at the one picked', async () => {
    const runner = new HookRunner()
    const view = () => WorkingDirUnavailableNotice({ issue: ISSUE })
    const before = runner.render(view)
    expect(text(before)).toContain('The working directory is unavailable')
    expect(text(before)).toContain('/Users/me/Desktop/Halo folder')

    await buttons(before)[0].props!.onClick!()
    await settle()

    expect(env.setSpaceWorkingDir).toHaveBeenCalledWith('space-1', '/Users/me/Projects/halo')
    expect(text(runner.render(view))).toContain('The working directory is now /Users/me/Projects/halo. Send your message again.')
  })

  it('changes nothing when the picker is closed, and says why when the change fails', async () => {
    const runner = new HookRunner()
    const view = () => WorkingDirUnavailableNotice({ issue: ISSUE })

    env.selectFolder.mockResolvedValueOnce({ success: true, data: null })
    await buttons(runner.render(view))[0].props!.onClick!()
    expect(env.setSpaceWorkingDir).not.toHaveBeenCalled()

    env.setSpaceWorkingDir.mockResolvedValueOnce('ENOSPC: no space left on device')
    await buttons(runner.render(view))[0].props!.onClick!()
    await settle()
    expect(text(runner.render(view))).toContain('Could not change the working directory: ENOSPC: no space left on device')
  })

  it('on a remote page, says the folder is changed in the desktop app', () => {
    env.remote = true
    const tree = new HookRunner().render(() => WorkingDirUnavailableNotice({ issue: ISSUE }))

    expect(buttons(tree)[0].props?.disabled).toBe(true)
    expect(text(tree)).toContain('The folder can only be changed in the desktop app.')
  })
})

describe('the workspace dialog', () => {
  const space = { id: 'space-1', name: 'Project', icon: 'folder', path: '/halo/spaces/space-1', isTemp: false, workingDir: '/Users/me/Desktop/Halo folder' } as Space

  it('shows the working directory and changes it at once', async () => {
    const runner = new HookRunner()
    const view = () => EditSpaceDialog({ space, onClose: () => {}, onSaved: () => {} })
    const tree = runner.render(view)
    expect(text(tree)).toContain('Working directory')
    expect(text(tree)).toContain('/Users/me/Desktop/Halo folder')

    const change = buttons(tree).find(node => text(node) === 'Change folder')!
    await change.props!.onClick!()
    await settle()

    const after = text(runner.render(view))
    expect(after).toContain('/Users/me/Projects/halo')
    expect(after).toContain('Changed. Conversations keep their history; any reply in progress finishes first.')
  })

  it('shows where a default-location workspace works', () => {
    const tree = new HookRunner().render(() => EditSpaceDialog({ space: { ...space, workingDir: undefined }, onClose: () => {}, onSaved: () => {} }))

    expect(text(tree)).toContain('/halo/spaces/space-1')
  })

  it('starts on the color the workspace is shown in, also when none was ever picked', () => {
    const pickedColor = (target: Space) => {
      const tree = new HookRunner().render(() => EditSpaceDialog({ space: target, onClose: () => {}, onSaved: () => {} }))
      const swatch = nodes(tree).find(node => node.type === SpaceColorSwatch) as { props: { value: string } }
      return swatch.props.value
    }

    expect(pickedColor({ ...space, color: 'danger' })).toBe('danger')
    for (const id of ['space-1', 'space-2', 'space-3', 'a', 'b']) {
      const uncolored = { ...space, id, color: undefined }
      expect(SPACE_COLOR_CSS[pickedColor(uncolored) as SpaceColorId]).toBe(spaceAvatarColor(uncolored))
    }
  })
})
