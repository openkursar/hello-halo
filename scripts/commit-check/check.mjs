import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { gitPath, stagedChange } from './staged.mjs'
import { compileRules } from './match.mjs'

const POLICY = 'scripts/commit-check/disclosure-rules.json'
const RETRY = 'git -c disclosure.reviewed=true commit <same arguments as before>'
const MAX_ROWS = 20
const MAX_LINES = 5

// These may be live values, so they are never printed.
const HIDDEN = {
  credential: 'looks like a credential',
  network: 'looks like a private network address',
  path: 'looks like a personal or shared path',
  connection: 'looks like a service connection string'
}
const SHOWN = {
  name: 'company or product name',
  context: 'wording about internal work'
}

function reviewed() {
  const run = spawnSync('git', ['config', '--bool', '--get', 'disclosure.reviewed'], { encoding: 'utf8' })
  return run.status === 0 && run.stdout.trim() === 'true'
}

function messageLines(file) {
  const lines = []
  for (const [i, text] of readFileSync(file, 'utf8').split('\n').entries()) {
    // `#` lines are Git's template; `commit -v` appends the diff below the scissors line.
    if (/^# -+ >8 -+$/.test(text)) break
    if (!text.startsWith('#')) lines.push([i + 1, text])
  }
  return lines
}

function scan(messageFile) {
  const matches = compileRules(JSON.parse(readFileSync(new URL('./disclosure-rules.json', import.meta.url), 'utf8')))
  const findings = []
  const record = (place, line, hits) => {
    for (const { category, value } of hits) findings.push({ place, line, category, value })
  }
  if (messageFile) for (const [line, text] of messageLines(messageFile)) record('commit message', line, matches(text))
  // Merged commits were checked when they were made, or are already public.
  const merging = existsSync(gitPath('MERGE_HEAD'))
  const files = merging ? [] : stagedChange(true)
  files.forEach((file, i) => {
    if (file.status === 'D') return
    const nameHits = 'ARC'.includes(file.status) ? matches(file.path) : []
    // A file name can itself carry a secret.
    const place = nameHits.some(hit => hit.category in HIDDEN) ? `staged file #${i + 1} (name hidden)` : file.path
    record(place, 'file name', nameHits)
    for (const [line, text] of file.lines) record(place, line, matches(text, file.path === POLICY))
  })
  return { findings, merging, staged: files.length }
}

function where(lines) {
  const unique = [...new Set(lines)]
  const numbers = unique.filter(line => typeof line === 'number')
  const parts = unique.includes('file name') ? ['file name'] : []
  if (numbers.length) {
    const more = numbers.length > MAX_LINES ? ` +${numbers.length - MAX_LINES} more` : ''
    parts.push(`${numbers.length > 1 ? 'lines' : 'line'} ${numbers.slice(0, MAX_LINES).join(', ')}${more}`)
  }
  return parts.join(', ')
}

function rows(findings) {
  const groups = new Map()
  for (const { place, line, category, value } of findings) {
    const hidden = category in HIDDEN
    const key = `${place}\0${hidden ? category : value.toLowerCase().replace(/[ ._-]/g, '')}`
    if (!groups.has(key)) groups.set(key, { place, label: hidden ? `${HIDDEN[category]} (value hidden)` : `${SHOWN[category]}: ${value}`, lines: [] })
    groups.get(key).lines.push(line)
  }
  return [...groups.values()].map(({ place, label, lines }) => `  ${place}  ${where(lines)}  ${label}`)
}

function main() {
  const [messageFile] = process.argv.slice(2)
  const hook = messageFile !== undefined
  if (hook && reviewed()) return 0
  const { findings, merging, staged } = scan(messageFile)
  if (!hook && !staged) {
    console.log(merging ? 'Merge in progress: merged commits are not rescanned.' : 'Nothing staged.')
    return 0
  }
  if (!findings.length) return 0

  const all = rows(findings)
  const shown = hook && all.length > MAX_ROWS
    ? [...all.slice(0, MAX_ROWS), `  ...and ${all.length - MAX_ROWS} more. Run node scripts/commit-check/check.mjs to see them all.`]
    : all
  console.error([
    `The repository's commit check found possible sensitive information or internal details in this ${hook ? 'commit, so nothing has been committed yet' : 'staged change'}.`,
    'These may be false positives, or things the code genuinely needs:',
    '',
    ...shown,
    '',
    'If they are false positives or the code needs them, commit again with:',
    `  ${RETRY}`,
    'If something should not be public, remove it, stage the change and commit again.'
  ].join('\n'))
  return 1
}

try {
  process.exitCode = main()
} catch (error) {
  // System errors can quote private paths; only our own messages are printed.
  console.error(`The repository's commit check could not run${error.code ? '' : ` (${error.message})`}, so nothing has been checked or committed.`)
  console.error(`Look over the staged change yourself. If it is fine, commit again with:\n  ${RETRY}`)
  process.exitCode = 2
}
