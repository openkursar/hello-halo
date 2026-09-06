#!/usr/bin/env node
/**
 * gen-api-ref.mjs — generate the AI-facing HTTP API reference
 *
 * Halo's remote HTTP surface (`src/main/http/routes/*.routes.ts`) is also how
 * an AI session can operate Halo itself, over a loopback API. This script
 * reconciles that surface against hand-written descriptions
 * (`*.routes.meta.ts`, one per routes file) and renders the result into
 * `resources/api-ref/`: per-group manual pages an agent reads on demand, a
 * flat greppable index, and the two JSON tables (`scope.json`, `routes.json`)
 * the loopback server's auth middleware uses to tell "not exposed" (403)
 * apart from "does not exist" (404).
 *
 * The two artifacts are generated from the same reconciled data, so a route
 * documented as callable is structurally guaranteed to be one the server
 * will actually allow, and vice versa.
 *
 * Modes:
 *   node scripts/gen-api-ref.mjs             write resources/api-ref/
 *   node scripts/gen-api-ref.mjs --check      validate + diff only, no write
 *   node scripts/gen-api-ref.mjs --scaffold   add missing *.routes.meta.ts
 *                                             entries as expose:'unlabeled'
 *                                             placeholders, for annotators.
 *                                             Any remaining 'unlabeled' entry
 *                                             fails the default/--check build.
 *
 * Meta files are TypeScript with a single type-only import; they are
 * transformed to ESM with esbuild (already a dependency) and imported from a
 * throwaway temp file, so no AST parsing or extra tooling is needed.
 *
 * Exit codes:
 *   0 — success (or, in --check, no diff)
 *   1 — reconciliation failed, or --check found a diff
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { transform } from 'esbuild'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..')
const ROUTES_DIR = join(PROJECT_ROOT, 'src', 'main', 'http', 'routes')
const TARGET_DIR = join(PROJECT_ROOT, 'resources', 'api-ref')

/** Token substituted by the runtime manual service with the resolved absolute path. */
const INDEX_PATH_TOKEN = '{{API_REF_INDEX_PATH}}'

const BASE_INDENT = '     '
const CONT_INDENT = '          '

/**
 * Must match `registerApiRoutes` in routes/index.ts **position for position**,
 * not merely as a set. `routes.json` inherits this order, and `classify`
 * (http/self-api/scope.ts) resolves a request to the first entry that matches
 * it — its model of which route Express will dispatch to. Reorder one and the
 * gate can authorize a route Express never reaches while handing the request
 * to one nobody exposed.
 *
 * Both properties are reconciled below rather than trusted: membership,
 * because a `*.routes.ts` missing from this list would have every one of its
 * endpoints answer 404 "no such path"; and order, for the reason above.
 */
const ROUTE_FILES = [
  'config', 'ai-sources', 'space', 'agent', 'terminal', 'artifact',
  'notify', 'im', 'system', 'apps', 'store', 'tlon',
]

/**
 * Fails the build when `ROUTE_FILES` and `registerApiRoutes` disagree on the
 * ORDER of registration. Membership is checked separately; this is the half
 * `classify` depends on, and the half a `.sort()` comparison cannot see.
 */
function assertRouteFilesMatchRegistrationOrder() {
  const source = readFileSync(join(ROUTES_DIR, 'index.ts'), 'utf-8')

  // `registerFooRoutes` -> the module basename it was imported from.
  const moduleOf = new Map()
  for (const [, fn, mod] of source.matchAll(/import\s*\{\s*(\w+)\s*\}\s*from\s*'\.\/([\w-]+)\.routes'/g)) {
    moduleOf.set(fn, mod)
  }

  const body = source.slice(source.indexOf('export function registerApiRoutes'))
  const registered = [...body.matchAll(/^\s*(\w+)\(app\)/gm)]
    .map(([, fn]) => moduleOf.get(fn))
    .filter(Boolean)

  if (registered.length === ROUTE_FILES.length && registered.every((m, i) => m === ROUTE_FILES[i])) return

  log.err('ROUTE_FILES does not match the registration order in routes/index.ts:')
  log.err(`  index.ts:     ${registered.join(', ')}`)
  log.err(`  ROUTE_FILES:  ${ROUTE_FILES.join(', ')}`)
  log.err('  order is load-bearing: classify() resolves a request to the first matching entry of')
  log.err('  routes.json as its model of Express dispatch, so a mismatch lets the gate authorize a')
  log.err('  route Express will not reach while the request lands on one that was never exposed.')
  process.exit(1)
}

/** Fails the build when `ROUTE_FILES` and the routes directory have drifted apart. */
function assertRouteFilesCoverDirectory() {
  const onDisk = readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith('.routes.ts'))
    .map((f) => f.slice(0, -'.routes.ts'.length))
    .sort()
  const declared = [...ROUTE_FILES].sort()

  const missing = onDisk.filter((f) => !declared.includes(f))
  const stale = declared.filter((f) => !onDisk.includes(f))
  if (missing.length === 0 && stale.length === 0) return

  if (missing.length) log.err(`route file(s) not listed in ROUTE_FILES: ${missing.join(', ')}`)
  if (stale.length) log.err(`ROUTE_FILES entries with no matching *.routes.ts: ${stale.join(', ')}`)
  log.err(`update ROUTE_FILES in ${'scripts/gen-api-ref.mjs'} to match src/main/http/routes/`)
  process.exit(1)
}

const log = {
  info: (m) => console.log(`[gen-api-ref] ${m}`),
  warn: (m) => console.warn(`[gen-api-ref] WARN ${m}`),
  err: (m) => console.error(`[gen-api-ref] ERROR ${m}`),
}

