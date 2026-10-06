/**
 * planMessageParts decides from BODYSTRUCTURE which parts email_read downloads.
 * Attachments are listed, never fetched; anything mailparser would assemble
 * differently from the shapes it knows is left to a whole-message read (null).
 */

import { describe, expect, it } from 'vitest'
import { approximateSizeLabel, decodedSize, planMessageParts, type BodyStructureNode } from '../../../../src/main/services/email-mcp/message-parts'

const plain = (part: string, extra: Partial<BodyStructureNode> = {}): BodyStructureNode =>
  ({ part, type: 'text/plain', encoding: 'quoted-printable', size: 120, ...extra })
const html = (part: string, extra: Partial<BodyStructureNode> = {}): BodyStructureNode =>
  ({ part, type: 'text/html', encoding: 'base64', size: 900, ...extra })
const pdf = (part: string): BodyStructureNode =>
  ({ part, type: 'application/pdf', encoding: 'base64', size: 78_000, disposition: 'attachment' })
const image = (part: string, id?: string): BodyStructureNode =>
  ({ part, type: 'image/png', encoding: 'base64', size: 780, disposition: 'inline', ...(id ? { id } : {}) })
const multipart = (subtype: string, childNodes: BodyStructureNode[], part?: string): BodyStructureNode =>
  ({ ...(part ? { part } : {}), type: `multipart/${subtype}`, childNodes })

describe('planMessageParts', () => {
  it('downloads the plain and HTML alternatives and only lists the attachment', () => {
    const plan = planMessageParts(multipart('mixed', [
      multipart('alternative', [plain('1.1'), html('1.2')], '1'),
      pdf('2'),
    ]))

    expect(plan).toEqual({
      plainPart: '1.1',
      htmlPart: '1.2',
      attachments: [{ part: '2', size: decodedSize({ encoding: 'base64', size: 78_000 }), related: false }],
    })
  })

  it('marks images an HTML body references inline as related', () => {
    const plan = planMessageParts(multipart('related', [
      multipart('alternative', [plain('1.1'), html('1.2')], '1'),
      image('2', '<logo@example.com>'),
      image('3'),
    ]))

    expect(plan?.attachments.map(att => [att.part, att.related])).toEqual([['2', true], ['3', false]])
  })

  it('takes a lone HTML or plain body wherever it sits', () => {
    expect(planMessageParts(multipart('mixed', [html('1'), pdf('2')]))).toMatchObject({ htmlPart: '1', plainPart: undefined })
    expect(planMessageParts(multipart('mixed', [plain('1'), pdf('2')]))).toMatchObject({ plainPart: '1', htmlPart: undefined })
    expect(planMessageParts(multipart('alternative', [html('1'), { part: '2', type: 'text/calendar', size: 300 }])))
      .toMatchObject({ htmlPart: '1', attachments: [{ part: '2' }] })
  })

  it('lists text files and attached messages as attachments, not bodies', () => {
    const plan = planMessageParts(multipart('mixed', [
      plain('1'),
      plain('2', { disposition: 'attachment' }),
      { part: '3', type: 'message/rfc822', size: 4000, disposition: 'attachment', childNodes: [plain('3')] },
      { part: '4', type: 'message/rfc822', size: 4000, encoding: 'base64', disposition: 'inline' },
    ]))

    expect(plan).toMatchObject({ plainPart: '1', attachments: [{ part: '2' }, { part: '3' }, { part: '4' }] })
  })

  it('plans a message with attachments only', () => {
    expect(planMessageParts(multipart('mixed', [pdf('1'), pdf('2')]))).toEqual({
      plainPart: undefined,
      htmlPart: undefined,
      attachments: [expect.objectContaining({ part: '1' }), expect.objectContaining({ part: '2' })],
    })
  })

  it.each([
    ['a single-part message', plain('1')],
    ['no structure', undefined],
    ['an inline forwarded message', multipart('mixed', [plain('1'), { part: '2', type: 'message/rfc822', disposition: 'inline', size: 900 }])],
    ['a delivery report', multipart('report', [plain('1'), { part: '2', type: 'message/delivery-status', size: 300 }])],
    ['two plain bodies', multipart('mixed', [plain('1'), pdf('2'), plain('3')])],
    ['plain and HTML that are not alternatives', multipart('mixed', [plain('1'), html('2')])],
    ['a leaf without a part number', multipart('mixed', [{ type: 'text/plain', size: 10 }])],
    ['an empty multipart', multipart('mixed', [multipart('alternative', [], '1')])],
  ] as const)('leaves %s to a whole-message read', (_label, structure) => {
    expect(planMessageParts(structure as BodyStructureNode | undefined)).toBeNull()
  })
})

describe('decodedSize', () => {
  it('estimates base64 content from its encoded size', () => {
    const content = Buffer.alloc(3 * 1024 * 1024, 7)
    const encoded = content.toString('base64').replace(/.{76}/g, '$&\r\n')

    const estimate = decodedSize({ encoding: 'base64', size: Buffer.byteLength(encoded) })

    expect(Math.abs(estimate - content.length)).toBeLessThanOrEqual(3)
  })

  it('reports other encodings as they are', () => {
    expect(decodedSize({ encoding: '7bit', size: 512 })).toBe(512)
    expect(decodedSize({ size: 512 })).toBe(512)
    expect(decodedSize({ encoding: 'base64' })).toBe(0)
  })
})

describe('approximateSizeLabel', () => {
  it.each([
    [900, '~900 B (estimated)'],
    [1536, '~1.5 KB (estimated)'],
    [512 * 1024 - 1, '~512 KB (estimated)'],
    [1.2 * 1024 * 1024, '~1.2 MB (estimated)'],
    [1024 * 1024 - 20, '~1 MB (estimated)'],
    [3 * 1024 ** 3, '~3 GB (estimated)'],
    [2048 * 1024 ** 3, '~2048 GB (estimated)'],
  ])('labels %d bytes as %s', (bytes, label) => {
    expect(approximateSizeLabel(bytes)).toBe(label)
  })
})
