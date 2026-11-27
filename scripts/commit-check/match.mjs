import { isIP } from 'node:net'

function vocabulary(terms) {
  const boundary = '(?:(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z]))'
  const alternatives = [...new Set(terms)].sort((a, b) => b.length - a.length).map(term => {
    const words = term.replace(/([a-z])([A-Z])/g, '$1 $2').split(/[ ._-]+/)
    const body = words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[a-z]/gi, ch => `[${ch.toLowerCase()}${ch.toUpperCase()}]`)).join('[ ._-]*')
    const left = /^[a-z\d]/i.test(term) ? `(?:(?<![A-Za-z0-9])|${boundary})` : ''
    const right = /[a-z\d]$/i.test(term) ? `(?:(?![A-Za-z0-9])|${boundary})` : ''
    return `${left}${body}${right}`
  })
  return new RegExp(alternatives.join('|'), 'gu')
}

function concrete(match, validate) {
  if (validate === 'ip') return isIP(match[0].replace(/\.$/, '')) !== 0
  if (validate === 'host') return !/^(?:localhost|127\.[\d.]+)$|(?:^|\.)(?:example\.(?:com|net|org)|example|invalid|test)$/i.test(match[1] ?? match[0])
  if (validate === 'literal') {
    const [, quote, value] = match
    if (/^(?:[$<{]|process\.env\b|env\.|os\.(?:environ|getenv)|secrets\.|import\.meta\.env\b)/i.test(value)) return false
    if (quote) return true
    return !/^(?:true|false|null|undefined|string|number|boolean|[a-z_$][\w$]*(?:\.[a-z_$][\w$]*)+|[a-z_$][\w$.]*\(.*)$/i.test(value)
  }
  return true
}

export function compileRules(rules) {
  const vocabularyChecks = [['name', vocabulary(rules.names.flat())], ['context', vocabulary(rules.phrases)]]
  const formats = rules.patterns.map(({ category, source, validate }) => ({ category, regex: new RegExp(source, 'gi'), validate }))
  const declarations = new Set([...rules.names.flat(), ...rules.phrases, ...rules.patterns.map(p => p.source)].map(v => JSON.stringify(v)))
  return (text, definition = false) => {
    const result = []
    for (const { category, regex, validate } of formats) {
      for (const match of text.matchAll(regex)) {
        if (concrete(match, validate)) result.push({ category, column: match.index + 1, value: match[0] })
      }
    }
    const literals = definition ? [...text.matchAll(/"(?:\\.|[^"\\])*"/g)].filter(m => declarations.has(m[0])) : []
    for (const [category, regex] of vocabularyChecks) {
      for (const match of text.matchAll(regex)) {
        if (literals.some(token => token.index < match.index && match.index + match[0].length < token.index + token[0].length)) continue
        result.push({ category, column: match.index + 1, value: match[0] })
      }
    }
    return result
  }
}
