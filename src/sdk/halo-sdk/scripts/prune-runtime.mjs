import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import ts from 'typescript';

const runtimeExtension = /\.(?:c|m)?js$/;
const portable = value => value.replaceAll('\\', '/');
const inside = (directory, path) => path.startsWith(directory + sep);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function filesWithin(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Runtime output must not contain symlinks: ${path}`);
    if (entry.isDirectory()) files.push(...await filesWithin(path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

function expression(node) {
  if (!node) return '';
  if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node)) return expression(node.expression);
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isStringLiteralLike(node)) return JSON.stringify(node.text);
  if (ts.isPropertyAccessExpression(node)) return `${expression(node.expression)}.${node.name.text}`;
  if (ts.isCallExpression(node)) return `${expression(node.expression)}(${node.arguments.map(expression).join(',')})`;
  if (ts.isBinaryExpression(node)) return `${expression(node.left)}${node.operatorToken.getText()}${expression(node.right)}`;
  if (ts.isMetaProperty(node)) return node.getText();
  return node.getText().replace(/\s+/g, ' ');
}

function namedFunction(node) {
  for (let current = node.parent; current; current = current.parent) {
    if ((ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) && current.name) return current;
  }
}

function contains(node, predicate) {
  if (predicate(node)) return true;
  let found = false;
  ts.forEachChild(node, child => { if (!found) found = contains(child, predicate); });
  return found;
}

function guardedFileImport(node, argument) {
  let statement = node;
  while (statement.parent && !ts.isBlock(statement.parent)) statement = statement.parent;
  if (!statement.parent || !ts.isBlock(statement.parent)) return false;
  const statements = statement.parent.statements;
  return statements.slice(0, statements.indexOf(statement)).some(previous =>
    ts.isIfStatement(previous) && expression(previous.expression) === `new URL(${argument}).protocol!=="file:"` &&
    contains(previous.thenStatement, ts.isThrowStatement));
}

function allowedDynamic(file, node, kind, argument) {
  const canonical = file.replace(/^dist\//, '').replace(/\.js$/, '.ts');
  const owner = namedFunction(node);
  const name = owner?.name?.getText();
  if (kind === 'require' && canonical === 'native/binding.ts') {
    if (name === 'loadBinding' && argument === 'path' && contains(owner, candidate =>
      ts.isVariableDeclaration(candidate) && candidate.name.getText() === 'path' && expression(candidate.initializer) === 'nativeBinaryPath()')) {
      return 'platform native library declared by native/build-info.json';
    }
    if (name === 'nativeBinaryPath' && argument === 'join(directory,"source-identity.cjs")') {
      for (let current = node.parent; current && current !== owner; current = current.parent) {
        if (ts.isIfStatement(current) && expression(current.expression) === 'modulePath.endsWith(".ts")') {
          return 'source-module validation only; compiled JavaScript does not enter this branch';
        }
      }
    }
  }
  if (kind === 'import' && ((canonical === 'native/runtime.ts' && name === 'prepare' && argument === 'setup.module') ||
      (canonical === 'worker/entry.ts' && name === 'create' && argument === 'value.setup.module')) && guardedFileImport(node, argument)) {
    return 'absolute file URL supplied and owned by the embedding host';
  }
}

function auditSource(file, code, runtimeFile, bundled = false) {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true,
    extname(file) === '.ts' ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const factories = new Set();
  const requires = new Set(['require', '__require']);
  const createdRequires = new Set();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.text !== 'node:module') continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const item of bindings.elements) if ((item.propertyName ?? item.name).text === 'createRequire') factories.add(item.name.text);
    }
  }
  const registrations = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
        ts.isCallExpression(node.initializer) && ts.isIdentifier(node.initializer.expression) && factories.has(node.initializer.expression.text)) {
      requires.add(node.name.text);
      createdRequires.add(node.name.text);
    }
    ts.forEachChild(node, registrations);
  };
  registrations(source);
  const dynamic = [], local = [];
  const load = (node, kind, argument, factory = false) => {
    if (argument && ts.isStringLiteralLike(argument)) {
      if (runtimeFile && argument.text.startsWith('.') && (!bundled || factory)) local.push(resolve(dirname(runtimeFile), argument.text));
      return;
    }
    const value = expression(argument);
    const purpose = allowedDynamic(file, node, kind, value);
    if (!purpose) throw new Error(`Unclassified dynamic runtime dependency in ${file}: ${kind}(${value})`);
    dynamic.push({ file, kind, expression: value, purpose });
  };
  const visit = node => {
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) load(node, 'import', node.arguments[0]);
      else if (ts.isIdentifier(node.expression) && requires.has(node.expression.text)) load(node, 'require', node.arguments[0], createdRequires.has(node.expression.text));
      else if (ts.isCallExpression(node.expression) && ts.isIdentifier(node.expression.expression) && factories.has(node.expression.expression.text)) load(node, 'require', node.arguments[0], true);
      else if (ts.isIdentifier(node.expression) && node.expression.text === 'eval') throw new Error(`Runtime eval requires an explicit asset contract: ${file}`);
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === 'Function') throw new Error(`Runtime code generation requires an explicit asset contract: ${file}`);
      if (node.expression.text === 'URL' && expression(node.arguments?.[1]) === 'import.meta.url') {
        const argument = node.arguments[0];
        if (!ts.isStringLiteralLike(argument)) throw new Error(`Unclassified runtime asset URL in ${file}: ${expression(argument)}`);
        if (runtimeFile && argument.text.startsWith('.')) local.push(resolve(dirname(runtimeFile), argument.text));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { dynamic, local };
}

async function runtimeAssets(sdk) {
  const files = ['dist/native/build-info.json', 'dist/native/THIRD-PARTY-NOTICES.txt', 'dist/worker/THIRD-PARTY-NOTICES.txt'];
  const manifest = JSON.parse(await fs.readFile(join(sdk, files[0]), 'utf8'));
  if (manifest.implementation !== 'rust' || !Array.isArray(manifest.artifacts) || !manifest.artifacts.length) {
    throw new Error('Runtime closure requires the native build manifest');
  }
  for (const artifact of manifest.artifacts) {
    if (!/^halo-sdk\.[a-z0-9-]+\.node$/.test(artifact.filename ?? '')) throw new Error('Native runtime asset filename is invalid');
    const file = `dist/native/${artifact.filename}`;
    const bytes = await fs.readFile(join(sdk, file));
    if (digest(bytes) !== artifact.sha256) throw new Error(`Native runtime asset differs from its build manifest: ${file}`);
    files.push(file);
  }
  for (const file of files) if (!(await fs.stat(join(sdk, file))).isFile()) throw new Error(`Runtime asset is missing: ${file}`);
  return files;
}

export async function analyzeRuntime(sdkDirectory) {
  const sdk = resolve(sdkDirectory), dist = join(sdk, 'dist');
  const packageJson = JSON.parse(await fs.readFile(join(sdk, 'package.json'), 'utf8'));
  const roots = new Set([join(dist, 'worker/entry.js')]);
  const addTargets = value => {
    if (typeof value === 'string' && value.includes('*') && !/\.d\.(?:c|m)?ts$/.test(value)) {
      throw new Error(`Runtime package target needs an explicit closure contract: ${value}`);
    }
    if (typeof value === 'string' && runtimeExtension.test(value)) {
      const target = resolve(sdk, value);
      if (!inside(dist, target) || value.includes('*')) throw new Error(`Runtime package target needs an explicit closure contract: ${value}`);
      roots.add(target);
    } else if (Array.isArray(value)) value.forEach(addTargets);
    else if (value && typeof value === 'object') Object.values(value).forEach(addTargets);
  };
  for (const value of [packageJson.exports, packageJson.imports, packageJson.main, packageJson.module, packageJson.browser, packageJson.bin]) addTargets(value);
  const assets = await runtimeAssets(sdk);
  const worker = join(dist, 'worker/entry.js');
  const workerMap = JSON.parse(await fs.readFile(`${worker}.map`, 'utf8'));
  const bundledSources = workerMap.sources.map((file, index) => {
    const path = resolve(dirname(worker), workerMap.sourceRoot ?? '', file);
    const code = workerMap.sourcesContent?.[index];
    if (typeof code !== 'string') throw new Error(`Worker source map lacks its authored input: ${file}`);
    return { file: portable(relative(sdk, path)), code };
  });
  const dynamic = [], localAssets = new Set(assets.map(file => join(sdk, file)));
  let retained;
  for (;;) {
    const result = await build({ absWorkingDir: sdk, entryPoints: [...roots], outdir: join(dist, '.runtime-analysis'),
      bundle: true, platform: 'node', format: 'esm', write: false, metafile: true, logLevel: 'silent' });
    if (result.warnings.length) throw new Error(`Runtime dependency analysis is incomplete: ${result.warnings.map(warning => warning.text).join('; ')}`);
    retained = new Set(Object.keys(result.metafile.inputs).map(file => resolve(sdk, file)).filter(file => inside(dist, file)));
    let expanded = false;
    dynamic.length = 0;
    for (const path of retained) {
      if (!runtimeExtension.test(path) || path === worker) continue;
      const audit = auditSource(portable(relative(sdk, path)), await fs.readFile(path, 'utf8'), path);
      dynamic.push(...audit.dynamic);
      for (const asset of audit.local) {
        if (!inside(dist, asset)) throw new Error(`Runtime asset leaves the package output: ${asset}`);
        if (!(await fs.stat(asset)).isFile()) throw new Error(`Runtime dependency is missing: ${asset}`);
        localAssets.add(asset);
        if (runtimeExtension.test(asset) && !roots.has(asset)) { roots.add(asset); expanded = true; }
      }
    }
    for (const input of bundledSources) {
      const audit = auditSource(input.file, input.code, worker, true);
      dynamic.push(...audit.dynamic);
      for (const asset of audit.local) {
        if (!inside(dist, asset) || !(await fs.stat(asset)).isFile()) throw new Error(`Bundled runtime asset is unavailable: ${input.file}`);
        localAssets.add(asset);
        if (runtimeExtension.test(asset) && !roots.has(asset)) { roots.add(asset); expanded = true; }
      }
    }
    if (!expanded) break;
  }
  const protocol = packageJson.exports?.['./collaboration/protocol'];
  const protocolEntry = typeof protocol === 'string' ? protocol : protocol?.import;
  if (!protocolEntry) throw new Error('The renderer-safe collaboration protocol entry is missing');
  const browser = await build({ absWorkingDir: sdk, entryPoints: [resolve(sdk, protocolEntry)], bundle: true,
    platform: 'browser', format: 'esm', write: false, metafile: true, logLevel: 'silent' });
  if (browser.warnings.length) throw new Error('Browser protocol dependency analysis produced warnings');
  for (const file of Object.keys(browser.metafile.inputs).map(file => resolve(sdk, file))) if (inside(dist, file)) retained.add(file);
  const files = await filesWithin(dist), removed = [], kept = [], declarations = [];
  for (const path of files) {
    const file = portable(relative(sdk, path));
    const bytes = await fs.readFile(path);
    const record = { path: file, bytes: bytes.length, sha256: digest(bytes) };
    if (runtimeExtension.test(path)) (retained.has(path) ? kept : removed).push(record);
    else if (/\.(?:c|m)?js\.map$/.test(path) && !retained.has(path.slice(0, -4))) removed.push(record);
    else if (/\.d\.(?:c|m)?ts(?:\.map)?$/.test(path)) declarations.push(record);
  }
  return { version: 1, entryPoints: [...roots].map(path => portable(relative(sdk, path))).sort(),
    runtime: kept, declarations, assets: [...localAssets].map(path => portable(relative(sdk, path))).sort(),
    dynamic, removed, removedBytes: removed.reduce((sum, file) => sum + file.bytes, 0) };
}

export async function pruneRuntime(sdkDirectory) {
  const sdk = resolve(sdkDirectory);
  const report = await analyzeRuntime(sdk);
  for (const file of report.removed) await fs.rm(join(sdk, file.path));
  for (const file of report.declarations) {
    if (digest(await fs.readFile(join(sdk, file.path))) !== file.sha256) throw new Error(`Runtime pruning changed a declaration: ${file.path}`);
  }
  await fs.writeFile(join(sdk, 'dist/runtime-manifest.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[halo-sdk] Runtime closure: ${report.runtime.length} JavaScript files; removed ${report.removed.length} files (${report.removedBytes} bytes)`);
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sdk = fileURLToPath(new URL('..', import.meta.url));
  const report = process.argv.includes('--check') ? await analyzeRuntime(sdk) : await pruneRuntime(sdk);
  if (process.argv.includes('--check')) console.log(JSON.stringify({ runtimeFiles: report.runtime.length, removableFiles: report.removed.length, removableBytes: report.removedBytes }));
}
