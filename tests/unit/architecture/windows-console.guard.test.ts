import ts from 'typescript'
import { existsSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { listSourceFiles, readSource, REPO_ROOT } from './lib/source-scan'

const launchNames = new Set(['spawn', 'spawnSync', 'fork', 'exec', 'execSync', 'execFile', 'execFileSync'])
const posixOnly = new Set([
  'src/main/services/health/process-guardian/platform/darwin.ts',
  'src/main/services/health/process-guardian/platform/linux.ts',
  'src/main/services/agent/mcp-auth-state.ts',
])

function unhiddenLaunches(file: string): string[] {
  const source = ts.createSourceFile(file, readSource(file), ts.ScriptTarget.Latest, true)
  const launches = new Set<string>()
  const namespaces = new Set<string>()
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    if (!['child_process', 'node:child_process'].includes(statement.moduleSpecifier.text)) continue
    const clause = statement.importClause
    if (clause?.name) namespaces.add(clause.name.text)
    const bindings = clause?.namedBindings
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text)
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        if (launchNames.has((binding.propertyName ?? binding.name).text)) launches.add(binding.name.text)
      }
    }
  }

  const collectAliases = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)) {
      const call = node.initializer
      if (ts.isIdentifier(call.expression) && call.expression.text === 'promisify' &&
          call.arguments[0] && ts.isIdentifier(call.arguments[0]) && launches.has(call.arguments[0].text)) {
        launches.add(node.name.text)
      }
    }
    ts.forEachChild(node, collectAliases)
  }
  collectAliases(source)

  const offenders: string[] = []
  const inspect = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const launch = ts.isIdentifier(callee) ? launches.has(callee.text)
        : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) &&
          namespaces.has(callee.expression.text) && launchNames.has(callee.name.text)
      if (launch) {
        const hidden = node.arguments.some((arg) => ts.isObjectLiteralExpression(arg) && arg.properties.some((property) =>
          ts.isPropertyAssignment(property) && property.name.getText(source) === 'windowsHide' &&
          property.initializer.kind === ts.SyntaxKind.TrueKeyword))
        if (!hidden) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
          offenders.push(`${file}:${line} ${callee.getText(source)}`)
        }
      }
    }
    ts.forEachChild(node, inspect)
  }
  inspect(source)
  return offenders
}

describe('background Windows console guard', () => {
  it('every Halo-owned child launch hides its console, including probes and workers', () => {
    // The in-process SDK is an optional, separate repository, absent in core CI.
    const sdkFiles = existsSync(join(REPO_ROOT, 'src/sdk/halo-sdk/package.json')) ? listSourceFiles('src/sdk/halo-sdk') : []
    const files = [...listSourceFiles('src/main'), ...listSourceFiles('src/worker'), ...sdkFiles]
      .filter((file) => !posixOnly.has(file) && !file.includes('/dist/') && !file.includes('/swe-bench-eval/') && !file.endsWith('.test.ts'))
    expect(files.flatMap(unhiddenLaunches)).toEqual([])
  })
})
