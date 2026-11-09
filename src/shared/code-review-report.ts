const REPORT_SECTIONS = ['Conclusion', 'Must fix', 'Needs your decision', 'Suggestions', 'Structure summary'] as const

/** Headings in the languages Halo ships in, so every report reads the same. */
const LOCALIZED_SECTIONS: Record<string, readonly string[]> = {
  'zh-CN': ['结论', '必须修', '需要你决定', '建议', '结构摘要'],
  'zh-TW': ['結論', '必須修', '需要你決定', '建議', '結構摘要'],
  ja: ['結論', '必ず修正', '判断が必要', '提案', '構成の概要'],
  de: ['Fazit', 'Muss behoben werden', 'Deine Entscheidung', 'Vorschläge', 'Strukturübersicht'],
  es: ['Conclusión', 'Hay que corregir', 'Decides tú', 'Sugerencias', 'Resumen de la estructura'],
  fr: ['Conclusion', 'À corriger', 'À décider', 'Suggestions', 'Résumé de la structure'],
}

export function reviewReportHeadings(language: string): readonly string[] {
  return LOCALIZED_SECTIONS[language] ?? LOCALIZED_SECTIONS[language.split('-')[0]] ?? REPORT_SECTIONS
}

/** A hand-off note or truncated reply is not a report; content remains unmodified. */
export function hasReviewReport(content: string, language: string): boolean {
  const headings = reviewReportHeadings(language).map(heading => heading.toLocaleLowerCase())
  const sections = new Map<number, string[]>()
  let current = -1
  let fence: string | undefined
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    const delimiter = trimmed.match(/^(`{3,}|~{3,})/)
    if (delimiter) {
      if (!fence) fence = delimiter[1][0]
      else if (delimiter[1][0] === fence) fence = undefined
      continue
    }
    if (fence) continue
    const headingText = /^#{1,6}[ \t]+/.test(trimmed)
      ? trimmed.replace(/^#{1,6}[ \t]+/, '').replace(/[ \t]+#+[ \t]*$/, '')
      : trimmed
    const title = headingText.replace(/^\d+[.)]\s+/, '')
      .replace(/\*\*|__/g, '').trim()
    const normalized = title.toLocaleLowerCase()
    const index = headings.findIndex(heading => normalized === heading ||
      (normalized.startsWith(heading) && /^\s*[:：—–-]\s*/.test(normalized.slice(heading.length))))
    if (index >= 0) {
      if (index <= current) return false
      current = index
      const inline = title.slice(headings[index].length).replace(/^\s*[:：—–-]\s*/, '').trim()
      sections.set(index, inline ? [inline] : [])
    } else if (current >= 0 && trimmed) sections.get(current)!.push(trimmed)
  }
  return headings.every((_, index) => (sections.get(index)?.length ?? 0) > 0)
}

