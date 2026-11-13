const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { buildHaloSdk } = require('../../scripts/lib/halo-sdk-build.cjs');
const { ENGINE_RUNTIMES, nativeRuntimeFile } = require('../../scripts/engine-runtimes.cjs');

function fixture({ sdk = true, sdkModules = true, link = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-sdk-build-'));
  const sdkDir = path.join(root, 'src', 'sdk', 'halo-sdk');
  if (sdk) {
    fs.mkdirSync(sdkDir, { recursive: true });
    fs.writeFileSync(path.join(sdkDir, 'package.json'), JSON.stringify({
      name: '@hello-halo/agent-sdk', scripts: { build: 'tsc' },
    }));
    if (sdkModules) fs.mkdirSync(path.join(sdkDir, 'node_modules'));
  }
  if (link) {
    fs.mkdirSync(path.join(root, 'node_modules', '@hello-halo'), { recursive: true });
    fs.symlinkSync(path.join('..', '..', 'src', 'sdk', 'halo-sdk'), path.join(root, 'node_modules', '@hello-halo', 'agent-sdk'));
  }
  return { root, sdkDir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function emitDist(sdkDir) {
  for (const file of ENGINE_RUNTIMES.halo.requiredFiles) {
    fs.mkdirSync(path.dirname(path.join(sdkDir, file)), { recursive: true });
    fs.writeFileSync(path.join(sdkDir, file), 'export {}\n');
  }
  const bytes = Buffer.from('native fixture');
  fs.writeFileSync(path.join(sdkDir, nativeRuntimeFile()), bytes);
  fs.writeFileSync(path.join(sdkDir, 'dist/native/build-info.json'), JSON.stringify({
    implementation: 'rust', abiVersion: 1, buildId: 'fixture', artifacts: [{
      platform: `${process.platform}-${process.arch}`, filename: path.basename(nativeRuntimeFile()),
      sha256: require('node:crypto').createHash('sha256').update(bytes).digest('hex'),
    }],
  }));
}

test('runs the SDK build inside the SDK checkout and accepts its native library and bridge', () => {
  const { root, sdkDir, cleanup } = fixture();
  try {
    const calls = [];
    buildHaloSdk(root, { env: { MARK: '1' }, execFile: (...args) => {
      if (args[0] !== 'npm') return '';
      calls.push(args);
      emitDist(sdkDir);
    } });
    assert.equal(calls.length, 1);
    const [, argv, options] = calls[0];
    assert.deepEqual(argv, ['run', 'build']);
    assert.equal(options.cwd, sdkDir);
    assert.equal(options.env.MARK, '1');
  } finally {
    cleanup();
  }
});

test('refuses to package without the SDK checkout or its dependencies, before building', () => {
  for (const [shape, message] of [
    [{ sdk: false, link: false }, /not found at src\/sdk\/halo-sdk/],
    [{ sdkModules: false }, /run npm install in src\/sdk\/halo-sdk/],
    [{ link: false }, /run npm install at the repository root/],
  ]) {
    const { root, cleanup } = fixture(shape);
    try {
      let built = false;
      assert.throws(() => buildHaloSdk(root, { execFile: () => { built = true; } }), message);
      assert.equal(built, false);
    } finally {
      cleanup();
    }
  }
});

test('refuses a checkout that is not the buildable Halo SDK package, before building', () => {
  for (const manifest of [
    { name: '@example/other-sdk', scripts: { build: 'tsc' } },
    { name: '@hello-halo/agent-sdk', scripts: {} },
  ]) {
    const { root, sdkDir, cleanup } = fixture();
    try {
      fs.writeFileSync(path.join(sdkDir, 'package.json'), JSON.stringify(manifest));
      let built = false;
      assert.throws(() => buildHaloSdk(root, { execFile: () => { built = true; } }), /is not a buildable @hello-halo\/agent-sdk/);
      assert.equal(built, false);
    } finally {
      cleanup();
    }
  }
});

test('logs the SDK revision and its uncommitted file count, and still builds when git cannot tell', (t) => {
  const { root, sdkDir, cleanup } = fixture();
  try {
    const revisionLine = (git) => {
      const logs = [];
      const log = t.mock.method(console, 'log', (message) => logs.push(message));
      try {
        buildHaloSdk(root, { execFile: (file, args) => (file === 'git' ? git(args) : emitDist(sdkDir)) });
      } finally {
        log.mock.restore();
      }
      return logs.find(message => message.startsWith('[halo-sdk] SDK '));
    };
    const checkout = (toplevel) => (args) => {
      if (args.includes('--show-toplevel')) return `${toplevel}\n`;
      if (args.includes('status')) return ' M core/query-loop.ts\n?? notes.md\n';
      return 'e7f264a\n';
    };
    assert.equal(revisionLine(checkout(sdkDir)), '[halo-sdk] SDK e7f264a · 2 uncommitted');
    assert.equal(revisionLine(checkout(root)), '[halo-sdk] SDK e7f264a · 2 uncommitted');
    assert.equal(revisionLine(checkout(path.join(root, '..'))), '[halo-sdk] SDK revision unknown (not a git checkout)');
    assert.equal(revisionLine(() => { throw new Error('spawn git ENOENT'); }), '[halo-sdk] SDK revision unknown (git unavailable)');
  } finally {
    cleanup();
  }
});

test('rejects an installed SDK copy that a rebuild of the checkout would not reach', () => {
  const { root, cleanup } = fixture({ link: false });
  try {
    fs.mkdirSync(path.join(root, 'node_modules', '@hello-halo', 'agent-sdk'), { recursive: true });
    assert.throws(() => buildHaloSdk(root, { execFile: () => {} }), /does not link to src\/sdk\/halo-sdk/);
  } finally {
    cleanup();
  }
});

test('a failed SDK build or one without its execution entry fails the package', () => {
  const { root, cleanup } = fixture();
  try {
    assert.throws(() => buildHaloSdk(root, { execFile: () => { throw new Error('Command failed: npm run build'); } }), /Command failed/);
    assert.throws(() => buildHaloSdk(root, { execFile: () => {} }), /did not produce dist\/worker\/index\.js/);
  } finally {
    cleanup();
  }
});

test('run directly, it reports a refusal on one line and exits non-zero for shell callers', () => {
  const { root, cleanup } = fixture({ sdkModules: false });
  try {
    for (const file of ['scripts/lib/halo-sdk-build.cjs', 'scripts/engine-runtimes.cjs', 'runtimes/dsh/manifest.cjs']) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.copyFileSync(path.join(__dirname, '../..', file), path.join(root, file));
    }
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/lib/halo-sdk-build.cjs')], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stderr.trim(), '[halo-sdk] Halo SDK dependencies are missing; run npm install in src/sdk/halo-sdk first.');
  } finally {
    cleanup();
  }
});

function runExperimentalBuild({ buildHaloSdk = () => {} } = {}) {
  const calls = [];
  const errors = [];
  const root = path.resolve(__dirname, '../..');
  const fakeProcess = {
    platform: 'darwin', arch: 'arm64', argv: ['node', 'build-experimental.cjs'],
    execPath: '/test/node', env: {}, exitCode: 0,
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'scripts/build-experimental.cjs'), 'utf8'), {
    __dirname: path.join(root, 'scripts'), process: fakeProcess,
    console: { log() {}, error(message) { errors.push(message); } },
    require(id) {
      if (id === 'node:path') return path;
      if (id === 'node:fs') return { readFileSync: () => JSON.stringify({ version: '3.2.0-experimental.1' }) };
      if (id === 'node:child_process') return { execFileSync: (...args) => calls.push(args) };
      if (id === './lib/mac-local-signing.cjs') return { signingEnvironment: () => ({ CSC_LINK: '/secret.p12' }) };
      if (id === './lib/experimental-product.cjs') return { validateExperimentalProduct() {} };
      if (id === './lib/halo-sdk-build.cjs') return {
        buildHaloSdk: (...args) => { calls.push(['halo-sdk', args]); buildHaloSdk(...args); },
      };
      throw new Error(`Unexpected import: ${id}`);
    },
  });
  return { calls, errors, root, exitCode: fakeProcess.exitCode };
}

