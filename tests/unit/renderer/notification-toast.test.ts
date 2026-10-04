/**
 * Toasts reach screen readers: errors through an alert region, everything else
 * through a polite status region, both mounted even with nothing to say; the
 * cards carry no live role of their own, so each toast is read once, and their
 * close buttons have a name.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ToastItem } from '../../../src/renderer/stores/notification.store'

// Server rendering reads a zustand store's initial state, so the store hands the component this state instead.
const { state } = vi.hoisted(() => ({ state: { toasts: [] as ToastItem[], dismiss: () => {} } }))
vi.mock('../../../src/renderer/stores/notification.store', () => ({
  useNotificationStore: (select: (current: typeof state) => unknown) => select(state),
}))
vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string) => text }) }))

import { NotificationToast } from '../../../src/renderer/components/notification/NotificationToast'

const STATUS_OPEN = '<div role="status" aria-live="polite" aria-atomic="false" class="sr-only">'
const ALERT_OPEN = '<div role="alert" aria-live="assertive" aria-atomic="false" class="sr-only">'

function toast(fields: Partial<ToastItem> & Pick<ToastItem, 'id' | 'title' | 'variant'>): ToastItem {
  return { duration: 4000, createdAt: 1, ...fields }
}

/** The two live regions' contents and the visible stack, from the rendered markup. */
function render() {
  const markup = renderToStaticMarkup(createElement(NotificationToast))
  const statusStart = markup.indexOf(STATUS_OPEN)
  const alertStart = markup.indexOf(ALERT_OPEN)
  const stackStart = markup.indexOf('<div class="fixed')
  return {
    markup,
    status: markup.slice(statusStart + STATUS_OPEN.length, alertStart - '</div>'.length),
    alert: markup.slice(alertStart + ALERT_OPEN.length, (stackStart === -1 ? markup.length : stackStart) - '</div>'.length),
    stack: stackStart === -1 ? '' : markup.slice(stackStart),
    regionsFirst: statusStart === 0 && alertStart > statusStart,
  }
}

const count = (text: string, part: string) => text.split(part).length - 1

beforeEach(() => {
  state.toasts = []
})

describe('NotificationToast announcements', () => {
  it('keeps both live regions mounted, and empty, when no toast is showing', () => {
    const { markup, status, alert, stack, regionsFirst } = render()
    expect(regionsFirst).toBe(true)
    expect(status).toBe('')
    expect(alert).toBe('')
    expect(stack).toBe('')
    expect(markup).toBe(`${STATUS_OPEN}</div>${ALERT_OPEN}</div>`)
  })

  it('reads errors as alerts and everything else politely, each toast once', () => {
    state.toasts = [
      toast({ id: 'added', title: 'Added to “Greeting update”', variant: 'default' }),
      toast({ id: 'commit', title: 'Committed 9f3c2ab', variant: 'success' }),
      toast({ id: 'push', title: 'Committed 9f3c2ab, but the push failed', body: 'Couldn’t reach the remote.', variant: 'warning' }),
      toast({ id: 'failed', title: 'Git failed', body: 'fatal: bad object HEAD', variant: 'error' }),
    ]
    const { status, alert, stack } = render()

    expect(status).toContain('Added to “Greeting update”')
    expect(status).toContain('Committed 9f3c2ab, but the push failed')
    expect(status).toContain('Couldn’t reach the remote.')
    expect(status).not.toContain('Git failed')
    expect(alert).toContain('Git failed')
    expect(alert).toContain('fatal: bad object HEAD')
    expect(alert).not.toContain('Committed')

    // One line per toast across both regions.
    const live = status + alert
    expect(count(live, 'Added to “Greeting update”')).toBe(1)
    expect(count(live, 'Git failed')).toBe(1)
    expect(count(live, '<div>')).toBe(4)

    // The visible cards are not live regions themselves, so nothing is read twice.
    expect(stack).toContain('Git failed')
    expect(stack).not.toContain('aria-live')
    expect(stack).not.toContain('role="status"')
    expect(stack).not.toContain('role="alert"')
    // Every card's close button is named, not just "button".
    expect(count(stack, 'aria-label="Dismiss"')).toBe(4)
  })

  it('reads only the title of a markdown body', () => {
    state.toasts = [toast({ id: 'notes', title: 'Halo 3.0 is ready', body: '- **Changes** view\n- Inline comments', bodyFormat: 'markdown', variant: 'success', duration: 0 })]
    const { status } = render()
    expect(status).toContain('Halo 3.0 is ready')
    expect(status).not.toContain('Inline comments')
  })
})
