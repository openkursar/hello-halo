const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const { createInterface } = require('node:readline');

const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
writeFileSync(process.argv[2], JSON.stringify([process.pid, child.pid]));
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === 'initialize'
    ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
    : request.method === 'tools/list' ? { tools: [] } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
});
