/** The card is rendered without a DOM so its bubbling key handler can be exercised directly. */
import { expect, it, vi } from 'vitest'
import type { InstalledApp } from '../../../src/shared/apps/app-types'

vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => [typeof initial === 'function' ? (initial as () => unknown)() : initial, () => {}],
  useRef: (initial: unknown) => ({ current: initial }),
  useEffect: () => {},
  useCallback: (fn: unknown) => fn,
}))
vi.mock('../../../src/renderer/stores/apps.store', () => ({
  useAppsStore: () => ({ pauseApp: vi.fn(), resumeApp: vi.fn(), uninstallApp: vi.fn(), moveAppToSpace: vi.fn(), reinstallApp: vi.fn(), updateAppOverrides: vi.fn() }),
  useMcpDependents: () => ({}),
}))
vi.mock('../../../src/renderer/stores/space.store', () => ({ useSpaceStore: (select: (state: unknown) => unknown) => select({ haloSpace: null, spaces: [] }) }))
vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string) => text }), getCurrentLanguage: () => 'en' }))
vi.mock('../../../src/renderer/api', () => ({ api: {} }))
vi.mock('../../../src/renderer/hooks/useConfirmDialog', () => ({ useConfirmDialog: () => ({ showConfirm: vi.fn(), DialogComponent: null }) }))
vi.mock('../../../src/renderer/components/tags/useTagActions', () => ({ notifyTagError: vi.fn() }))

import { McpCard } from '../../../src/renderer/components/apps/McpCard'

const app = {
  id: 'mcp-ledger', specId: 'ledger', spaceId: null, status: 'active', userOverrides: { tags: ['Finance'] },
  permissions: { granted: [], denied: [] },
  spec: { spec_version: '1.0', type: 'mcp', name: 'Ledger alpha', description: 'Reads the ledger', version: '1.0.0', author: 'Tester', mcp_server: { transport: 'stdio', command: 'ledger' } },
} as unknown as InstalledApp

type KeyEvent = { key: string; target: unknown; currentTarget: unknown }

function card(onOpen: () => void) {
  return McpCard({ app, spaceMap: {}, onOpen }) as unknown as { props: { role: string; onKeyDown: (event: KeyEvent) => void } }
}

it('opens the detail when Enter is pressed on the focused card', () => {
  const onOpen = vi.fn()
  const root = card(onOpen)
  expect(root.props.role).toBe('button')
  const focused = {}
  root.props.onKeyDown({ key: 'Enter', target: focused, currentTarget: focused })
  expect(onOpen).toHaveBeenCalledTimes(1)
})

it('stays on the list when Enter is pressed in a control inside the card, such as the tag input', () => {
  const onOpen = vi.fn()
  card(onOpen).props.onKeyDown({ key: 'Enter', target: { tagName: 'INPUT' }, currentTarget: {} })
  expect(onOpen).not.toHaveBeenCalled()
})
