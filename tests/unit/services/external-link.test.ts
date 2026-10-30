/**
 * Links leaving Halo: web links open without a shell, local files are shown in
 * their folder and never run, other targets wait for the person's confirmation,
 * and code-running schemes are refused.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const openExternal = vi.fn(async (_url: string) => undefined)
const showItemInFolder = vi.fn()
const showMessageBox = vi.fn(async () => ({ response: 1 }))
vi.mock('electron', () => ({
  app: { getLocale: () => 'en-US' },
  dialog: { showMessageBox: (...args: unknown[]) => showMessageBox(...(args as [])) },
  shell: {
    openExternal: (url: string) => openExternal(url),
    showItemInFolder: (path: string) => showItemInFolder(path),
  },
}))
const handleDeepLinkUrl = vi.fn()
let deepLinkScheme = 'halo'
vi.mock('../../../src/main/foundation/product-config', () => ({
  getDeepLinkScheme: () => deepLinkScheme,
}))
vi.mock('../../../src/main/services/deep-link.service', () => ({
  handleDeepLinkUrl: (url: string) => handleDeepLinkUrl(url),
}))
const openPackage = vi.fn()
vi.mock('open', () => ({ default: openPackage }))

import { classifyExternalLink, openExternalLink } from '../../../src/main/services/external-link.service'

beforeEach(() => {
  vi.clearAllMocks()
  deepLinkScheme = 'halo'
  showMessageBox.mockResolvedValue({ response: 1 })
})

describe('classifyExternalLink', () => {
  it('opens web and mail links directly', () => {
    for (const url of ['https://example.com/a', 'http://example.com', 'mailto:a@example.com']) {
      expect(classifyExternalLink(url)).toEqual({ kind: 'open' })
    }
  })

  it('reveals a local file instead of running it', () => {
    expect(classifyExternalLink('file:///Users/me/Downloads/run.command')).toEqual({ kind: 'reveal', path: '/Users/me/Downloads/run.command' })
    expect(classifyExternalLink('file://localhost/tmp/a%20b.txt?x=1#y')).toEqual({ kind: 'reveal', path: '/tmp/a b.txt' })
  })

  it('asks before a file on another host or any app protocol', () => {
    for (const url of ['file://attacker.example/share/setup.exe', 'ms-msdt:/id PCWDiagnostic', 'search-ms:query=x', 'smb://host/share', 'vscode://file/a']) {
      expect(classifyExternalLink(url)).toEqual({ kind: 'confirm' })
    }
  })

  it('handles Halo links itself', () => {
    expect(classifyExternalLink('halo://join?office=o&invite=i&server=https://s')).toEqual({ kind: 'deep-link' })
  })

  it('keeps experimental and stable app links separate', () => {
    deepLinkScheme = 'halo-experimental'
    expect(classifyExternalLink('halo-experimental://join?office=o')).toEqual({ kind: 'deep-link' })
    expect(classifyExternalLink('halo://join?office=o')).toEqual({ kind: 'confirm' })
  })

  it('refuses code-running schemes and non-URLs', () => {
    for (const url of ['javascript:alert(1)', 'JavaScript:alert(1)', 'vbscript:x', 'data:text/html,<script>1</script>', 'not a url', '']) {
      expect(classifyExternalLink(url)).toEqual({ kind: 'refuse' })
    }
  })
})

describe('openExternalLink', () => {
  it('hands a web link to the OS unchanged, never to a shell command', async () => {
    const url = 'https://example.com/$(calc)'
    await openExternalLink(url)
    expect(openExternal).toHaveBeenCalledWith(url)
    expect(openPackage).not.toHaveBeenCalled()
    expect(showMessageBox).not.toHaveBeenCalled()
  })

  it('shows a local file in its folder and does not open it', async () => {
    await openExternalLink('file:///tmp/x/$(calc).txt')
    expect(showItemInFolder).toHaveBeenCalledWith('/tmp/x/$(calc).txt')
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('opens an app link only after the person confirms the full address', async () => {
    const url = 'ms-msdt:/id PCWDiagnostic /skip force'
    await openExternalLink(url)
    expect(showMessageBox).toHaveBeenCalledTimes(1)
    const [options] = showMessageBox.mock.calls[0] as unknown as [Electron.MessageBoxOptions]
    expect(options.detail).toBe(url)
    expect(options.buttons).toEqual(['Open', 'Cancel'])
    expect(options.cancelId).toBe(1)
    expect(options.defaultId).toBe(1)
    expect(openExternal).not.toHaveBeenCalled()

    showMessageBox.mockResolvedValue({ response: 0 })
    await openExternalLink(url)
    expect(openExternal).toHaveBeenCalledWith(url)
  })

  it('asks before following a file link to another host', async () => {
    await openExternalLink('file://attacker.example/share/setup.exe')
    expect(showMessageBox).toHaveBeenCalledTimes(1)
    expect(showItemInFolder).not.toHaveBeenCalled()
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('routes a Halo link in-process', async () => {
    const url = 'halo://join?office=o&invite=i&server=https://s'
    await openExternalLink(url)
    expect(handleDeepLinkUrl).toHaveBeenCalledWith(url)
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('does nothing for a refused link', async () => {
    await openExternalLink('javascript:alert(1)')
    expect(openExternal).not.toHaveBeenCalled()
    expect(showMessageBox).not.toHaveBeenCalled()
    expect(showItemInFolder).not.toHaveBeenCalled()
  })

  it('keeps the link closed when the confirmation cannot be shown', async () => {
    showMessageBox.mockRejectedValue(new Error('no display'))
    await openExternalLink('smb://host/share')
    expect(openExternal).not.toHaveBeenCalled()
  })
})

describe('link exits', () => {
  it('send every link through this service, not the open package', () => {
    const root = join(__dirname, '../../../src/main')
    for (const file of ['index.ts', 'ipc/git-bash.ts']) {
      const source = readFileSync(join(root, file), 'utf8')
      expect(source).not.toMatch(/from 'open'/)
      expect(source).toContain('openExternalLink(')
    }
  })
})
