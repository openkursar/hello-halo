/**
 * The diagnostics row for the child process's local connection: healthy,
 * failed with its reason, and — only when the system refused it — the program
 * to hand to IT.
 */

import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('../../../src/renderer/i18n', () => ({
  useTranslation: () => ({
    t: (text: string, values?: Record<string, string>) =>
      text.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => values?.[name] ?? ''),
  }),
}))

import { ChildLocalConnectionRow } from '../../../src/renderer/components/settings/ChildLocalConnectionRow'

const render = (check: Parameters<typeof ChildLocalConnectionRow>[0]['check']) =>
  renderToStaticMarkup(createElement(ChildLocalConnectionRow, { check }))

describe('ChildLocalConnectionRow', () => {
  it('shows a connection that went through', () => {
    const html = render({ reachable: true, blocked: false, program: '/halo' })

    expect(html).toContain('Child process local connection')
    expect(html).toContain('Healthy')
    expect(html).not.toContain('IT team')
  })

  it('names the program to allow when the system refused the connection', () => {
    const html = render({ reachable: false, blocked: true, error: 'EACCES', program: 'C:\\Halo\\Halo.exe' })

    expect(html).toContain('Failed')
    expect(html).toContain('(EACCES)')
    expect(html).toContain('Ask your IT team to allow this program to make local connections: C:\\Halo\\Halo.exe')
  })

  it('gives only the reason for any other failure', () => {
    const html = render({ reachable: false, blocked: false, error: 'ECONNREFUSED', program: '/halo' })

    expect(html).toContain('(ECONNREFUSED)')
    expect(html).not.toContain('IT team')
  })
})
