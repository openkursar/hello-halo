// CI finalizes evidence even when dependency installation failed, so this module
// uses only Node built-ins; its key must stay equal to catalog's instanceKey.
const failing = new Set(['failed', 'flaky'])
const notCovered = new Set(['blocked', 'manual', 'skipped'])
const ansi = /\u001b\[[0-9;]*m/g
const localPath = /(?<=^|[\s'"`(=[])(?:\/(?:Users|home|Volumes|private|var|tmp|opt|etc|root|Applications)\/[^\s'"`)\]]+|[A-Za-z]:\\[^\s'"`)\]]+)/g

const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value

export const resultKey = item => `${item.caseId}:${JSON.stringify(canonical(item.variant ?? {}))}`

export function failingCaseIds(results) {
  return [...new Set(Object.entries(results ?? {}).filter(([, status]) => failing.has(status)).map(([key]) => key.slice(0, key.indexOf(':'))))]
    .filter(id => /^[a-z][a-z0-9.-]*$/.test(id)).sort()
}

/**
 * Last known result per scenario instance after this run. A scenario the run
 * selected is replaced as a whole, including variants it no longer has; one it
 * did not select keeps its earlier results while it still exists in the catalog.
 */
export function nextResults(previous, run) {
  const selected = new Set(run.cases.map(item => item.caseId))
  const known = new Set([...selected, ...(run.excluded ?? []).map(item => item.caseId)])
  const results = {}
  for (const [key, status] of Object.entries(previous ?? {})) {
    const id = key.slice(0, key.indexOf(':'))
    if (known.has(id) && !selected.has(id)) results[key] = status
  }
  for (const item of run.cases) results[resultKey(item)] = item.status
  return results
}

function firstLine(text) {
  const line = String(text ?? '').replace(ansi, '').split('\n').map(part => part.trim()).find(Boolean) ?? ''
  const masked = line.replace(localPath, '<path>')
  return masked.length > 200 ? `${masked.slice(0, 197)}...` : masked
}

function reasonOf(item) {
  if (item.status === 'failed') return firstLine(item.attempts?.findLast(attempt => attempt.errors?.length)?.errors[0] ?? item.reason)
  return firstLine(item.reason)
}

function entry(item, was) {
  const variant = item.variant && Object.keys(item.variant).length ? item.variant : undefined
  const reason = reasonOf(item)
  return {
    caseId: item.caseId, ...(variant ? { variant } : {}), module: item.module, title: item.title,
    status: item.status, previous: was ?? null, ...(reason ? { reason } : {}),
  }
}

// Without earlier results nothing can be called new, so failures are reported as they are.
export function compareResults(run, previous) {
  const before = previous?.results ?? null
  const groups = { newFailures: [], stillFailing: [], fixed: [], unstable: [], lostCoverage: [], notRun: [], failingNow: [] }
  const counts = { selected: run.cases.length, passed: 0, failed: 0, flaky: 0, blocked: 0, manual: 0, skipped: 0, notRun: 0, newlyCovered: 0 }
  const uncovered = {}
  for (const item of run.cases) {
    const status = item.status
    const was = before?.[resultKey(item)]
    if (status === 'passed') counts.passed++
    else if (status === 'failed') counts.failed++
    else if (status === 'flaky') counts.flaky++
    else if (status === 'not-run') counts.notRun++
    else if (notCovered.has(status)) counts[status]++
    if (status === 'failed') {
      if (!before) groups.failingNow.push(entry(item, was))
      else if (failing.has(was)) groups.stillFailing.push(entry(item, was))
      else groups.newFailures.push(entry(item, was))
    } else if (status === 'flaky') groups.unstable.push(entry(item, was))
    else if (status === 'passed') {
      if (failing.has(was)) groups.fixed.push(entry(item, was))
      else if (before && was !== 'passed') counts.newlyCovered++
    } else if (notCovered.has(status)) {
      uncovered[item.module] = (uncovered[item.module] ?? 0) + 1
      if (before && (was === 'passed' || was === 'flaky' || was === 'failed')) groups.lostCoverage.push(entry(item, was))
    } else if (status === 'not-run') groups.notRun.push(entry(item, was))
  }
  const comparedWith = previous ? { ref: previous.ref, revision: previous.revision, runId: previous.runId, completedAt: previous.completedAt } : null
  return { version: 1, comparedWith, counts: { ...counts, uncovered: counts.blocked + counts.manual + counts.skipped }, uncoveredByModule: Object.fromEntries(Object.entries(uncovered).sort(([left], [right]) => left.localeCompare(right))), ...groups }
}

const clean = value => String(value ?? '').replace(/[\r\n|`<>]/g, ' ').trim()
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`

function line(item) {
  const variant = item.variant ? ` ${clean(Object.entries(item.variant).map(([key, value]) => `${key}=${value}`).join(', '))}` : ''
  const was = item.previous && item.previous !== item.status ? ` · was ${clean(item.previous)}` : ''
  return `- \`${clean(item.caseId)}\`${variant} — ${clean(item.title?.en ?? item.caseId)} (${clean(item.module)})${item.reason ? ` · ${clean(item.reason)}` : ''}${was}`
}

