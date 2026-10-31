import { createHash, type Hash } from 'node:crypto'
import { Readable } from 'node:stream'
import { setImmediate as yieldToMain } from 'node:timers/promises'

interface OutputHash {
  value: Hash
  trimmed: Hash
  started: boolean
}

const entities: Record<string, string> = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&amp;': '&' }
const entityNames = Object.keys(entities)

function append(state: OutputHash, text: string) {
  if (!state.started) {
    text = text.trimStart()
    if (!text) return
    state.started = true
  }
  const content = text.trimEnd()
  if (content) {
    state.value.update(content)
    state.trimmed = state.value.copy()
  }
  state.value.update(text.slice(content.length))
}

/** Identify only the previous sharedStrings-only output; never use it as new extraction. */
export async function legacyXlsxTextHash(buffer: Buffer, sourcePath: string): Promise<string | null> {
  const { default: JSZip } = await import('jszip')
  const zip = await JSZip.loadAsync(buffer)
  const file = zip.file('xl/sharedStrings.xml')
  if (!file) return null
  const prefix = createHash('sha256').update(`<!-- source: ${sourcePath} -->\n\n`)
  let committed: OutputHash = { value: prefix, trimmed: prefix.copy(), started: false }
  let entry: OutputHash | null = null
  let entries = 0
  let entryStarted = false
  let mode: 'outside' | 'attributes' | 'text' = 'outside'
  let carry = ''
  let entityCarry = ''

  const text = (part: string, final = false) => {
    const value = entityCarry + part
    let end = value.length
    if (!final) {
      const amp = value.lastIndexOf('&')
      if (amp >= 0 && entityNames.some(entity => entity.startsWith(value.slice(amp)) && entity !== value.slice(amp))) end = amp
      if (end > 0 && /[\uD800-\uDBFF]/.test(value[end - 1])) end--
    }
    entityCarry = value.slice(end)
    const decoded = value.slice(0, end).replace(/&(?:lt|gt|quot|apos|amp);/g, entity => entities[entity])
    if (!decoded) return
    if (!entryStarted) {
      entryStarted = true
      if (entries) append(entry!, '\n')
    }
    append(entry!, decoded)
  }

  const begin = () => {
    entry = { value: committed.value.copy(), trimmed: committed.trimmed.copy(), started: committed.started }
    entryStarted = false
    entityCarry = ''
    mode = 'text'
  }

  // This recognizes the former literal <t ...>...</t> rule, including its five
  // entity substitutions. XML-normalizing it would misidentify edited output.
  const consume = (chunk: string) => {
    const value = carry + chunk
    carry = ''
    let position = 0
    while (position < value.length) {
      if (mode === 'outside') {
        const start = value.indexOf('<t', position)
        if (start < 0) {
          if (value.endsWith('<')) carry = '<'
          return
        }
        const next = start + 2
        if (next === value.length) { carry = '<t'; return }
        if (value[next] === '>') { begin(); position = next + 1 }
        else if (/\s/.test(value[next])) { mode = 'attributes'; position = next + 1 }
        else position = next
      } else if (mode === 'attributes') {
        const end = value.indexOf('>', position)
        if (end < 0) return
        begin()
        position = end + 1
      } else {
        const end = value.indexOf('</t>', position)
        if (end < 0) {
          const remaining = value.slice(position)
          const split = Math.max(0, remaining.length - 3)
          text(remaining.slice(0, split))
          carry = remaining.slice(split)
          return
        }
        text(value.slice(position, end), true)
        if (entryStarted) { committed = entry!; entries++ }
        entry = null
        mode = 'outside'
        position = end + 4
      }
    }
  }

  const source = file.nodeStream('nodebuffer') as Readable
  const stream = new Readable({ highWaterMark: 16 * 1024 }).wrap(source)
  stream.setEncoding('utf8')
  try {
    for await (const chunk of stream) {
      consume(chunk as string)
      await yieldToMain()
    }
  } finally {
    source.pause()
    source.destroy()
    stream.destroy()
  }
  return committed.started ? committed.trimmed.digest('hex') : null
}