const groupsOf = (g) => (Array.isArray(g) ? g : g ? [g] : [])
const routeKey = (method, path) => `${method} ${path}`

/**
 * Syntactic proxy for "this route can destroy something": a DELETE, or a
 * mutating path ending in one of these verbs, is where a wrong guess is
 * expensive enough that `impact` must be a conscious decision, not an
 * omission. Deliberately mechanical (method + path shape
 * only) — it cannot know that a *specific* DELETE is actually safe, only
 * that the shape is the one worth a human looking at once.
 */
const DESTRUCTIVE_PATH_SUFFIXES = ['/remove', '/clear', '/uninstall', '/unbind', '/reset']
function isDestructiveShaped(method, path) {
  if (method === 'DELETE') return true
  return DESTRUCTIVE_PATH_SUFFIXES.some((suffix) => path.endsWith(suffix))
}

/**
 * Every real id in this codebase is a uuid v4 (apps/manager/service.ts:425,
 * space.service.ts:475, conversation.service.ts:711) — a fabricated example
 * like `"ap_7f3c"` teaches an agent a format that does not exist, and the
 * same short-prefix-plus-digits shape has already leaked from the spec's own
 * examples into annotated meta twice. Requires a digit after the underscore
 * so legitimate enum-ish literals (`"api_key"`, `"run_complete"`) don't match.
 */
const FABRICATED_ID_RE = /"[a-z]{2,6}_[A-Za-z0-9]*\d[A-Za-z0-9]*"/g

/**
 * Writes that reach the socket without passing through `res.json`, which is
 * the only method the loopback listener's redaction wraps (http/self-api/
 * redact.ts). A route doing any of these would return unredacted bytes to the
 * agent. `res.sendStatus(` is deliberately not matched — `send` requires the
 * paren immediately after, and a status line carries no payload.
 */
const RAW_WRITE_RE = /\.pipe\(\s*res\s*\)|\bres\.(?:send|end|write|sendFile|download)\s*\(/

/** Strips comments so a mention of `res.send(` in prose is not read as code. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/**
 * The per-route check below can only see a route's own registration block. A
 * raw write inside a shared helper is reachable from every route, `ai` ones
 * included, and would be invisible there — so the helper modules are held to
 * the stricter rule: no raw writes at all. Route modules are exempt because a
 * streaming handler is legitimate as long as it stays `internal`, which the
 * per-route check enforces.
 */
function assertHelpersNeverWriteRaw() {
  const helpers = readdirSync(ROUTES_DIR).filter(
    (f) => f.endsWith('.ts') && !f.endsWith('.routes.ts') && !f.endsWith('.routes.meta.ts')
  )
  const offenders = helpers.filter((f) =>
    RAW_WRITE_RE.test(stripComments(readFileSync(join(ROUTES_DIR, f), 'utf-8')))
  )
  if (offenders.length === 0) return

  log.err(`shared route helper(s) write the response outside res.json: ${offenders.join(', ')}`)
  log.err('  a helper is reachable from every route, so this cannot be scoped to internal ones;')
  log.err('  the self-API listener redacts res.json only. Answer through res.json instead.')
  process.exit(1)
}

/**
 * Each route carries the source of its own registration block — the text from
 * its `app.<method>(` line up to the next route's (or end of file). Routes in
 * these modules are registered sequentially, so the slice is the handler; a
 * helper declared between two routes would be attributed to the earlier one,
 * which only ever costs a false positive on a check worth reading anyway.
 */
function scanRoutesFile(file) {
  const path = join(ROUTES_DIR, `${file}.routes.ts`)
  const lines = readFileSync(path, 'utf-8').split('\n')
  const re = /app\.(get|post|put|patch|delete)\(\s*'([^']+)'/
  const routes = []
  lines.forEach((line, i) => {
    const m = line.match(re)
    if (m) routes.push({ method: m[1].toUpperCase(), path: m[2], file, line: i + 1 })
  })
  routes.forEach((r, i) => {
    const end = i + 1 < routes.length ? routes[i + 1].line - 1 : lines.length
    r.body = stripComments(lines.slice(r.line - 1, end).join('\n'))
  })
  return routes
}

