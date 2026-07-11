/**
 * halo:// deep-link service.
 *
 * Registers the app as the `halo` protocol handler and turns
 * `halo://join?office=&invite=&server=` (emitted by the browser invite landing
 * page) into a renderer event that opens the join-office dialog pre-filled —
 * the one-click join path: click the shared link in a browser → "Open in Halo"
 * → the app comes to front with the join dialog ready.
 *
 * Delivery is two-channel because a link can arrive BEFORE the renderer exists
 * (cold start from a browser click):
 *   - live push: `team:invite-link` via sendToRenderer when a window is up;
 *   - cold start: the last link is buffered and served once through
 *     consumePendingInviteLink() (IPC `team:consume-pending-invite`), which the
 *     renderer calls on startup.
 *
 * The deep link carries no more than the shareable http(s) invite link already
 * does (office id + invite token + server origin); it is normalized back into
 * that http(s) form so the renderer reuses the existing link parser unchanged.
 */

import { app } from 'electron'
import { resolve } from 'path'
import { getMainWindow, sendToRenderer } from '../foundation/window.service'

const LOG_TAG = '[DeepLink]'
const PROTOCOL = 'halo'

/** Renderer event channel carrying `{ link: string }`. */
export const TEAM_INVITE_LINK_EVENT = 'team:invite-link'

let pendingInviteLink: string | null = null

interface ParsedJoinLink {
  officeId: string
  inviteToken: string
  serverUrl: string
}

/** Parse `halo://join?office=&invite=&server=`; null for anything else. */
function parseJoinDeepLink(raw: string): ParsedJoinLink | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== `${PROTOCOL}:`) return null
  // Custom-scheme parsing differs across platforms: the action may land in the
  // host ("halo://join") or the pathname ("halo:/join"); accept both.
  const action = (url.host || url.pathname.replace(/^\/+/, '')).toLowerCase()
  if (action !== 'join') return null
  const officeId = url.searchParams.get('office')
  const inviteToken = url.searchParams.get('invite')
  const server = url.searchParams.get('server')
  if (!officeId || !inviteToken || !server) return null
  let serverUrl: string
  try {
    serverUrl = new URL(server).origin
  } catch {
    return null
  }
  if (!/^https?:$/.test(new URL(serverUrl).protocol)) return null
  return { officeId, inviteToken, serverUrl }
}

/** Normalize a parsed join deep link back into the shareable http(s) form. */
function toInviteLink(parsed: ParsedJoinLink): string {
  return `${parsed.serverUrl}/?office=${encodeURIComponent(parsed.officeId)}&invite=${encodeURIComponent(parsed.inviteToken)}`
}

function focusMainWindow(): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  if (!win.isVisible()) win.show()
  if (win.isMinimized()) win.restore()
  win.focus()
  if (process.platform === 'darwin') {
    app.dock?.show()
  }
}

/**
 * Handle one incoming deep-link URL (from open-url, argv, or second-instance).
 * Unknown/malformed URLs are ignored with a log — never a throw on this path.
 */
export function handleDeepLinkUrl(raw: string): void {
  const parsed = parseJoinDeepLink(raw)
  if (!parsed) {
    console.warn(`${LOG_TAG} ignored unrecognized deep link`)
    return
  }
  const link = toInviteLink(parsed)
  // Buffer for a renderer that is not up yet; a live renderer consumes the push
  // and the buffered copy is cleared on its startup consume call regardless.
  pendingInviteLink = link
  console.log(`${LOG_TAG} join link received office=${parsed.officeId}`)
  focusMainWindow()
  sendToRenderer(TEAM_INVITE_LINK_EVENT, { link })
}

/** Scan a process argv for a halo:// URL (Windows/Linux delivery path). */
export function handleDeepLinkArgv(argv: string[]): void {
  const url = argv.find((arg) => arg.startsWith(`${PROTOCOL}://`))
  if (url) handleDeepLinkUrl(url)
}

/**
 * One-shot pull of a link that arrived before the renderer was ready.
 * Clears the buffer so a stale invite never re-opens the dialog later.
 */
export function consumePendingInviteLink(): string | null {
  const link = pendingInviteLink
  pendingInviteLink = null
  return link
}

/**
 * Register the protocol handler + macOS open-url listener. Call once, before
 * app ready (open-url can fire during launch). Windows/Linux cold-start argv is
 * handled by the caller after ready (handleDeepLinkArgv(process.argv)).
 */
export function registerDeepLinkHandling(): void {
  // Dev builds need the executable + entry script spelled out for the OS to
  // route the protocol to THIS checkout instead of an installed build.
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [resolve(process.argv[1])])
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL)
  }

  app.on('open-url', (event, url) => {
    event.preventDefault()
    handleDeepLinkUrl(url)
  })

  console.log(`${LOG_TAG} registered ${PROTOCOL}:// handler`)
}
