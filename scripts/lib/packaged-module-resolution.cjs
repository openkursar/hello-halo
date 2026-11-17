'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { builtinModules } = require('node:module')
const acorn = require('acorn')

function staticRequires(source) {
  const found = new Set()
  const builtins = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`), 'electron'])
  const root = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true })
  function visit(node) {
    if (!node || typeof node !== 'object') return
    if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'require' && node.arguments.length === 1) {
      const specifier = node.arguments[0].value
      if (typeof specifier === 'string' && !builtins.has(specifier)) found.add(specifier)
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value === 'object') visit(value)
    }
  }
  visit(root)
  return [...found].sort()
}

function assertPackagedModuleResolution(resources, executable) {
  const asar = require('@electron/asar')
  const archive = path.join(resources, 'app.asar')
  const entry = 'out/main/index.cjs'
  const source = fs.existsSync(archive) ? asar.extractFile(archive, entry).toString('utf8') : fs.readFileSync(path.join(resources, 'app', entry), 'utf8')
  const requests = staticRequires(source)
  const entryPath = path.join(fs.existsSync(archive) ? archive : path.join(resources, 'app'), entry)
  const script = `const r=require('node:module').createRequire(${JSON.stringify(entryPath)});for(const s of ${JSON.stringify(requests)}){try{r.resolve(s)}catch(e){console.error('Packaged module resolution failed: '+s);process.exitCode=1}}`
  execFileSync(executable, ['-e', script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 20000, stdio: 'pipe'
  })
  console.log(`[distribution] Resolved ${requests.length} static main-process imports using packaged Electron`)
  return requests
}

module.exports = { staticRequires, assertPackagedModuleResolution }
