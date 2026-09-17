const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { findMachOFiles } = require('../../scripts/lib/mac-local-signing.cjs');

test('finds native resources without depending on extension or executable permission', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-macho-check-'));
  try {
    fs.mkdirSync(path.join(dir, 'vendor'));
    fs.writeFileSync(path.join(dir, 'vendor', 'codex'), Buffer.from('cffaedfe00000000', 'hex'), { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'fat'), Buffer.from('cafebabe00000002', 'hex'));
    fs.writeFileSync(path.join(dir, 'fat64'), Buffer.from('cafebabf00000002', 'hex'));
    fs.writeFileSync(path.join(dir, 'Java.class'), Buffer.from('cafebabe00000000', 'hex'));
    fs.writeFileSync(path.join(dir, 'script'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(dir, 'short'), 'a');
    fs.symlinkSync(dir, path.join(dir, 'loop'));
    assert.deepEqual(findMachOFiles(dir).map(file => path.relative(dir, file)).sort(),
      ['fat', 'fat64', path.join('vendor', 'codex')].sort());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('local build targets the host and cannot inherit distribution signing', () => {
  const calls = [];
  const root = path.resolve(__dirname, '../..');
  const fakeProcess = {
    platform: 'darwin', arch: 'arm64', argv: ['node', 'build-mac-local.cjs'],
    execPath: '/test/node', env: {}, exitCode: 0,
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'scripts/build-mac-local.cjs'), 'utf8'), {
    __dirname: path.join(root, 'scripts'), process: fakeProcess,
    console: { log() {}, error(message) { throw new Error(message); } },
    require(id) {
      if (id === 'node:path') return path;
      if (id === 'node:child_process') return { execFileSync: (...args) => calls.push(args) };
      if (id === './lib/mac-local-signing.cjs') return {
        signingEnvironment: () => ({ CSC_LINK: '/secret.p12', CSC_NAME: 'Developer ID',
          HALO_MAC_SIGN_MODE: 'developer-id', APPLE_ID: 'example', CODESIGN_ALLOCATE: '/working/tool' }),
      };
      throw new Error(`Unexpected import: ${id}`);
    },
  });
  assert.equal(fakeProcess.exitCode, 0);
  const prepare = calls.find(([, args]) => args[0] === 'scripts/prepare-binaries.mjs');
  assert.equal(prepare[1][2], 'mac-arm64');
  const [, args, options] = calls.at(-1);
  assert.ok(args.includes('dmg:arm64'));
  assert.ok(args.includes('zip:arm64'));
  assert.ok(!args.includes('dmg:x64'));
  assert.equal(args.at(-1), 'never');
  assert.ok(args.includes('-c.mac.notarize=false'));
  assert.equal(options.env.HALO_MAC_SIGN_MODE, 'adhoc');
  assert.equal(options.env.CSC_IDENTITY_AUTO_DISCOVERY, 'false');
  assert.equal(options.env.CSC_LINK, undefined);
  assert.equal(options.env.APPLE_ID, undefined);
  assert.equal(options.env.CODESIGN_ALLOCATE, '/working/tool');
});