function list(items, limit) {
  const shown = items.slice(0, limit).map(line)
  if (items.length > limit) shown.push(`- … and ${items.length - limit} more in quality.json`)
  return shown
}

function details(title, items, limit) {
  return items.length ? ['', `<details><summary>${title} (${items.length})</summary>`, '', ...list(items, limit), '', '</details>'] : []
}

export function renderQuality(quality, { limit = 40 } = {}) {
  const { counts, comparedWith } = quality
  const lines = ['### Quality', '']
  if (comparedWith) {
    const parts = [quality.newFailures.length ? `**${plural(quality.newFailures.length, 'new failure')}**` : '**No new failures**', `${quality.fixed.length} fixed`, `${quality.stillFailing.length} still failing`]
    if (quality.lostCoverage.length) parts.push(`${quality.lostCoverage.length} no longer verified`)
    if (quality.unstable.length) parts.push(`${quality.unstable.length} unstable`)
    parts.push(`${counts.uncovered} not covered`)
    lines.push(parts.join(' · '))
    const when = comparedWith.completedAt ? `, ${clean(String(comparedWith.completedAt).slice(0, 10))}` : ''
    lines.push('', `Compared with \`${clean(String(comparedWith.revision ?? '').slice(0, 8))}\` on \`${clean(comparedWith.ref)}\`${when}.`)
  } else {
    const parts = [counts.failed ? `**${counts.failed} failing**` : '**Nothing failing**', `${counts.passed} passing`]
    if (quality.unstable.length) parts.push(`${quality.unstable.length} unstable`)
    parts.push(`${counts.uncovered} not covered`)
    lines.push(parts.join(' · '))
    lines.push('', quality.baselineUnavailable
      ? 'The earlier result could not be retrieved (the connection to GitHub failed), so nothing is compared with this run; failures are listed as they are, and some may predate it.'
      : 'No earlier result to compare with, so failures are listed as they are; some may predate this run.')
  }
  if (quality.newFailures.length) lines.push('', '#### New failures', '', ...list(quality.newFailures, limit))
  if (quality.failingNow.length) lines.push('', '#### Failing', '', ...list(quality.failingNow, limit))
  if (quality.lostCoverage.length) lines.push('', '#### No longer verified', '', ...list(quality.lostCoverage, limit))
  if (quality.notRun.length) lines.push('', '#### Not executed', '', ...list(quality.notRun, limit))
  lines.push(...details('Still failing', quality.stillFailing, limit), ...details('Unstable', quality.unstable, limit), ...details('Fixed', quality.fixed, limit))
  const modules = Object.entries(quality.uncoveredByModule ?? {})
  if (modules.length) {
    lines.push('', `<details><summary>Not covered (${counts.uncovered}) — scenarios without a runnable test, a required environment or a person to run them</summary>`, '', modules.map(([name, count]) => `\`${clean(name)}\` ${count}`).join(' · '), '', '</details>')
  }
  return lines
}
