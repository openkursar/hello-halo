const fs = require('node:fs')
const promises = require('node:fs/promises')
const children = require('node:child_process')
const { syncBuiltinESMExports } = require('node:module')
const { join } = require('node:path')

const evidence = { pid: process.pid, operations: [], children: [], truncated: false }
const destination = join(process.env.HALO_DATA_DIR, 'runtime-idle-observation.json')
const write = () => fs.writeFileSync(destination, JSON.stringify(evidence))
const relevant = /(?:^|[/\\])(?:claude|codex)(?:\.exe|\.cmd|\.js)?$|@anthropic-ai[/\\]claude-code|@openai[/\\]codex|[/\\]\.nvm[/\\]versions[/\\]node$/i
function record(list, value) {
  if (list.length < 1024) list.push(value)
  else evidence.truncated = true
  write()
}
for (const operation of ['stat', 'access', 'realpath', 'open', 'opendir']) {
  const original = promises[operation]
  promises[operation] = function (...args) {
    const path = String(args[0])
    if (relevant.test(path) || operation === 'opendir' && /[/\\]runtimes[/\\](?:claude-code|codex)$/.test(path)) record(evidence.operations, { operation, path })
    return Reflect.apply(original, this, args)
  }
}
for (const operation of ['spawn', 'execFile', 'exec', 'fork']) {
  const original = children[operation]
  children[operation] = function (...args) {
    const executable = String(args[0])
    if (relevant.test(executable)) record(evidence.children, { operation, executable })
    return Reflect.apply(original, this, args)
  }
}
syncBuiltinESMExports()
write()
