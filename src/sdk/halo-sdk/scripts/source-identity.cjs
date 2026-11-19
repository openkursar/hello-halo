const { createHash } = require('node:crypto');
const { readFileSync, readdirSync, statSync } = require('node:fs');
const { basename, join, resolve } = require('node:path');

function sourceIdentity(workspace) {
  workspace = resolve(workspace);
  const hash = createHash('sha256');
  const visit = path => {
    if (statSync(path).isDirectory()) {
      for (const entry of readdirSync(path).sort((a, b) => a.localeCompare(b, 'en'))) {
        if (entry !== 'target') visit(join(path, entry));
      }
    } else if (/\.(rs|toml|json|txt|cjs|mjs)$/.test(path) || basename(path).startsWith('LICENSE') || path.endsWith('Cargo.lock')) {
      hash.update(path.slice(workspace.length).replaceAll('\\', '/')).update('\0').update(readFileSync(path)).update('\0');
    }
  };
  for (const input of ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'crates', 'bindings/node/crate',
    'bindings/node/collaboration/model-selection-limits.json', 'scripts/source-identity.cjs']) {
    visit(join(workspace, input));
  }
  return hash.digest('hex');
}

module.exports = { sourceIdentity };
