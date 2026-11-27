import { spawnSync } from 'node:child_process'

export function git(args) {
  const run = spawnSync('git', ['--no-pager', ...args], {
    encoding: 'buffer', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' }
  })
  if (run.error || run.status !== 0) throw new Error('Cannot read the Git index')
  return run.stdout
}

export function gitPath(name) {
  return git(['rev-parse', '--path-format=absolute', '--git-path', name]).toString().trimEnd()
}

export function stagedChange(withPatch) {
  const raw = git(['-c', 'core.quotePath=true', 'diff', '--cached', '--abbrev=64', '--unified=0', '--inter-hunk-context=0',
    '--no-color', '--no-ext-diff', '--no-textconv', '--no-relative', '--ignore-submodules=none', '--submodule=short',
    '--find-renames', '--output-indicator-new=+', '--output-indicator-old=-', '--output-indicator-context= ',
    ...(withPatch ? ['--patch'] : ['--no-patch']), '--raw', '-z', '--'])
  if (!raw.length) return []
  const invalid = () => { throw new Error('Unrecognized staged patch format') }
  const split = withPatch ? raw.indexOf(Buffer.from([0, 0])) : raw.length - 1
  if (split < 0 || raw[split] !== 0) invalid()
  const fields = raw.subarray(0, split).toString('utf8').split('\0')
  const files = []
  for (let i = 0; i < fields.length;) {
    const header = fields[i++]
    const record = /^:\d{6} \d{6} [a-f0-9]+ [a-f0-9]+ ([ADMRTC])\d*$/.exec(header)
    if (!record) invalid()
    const status = record[1]
    const oldPath = 'RC'.includes(status) ? fields[i++] : null
    const path = fields[i++]
    if (!path || path.includes('\uFFFD') || oldPath?.includes('\uFFFD')) invalid()
    files.push({ header, oldPath, path, status, lines: [] })
  }
  if (!withPatch) return files
  let index = -1
  let lineNumber = null
  let typeAddition = false
  for (const line of raw.subarray(split + 2).toString('utf8').split('\n')) {
    if (line.startsWith('diff --git ')) {
      // A type change has one raw record but two patches: deletion then addition.
      if (!typeAddition) index++
      typeAddition = !typeAddition && files[index]?.status === 'T'
      lineNumber = null
    } else if (line.startsWith('@@ ')) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
      if (!hunk || !files[index]) invalid()
      lineNumber = Number(hunk[1])
    } else if (lineNumber !== null && (line[0] === '+' || line[0] === ' ')) {
      if (line[0] === '+') files[index].lines.push([lineNumber, line.slice(1)])
      lineNumber++
    }
  }
  if (index + 1 !== files.length || typeAddition) invalid()
  return files
}