async function transformAndImport(sourcePath) {
  const source = readFileSync(sourcePath, 'utf-8')
  const { code } = await transform(source, { loader: 'ts', format: 'esm', target: 'node18' })
  const tmpFile = join(tmpdir(), `gen-api-ref-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
  writeFileSync(tmpFile, code)
  try {
    return await import(pathToFileURL(tmpFile).href)
  } finally {
    rmSync(tmpFile, { force: true })
  }
}

function metaPathFor(file) {
  return join(ROUTES_DIR, `${file}.routes.meta.ts`)
}

async function loadMeta(file) {
  const path = metaPathFor(file)
  if (!existsSync(path)) return null
  const mod = await transformAndImport(path)
  return mod.MODULE
}

async function loadGroups() {
  const mod = await transformAndImport(join(ROUTES_DIR, '_meta-groups.ts'))
  const groups = mod.GROUPS

  // The runtime offers these groups in the halo_api_ref enum; the pages below
  // are what a request for one returns. A group offered without a page sends
  // the agent to a dead end, and a page nobody can ask for is dead weight.
  const declared = await transformAndImport(
    join(PROJECT_ROOT, 'src', 'main', 'services', 'api-ref', 'groups.ts')
  )
  const offered = [...declared.API_REF_GROUP_IDS].sort()
  const paged = Object.keys(groups).sort()
  if (offered.join() !== paged.join()) {
    log.err('group mismatch between services/api-ref/groups.ts and routes/_meta-groups.ts:')
    for (const g of offered.filter((g) => !paged.includes(g))) log.err(`  offered with no page: ${g}`)
    for (const g of paged.filter((g) => !offered.includes(g))) log.err(`  page nobody can ask for: ${g}`)
    process.exit(1)
  }

  return groups
}

// ---------------------------------------------------------------------------
// Body-shape derivation — turns a written shape (`{frequency: "30m"|"2h"|"1d"}`)
// into one concrete JSON literal an agent could send as-is, so curl -d never
// carries a placeholder. Picks the first alternative of a union, omits
// optional (`?`) fields, and renders an untyped or bare-`string` field as
// `"<fieldName>"` — the same fill-this-in convention already used for path
// params, so an agent recognizes it as one thing to edit, not a literal value.
// Throws when a value truly cannot be inferred (e.g. a named type alias);
// callers must surface that as a build failure, never guess further.
// ---------------------------------------------------------------------------

function tokenizeShape(text) {
  const re = /\s*(?:("(?:[^"\\]|\\.)*")|(-?\d+(?:\.\d+)?)|([A-Za-z_$][A-Za-z0-9_$]*)|([{}[\]:,?|]))/y
  const tokens = []
  let idx = 0
  while (idx < text.length) {
    re.lastIndex = idx
    const m = re.exec(text)
    if (!m) {
      if (/^\s*$/.test(text.slice(idx))) break
      throw new Error(`unexpected character at position ${idx}: '${text[idx]}'`)
    }
    idx = re.lastIndex
    if (m[1] !== undefined) tokens.push({ type: 'string', value: JSON.parse(m[1]) })
    else if (m[2] !== undefined) tokens.push({ type: 'number', value: Number(m[2]) })
    else if (m[3] !== undefined) tokens.push({ type: 'ident', value: m[3] })
    else if (m[4] !== undefined) tokens.push({ type: 'punct', value: m[4] })
  }
  return tokens
}

class ShapeParser {
  constructor(tokens) {
    this.tokens = tokens
    this.pos = 0
  }
  peekIs(value) {
    const t = this.tokens[this.pos]
    return Boolean(t && t.type === 'punct' && t.value === value)
  }
  expect(value) {
    if (!this.peekIs(value)) throw new Error(`expected '${value}'`)
    this.pos++
  }
  parseType() {
    const options = [this.parsePostfixType()]
    while (this.peekIs('|')) {
      this.pos++
      options.push(this.parsePostfixType())
    }
    return options.length === 1 ? options[0] : { kind: 'union', options }
  }
  parsePostfixType() {
    let node = this.parsePrimaryType()
    while (this.peekIs('[')) {
      const save = this.pos
      this.pos++
      if (this.peekIs(']')) {
        this.pos++
        node = { kind: 'array', element: node }
      } else {
        this.pos = save
        break
      }
    }
    return node
  }
  parsePrimaryType() {
    const t = this.tokens[this.pos++]
    if (!t) throw new Error('unexpected end of shape')
    if (t.type === 'string' || t.type === 'number') return { kind: 'literal', value: t.value }
    if (t.type === 'ident') {
      if (t.value === 'true') return { kind: 'literal', value: true }
      if (t.value === 'false') return { kind: 'literal', value: false }
      if (t.value === 'null') return { kind: 'literal', value: null }
      return { kind: 'bare', name: t.value }
    }
    if (t.type === 'punct' && t.value === '{') return this.parseObjectBody()
    if (t.type === 'punct' && t.value === '[') {
      const element = this.parseType()
      this.expect(']')
      return { kind: 'array', element }
    }
    throw new Error(`unexpected token '${t.value}'`)
  }
  parseObjectBody() {
    const fields = []
    if (this.peekIs('}')) {
      this.pos++
      return { kind: 'object', fields }
    }
    for (;;) {
      const keyTok = this.tokens[this.pos++]
      if (!keyTok || (keyTok.type !== 'ident' && keyTok.type !== 'string')) throw new Error('expected a field name')
      let optional = false
      if (this.peekIs('?')) {
        this.pos++
        optional = true
      }
      let type = null
      if (this.peekIs(':')) {
        this.pos++
        type = this.parseType()
      }
      fields.push({ key: keyTok.value, optional, type })
      if (this.peekIs(',')) {
        this.pos++
        if (this.peekIs('}')) {
          this.pos++
          break
        }
        continue
      }
      this.expect('}')
      break
    }
    return { kind: 'object', fields }
  }
}

function exampleFromNode(node, hint) {
  switch (node.kind) {
    case 'literal':
      return node.value
    case 'bare':
      switch (node.name) {
        case 'string':
          return `<${hint}>`
        case 'number':
          return 0
        case 'boolean':
          return true
        case 'null':
          return null
        default:
          throw new Error(`cannot derive an example value for bare type '${node.name}'`)
      }
    case 'union':
      return exampleFromNode(node.options[0], hint)
    case 'array':
      return [exampleFromNode(node.element, hint)]
    case 'object': {
      const out = {}
      for (const field of node.fields) {
        if (field.optional) continue
        out[field.key] = field.type ? exampleFromNode(field.type, field.key) : `<${field.key}>`
      }
      return out
    }
    default:
      throw new Error(`unknown shape node kind '${node.kind}'`)
  }
}

/** First balanced `{...}` in the text, brace-depth counted with quote-awareness. Null if unbalanced or absent. */
function extractLeadingBraceExpr(text) {
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let quote = null
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (c === '\\') {
        i++
        continue
      }
      if (c === quote) inString = false
      continue
    }
    if (c === '"' || c === "'") {
      inString = true
      quote = c
      continue
    }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/**
 * Returns the JS value to send as JSON, or throws with a message meant for
 * the annotator. `undefined` means "this body text isn't describing a JSON
 * shape at all" (e.g. a note about a query param) — the caller renders no
 * `-d` flag in that case rather than fabricate one.
 */
function deriveBodyExample(bodyText) {
  try {
    return JSON.parse(bodyText)
  } catch {
    // Not already valid JSON — fall through to shape derivation.
  }

  if (!bodyText.includes('{')) return undefined

  const shape = extractLeadingBraceExpr(bodyText)
  if (!shape) throw new Error('starts with "{" but braces never balance — cannot isolate the shape')

  const parser = new ShapeParser(tokenizeShape(shape))
  const node = parser.parsePrimaryType()
  if (parser.pos !== parser.tokens.length) throw new Error('unexpected trailing content inside the shape')
  return exampleFromNode(node, 'value')
}

// ---------------------------------------------------------------------------
// --scaffold: add missing routes.meta.ts entries as unlabeled placeholders.
// Never touches an entry that already exists — annotation is additive only.
// ---------------------------------------------------------------------------

function skeletonFile(file, routes) {
  const entries = routes.map((r) => `    '${routeKey(r.method, r.path)}': { expose: 'unlabeled' },`).join('\n')
  return `import type { RouteModuleMeta } from './_meta-types'\n\nexport const MODULE: RouteModuleMeta = {\n  file: '${file}',\n  routes: {\n${entries}\n  },\n}\n`
}

function insertMissingEntries(source, missing) {
  const closeRe = /\n( *)\},\n\}\s*$/
  const m = source.match(closeRe)
  if (!m) {
    throw new Error(
      'could not locate the closing "  },\\n}" of the routes object — ' +
        'file does not match the expected scaffold shape, add entries by hand'
    )
  }
  const insertion = missing.map((r) => `    '${routeKey(r.method, r.path)}': { expose: 'unlabeled' },`).join('\n')
  const at = m.index + 1 // right after the newline, before the indent+"},"
  return `${source.slice(0, at)}${insertion}\n${source.slice(at)}`
}

async function runScaffold() {
  let changed = 0
  for (const file of ROUTE_FILES) {
    const scanned = scanRoutesFile(file)
    const path = metaPathFor(file)
    if (!existsSync(path)) {
      writeFileSync(path, skeletonFile(file, scanned))
      log.info(`created ${file}.routes.meta.ts (${scanned.length} placeholder entries)`)
      changed++
      continue
    }
    const meta = await loadMeta(file)
    const existingKeys = new Set(Object.keys(meta.routes || {}))
    const missing = scanned.filter((r) => !existingKeys.has(routeKey(r.method, r.path)))
    if (missing.length === 0) {
      log.info(`${file}.routes.meta.ts already covers all ${scanned.length} routes`)
      continue
    }
    const source = readFileSync(path, 'utf-8')
    writeFileSync(path, insertMissingEntries(source, missing))
    log.info(`${file}.routes.meta.ts: added ${missing.length} missing placeholder entries`)
    changed++
  }
  log.info(changed > 0 ? `scaffold done, ${changed} file(s) touched` : 'scaffold done, nothing to add')
}

// ---------------------------------------------------------------------------
// Reconciliation — the 8 hard failures from the spec, none optional.
// ---------------------------------------------------------------------------

async function reconcile() {
  const groups = await loadGroups()
  const groupIds = Object.keys(groups)
  const errors = []
  const allRoutes = []
  const usedGroups = new Set()
  const unlabeledByFile = new Map()

  for (const file of ROUTE_FILES) {
    const scanned = scanRoutesFile(file)
    const scannedKeys = new Set(scanned.map((r) => routeKey(r.method, r.path)))
    const meta = await loadMeta(file)
    if (!meta) {
      errors.push(`missing meta file: ${file}.routes.meta.ts — run --scaffold to create it`)
      continue
    }
    const metaRoutes = meta.routes || {}
    const metaKeys = new Set(Object.keys(metaRoutes))

    for (const r of scanned) {
      const key = routeKey(r.method, r.path)
      if (!metaKeys.has(key)) errors.push(`[1] missing description: ${key} (add to ${file}.routes.meta.ts)`)
    }
    for (const key of metaKeys) {
      if (!scannedKeys.has(key)) errors.push(`[2] route removed or renamed: ${key} (remove from ${file}.routes.meta.ts)`)
    }

    for (const r of scanned) {
      const key = routeKey(r.method, r.path)
      const rm = metaRoutes[key]
      if (!rm) continue // already reported as [1]

      if (rm.expose === 'ai') {
        if (!rm.group || groupsOf(rm.group).length === 0) errors.push(`[3] ${key}: expose:'ai' missing group`)
        if (!rm.summary) errors.push(`[3] ${key}: expose:'ai' missing summary`)
        if (RAW_WRITE_RE.test(r.body)) {
          errors.push(
            `[13] ${key}: expose:'ai' but the handler writes the response outside res.json ` +
              `(${r.file}.routes.ts:${r.line}). The loopback listener redacts res.json only, so exposing this ` +
              `route would hand the agent unredacted bytes. Keep it 'internal', or answer through res.json.`
          )
        }
        if (isDestructiveShaped(r.method, r.path) && !rm.impact) {
          errors.push(`[10] ${key}: DELETE/remove/clear/uninstall/unbind/reset route missing "impact" — a weak model cannot tell this apart from a narrower, safer sibling without it`)
        }
        for (const field of ['body', 'returns']) {
          const text = rm[field]
          if (typeof text !== 'string') continue
          for (const m of text.matchAll(FABRICATED_ID_RE)) {
            errors.push(`[12] ${key}: ${field} contains a made-up id literal ${m[0]} — every real id is a uuid; use a placeholder like "<xxxId — a uuid from GET ...>" instead`)
          }
        }
        if (rm.body !== undefined && r.method !== 'GET') {
          try {
            rm.__derivedBody = deriveBodyExample(rm.body)
          } catch (error) {
            errors.push(`[body] ${key}: ${error.message} — rewrite "body" as a concrete literal or a shape the derivation understands`)
          }
        }
        for (const g of groupsOf(rm.group)) {
          usedGroups.add(g)
          if (!groupIds.includes(g)) errors.push(`[4] ${key}: group '${g}' is not in the closed enum`)
        }
      } else if (rm.expose === 'wrapped') {
        if (!rm.group || groupsOf(rm.group).length === 0) errors.push(`[3] ${key}: expose:'wrapped' missing group`)
        if (!rm.summary) errors.push(`[3] ${key}: expose:'wrapped' missing summary`)
        if (!rm.useInstead || !rm.bypassCost) errors.push(`[6] ${key}: expose:'wrapped' missing useInstead or bypassCost`)
        for (const g of groupsOf(rm.group)) {
          usedGroups.add(g)
          if (!groupIds.includes(g)) errors.push(`[4] ${key}: group '${g}' is not in the closed enum`)
        }
      } else if (rm.expose === 'unlabeled') {
        if (!unlabeledByFile.has(file)) unlabeledByFile.set(file, [])
        unlabeledByFile.get(file).push(key)
      } else if (rm.expose !== 'internal') {
        errors.push(`[schema] ${key}: unknown expose value '${rm.expose}' (must be 'ai' | 'wrapped' | 'internal' | 'unlabeled')`)
      }

      allRoutes.push({ ...r, meta: rm })
    }
  }

  for (const gid of groupIds) {
    const g = groups[gid]
    if (!g.covers) errors.push(`[5] group '${gid}' missing covers`)
    if (!g.notHere) {
      errors.push(`[5] group '${gid}' missing notHere`)
    } else {
      for (const target of Object.values(g.notHere)) {
        if (!target.startsWith('tool:') && !groupIds.includes(target)) {
          errors.push(`[8] group '${gid}' notHere points to unknown group '${target}'`)
        }
      }
    }
  }
  for (const gid of groupIds) {
    if (!usedGroups.has(gid)) errors.push(`[7] group '${gid}' has zero routes assigned — an empty group misleads the agent`)
  }

  if (unlabeledByFile.size > 0) {
    const total = [...unlabeledByFile.values()].reduce((sum, keys) => sum + keys.length, 0)
    const perFile = [...unlabeledByFile.entries()].map(([file, keys]) => `${file}.routes.meta.ts ${keys.length} 条`).join('、')
    const [firstFile, firstKeys] = unlabeledByFile.entries().next().value
    errors.push(
      `[9] 未标注 ${total} 条（scaffold 占位未处理）：${perFile} — 首条 ${firstKeys[0]}（${firstFile}.routes.meta.ts）`
    )
  }

  // A "see also" pointer that leads to a 403 is worse than no pointer at all —
  // it hands the agent a specific dead end instead of leaving it to search.
  // Written references are literal "METHOD /api/..." text, the same form
  // annotators already use in narrowerAlternative and in prose notes.
  //
  // `notes` is prose, and prose can legitimately name an internal route while
  // explicitly warning it off ("X is not exposed to the assistant — tell the
  // user to do it in Settings"), which is the *correct* way to mention one.
  // Only flag a `notes` reference lacking such a caveat nearby; `narrowerAlternative`
  // is never prose — it's a bare pointer meant to be called directly, so any
  // internal target there is a bug with no legitimate reading.
  const exposeByKey = new Map(allRoutes.map((r) => [routeKey(r.method, r.path), r.meta.expose]))
  const PATH_REF_RE = /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/api\/\S+?)(?=[\s,.;)]|$)/g
  const CAVEAT_RE = /not exposed|is internal|not available|cannot be (called|used)|blocked|no longer/i
  for (const r of allRoutes) {
    const key = routeKey(r.method, r.path)
    if (r.meta.narrowerAlternative) {
      const refKey = r.meta.narrowerAlternative.trim()
      if (exposeByKey.get(refKey) === 'internal') {
        errors.push(`[11] ${key}: narrowerAlternative points to ${refKey}, which is 'internal' — the manual would send the agent through a 403`)
      }
    }
    if (r.meta.notes) {
      for (const m of r.meta.notes.matchAll(PATH_REF_RE)) {
        const refKey = `${m[1]} ${m[2]}`
        if (exposeByKey.get(refKey) !== 'internal') continue
        const window = r.meta.notes.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60)
        if (!CAVEAT_RE.test(window)) {
          errors.push(`[11] ${key}: notes points to ${refKey}, which is 'internal', without warning it off — the manual would send the agent through a 403`)
        }
      }
    }
  }

  // `withheld` and `expose` are two sources of truth about the same thing and
  // have already drifted apart twice (a route flips to 'ai', the withheld
  // sentence describing it as blocked is never updated, or vice versa). A
  // withheld entry's whole job is to say "not available here" — a concrete
  // path reference inside one is checked directly against expose; an
  // affirmative "can be done over/via this API" claim with no path to check
  // can only be flagged for a human, so it is a warning, not a failure.
  const AFFIRMATIVE_API_CLAIM_RE = /\bcan\s+(?:be\s+\w+|\w+)\b[^.]{0,40}\b(?:this |the )?API\b/i
  const warnings = []
  for (const gid of groupIds) {
    const withheld = groups[gid].withheld
    if (!withheld) continue
    for (const item of withheld) {
      for (const m of item.matchAll(PATH_REF_RE)) {
        const refKey = `${m[1]} ${m[2]}`
        const expose = exposeByKey.get(refKey)
        if (expose !== undefined && expose !== 'internal') {
          errors.push(`[13] group '${gid}' withheld references ${refKey}, which is expose:'${expose}' — withheld must only name routes that are actually 'internal'`)
        }
      }
      if (AFFIRMATIVE_API_CLAIM_RE.test(item)) {
        warnings.push(`[14] group '${gid}' withheld: affirmative API claim in "${item.slice(0, 80)}..." — verify by hand that nothing it describes is actually 'ai'`)
      }
    }
  }
  for (const w of warnings) log.warn(w)

  return { errors, allRoutes, groups }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * `:spaceId` renders as the literal `$HALO_SPACE_ID` shell variable, not a
 * `<spaceId>` placeholder: a placeholder itself signals "invent a value
 * here", and a weak model will (a space name, a
 * wrong pick, a fabricated uuid). The agent already has the real one in its
 * env; turning "remember not to guess this" into "there is nothing to guess"
 * is the same principle behind not rendering path params it can't guess at
 * all safely.
 */
function toDisplayPath(path) {
  return path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => (name === 'spaceId' ? '$HALO_SPACE_ID' : `<${name}>`))
}

/** Response shape hints at a JSON array — truncate by default so a big list can't flood context (see footer). */
function looksLikeListResponse(returns) {
  return typeof returns === 'string' && /data\s*:\s*\[/.test(returns)
}

function buildCurl(method, path, jsonBody, truncate) {
  const url = `$HALO_API_URL${toDisplayPath(path)}`
  const pipe = truncate ? ' | head -c 4000' : ''
  if (jsonBody === undefined) {
    const flag = method === 'GET' ? '-s' : `-sX ${method}`
    return `${BASE_INDENT}curl ${flag} "${url}" -H "Authorization: Bearer $HALO_API_TOKEN"${pipe}`
  }
  const last = `${CONT_INDENT}-d '${JSON.stringify(jsonBody)}'${pipe}`
  return [`${BASE_INDENT}curl -sX ${method} "${url}" \\`, `${CONT_INDENT}-H "Authorization: Bearer $HALO_API_TOKEN" \\`, `${CONT_INDENT}-H "Content-Type: application/json" \\`, last].join(
    '\n'
  )
}

/**
 * `!!` is deliberately not a `#` comment: pasting a DESTRUCTIVE block into
 * bash must break loudly (`command not found`) instead of the shell reading
 * through it silently (the whole reason `# out:` / `# body:` / `# err:`
 * exist elsewhere is so those lines DON'T break bash;
 * this is the one place breaking it is the point). Must name the narrower
 * alternative inline — it has to land on the exact line the agent is about
 * to misread, not in a group-level cross-reference already scrolled past.
 * Absent `impact` means safe/read-only by contract default — nothing is
 * rendered for it, keeping the common case uncluttered.
 */
function renderImpactLines(meta) {
  const lines = []
  if (meta.impact === 'irreversible') {
    lines.push(`${BASE_INDENT}!! DESTRUCTIVE: cannot be undone. Confirm with the user in plain language before running this.`)
    if (meta.narrowerAlternative) {
      lines.push(`${BASE_INDENT}!! If the user meant something smaller, use ${toDisplayPath(meta.narrowerAlternative)} instead.`)
    }
  } else if (meta.impact === 'reversible') {
    lines.push(`${BASE_INDENT}# note: reversible — can be undone or corrected afterward.`)
  }
  return lines
}

function renderEntry(r, pathWidth) {
  const header = `${r.method.padEnd(7)}${toDisplayPath(r.path).padEnd(pathWidth)}${r.meta.summary}`
  if (r.meta.expose === 'wrapped') {
    return [
      header,
      `${BASE_INDENT}# use ${r.meta.useInstead} instead — a raw call would skip: ${r.meta.bypassCost}.`,
      `${BASE_INDENT}# If that tool is not available to you, this capability is switched off in this build's settings —`,
      `${BASE_INDENT}# say that, and do not say Halo cannot do it.`,
    ].join('\n')
  }
  const jsonBody = r.method !== 'GET' ? r.meta.__derivedBody : undefined
  const truncate = r.method === 'GET' && looksLikeListResponse(r.meta.returns)
  const lines = [header, ...renderImpactLines(r.meta), buildCurl(r.method, r.path, jsonBody, truncate)]
  if (r.meta.body !== undefined) lines.push(`${BASE_INDENT}# body: ${r.meta.body}`)
  if (r.meta.returns) lines.push(`${BASE_INDENT}# out: ${r.meta.returns}`)
  if (r.meta.notes) {
    for (const n of r.meta.notes.split('\n')) {
      lines.push(`${BASE_INDENT}${isErrorNote(n) ? '# err:' : '# note:'} ${n}`)
    }
  }
  return lines.join('\n')
}

/**
 * `# err:` is what an agent scans when it wants to know how a call can fail,
 * so only lines that actually describe a failure earn it. Consequence prose
 * filed under the same label makes that scan return the wrong thing.
 */
function isErrorNote(line) {
  return /^\s*(\d{3}\b|"?\w+"? ?=|[A-Z_]{4,}\b)/.test(line) || /\b\d{3}\s*=/.test(line)
}

function wrap(text, label, maxWidth = 78) {
  const contIndent = ' '.repeat(label.length)
  const words = text.split(/\s+/)
  const lines = []
  let current = label
  for (const word of words) {
    const atStart = current === label || current === contIndent
    const candidate = atStart ? current + word : `${current} ${word}`
    if (!atStart && candidate.length > maxWidth) {
      lines.push(current)
      current = contIndent + word
    } else {
      current = candidate
    }
  }
  lines.push(current)
  return lines.join('\n')
}

/** One mapping per line, never folded — a wrapped `|`-joined list lets a weak model pair the wrong two fragments together. */
function renderNotHere(notHere) {
  return [
    'not here:',
    ...Object.entries(notHere).map(([k, v]) => `  ${k} -> ${v.startsWith('tool:') ? `use the ${v.slice('tool:'.length)} tool` : v}`),
  ]
}

/** Page-top table so a model that only reads the first 20% of a 200+ line page still knows what this page does and does not have. */
function renderOpsTable(routes, pathWidth) {
  if (routes.length === 0) return []
  return [
    'operations on this page:',
    ...routes.map((r) => {
      // The table is where scanning happens, so the weight difference between
      // "delete everything" and "delete one item" has to survive here too —
      // rebuilding it below in the entry body is too late for a model that
      // picked a line from this list.
      // Flagging every destructive row alike would re-flatten the one
      // distinction that matters here: several deletes sit side by side and
      // only some of them take the whole thing. Rows that have a narrower
      // sibling say so, so a model choosing off this list is warned on the
      // line it is about to pick.
      const mark =
        r.meta.impact !== 'irreversible'
          ? ''
          : r.meta.narrowerAlternative
            ? `   !! destructive - narrower: ${toDisplayPath(r.meta.narrowerAlternative)}`
            : '   !! destructive'
      return `  ${r.method.padEnd(7)}${toDisplayPath(r.path).padEnd(pathWidth)}${r.meta.summary}${mark}`
    }),
    '',
  ]
}

const FOOTER = [
  '-----------------------------------------------------------------------',
  '$HALO_API_URL, $HALO_API_TOKEN and $HALO_SPACE_ID are already set in your Bash',
  '  environment. Copy commands as-is; never expand or print those variables.',
  'Replace only <angle-bracket> placeholders. Get real ids from a list call above.',
  'Read the response body and check "success". HTTP 200 alone does not mean it',
  '  worked - many failures return 200 with {"success":false}.',
  'Pipe long responses through `| head -c 4000` so you do not flood your context.',
  'A POST that timed out may still have taken effect. List before you retry.',
  'Waiting on something? Back off (2s, then double), give up after 5 tries and',
  '  tell the user it is still running.',
  'Large or binary files do not go through this API - use Read / Write / Bash.',
  '403 = the endpoint exists but is closed to me in this build. Tell the user to',
  '  do it in the Halo app. Do not tell them Halo cannot do it.',
  '404 with a "code" field = my path is wrong. 404 without one = the id is wrong.',
  'Only call paths listed on this page or in the index. Never write one from',
  '  memory. If this page has left your context, call halo_api_ref again.',
  `Full index of every endpoint: ${INDEX_PATH_TOKEN}/index.txt`,
  `  grep -i "<keyword>" ${INDEX_PATH_TOKEN}/index.txt`,
  'Not listed here does NOT mean not supported — that is a real, deliverable',
  '  answer, not a failed search. Grep the index before you say "Halo can\'t do that".',
].join('\n')

/**
 * Placed at the foot of the page, immediately above the grep instruction,
 * because this is information consumed on the failure path: the agent reads
 * the top of a page to decide whether what it wants is here, and only reaches
 * the bottom after that has come up empty. Sitting above the grep line is what
 * lets it intercept the search it is about to start; higher up the page it
 * would be read before the question it answers has been asked, and would put
 * ten lines of "you cannot" ahead of the operations table.
 *
 * The closing sentences matter as much as the list. Without the first, an
 * agent treats a capability description as a path it merely has not been shown
 * and goes hunting; without the second, a page of "not yours" reads as "this
 * whole area is not yours" and switches the search rule off everywhere.
 */
function renderWithheld(withheld) {
  if (!withheld || withheld.length === 0) return []
  return [
    'Halo does all of these; you do not. Say so, and say where:',
    ...withheld.map((w) => `  - ${w}`),
    'That list is complete for this area and the search has already been done for',
    '  you: do not grep the index for these, and do not guess a path — it will 403.',
    'For anything NOT on that list the normal rule still applies: grep the index',
    '  before you tell the user something is impossible.',
    'After saying where, tell the user which nearby parts you CAN do for them —',
    '  a hand-off reads very differently from a refusal.',
    '',
  ]
}

/**
 * "There is no endpoint for this" is a real, deliverable answer — the three
 * layers of fallback (group -> notHere -> full grep) all assume the target
 * exists, so when it truly does not, the agent needs an actual exit ramp,
 * not just a longer path to the same dead end.
 */
function renderNoEndpoint(noEndpoint) {
  if (!noEndpoint || Object.keys(noEndpoint).length === 0) return []
  return [...Object.entries(noEndpoint).map(([k, v]) => `(no endpoint) ${k} — ${toDisplayPath(v)}`), '']
}

function renderGroupPage(group, routes, pathWidth) {
  const lines = [
    `## ${group.title}`,
    wrap(group.covers, 'covers: '),
    ...renderNotHere(group.notHere),
    '',
    ...renderNoEndpoint(group.noEndpoint),
    ...renderOpsTable(routes, pathWidth),
  ]
  for (const r of routes) {
    lines.push(renderEntry(r, pathWidth), '')
  }
  lines.push(...renderWithheld(group.withheld))
  lines.push(FOOTER)
  return lines.join('\n') + '\n'
}

function renderIndex(routes, pathWidth) {
  return (
    routes
      .map((r) => {
        const expose = `[${r.meta.expose}]`.padEnd(11)
        const groupsCol = groupsOf(r.meta.group).join(',').padEnd(24)
        return `${r.method.padEnd(7)}${toDisplayPath(r.path).padEnd(pathWidth)}${expose}${groupsCol}${r.meta.summary}`
      })
      .join('\n') + '\n'
  )
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n))
}

