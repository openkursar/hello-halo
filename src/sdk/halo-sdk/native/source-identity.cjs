const { createHash } = require('node:crypto');
const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

function sourceIdentity(workspace) {
  const hash = createHash('sha256');
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (entry.name === 'target') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (/\.(rs|toml|json|txt|cjs|mjs)$/.test(entry.name) || entry.name.startsWith('LICENSE') || entry.name === 'Cargo.lock') {
        hash.update(path.slice(workspace.length).replaceAll('\\', '/')).update('\0').update(readFileSync(path)).update('\0');
      }
    }
  };
  visit(workspace);
  return hash.digest('hex');
}

module.exports = { sourceIdentity };
