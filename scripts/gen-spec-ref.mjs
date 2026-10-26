#!/usr/bin/env node
/**
 * gen-spec-ref.mjs — export the App Spec field reference as JSON
 *
 * The documentation site renders the Digital Human spec reference from this
 * export, so its field list is never maintained by hand. Read-only over
 * src/main/apps/spec: field structure (type, required, default, allowed
 * values) comes from the Zod schemas on the module's public surface
 * (index.ts), bundled with esbuild into a throwaway temp file; descriptions
 * are the JSDoc comments in schema.ts, read with the TypeScript compiler API.
 * Nothing is written except the file passed to --export-json.
 *
 * Usage:
 *   node scripts/gen-spec-ref.mjs --export-json <file>
 *
 * Exit codes:
 *   0 — export written
 *   1 — missing argument, or the schemas could not be loaded or walked
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import ts from 'typescript'

const PROJECT_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const SPEC_DIR = join(PROJECT_ROOT, 'src', 'main', 'apps', 'spec')
const SCHEMA_FILE = join(SPEC_DIR, 'schema.ts')

const EXPORT_SCHEMA_VERSION = 1

/** Spec type → the exported schema that defines it. */
const SPEC_TYPES = {
  automation: 'AutomationSpecSchema',
  mcp: 'McpSpecSchema',
  skill: 'SkillSpecSchema',
  extension: 'ExtensionSpecSchema',
}

/** schema.ts helpers whose meaning a Zod walk cannot recover. */
const FORMATS = {
  nonEmptyString: 'non-empty',
  versionString: 'version',
  durationString: 'duration',
  cronString: 'cron',
}

/** Placeholder segment for a map's key in a field path. */
const MAP_KEYS = { memory_schema: '<field>', i18n: '<locale>', skill_files: '<file>', env: '<name>', headers: '<name>' }

// ---------------------------------------------------------------------------
// schema.ts comments
// ---------------------------------------------------------------------------

/**
 * Index the JSDoc of every object property in schema.ts by
 * `<variable>.<property chain>`, plus which schema variable a property's value
 * refers to, so a runtime walk can find the comment for any field. Variants of
 * a discriminated union are keyed `[type=<value>]`.
 */
