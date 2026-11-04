const fs = require('node:fs')
const promises = require('node:fs/promises')
const { syncBuiltinESMExports } = require('node:module')
const { join } = require('node:path')

// Observe calls before main imports its filesystem bindings; always delegate unchanged.
const evidence = { pid: process.pid, operations: [], truncated: false }
const destination = join(process.env.HALO_DATA_DIR, 'engine-discovery-observation.json')
const write = () => fs.writeFileSync(destination, JSON.stringify(evidence))
const selectedPath = JSON.parse(fs.readFileSync(join(process.env.HALO_DATA_DIR, 'config.json'), 'utf8')).agent?.ccRuntime?.selectedPath
const relevant = /(?:^|[/\\])(?:claude(?:\.exe|\.cmd)?|absent-automatic-cc|missing-automatic-cc|missing-explicit-cc)$|@anthropic-ai[/\\]claude-code|[/\\]\.nvm[/\\]versions[/\\]node$/i
for (const operation of ['stat', 'access', 'realpath', 'open', 'opendir']) {
  const original = promises[operation]
  promises[operation] = function (...args) {
    const path = String(args[0])
    if (path === selectedPath || relevant.test(path) || operation === 'opendir' && /[/\\]runtimes[/\\]claude-code$/.test(path)) {
      if (evidence.operations.length < 1024) evidence.operations.push({ operation, path })
      else evidence.truncated = true
      write()
    }
    return Reflect.apply(original, this, args)
  }
}
syncBuiltinESMExports()
write()
