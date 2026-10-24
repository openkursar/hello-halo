/**
 * Guard: what Halo loads before its window, and how the second phase starts.
 *
 * Everything statically imported from `src/main/index.ts` is loaded and run
 * before the window is created (ARCHITECTURE §16 "Code loads with its tier").
 * One static import of a second-phase module, or of a package only a rare path
 * needs, puts it and everything it imports back in front of the window, and
 * every other test stays green.
 */

import { build, type Metafile } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, findMatches, formatMatches, listSourceFiles, readSource } from './lib/source-scan'

const ENTRY = 'src/main/index.ts'

/** Loaded through `import()` after the first screen, or where they are used. */
const SECOND_PHASE = ['src/main/bootstrap/extended.ts', 'src/main/apps/runtime/index.ts', 'src/main/http/routes/']

/** Loaded on first use. */
const FIRST_USE_PACKAGES = ['@larksuiteoapi/node-sdk', 'axios', 'gpt-tokenizer', '@anthropic-ai/tokenizer']

/** The main entry's import graph as the bundler sees it, with every package left external. */
async function mainImports(): Promise<Metafile['inputs']> {
  const result = await build({
    absWorkingDir: REPO_ROOT,
    entryPoints: [ENTRY],
    bundle: true,
    write: false,
    metafile: true,
    platform: 'node',
    format: 'cjs',
    outfile: 'startup-phases-guard.cjs',
    logLevel: 'silent',
    plugins: [{
      name: 'packages-external',
      setup(builder) {
        builder.onResolve({ filter: /^[^./]/ }, (args) => ({ path: args.path, external: true }))
      },
    }],
  })
  return result.metafile.inputs
}

/** Files the entry reaches through import statements, each with the file that imports it. */
function staticallyReached(inputs: Metafile['inputs']): Map<string, string | null> {
  const importer = new Map<string, string | null>([[ENTRY, null]])
  const queue = [ENTRY]
  for (let file = queue.shift(); file; file = queue.shift()) {
    for (const edge of inputs[file]?.imports ?? []) {
      if (edge.kind !== 'import-statement' || edge.external || importer.has(edge.path)) continue
      importer.set(edge.path, file)
      queue.push(edge.path)
    }
  }
  return importer
}

function importChain(importer: Map<string, string | null>, file: string): string {
  const files: string[] = []
  for (let at: string | null | undefined = file; at; at = importer.get(at)) files.unshift(at)
  return files.join('\n  -> ')
}

describe('startup phases guard', () => {
  it('keeps the second phase and first-use packages out of what loads before the window', async () => {
    const inputs = await mainImports()
    const importer = staticallyReached(inputs)
    expect(importer.has('src/main/bootstrap/essential.ts')).toBe(true)

    const problems: string[] = []
    for (const file of importer.keys()) {
      if (SECOND_PHASE.some((module) => file.startsWith(module))) {
        problems.push(`${file} is imported statically:\n  ${importChain(importer, file)}`)
      }
      for (const edge of inputs[file]?.imports ?? []) {
        const name = FIRST_USE_PACKAGES.find((pkg) => edge.path === pkg || edge.path.startsWith(`${pkg}/`))
        if (name && edge.kind === 'import-statement') {
          problems.push(`${name} is imported statically:\n  ${importChain(importer, file)}`)
        }
      }
    }
    expect(problems.join('\n\n')).toBe('')
  }, 60_000)

  it('starts the second phase only when not quitting, and reports a failure to start it', () => {
    const index = readSource('src/main/index.ts')
    const start = index.indexOf('registerFirstScreenListener(() => {')
    expect(start).toBeGreaterThan(-1)
    const listener = index.slice(start, index.indexOf('\n  })\n', start))
    const quitCheck = listener.indexOf('if (isAppQuitting) return')
    expect(quitCheck).toBeGreaterThan(-1)
    expect(quitCheck).toBeLessThan(listener.indexOf('initializeExtendedServices()'))
    expect(listener).toMatch(/initializeExtendedServices\(\)[\s\S]*\.catch\([\s\S]*showUncaughtErrorNotice\(/)
  })

  it('bundles English as the only language in the renderer entry', () => {
    const imports = findMatches(listSourceFiles('src/renderer'), /^\s*import\s[^(]*\/locales\/(?!en\.json)[^'"]+\.json['"]/)
    expect(formatMatches(imports)).toBe('')
  })
})
