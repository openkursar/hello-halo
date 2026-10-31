import { createHash } from 'node:crypto'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { legacyXlsxTextHash } from '../../../../src/main/services/tlon/legacy-xlsx'

async function legacyHash(xml: string, sourcePath = 'book.xlsx') {
  const zip = new JSZip()
  zip.file('xl/sharedStrings.xml', xml)
  return legacyXlsxTextHash(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), sourcePath)
}

function expectedHash(text: string, sourcePath = 'book.xlsx') {
  return createHash('sha256').update(`<!-- source: ${sourcePath} -->\n\n${text}`).digest('hex')
}

describe('Legacy XLSX output identity', () => {
  it('matches the old literal text-run order, five entities and overall trim', async () => {
    const xml = '<sst><si><t>  </t></si><si><t xml:space="preserve">  A &amp; B </t></si><si><r><t>Rich</t></r><r><t>text &lt;x&gt; &quot;y&quot; &apos;z&apos;</t></r></si><si><t></t></si><si><t>  </t></si></sst>'
    expect(await legacyHash(xml)).toBe(expectedHash('A & B \nRich\ntext <x> "y" \'z\''))
  })

  it('does not normalize character references, CDATA or namespace-prefixed text', async () => {
    const xml = '<sst><si><x:t>Ignored prefix</x:t><t>&amp;lt; &#65; <![CDATA[raw]]></t></si></sst>'
    expect(await legacyHash(xml)).toBe(expectedHash('&lt; &#65; <![CDATA[raw]]>'))
  })

  it('ignores incomplete trailing matches instead of hashing a partial output', async () => {
    expect(await legacyHash('<sst><t>Kept</t><t>Unclosed')).toBe(expectedHash('Kept'))
    expect(await legacyHash('<sst><t>Unclosed')).toBeNull()
    expect(await legacyHash('<sst><t> \n </t></sst>')).toBeNull()
  })

  it('preserves UTF-8 and entity boundaries without buffering the whole XML', async () => {
    const text = `${'中😀&'.repeat(12000)} tail`
    const xml = `<sst><!--${' '.repeat(16377)}--><si><t>${text.replaceAll('&', '&amp;')}</t></si></sst>`
    expect(await legacyHash(xml, 'folder/资料.xlsx')).toBe(expectedHash(text, 'folder/资料.xlsx'))
  })

  it('matches the retired extractor across mixed token and chunk boundaries', async () => {
    const pieces = ['<t>', '</t>', '<t/>', '<t xml:space="preserve"/>', '<t x="a>b">', '<x:t>ignored</x:t>', '&amp;', '&lt;', '&amp;lt;', '&#65;', '<![CDATA[x]]>', '\r\n', '中😀', ' data ', '<', 't', '>', '&am', 'p;']
    let seed = 701
    for (let sample = 0; sample < 40; sample++) {
      const parts = Array.from({ length: 60 }, () => { seed = (seed * 16807) % 2147483647; return pieces[seed % pieces.length] })
      const xml = `${' '.repeat(16370 + sample)}${parts.join('')}`
      const text = [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(match => match[1]
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'))
        .filter(Boolean).join('\n').trim()
      expect(await legacyHash(xml), `Historical sample ${sample}`).toBe(text ? expectedHash(text) : null)
    }
  })
})
