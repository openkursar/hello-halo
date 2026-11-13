import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sdk = fileURLToPath(new URL('..', import.meta.url));
const workspace = join(sdk, 'native');
const targets = {
  'darwin-arm64': ['aarch64-apple-darwin', 'libhalo_node.dylib'],
  'darwin-x64': ['x86_64-apple-darwin', 'libhalo_node.dylib'],
  'win32-x64': ['x86_64-pc-windows-msvc', 'halo_node.dll'],
  'win32-arm64': ['aarch64-pc-windows-msvc', 'halo_node.dll'],
  'linux-x64': ['x86_64-unknown-linux-gnu', 'libhalo_node.so'],
  'linux-arm64': ['aarch64-unknown-linux-gnu', 'libhalo_node.so'],
};

const { sourceIdentity } = createRequire(import.meta.url)('../native/source-identity.cjs');

function cargo(args, options = {}) {
  const result = spawnSync(process.env.CARGO || 'cargo', args, { cwd: workspace, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Native SDK cargo ${args[0]} failed (${result.status ?? result.signal})`);
  return result;
}

async function notices(output, targetTriples) {
  const included = new Map();
  for (const triple of new Set(targetTriples)) {
    const result = cargo(['metadata', '--format-version', '1', '--locked', '--filter-platform', triple], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    const metadata = JSON.parse(result.stdout);
    const resolved = new Set(metadata.resolve.nodes.map(node => node.id));
    for (const pkg of metadata.packages) {
      if (pkg.source !== null && resolved.has(pkg.id)) included.set(pkg.id, pkg);
    }
  }
  const packages = [...included.values()].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
  const sections = ['Halo SDK Rust dependency notices'];
  for (const pkg of packages) {
    const directory = dirname(pkg.manifest_path);
    const files = (await readdir(directory)).filter(name => /^(licen[cs]e|copying|notice)([._-]|$)/i.test(name));
    const texts = [];
    for (const name of files) {
      try { texts.push(await readFile(join(directory, name), 'utf8')); }
      catch (error) { if (error.code !== 'EISDIR') throw error; }
    }
    sections.push(`${pkg.name}@${pkg.version}\nLicense: ${pkg.license ?? 'See upstream license'}\n${texts.join('\n')}`);
  }
  for (const name of ['LICENSE.minimatch', 'LICENSE.braces']) {
    const source = join(workspace, 'crates/halo-core/src/tools/glob_matcher', name);
    sections.push(`Ported source: ${name}\n${await readFile(source, 'utf8')}`);
  }
  await writeFile(join(output, 'THIRD-PARTY-NOTICES.txt'), `${sections.join('\n\n')}\n`);
}

export async function buildNative() {
  const requested = (process.env.HALO_SDK_NATIVE_TARGETS || `${process.platform}-${process.arch}`).split(',');
  const output = join(sdk, 'dist/native');
  await mkdir(output, { recursive: true });
  if (!existsSync(join(workspace, 'Cargo.lock'))) cargo(['generate-lockfile']);
  const buildId = sourceIdentity(workspace);
  const targetDirectory = resolve(workspace, process.env.CARGO_TARGET_DIR || 'target');
  const artifacts = [];
  for (const name of requested) {
    const target = targets[name];
    if (!target) throw new Error(`Unsupported native SDK platform: ${name}`);
    const triple = process.env.HALO_SDK_RUST_TARGET || target[0];
    const deploymentTarget = name.startsWith('darwin-') ? process.env.MACOSX_DEPLOYMENT_TARGET || (name === 'darwin-arm64' ? '11.0' : '10.15') : undefined;
    cargo(['build', '--locked', '--release', '-p', 'halo-node', '--target', triple, '--target-dir', targetDirectory], {
      env: { ...process.env, HALO_SDK_BUILD_ID: buildId,
        ...(deploymentTarget ? { MACOSX_DEPLOYMENT_TARGET: deploymentTarget } : {}),
      },
    });
    const source = join(targetDirectory, triple, 'release', target[1]);
    if (!existsSync(source)) throw new Error(`Native SDK build did not produce ${target[1]}`);
    const filename = `halo-sdk.${name}.node`;
    await copyFile(source, join(output, filename));
    if (name === `${process.platform}-${process.arch}`) {
      const native = createRequire(import.meta.url)(join(output, filename));
      const info = JSON.parse(native.runtimeInfo());
      if (info.implementation !== 'rust' || info.abiVersion !== 1 || info.buildId !== buildId) {
        throw new Error('Built native SDK identity does not match its source');
      }
    }
    artifacts.push({ platform: name, target: triple, filename, ...(deploymentTarget ? { deploymentTarget } : {}),
      sha256: createHash('sha256').update(await readFile(source)).digest('hex') });
  }
  if (sourceIdentity(workspace) !== buildId) throw new Error('Native SDK sources changed during compilation; rebuild a stable snapshot');
  await notices(output, artifacts.map(artifact => artifact.target));
  await writeFile(join(output, 'build-info.json'), `${JSON.stringify({ implementation: 'rust', abiVersion: 1, buildId, artifacts }, null, 2)}\n`);
  console.log(`[halo-sdk] Rust native library ${buildId.slice(0, 12)}: ${requested.join(', ')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildNative();
}
