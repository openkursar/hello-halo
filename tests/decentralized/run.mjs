#!/usr/bin/env node
// Launcher for the cluster regression tier (Digital Team / Remote Office).
//
// One npm entry (`npm run test:team`) maps here instead of five. Run it with no
// argument to print the suite catalog + prerequisites; run it with a suite name
// to launch that suite. Anything after the suite name is forwarded to the driver.
//
//   npm run test:team                      # print this catalog
//   npm run test:team -- single            # run the §1 suite
//   npm run test:team -- federation --only G1,K1
//   node tests/decentralized/run.mjs perf --long-run-minutes 30
//
// Full rationale and conventions: tests/decentralized/README.md

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const SUITES = {
  single: {
    file: 'checklist-single-machine.mjs',
    blurb: '§1 single-machine team fundamentals (create/run/dispatch/escalation/history)',
  },
  federation: {
    file: 'run-scenarios.mjs',
    defaultArgs: ['--all'],
    blurb: '§3 federation, 62 cross-node scenarios; writes RESULTS.md (--only <IDs> to select)',
  },
  upgrade: {
    file: 'checklist-upgrade-migration.mjs',
    blurb: '§4 upgrade/migration compatibility (old data dir → current build)',
  },
  perf: {
    file: 'checklist-perf.mjs',
    blurb: '§5 performance (--long-run-minutes / --soak-minutes for full duration)',
  },
  lifecycle: {
    file: 'checklist-data-lifecycle.mjs',
    blurb: '§7 data lifecycle & security (deletion / credentials / log secret scan)',
  },
}

function printCatalog() {
  const pad = Math.max(...Object.keys(SUITES).map((k) => k.length))
  console.log(`
Cluster regression suites — Digital Team / Remote Office

  Usage:  npm run test:team -- <suite> [args]
          node tests/decentralized/run.mjs <suite> [args]

  Suites:`)
  for (const [key, s] of Object.entries(SUITES)) {
    console.log(`    ${key.padEnd(pad)}   ${s.blurb}`)
  }
  console.log(`
  Before running (these boot REAL multi-process Halo nodes):
    1. npm run build                    once per code change
    2. .env.local has HALO_TEST_API_KEY / URL / MODEL / PROVIDER
                                        (protocol-only scenarios run without a key)
    3. Never run two suites in parallel — CPU contention yields
       timeout-shaped false negatives.

  Details, coverage, and what this tier can NEVER cover:
    tests/decentralized/README.md · SCENARIOS.md · CHECKLIST-COVERAGE.md
`)
}

const [, , suiteName, ...rest] = process.argv

if (!suiteName || suiteName === 'help' || suiteName === '-h' || suiteName === '--help') {
  printCatalog()
  process.exit(suiteName ? 0 : 1)
}

const suite = SUITES[suiteName]
if (!suite) {
  console.error(`Unknown suite: "${suiteName}"`)
  printCatalog()
  process.exit(1)
}

const args = rest.length ? rest : suite.defaultArgs ?? []
const child = spawn('node', [path.join(HERE, suite.file), ...args], { stdio: 'inherit' })
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