function renderAll(allRoutes, groups) {
  const exposedRoutes = allRoutes.filter((r) => r.meta.expose === 'ai' || r.meta.expose === 'wrapped')
  const pathWidth = clamp(Math.max(...exposedRoutes.map((r) => toDisplayPath(r.path).length)) + 2, 24, 60)

  const files = new Map()

  for (const gid of Object.keys(groups)) {
    // Declaration order only means something for route *matching* (a route
    // file's own ordering constraints, e.g. /reorder before /:spaceId) — it
    // says nothing about which capability a reader should see first. Path
    // order is deterministic, diff-stable, and (incidentally) puts a
    // group's flagship collection endpoint before its narrow one-off
    // routes, which declaration order does not: a weak model reading only
    // the first 20% of a long page must not land on the least-relevant one.
    const routesForGroup = exposedRoutes.filter((r) => groupsOf(r.meta.group).includes(gid)).sort((a, b) => a.path.localeCompare(b.path))
    files.set(`${gid}.txt`, renderGroupPage(groups[gid], routesForGroup, pathWidth))
  }

  files.set('index.txt', renderIndex(exposedRoutes, pathWidth))

  const scope = allRoutes.filter((r) => r.meta.expose === 'ai').map((r) => ({ method: r.method, path: r.path }))
  files.set('scope.json', JSON.stringify(scope, null, 2) + '\n')

  // group is included so the self-API middleware's 403 response can name a
  // real redirect target — never a template placeholder. Absent for
  // 'internal' routes, which carry no group in their meta.
  const routesJson = allRoutes.map((r) => {
    const group = groupsOf(r.meta.group)[0]
    return group ? { method: r.method, path: r.path, group } : { method: r.method, path: r.path }
  })
  files.set('routes.json', JSON.stringify(routesJson, null, 2) + '\n')

  const exposeCounts = { ai: 0, wrapped: 0, internal: 0, unlabeled: 0 }
  for (const r of allRoutes) exposeCounts[r.meta.expose]++
  const groupCounts = Object.fromEntries(Object.keys(groups).map((g) => [g, 0]))
  for (const r of exposedRoutes) for (const g of groupsOf(r.meta.group)) groupCounts[g]++
  // Derived from the routes alone — deliberately no timestamp. The tree is
  // committed and `--check` gates it in CI, so any field that changes without
  // the input changing turns the gate into noise people learn to ignore.
  files.set(
    'SNAPSHOT.json',
    JSON.stringify(
      {
        totalRoutes: allRoutes.length,
        expose: exposeCounts,
        groups: groupCounts,
        files: ROUTE_FILES,
      },
      null,
      2
    ) + '\n'
  )

  return files
}

