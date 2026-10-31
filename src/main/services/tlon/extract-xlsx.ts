import { posix } from 'node:path'
import { Readable } from 'node:stream'
import { setImmediate as yieldToMain } from 'node:timers/promises'
import type JSZip from 'jszip'

interface XmlVisitor {
  open?: (name: string, attributes: Record<string, string>) => void
  close?: (name: string) => void
  text?: (text: string) => void
}

interface Relationship {
  type: string
  target: string
  external: boolean
}

function localName(name: string): string {
  return name.slice(name.lastIndexOf(':') + 1)
}

function attribute(attributes: Record<string, string>, name: string): string | undefined {
  return Object.entries(attributes).find(([key]) => localName(key) === name)?.[1]
}

async function visitXml(zip: JSZip, part: string, visitor: XmlVisitor): Promise<void> {
  const file = zip.file(part)
  if (!file) throw new Error(`Spreadsheet part is missing: ${part}`)
  const { default: sax } = await import('sax')
  const parser = sax.parser(true, { xmlns: false, strictEntities: true })
  parser.onopentag = node => visitor.open?.(localName(node.name), node.attributes)
  parser.onclosetag = name => visitor.close?.(localName(name))
  parser.ontext = parser.oncdata = text => visitor.text?.(text)
  parser.onerror = error => { throw error }
  // JSZip's older Readable needs the native adapter for async iteration.
  const source = file.nodeStream('nodebuffer') as Readable
  const stream = new Readable({ highWaterMark: 16 * 1024 }).wrap(source)
  stream.setEncoding('utf8')
  try {
    for await (const chunk of stream) {
      parser.write(chunk as string)
      // Backpressure bounds decompression while other main-process work gets a turn.
      await yieldToMain()
    }
    parser.close()
  } finally {
    source.pause()
    source.destroy()
    stream.destroy()
  }
}

function relationshipPart(part: string): string {
  return posix.join(posix.dirname(part), '_rels', `${posix.basename(part)}.rels`)
}

function resolvePart(from: string, target: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) throw new Error('Spreadsheet relationship is not an internal package part')
  const decoded = decodeURIComponent(target)
  const part = decoded.startsWith('/') ? posix.normalize(decoded.slice(1)) : posix.normalize(posix.join(posix.dirname(from), decoded))
  if (part === '..' || part.startsWith('../')) throw new Error('Spreadsheet relationship escapes its package')
  return part
}

async function readRelationships(zip: JSZip, part: string): Promise<Map<string, Relationship>> {
  const relationships = new Map<string, Relationship>()
  await visitXml(zip, part, {
    open(name, attributes) {
      if (name !== 'Relationship') return
      const id = attribute(attributes, 'Id')
      const target = attribute(attributes, 'Target')
      const type = attribute(attributes, 'Type')
      if (id && target && type) relationships.set(id, { target, type, external: attribute(attributes, 'TargetMode') === 'External' })
    },
  })
  return relationships
}

async function readWorksheet(zip: JSZip, part: string, output: Array<string | number>, referenced: Set<number>): Promise<void> {
  const path: string[] = []
  let cell: { type: string; text: string[]; hasValue: boolean } | null = null
  let rowValues = 0
  await visitXml(zip, part, {
    open(name, attributes) {
      path.push(name)
      if (name === 'row' && path.at(-2) === 'sheetData') rowValues = 0
      if (name === 'c' && path.at(-2) === 'row' && path.includes('sheetData')) {
        cell = { type: attribute(attributes, 't') ?? 'n', text: [], hasValue: false }
      }
      if (cell && (name === 'v' || (name === 't' && cell.type === 'inlineStr' && path.includes('is') && !path.includes('rPh')))) cell.hasValue = true
    },
    text(text) {
      if (!cell) return
      if (path.at(-1) === 'v' || (cell.type === 'inlineStr' && path.at(-1) === 't' && path.includes('is') && !path.includes('rPh'))) cell.text.push(text)
    },
    close(name) {
      if (name === 'c' && cell) {
        if (cell.hasValue) {
          const value = cell.text.join('')
          if (cell.type === 's') {
            const index = Number(value.trim())
            if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(index)) throw new Error('Spreadsheet cell has an invalid shared-string reference')
            referenced.add(index)
            output.push(index, '\t')
          } else {
            // Formula text and links never run; only the stored value is indexed.
            output.push(value, '\t')
          }
          rowValues++
        }
        cell = null
      }
      if (name === 'row' && rowValues > 0) {
        output.pop()
        output.push('\n')
        rowValues = 0
      }
      path.pop()
    },
  })
}

async function readSharedStrings(zip: JSZip, part: string, referenced: Set<number>): Promise<Map<number, string>> {
  const strings = new Map<number, string>()
  const path: string[] = []
  let index = -1
  let text: string[] | null = null
  await visitXml(zip, part, {
    open(name) {
      path.push(name)
      if (name === 'si') {
        index++
        text = referenced.has(index) ? [] : null
      }
    },
    text(value) {
      if (text && path.at(-1) === 't' && !path.includes('rPh')) text.push(value)
    },
    close(name) {
      if (name === 'si' && text) {
        strings.set(index, text.join(''))
        text = null
      }
      path.pop()
    },
  })
  return strings
}

/** Read stored worksheet cells without allocating a dense sheet or evaluating formulas. */
export async function extractXlsx(buffer: Buffer): Promise<string> {
  const { default: JSZip } = await import('jszip')
  const zip = await JSZip.loadAsync(buffer)
  const root = await readRelationships(zip, '_rels/.rels')
  const document = [...root.values()].find(relation => relation.type.endsWith('/officeDocument') && !relation.external)
  if (!document) throw new Error('Spreadsheet workbook relationship is missing')
  const workbook = resolvePart('', document.target)
  const relationships = await readRelationships(zip, relationshipPart(workbook))
  const sheets: string[] = []
  await visitXml(zip, workbook, {
    open(name, attributes) {
      if (name !== 'sheet') return
      const relation = relationships.get(attribute(attributes, 'id') ?? '')
      if (!relation) throw new Error('Spreadsheet worksheet relationship is missing')
      if (relation.external) throw new Error('External spreadsheet worksheets cannot be read')
      if (relation.type.endsWith('/worksheet')) sheets.push(resolvePart(workbook, relation.target))
    },
  })
  const output: Array<string | number> = []
  const referenced = new Set<number>()
  for (const sheet of sheets) {
    if (output.length) output.push('\n')
    await readWorksheet(zip, sheet, output, referenced)
  }
  const shared = [...relationships.values()].find(relation => relation.type.endsWith('/sharedStrings') && !relation.external)
  const strings = referenced.size && shared ? await readSharedStrings(zip, resolvePart(workbook, shared.target), referenced) : new Map<number, string>()
  for (let index = 0; index < output.length; index++) {
    const value = output[index]
    if (typeof value === 'number') {
      if (!strings.has(value)) throw new Error(`Spreadsheet shared string ${value} is missing`)
      output[index] = strings.get(value)!
    }
    if (index % 1024 === 0) await yieldToMain()
  }
  return output.join('').trim()
}
