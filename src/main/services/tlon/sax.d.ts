/** The streaming XML surface used by spreadsheet extraction; sax ships no types. */
declare module 'sax' {
  interface XmlTag {
    name: string
    attributes: Record<string, string>
  }

  interface XmlParser {
    onopentag?: (tag: XmlTag) => void
    onclosetag?: (name: string) => void
    ontext?: (text: string) => void
    oncdata?: (text: string) => void
    onerror?: (error: Error) => void
    write(text: string): XmlParser
    close(): XmlParser
  }

  const sax: {
    parser(strict: boolean, options: { xmlns: false; strictEntities: boolean }): XmlParser
  }
  export default sax
}
