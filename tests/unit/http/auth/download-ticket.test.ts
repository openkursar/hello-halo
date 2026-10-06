/**
 * Download links carry a ticket instead of the access token: bound to one file,
 * good for two minutes and for every request in that time, unknown to anyone
 * who forges one. The API gate admits a ticket link without a token, while
 * asking for a ticket still takes the bearer token.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NextFunction, Request, Response } from 'express'

vi.mock('../../../../src/main/services/security-policy', () => ({
  isCredentialAtRestSafe: vi.fn(() => false),
}))

import {
  isDownloadTicketPath,
  issueDownloadTicket,
  redeemDownloadTicket,
} from '../../../../src/main/http/auth/download-ticket'
import { authMiddleware } from '../../../../src/main/http/auth/middleware'
import { clearAccessToken, setCustomAccessToken } from '../../../../src/main/http/auth/token-store'

afterEach(() => {
  vi.useRealTimers()
  clearAccessToken()
})

describe('download tickets', () => {
  it('open only their own file, as often as needed within two minutes', () => {
    vi.useFakeTimers()
    const report = issueDownloadTicket('/space/report.docx')
    const photo = issueDownloadTicket('/space/photo.png')

    expect(report).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(redeemDownloadTicket(report)).toBe('/space/report.docx')
    expect(redeemDownloadTicket(report)).toBe('/space/report.docx')
    expect(redeemDownloadTicket(photo)).toBe('/space/photo.png')

    vi.advanceTimersByTime(119_000)
    expect(redeemDownloadTicket(report)).toBe('/space/report.docx')
    vi.advanceTimersByTime(1_000)
    expect(redeemDownloadTicket(report)).toBeNull()
  })

  it('know nothing of a forged or altered ticket', () => {
    const ticket = issueDownloadTicket('/space/report.docx')
    expect(redeemDownloadTicket('A'.repeat(43))).toBeNull()
    expect(redeemDownloadTicket(`${ticket.slice(0, -1)}${ticket.endsWith('A') ? 'B' : 'A'}`)).toBeNull()
    expect(redeemDownloadTicket('')).toBeNull()
  })

  it('keep at most 256, dropping the oldest', () => {
    const first = issueDownloadTicket('/space/first.txt')
    for (let i = 0; i < 256; i++) issueDownloadTicket(`/space/${i}.txt`)
    expect(redeemDownloadTicket(first)).toBeNull()
  })
})

function gate(req: Partial<Request>): { passed: boolean; status: number } {
  let status = 200
  let passed = false
  const res = { status(code: number) { status = code; return this }, json() { return this } }
  authMiddleware({ headers: {}, query: {}, ...req } as Request, res as unknown as Response, (() => { passed = true }) as NextFunction)
  return { passed, status }
}

describe('the API gate and ticket links', () => {
  // Mounted at /api, so Express hands the middleware the path without that prefix.
  const mounted = (path: string, headers: Record<string, string> = {}) => ({ baseUrl: '/api', path, headers })

  it('admits a ticket link without a token', () => {
    expect(gate(mounted(`/artifacts/file/${'a'.repeat(43)}`)).passed).toBe(true)
  })

  it('admits nothing else on that route without a token', () => {
    for (const path of ['/artifacts/file/short', `/artifacts/file/${'a'.repeat(43)}/x`, `/artifacts/file/${'a'.repeat(42)}.`, '/artifacts/file/']) {
      expect(gate(mounted(path)), path).toEqual({ passed: false, status: 401 })
    }
  })

  it('still asks for the bearer token to issue a ticket', () => {
    expect(setCustomAccessToken('Aa1!Aa1!').ok).toBe(true)
    expect(gate(mounted('/artifacts/download-ticket'))).toEqual({ passed: false, status: 401 })
    expect(gate(mounted('/artifacts/download-ticket', { authorization: 'Bearer wrong' }))).toEqual({ passed: false, status: 401 })
    expect(gate(mounted('/artifacts/download-ticket', { authorization: 'Bearer Aa1!Aa1!' })).passed).toBe(true)
  })

  it('matches ticket paths exactly', () => {
    expect(isDownloadTicketPath(`/api/artifacts/file/${'_-'.repeat(21)}a`)).toBe(true)
    expect(isDownloadTicketPath(`/api/artifacts/file/${'a'.repeat(44)}`)).toBe(false)
    expect(isDownloadTicketPath(`/api/artifacts/files/${'a'.repeat(43)}`)).toBe(false)
  })
})
