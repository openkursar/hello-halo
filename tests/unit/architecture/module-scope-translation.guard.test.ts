/**
 * Guard: nothing translates while its module loads.
 *
 * Languages other than English load after the app's modules have run
 * (ARCHITECTURE §16 "Code loads with its tier"). A `t()` that runs while a
 * module loads (a module-scope constant, a store initializer, a static class
 * field) gets English, and keeps it after the language has arrived.
 */

import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { listSourceFiles, readSource } from './lib/source-scan'

/** Runs before the app's code and translates from strings inlined at build time. */
const OWN_TRANSLATOR = ['src/renderer/boot/splash.ts']

/** Methods that call their callback before they return. */
const IN_PLACE_CALLBACKS = new Set(['map', 'forEach', 'filter', 'reduce', 'reduceRight', 'flatMap', 'some', 'every', 'find', 'findIndex', 'findLast', 'findLastIndex', 'sort', 'toSorted', 'from'])

/** zustand store factories and middleware: the initializer runs when the store is created. */
const STORE_FACTORIES = new Set(['create', 'createStore', 'createWithEqualityFn', 'persist', 'immer', 'subscribeWithSelector', 'devtools', 'combine'])

interface Translation {
  line: number
  call: string
}

function calleeName(expression: ts.Expression): string {
  if (ts.isIdentifier(expression)) return expression.text
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text
  return ''
}

/** Whether a function runs where it is written: called on the spot, as an in-place callback, or as a store initializer. */
function runsInPlace(fn: ts.Node): boolean {
  let node = fn
  while (ts.isParenthesizedExpression(node.parent)) node = node.parent
  const call = node.parent
  if (!ts.isCallExpression(call)) return false
  if (call.expression === node) return true
  if (!call.arguments.some((argument) => argument === node)) return false
  const name = calleeName(call.expression)
  if (IN_PLACE_CALLBACKS.has(name) || STORE_FACTORIES.has(name)) return true
  // create<State>()(initializer)
  return ts.isCallExpression(call.expression) && STORE_FACTORIES.has(calleeName(call.expression.expression))
}

function isStatic(member: ts.ClassElement): boolean {
  return ts.canHaveModifiers(member) && !!ts.getModifiers(member)?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)
}

/** Translation calls that run while `file` loads, following calls into its own functions and classes. */
function translationsAtLoad(file: string, text = readSource(file)): Translation[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const functionBodies = new Map<string, ts.Node | undefined>()
  const classes = new Map<string, ts.ClassDeclaration>()
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) functionBodies.set(statement.name.text, statement.body)
    if (ts.isClassDeclaration(statement) && statement.name) classes.set(statement.name.text, statement)
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      const value = declaration.initializer
      if (ts.isIdentifier(declaration.name) && value && (ts.isArrowFunction(value) || ts.isFunctionExpression(value))) {
        functionBodies.set(declaration.name.text, value.body)
      }
    }
  }

  const found: Translation[] = []
  const followed = new Set<ts.Node>()
  const follow = (body: ts.Node | undefined): void => {
    if (!body || followed.has(body)) return
    followed.add(body)
    visit(body)
  }
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) && !runsInPlace(node)) return
    if (ts.isClassLike(node)) {
      for (const member of node.members) {
        if (ts.isClassStaticBlockDeclaration(member)) visit(member.body)
        else if (ts.isPropertyDeclaration(member) && isStatic(member) && member.initializer) visit(member.initializer)
      }
      return
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(source)
      if (callee === 't' || callee === 'i18n.t' || callee === 'i18next.t' || /(^|\.)getFixedT$/.test(callee)) {
        found.push({
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          call: node.getText(source).replace(/\s+/g, ' ').slice(0, 100),
        })
      } else if (ts.isIdentifier(node.expression)) {
        follow(functionBodies.get(node.expression.text))
      }
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      for (const member of classes.get(node.expression.text)?.members ?? []) {
        if (ts.isConstructorDeclaration(member)) follow(member.body)
        else if (ts.isPropertyDeclaration(member) && !isStatic(member)) follow(member.initializer)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

describe('module-scope translation guard', () => {
  it('translates nothing while a renderer module loads', () => {
    const files = [...listSourceFiles('src/renderer'), ...listSourceFiles('src/shared')]
      .filter((file) => !OWN_TRANSLATOR.includes(file) && /\bt\(|\.t\(|getFixedT/.test(readSource(file)))
    const found = files.flatMap((file) => translationsAtLoad(file).map((hit) => `${file}:${hit.line}  ${hit.call}`))
    expect(found.join('\n')).toBe('')
  })

  it('finds a translation however the load reaches it', () => {
    const fixture = [
      "import i18n from '../i18n'",
      "import { create } from 'zustand'",
      "const LABEL = i18n.t('At load')",
      "const later = () => i18n.t('Later')",
      "function labels() { return [i18n.t('Via helper')] }",
      'const LABELS = labels()',
      "const useStore = create(() => ({ title: i18n.t('Store') }))",
      "const NAMES = ['a'].map((name) => i18n.t(name))",
      "class Panel { static title = i18n.t('Static'); name = i18n.t('Instance'); open() { return i18n.t('Method') } }",
      'const panel = new Panel()',
      "export function Component() { return i18n.t('Render') }",
    ].join('\n')
    expect(translationsAtLoad('fixture.ts', fixture).map((hit) => hit.call)).toEqual([
      "i18n.t('At load')",
      "i18n.t('Via helper')",
      "i18n.t('Store')",
      'i18n.t(name)',
      "i18n.t('Static')",
      "i18n.t('Instance')",
    ])
  })
})