function readSchemaComments() {
  const text = readFileSync(SCHEMA_FILE, 'utf8')
  const source = ts.createSourceFile(SCHEMA_FILE, text, ts.ScriptTarget.Latest, true)
  const variables = new Set()
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const decl of statement.declarationList.declarations) {
      if (ts.isIdentifier(decl.name)) variables.add(decl.name.text)
    }
  }

  const props = new Map()
  const aliases = new Map()

  const jsdocOf = (node) => {
    const ranges = ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []
    const doc = ranges.map((r) => text.slice(r.pos, r.end)).filter((c) => c.startsWith('/**')).pop()
    if (!doc) return undefined
    return doc
      .replace(/^\/\*\*|\*\/$/g, '')
      .split('\n')
      .map((line) => line.replace(/^\s*\*\s?/, '').trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\\\//g, '/')
  }

  const identifiersIn = (node) => {
    const found = []
    const visit = (n) => {
      if (ts.isIdentifier(n)) found.push(n.text)
      ts.forEachChild(n, visit)
    }
    visit(node)
    return found
  }

  const literalOf = (node) => {
    if (!node || !ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return undefined
    if (node.expression.name.text !== 'literal') return undefined
    const arg = node.arguments[0]
    return arg && ts.isStringLiteral(arg) ? arg.text : undefined
  }

  const visit = (node, owner, chain) => {
    if (ts.isObjectLiteralExpression(node)) {
      // Only an option of a union — `[z.object({ type: z.literal(…) }), …]` — is a variant.
      const isOption = ts.isCallExpression(node.parent) && ts.isArrayLiteralExpression(node.parent.parent)
      const typeProp = isOption && node.properties.find(
        (p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'type'
      )
      const variant = typeProp ? literalOf(typeProp.initializer) : undefined
      const base = variant ? [...chain, `[type=${variant}]`] : chain
      for (const prop of node.properties) {
        if (!ts.isPropertyAssignment(prop) || !(ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) continue
        const name = prop.name.text
        const ids = identifiersIn(prop.initializer)
        props.set([owner, ...base, name].join('.'), {
          description: jsdocOf(prop),
          ref: ids.find((id) => id !== owner && id.endsWith('Schema') && variables.has(id)),
          format: FORMATS[ids.find((id) => id in FORMATS)],
        })
        visit(prop.initializer, owner, [...base, name])
      }
      return
    }
    ts.forEachChild(node, (child) => visit(child, owner, chain))
  }

  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const decl of statement.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue
      const owner = decl.name.text
      // `Base.extend({...})` and `z.record(z.string(), Other)` both read their
      // remaining fields from another variable.
      const target = identifiersIn(decl.initializer).find((id) => id !== owner && id.endsWith('Schema') && variables.has(id))
      if (target) aliases.set(owner, target)
      visit(decl.initializer, owner, [])
    }
  }

  return function lookup(owner, chain, key) {
    let current = owner
    for (let hops = 0; current && hops < 5; hops++) {
      const hit = props.get([current, ...chain, key].join('.'))
      // Only a top-level field can be declared on the schema this one extends.
      if (hit || chain.length > 0) return hit ?? {}
      current = aliases.get(current)
    }
    return {}
  }
}

// ---------------------------------------------------------------------------
// Zod walk
// ---------------------------------------------------------------------------

async function loadSpecModule() {
  const dir = mkdtempSync(join(tmpdir(), 'halo-spec-ref-'))
  const outfile = join(dir, 'spec.mjs')
  try {
    await build({
      entryPoints: [join(SPEC_DIR, 'index.ts')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile,
      logLevel: 'silent',
      // Bundled CommonJS dependencies still call require() for Node builtins.
      banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    })
    return await import(pathToFileURL(outfile).href)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const kindOf = (schema) => schema?._def?.typeName

function unwrap(schema) {
  let current = schema
  let optional = false
  let defaultValue
  for (;;) {
    const kind = kindOf(current)
    if (kind === 'ZodOptional' || kind === 'ZodNullable') {
      optional = true
      current = current._def.innerType
    } else if (kind === 'ZodDefault') {
      optional = true
      defaultValue = current._def.defaultValue()
      current = current._def.innerType
    } else if (kind === 'ZodEffects') {
      current = current._def.schema
    } else {
      return { schema: current, optional, defaultValue }
    }
  }
}

function typeLabel(schema) {
  const { schema: s } = unwrap(schema)
  switch (kindOf(s)) {
    case 'ZodString': return 'string'
    case 'ZodNumber': return 'number'
    case 'ZodBoolean': return 'boolean'
    case 'ZodEnum': return 'enum'
    case 'ZodLiteral': return 'literal'
    case 'ZodUnknown':
    case 'ZodAny': return 'any'
    case 'ZodArray': {
      const element = typeLabel(s._def.type)
      return element.includes(' | ') ? `(${element})[]` : `${element}[]`
    }
    case 'ZodRecord': return `map<string, ${typeLabel(s._def.valueType)}>`
    case 'ZodObject':
    case 'ZodDiscriminatedUnion': return 'object'
    case 'ZodUnion': return s._def.options.map(typeLabel).join(' | ')
    default: throw new Error(`unsupported Zod type ${kindOf(s)}`)
  }
}

function constraintsOf(schema) {
  const out = {}
  const checks = schema._def.checks ?? []
  if (kindOf(schema) === 'ZodString') {
    if (checks.some((c) => c.kind === 'url')) out.format = 'url'
    const regex = checks.find((c) => c.kind === 'regex')
    if (regex) out.pattern = regex.regex.source
  }
  if (kindOf(schema) === 'ZodNumber') {
    const limits = checks
      .filter((c) => c.kind === 'min' || c.kind === 'max')
      .map((c) => `${c.kind === 'min' ? (c.inclusive ? '>=' : '>') : (c.inclusive ? '<=' : '<')} ${c.value}`)
    if (checks.some((c) => c.kind === 'int')) limits.push('integer')
    if (limits.length) out.constraints = limits
  }
  if (kindOf(schema) === 'ZodEnum') out.values = [...schema._def.values]
  if (kindOf(schema) === 'ZodLiteral') out.values = [schema._def.value]
  if (kindOf(schema) === 'ZodArray') {
    const element = unwrap(schema._def.type).schema
    if (kindOf(element) === 'ZodEnum') out.values = [...element._def.values]
  }
  return out
}

function walkFields(root, owner, lookup) {
  const rows = []

  const field = (child, path, ctx, key, variant) => {
    const { schema, optional, defaultValue } = unwrap(child)
    const meta = lookup(ctx.owner, ctx.chain, key)
    const row = {
      id: variant ? `${path}@${variant}` : path,
      path,
      type: typeLabel(schema),
      required: !optional,
      ...(variant ? { variant } : {}),
      ...(defaultValue !== undefined ? { default: defaultValue } : {}),
      ...(meta.format ? { format: meta.format } : {}),
      ...constraintsOf(schema),
      ...(meta.description ? { description: meta.description } : {}),
    }
    rows.push(row)
    const next = meta.ref ? { owner: meta.ref, chain: [] } : { owner: ctx.owner, chain: [...ctx.chain, key] }
    descend(schema, path, next, variant, key)
  }

  const descend = (schema, path, ctx, variant, key) => {
    const s = unwrap(schema).schema
    switch (kindOf(s)) {
      case 'ZodObject':
        for (const [name, child] of Object.entries(s.shape)) field(child, `${path}.${name}`, ctx, name, variant)
        return
      case 'ZodArray':
        return descend(s._def.type, `${path}[]`, ctx, variant, key)
      case 'ZodRecord':
        return descend(s._def.valueType, `${path}.${MAP_KEYS[key] ?? '<key>'}`, ctx, variant, key)
      case 'ZodUnion':
        for (const option of s._def.options) descend(option, path, ctx, variant, key)
        return
      case 'ZodDiscriminatedUnion': {
        const discriminator = s._def.discriminator
        const options = [...s._def.options]
        const values = options.map((o) => o.shape[discriminator]._def.value)
        rows.push({ id: `${path}.${discriminator}`, path: `${path}.${discriminator}`, type: 'enum', required: true, values })
        for (const option of options) {
          const value = option.shape[discriminator]._def.value
          const optionCtx = { owner: ctx.owner, chain: [...ctx.chain, `[${discriminator}=${value}]`] }
          for (const [name, child] of Object.entries(option.shape)) {
            if (name !== discriminator) field(child, `${path}.${name}`, optionCtx, name, value)
          }
        }
        return
      }
      default:
        return
    }
  }

  for (const [name, child] of Object.entries(root.shape)) field(child, name, { owner, chain: [] }, name, undefined)
  return rows.map((row) => ({ ...row, path: row.path.replace(/^\./, ''), id: row.id.replace(/^\./, '') }))
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const argIndex = process.argv.indexOf('--export-json')
  const target = argIndex === -1 ? undefined : process.argv[argIndex + 1]
  if (!target || target.startsWith('--')) {
    console.error('[gen-spec-ref] usage: node scripts/gen-spec-ref.mjs --export-json <file>')
    process.exit(1)
  }

  const spec = await loadSpecModule()
  const lookup = readSchemaComments()
  const fields = {}
  for (const [type, exportName] of Object.entries(SPEC_TYPES)) {
    const schema = spec[exportName]
    if (kindOf(schema) !== 'ZodObject') throw new Error(`${exportName} is not exported from apps/spec as a Zod object`)
    fields[type] = walkFields(schema, exportName, lookup)
  }

  const appVersion = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8')).version
  const data = {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    appVersion,
    source: 'src/main/apps/spec/schema.ts',
    specTypes: Object.keys(SPEC_TYPES),
    fields,
  }
  const file = resolve(process.cwd(), target)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n')
  const counts = Object.entries(fields).map(([type, rows]) => `${type} ${rows.length}`).join(', ')
  console.log(`[gen-spec-ref] wrote ${file} (${counts})`)
}

main().catch((error) => {
  console.error('[gen-spec-ref]', error instanceof Error ? error.message : error)
  process.exit(1)
})
