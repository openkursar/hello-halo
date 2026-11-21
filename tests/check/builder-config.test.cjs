'use strict'

// electron-builder merges `-c` overrides into this object, so a key it may
// override must be writable; an accessor without a setter rejects the merge.

const assert = require('node:assert/strict')
const { test } = require('node:test')

const config = require('../../electron-builder.cjs')

test('the packager config accepts a CLI output override', () => {
  config.directories.output = 'dist/override-probe'
  assert.equal(config.directories.output, 'dist/override-probe')
})

test('the app directory stays lazily staged', () => {
  const app = Object.getOwnPropertyDescriptor(config.directories, 'app')
  assert.equal(typeof app?.get, 'function')
})