test('the experimental build rebuilds the Halo SDK before preparing its product or compiling', () => {
  const { calls, errors, root, exitCode } = runExperimentalBuild();
  assert.deepEqual(errors, []);
  assert.equal(exitCode, 0);
  assert.equal(calls[0][0], 'halo-sdk');
  const [, [sdkRoot, { env }]] = calls[0];
  assert.equal(sdkRoot, root);
  assert.equal(env.CSC_LINK, undefined);
  assert.ok(calls.findIndex(([, args]) => args[0] === 'scripts/prepare-experimental-product.mjs') > 0);
});

test('a Halo SDK that cannot be built stops the experimental build before anything else runs', () => {
  const { calls, errors, exitCode } = runExperimentalBuild({
    buildHaloSdk: () => { throw new Error('Halo SDK dependencies are missing; run npm install in src/sdk/halo-sdk first.'); },
  });
  assert.equal(exitCode, 1);
  assert.deepEqual(calls.map(([file]) => file), ['halo-sdk']);
  assert.match(errors[0], /npm install in src\/sdk\/halo-sdk/);
});

function runSignedBuild({ sdkExit = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-signed-build-'));
  try {
    fs.mkdirSync(path.join(dir, 'scripts', 'lib'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'bin'));
    fs.copyFileSync(path.join(__dirname, '../../scripts/build-mac-signed.sh'), path.join(dir, 'scripts', 'build-mac-signed.sh'));
    fs.writeFileSync(path.join(dir, 'scripts', 'lib', 'mac-signing.sh'),
      'halo_prepare_mac_signing() { export HALO_MAC_SIGN_SRC=test; }\n');
    fs.writeFileSync(path.join(dir, '.env.local'), 'APPLE_ID=a\nAPPLE_APP_SPECIFIC_PASSWORD=b\nAPPLE_TEAM_ID=c\n');
    const calls = path.join(dir, 'calls.log');
    for (const tool of ['node', 'npm', 'npx']) {
      const exit = tool === 'node' ? `[ "$1" = scripts/lib/halo-sdk-build.cjs ] && exit ${sdkExit}` : '';
      fs.writeFileSync(path.join(dir, 'bin', tool), `#!/bin/bash\necho "${tool} $*" >> "${calls}"\n${exit}\nexit 0\n`, { mode: 0o755 });
    }
    const result = spawnSync('/bin/bash', [path.join(dir, 'scripts', 'build-mac-signed.sh')], {
      cwd: dir, encoding: 'utf8', env: { PATH: `${path.join(dir, 'bin')}:/usr/bin:/bin`, HOME: dir },
    });
    const lines = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : [];
    return { status: result.status, lines };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the signed build rebuilds the Halo SDK before preparing binaries or compiling', () => {
  const { status, lines } = runSignedBuild();
  assert.equal(status, 0);
  assert.equal(lines[0], 'node scripts/lib/halo-sdk-build.cjs');
  assert.ok(lines.indexOf('npm run build') > 0);
});

test('a Halo SDK that cannot be built stops the signed build before anything else runs', () => {
  const { status, lines } = runSignedBuild({ sdkExit: 1 });
  assert.notEqual(status, 0);
  assert.deepEqual(lines, ['node scripts/lib/halo-sdk-build.cjs']);
});

test('rejects a native binary changed after the recorded build', () => {
  const { root, sdkDir, cleanup } = fixture();
  try {
    assert.throws(() => buildHaloSdk(root, { execFile: file => {
      if (file !== 'npm') return '';
      emitDist(sdkDir);
      fs.appendFileSync(path.join(sdkDir, nativeRuntimeFile()), 'changed');
    } }), /differs from its build identity/);
  } finally { cleanup(); }
});

test('requires the requested native architecture instead of accepting the build host library', () => {
  const { root, sdkDir, cleanup } = fixture();
  try {
    const target = process.arch === 'arm64' ? 'darwin-x64' : 'darwin-arm64';
    assert.throws(() => buildHaloSdk(root, { env: { HALO_SDK_NATIVE_TARGETS: target }, execFile: file => {
      if (file !== 'npm') return '';
      emitDist(sdkDir);
    } }), /Native SDK build lacks/);
  } finally { cleanup(); }
});
