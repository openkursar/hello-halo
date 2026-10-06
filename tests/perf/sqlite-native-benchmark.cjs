const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const binding = process.argv[2] || path.dirname(require.resolve('better-sqlite3/package.json'));
const driverVersion = require(path.join(binding, 'package.json')).version;
if (Number(driverVersion.split('.')[0]) >= 13 && Number(process.versions.napi) < 10) {
  throw new Error('SQLite 13 requires N-API 10 (Node 22.14+ or Electron 43).');
}
const Database = require(binding);
const payload = JSON.stringify({
  title: 'Stored work item', details: 'x'.repeat(1000),
  flags: ['active', 'visible'], updatedAt: 1791130000000,
});
const samples = [];

for (let sample = 0; sample < 7; sample++) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-sqlite-wal-bench-'));
  let db;
  try {
    db = new Database(path.join(directory, 'halo.db'));
    db.pragma('journal_mode=WAL');
    db.pragma('synchronous=NORMAL');
    db.pragma('foreign_keys=ON');
    db.exec('CREATE TABLE entries(id INTEGER PRIMARY KEY,payload TEXT NOT NULL,state TEXT)');
    const insert = db.prepare('INSERT INTO entries VALUES(?,?,?)');
    let started = performance.now();
    for (let batch = 0; batch < 100; batch++) {
      db.transaction(() => {
        for (let index = 0; index < 100; index++) insert.run(batch * 100 + index, payload, 'ready');
      })();
    }
    const batchedInsert = performance.now() - started;
    const read = db.prepare('SELECT payload,state FROM entries WHERE id=?');
    started = performance.now();
    for (let index = 0; index < 10000; index++) JSON.parse(read.get(index).payload);
    const reads = performance.now() - started;
    const update = db.prepare('UPDATE entries SET state=? WHERE id=?');
    started = performance.now();
    for (let batch = 0; batch < 100; batch++) {
      db.transaction(() => {
        for (let index = 0; index < 100; index++) update.run('done', batch * 100 + index);
      })();
    }
    const batchedUpdate = performance.now() - started;
    samples.push({ batchedInsert, reads, batchedUpdate });
  } finally {
    db?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

// The first round warms the runtime and filesystem; compare the remaining rounds.
const median = values => {
  const ordered = values.sort((a, b) => a - b);
  const center = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[center] : (ordered[center - 1] + ordered[center]) / 2;
};
const medians = Object.fromEntries(Object.keys(samples[0]).map(key => [
  key, median(samples.slice(1).map(sample => sample[key])),
]));
console.log(JSON.stringify({ node: process.version, electron: process.versions.electron, driver: driverVersion, samples, medians }, null, 2));
