/**
 * The one way a link leaves Halo for the operating system: every
 * `window.open` / `target=_blank` from the main window and the renderer's
 * `openExternal` call end here.
 *
 * - web and mail links open in the default app;
 * - `halo:` links are Halo's own, handled in-process;
 * - a local `file:` link is never run: the file is shown in its folder;
 * - any other target (an app protocol, a file on another host) can start a
 *   program, so it opens only after the person confirms the full address;
 * - schemes that run code in whatever follows them are refused.
 *
 * Nothing goes through a shell: `shell.openExternal` hands the URL to the OS
 * as data, where a shell command line could expand parts of it.
 */

import { app, dialog, shell, type BrowserWindow } from 'electron'
import { fileURLToPath } from 'url'
import { handleDeepLinkUrl } from './deep-link.service'
import { getDeepLinkScheme } from '../foundation/product-config'

export type ExternalLinkAction =
  | { kind: 'open' }
  | { kind: 'deep-link' }
  | { kind: 'reveal'; path: string }
  | { kind: 'confirm' }
  | { kind: 'refuse' }

const OPEN_DIRECTLY = new Set(['http:', 'https:', 'mailto:'])
const REFUSED = new Set(['javascript:', 'vbscript:', 'data:'])

export function classifyExternalLink(raw: string): ExternalLinkAction {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { kind: 'refuse' }
  }
  if (OPEN_DIRECTLY.has(url.protocol)) return { kind: 'open' }
  if (url.protocol === `${getDeepLinkScheme()}:`) return { kind: 'deep-link' }
  if (REFUSED.has(url.protocol)) return { kind: 'refuse' }
  if (url.protocol === 'file:' && (!url.host || url.host === 'localhost')) {
    try {
      url.host = ''
      url.search = ''
      url.hash = ''
      return { kind: 'reveal', path: fileURLToPath(url) }
    } catch {
      return { kind: 'refuse' }
    }
  }
  return { kind: 'confirm' }
}

function confirmCopy(): { message: string; open: string; cancel: string } {
  // The main process has no renderer translations; it follows the OS language
  // like Halo's other native dialogs.
  return app.getLocale().toLowerCase().startsWith('zh')
    ? { message: '用其他应用打开这个链接？', open: '打开', cancel: '取消' }
    : { message: 'Open this link in another app?', open: 'Open', cancel: 'Cancel' }
}

async function confirmOpen(url: string, parent: BrowserWindow | null): Promise<boolean> {
  const copy = confirmCopy()
  const options: Electron.MessageBoxOptions = {
    type: 'question',
    title: 'Halo',
    message: copy.message,
    detail: url,
    buttons: [copy.open, copy.cancel],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  }
  try {
    const { response } = parent && !parent.isDestroyed()
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options)
    if (response !== 0) console.log('[ExternalLink] Not opened: the person declined')
    return response === 0
  } catch (error) {
    console.error('[ExternalLink] The confirmation could not be shown; the link stays closed:', error)
    return false
  }
}

async function openWithOs(url: string, scheme: string): Promise<void> {
  try {
    await shell.openExternal(url)
  } catch (error) {
    console.warn(`[ExternalLink] The system could not open a ${scheme} link:`, error)
  }
}

export async function openExternalLink(raw: string, parent: BrowserWindow | null = null): Promise<void> {
  const action = classifyExternalLink(raw)
  const scheme = /^[a-z][a-z0-9+.-]*:/i.exec(raw)?.[0].toLowerCase() ?? 'no-scheme'
  switch (action.kind) {
    case 'open':
      await openWithOs(raw, scheme)
      return
    case 'deep-link':
      handleDeepLinkUrl(raw)
      return
    case 'reveal':
      shell.showItemInFolder(action.path)
      return
    case 'confirm':
      if (await confirmOpen(raw, parent)) await openWithOs(raw, scheme)
      return
    case 'refuse':
      console.warn(`[ExternalLink] Refused a ${scheme} link: it would run code or is not a URL`)
      return
  }
}
