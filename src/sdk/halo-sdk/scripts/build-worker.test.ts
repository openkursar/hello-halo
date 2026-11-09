import { afterEach, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { copyFile, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorker } from './build-worker.mjs';
import { bundledLicenseNotice } from './bundled-licenses.mjs';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const directories: string[] = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'sdk-bundle-licenses-'));
  directories.push(directory);
  return directory;
}

async function put(directory: string, file: string, text: string) {
  const path = join(directory, file);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

async function fixture(license = 'MIT') {
  const directory = await temporaryDirectory();
  await put(directory, 'package.json', JSON.stringify({ name: 'bundle-fixture', version: '1.0.0', type: 'module' }));
  await put(directory, 'entry.js', "import { value } from '@fixture/dependency'; console.log(value);");
  await put(directory, 'node_modules/@fixture/dependency/package.json', JSON.stringify({
    name: '@fixture/dependency', version: '2.3.4', license, main: './dist/index.js',
  }));
  await put(directory, 'node_modules/@fixture/dependency/dist/package.json', '{"type":"module"}');
  await put(directory, 'node_modules/@fixture/dependency/dist/index.js', 'export const value = 42;');
  await put(directory, 'node_modules/unused/package.json', '{"name":"unused","version":"1.0.0"}');
  const result = await build({
    absWorkingDir: directory, entryPoints: ['entry.js'], outfile: join(directory, 'output/entry.js'),
    bundle: true, platform: 'node', format: 'esm', sourcemap: true, metafile: true, write: false,
  });
  return { directory, result, dependency: join(directory, 'node_modules/@fixture/dependency') };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('bundled dependency notices', () => {
  it('runs the CLI build through a directory alias instead of silently skipping it', async () => {
    const directory = await temporaryDirectory();
    const project = join(directory, 'project');
    await put(project, 'package.json', JSON.stringify({ name: 'worker-cli-fixture', type: 'module' }));
    await put(project, 'worker/entry.ts', 'export const ready = true;');
    await mkdir(join(project, 'scripts'), { recursive: true });
    for (const name of ['build-worker.mjs', 'bundled-licenses.mjs']) {
      await copyFile(join(projectDirectory, 'scripts', name), join(project, 'scripts', name));
    }
    await symlink(join(projectDirectory, 'node_modules'), join(project, 'node_modules'), 'junction');
    const alias = join(directory, 'alias');
    await symlink(project, alias, 'junction');
    await promisify(execFile)(process.execPath, [join(alias, 'scripts/build-worker.mjs')]);
    expect(await readFile(join(project, 'dist/worker/entry.js'), 'utf8')).toContain('ready');
    expect(await readFile(join(project, 'dist/worker/THIRD-PARTY-NOTICES.txt'), 'utf8'))
      .toContain('Third-party notices');
  });

  it('ships the full license texts beside an isolated real worker build', async () => {
    const directory = await temporaryDirectory();
    const result = await buildWorker(join(directory, 'worker/entry.mjs'));
    const notice = await readFile(join(directory, 'worker/THIRD-PARTY-NOTICES.txt'), 'utf8');
    const worker = await readFile(join(directory, 'worker/entry.mjs'), 'utf8');
    const sourceMap = JSON.parse(await readFile(join(directory, 'worker/entry.mjs.map'), 'utf8'));
    expect(worker).toContain('./THIRD-PARTY-NOTICES.txt');
    expect(sourceMap.sourcesContent.length).toBeGreaterThan(0);
    for (const [name, filename] of [
      ['yaml', 'LICENSE'], ['minimatch', 'LICENSE'], ['balanced-match', 'LICENSE.md'], ['brace-expansion', 'LICENSE'],
    ]) {
      const dependency = join(projectDirectory, 'node_modules', name);
      const manifest = JSON.parse(await readFile(join(dependency, 'package.json'), 'utf8'));
      expect(Object.keys(result.metafile.inputs).some(path => path.includes(`/node_modules/${name}/`) || path.startsWith(`node_modules/${name}/`))).toBe(true);
      expect(notice).toContain(`${name}@${manifest.version}\nLicense: ${manifest.license}`);
      expect(notice).toContain(await readFile(join(dependency, filename), 'utf8'));
    }
    expect(notice).not.toContain(projectDirectory);
    expect(notice).not.toContain(directory);
  });

  it('discovers scoped packages through nested module metadata and preserves declared licenses and notices', async () => {
    const { directory, result, dependency } = await fixture('SEE LICENSE IN legal/terms.txt');
    const license = 'Copyright Example Contributors\r\nPermission text retained verbatim.\r\n';
    const notice = 'Additional attribution retained verbatim.\n';
    await put(dependency, 'legal/terms.txt', license);
    await put(dependency, 'NOTICE.txt', notice);
    const text = await bundledLicenseNotice(result.metafile, directory, directory);
    expect(text).toContain('@fixture/dependency@2.3.4');
    expect(text.match(/@fixture\/dependency@2\.3\.4/g)).toHaveLength(1);
    expect(text).toContain(license);
    expect(text).toContain(notice);
    expect(text).not.toContain('unused@');
    expect(text).not.toContain('bundle-fixture@');
  });

  it('fails when a bundled package only declares an SPDX identifier without supplying its license text', async () => {
    const { directory, result, dependency } = await fixture();
    await put(dependency, 'NOTICE', 'An attribution notice alone is not a license.');
    await expect(bundledLicenseNotice(result.metafile, directory, directory))
      .rejects.toThrow('Missing license text for bundled dependency @fixture/dependency@2.3.4');
  });

  it('retains license collections and rejects empty license documents', async () => {
    const { directory, result, dependency } = await fixture();
    await put(dependency, 'LICENSES/component/MIT.txt', 'Copyright Example Contributors\nFull component permission text.');
    expect(await bundledLicenseNotice(result.metafile, directory, directory))
      .toContain('--- LICENSES/component/MIT.txt ---\nCopyright Example Contributors\nFull component permission text.');
    await put(dependency, 'LICENSE', '   ');
    await expect(bundledLicenseNotice(result.metafile, directory, directory)).rejects.toThrow('Empty legal document');
  });

  it('rejects a declared license outside the dependency package', async () => {
    const { directory, result, dependency } = await fixture('SEE LICENSE IN ../outside.txt');
    await put(dirname(dependency), 'outside.txt', 'Not a package license.');
    await expect(bundledLicenseNotice(result.metafile, directory, directory))
      .rejects.toThrow('License document escapes package @fixture/dependency');
  });
});
