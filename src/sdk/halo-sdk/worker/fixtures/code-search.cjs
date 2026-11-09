const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const configuration = JSON.parse(process.argv[2]);
let indexes = 0;
process.on('message', request => {
  if (request.type === 'close') { process.disconnect(); return; }
  if (request.type !== 'search') return;
  mkdirSync(configuration.cachePath, { recursive: true });
  if (request.query === 'hang') {
    writeFileSync(join(configuration.cachePath, 'query-started'), String(process.pid));
    return;
  }
  if (!indexes || request.refresh) indexes++;
  process.send({ type: 'result', id: request.id, result: {
    hits: [{ path: join(configuration.root, 'sample.ts'), lineStart: 1, lineEnd: 1,
      snippet: JSON.stringify({ pid: process.pid, indexes }), truncated: false }],
    freshness: 'possibly_stale', exhaustive: false,
  } });
});
process.on('disconnect', () => process.exit(0));
process.send({ type: 'ready' });
