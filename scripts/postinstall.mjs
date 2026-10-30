import { execSync } from 'child_process'

const run = (cmd) => execSync(cmd, { stdio: 'inherit' })

if (Number(process.versions.napi) < 10) {
  throw new Error('Halo requires a Node runtime with N-API 10 (Node 22.14.0+ or 24+) for its native dependencies.')
}

// Optional engines are never installed here.
run('patch-package')

// Prepare Electron and native dependencies. Packaging-only machines can
//    skip the host runtime with HALO_SKIP_NATIVE_REBUILD=1.
if (process.env.HALO_SKIP_NATIVE_REBUILD === '1') {
  console.log('  - native rebuild skipped (HALO_SKIP_NATIVE_REBUILD=1)')
} else {
  // Electron 42+ downloads on first CLI use; Node API consumers need it now.
  run('install-electron')
  run('electron-builder install-app-deps')
}