// ---------------------------------------------------------------------------
// Output — staging directory + atomic replace, same convention as sync-ai-guides.mjs.
// ---------------------------------------------------------------------------

function writeOutputs(files) {
  const staging = `${TARGET_DIR}.tmp`
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  for (const [rel, content] of files) writeFileSync(join(staging, rel), content)
  rmSync(TARGET_DIR, { recursive: true, force: true })
  mkdirSync(resolve(TARGET_DIR, '..'), { recursive: true })
  cpSync(staging, TARGET_DIR, { recursive: true })
  rmSync(staging, { recursive: true, force: true })
}

function diffOutputs(files) {
  const diffs = []
  for (const [rel, content] of files) {
    const path = join(TARGET_DIR, rel)
    if (!existsSync(path)) {
      diffs.push(`missing: ${rel}`)
      continue
    }
    if (readFileSync(path, 'utf-8') !== content) diffs.push(`stale: ${rel}`)
  }
  if (existsSync(TARGET_DIR)) {
    const known = new Set(files.keys())
    for (const entry of readdirSync(TARGET_DIR)) {
      if (!known.has(entry)) diffs.push(`unexpected extra file: ${entry}`)
    }
  }
  return diffs
}

// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2)
  const check = args.includes('--check')
  const scaffold = args.includes('--scaffold')
  if (check && scaffold) {
    log.err('--check and --scaffold are mutually exclusive')
    process.exit(1)
  }

  assertRouteFilesCoverDirectory()
  assertRouteFilesMatchRegistrationOrder()
  assertHelpersNeverWriteRaw()

  if (scaffold) {
    await runScaffold()
    return
  }

  const { errors, allRoutes, groups } = await reconcile()
  if (errors.length > 0) {
    log.err(`${errors.length} reconciliation failure(s):`)
    for (const e of errors) log.err(`  ${e}`)
    process.exit(1)
  }

  const files = renderAll(allRoutes, groups)

  if (check) {
    const diffs = diffOutputs(files)
    if (diffs.length > 0) {
      log.err(`${diffs.length} file(s) out of date in resources/api-ref/:`)
      for (const d of diffs) log.err(`  ${d}`)
      log.err('run: node scripts/gen-api-ref.mjs')
      process.exit(1)
    }
    log.info('resources/api-ref/ is up to date')
    return
  }

  writeOutputs(files)
  log.info(`wrote ${files.size} file(s) to resources/api-ref/ (${allRoutes.length} routes reconciled)`)
}

main().catch((e) => {
  log.err(e.stack || e.message)
  process.exit(1)
})
