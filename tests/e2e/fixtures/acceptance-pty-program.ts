import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'

export type ProcessObservation = { state: 'running' | 'exited' | 'unknown'; code?: string }

export function observeProcess(pid: number, probe: (pid: number, signal: 0) => unknown = process.kill): ProcessObservation {
  if (!Number.isSafeInteger(pid) || pid <= 1) return { state: 'unknown', code: 'INVALID_PID' }
  try { probe(pid, 0); return { state: 'running' } }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ESRCH' ? { state: 'exited' } : { state: 'unknown', code: code ?? 'UNAVAILABLE' }
  }
}

interface ProgramReceipt {
  marker: string
  pid: number
  shellPid: number
  cwd: string
  execPath: string
  port: number
}

interface InputReceipt { sequence: number; input: string; pid: number; cwd: string }

function quote(value: string) {
  return process.platform === 'win32' ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`
}

export function ownedPtyProgram(profile: string, label: string) {
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(label)) throw new Error('An owned terminal label must be a short file-safe identifier')
  const marker = `${label}-${randomBytes(4).toString('hex')}`
  const token = randomBytes(32).toString('hex')
  const directory = join(profile, `terminal-${marker}`)
  mkdirSync(directory)
  const file = join(directory, 'interactive.cjs')
  const receiptFile = join(directory, 'process.json')
  const inputsFile = join(directory, 'inputs.jsonl')
  const exitFile = join(directory, 'exit.json')
  const ready = `PTY_READY_${marker}`
  writeFileSync(file, `const fs = require('node:fs');
const http = require('node:http');
const readline = require('node:readline');
const marker = ${JSON.stringify(marker)}, token = ${JSON.stringify(token)};
let sequence = 0, reason = 'natural', ending = false;
const sockets = new Set();
const receipt = { marker, pid: process.pid, shellPid: process.ppid, cwd: fs.realpathSync(process.cwd()), execPath: process.execPath };
function stop(value) { if (ending) return; ending = true; reason = value; for (const socket of sockets) socket.destroy(); server.close(); process.exit(0); }
const server = http.createServer((request, response) => {
  if (request.headers.authorization !== 'Bearer ' + token) { response.writeHead(403).end(); return; }
  if (request.method === 'GET' && request.url === '/identity') { response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(receipt)); return; }
  if (request.method === 'POST' && request.url === '/stop') { response.writeHead(200).end('stopping', () => stop('fixture-cleanup')); return; }
  response.writeHead(404).end();
});
server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
server.listen(0, '127.0.0.1', () => {
  receipt.port = server.address().port;
  fs.writeFileSync(${JSON.stringify(receiptFile + '.tmp')}, JSON.stringify(receipt));
  fs.renameSync(${JSON.stringify(receiptFile + '.tmp')}, ${JSON.stringify(receiptFile)});
  process.stdout.write(${JSON.stringify(ready + '\r\n')});
});
const input = readline.createInterface({ input: process.stdin, terminal: false });
input.on('line', value => {
  const record = { sequence: ++sequence, input: value, pid: process.pid, cwd: fs.realpathSync(process.cwd()) };
  fs.appendFileSync(${JSON.stringify(inputsFile)}, JSON.stringify(record) + ${JSON.stringify('\n')});
  process.stdout.write('PTY_ACK_' + marker + '_' + sequence + '_' + value + ${JSON.stringify('\r\n')});
});
input.on('close', () => stop('stdin-closed'));
process.on('SIGTERM', () => stop('sigterm'));
process.on('SIGHUP', () => stop('sighup'));
process.on('exit', () => fs.writeFileSync(${JSON.stringify(exitFile)}, JSON.stringify({ marker, pid: process.pid, reason })));
setTimeout(() => stop('watchdog'), 600000).unref();
`)
  let sessionId: string | undefined
  let issued = false
  const receipt = (): ProgramReceipt | undefined => {
    if (!existsSync(receiptFile)) return undefined
    const value = JSON.parse(readFileSync(receiptFile, 'utf8')) as ProgramReceipt
    if (value.marker !== marker || !Number.isSafeInteger(value.pid) || value.pid <= 1 || !Number.isSafeInteger(value.shellPid) || value.shellPid <= 1 || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw new Error('The terminal process receipt does not identify the owned program')
    return value
  }
  const control = (method: 'GET' | 'POST', endpoint: string, value: ProgramReceipt) => new Promise<string>((resolve, reject) => {
    const call = request({ hostname: '127.0.0.1', port: value.port, path: endpoint, method, headers: { Authorization: `Bearer ${token}` }, timeout: 2000, agent: false }, response => {
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 16384) { call.destroy(new Error('Owned terminal control response exceeded its limit')); return }
        chunks.push(chunk)
      })
      response.once('error', reject)
      response.once('end', () => response.statusCode === 200 ? resolve(Buffer.concat(chunks).toString('utf8')) : reject(new Error(`Owned terminal control refused with status ${response.statusCode}`)))
    })
    call.once('timeout', () => call.destroy(new Error('Owned terminal control timed out')))
    call.once('error', reject)
    call.end()
  })
  return {
    marker, ready, file,
    command: `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)} ${quote(file)}`,
    bind(id: string) { sessionId = id },
    markIssued() { issued = true },
    receipt,
    inputs: (): InputReceipt[] => existsSync(inputsFile) ? readFileSync(inputsFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [],
    ack: (sequence: number, input: string) => `PTY_ACK_${marker}_${sequence}_${input}`,
    observation() {
      let value: ProgramReceipt | undefined
      let invalid = false
      try { value = receipt() } catch { invalid = true }
      let exit: { reason: string } | null = null
      try { if (existsSync(exitFile)) exit = JSON.parse(readFileSync(exitFile, 'utf8')) } catch { exit = { reason: 'unreadable' } }
      return { marker, sessionId, issued, receipt: value, process: value ? observeProcess(value.pid) : { state: 'unknown' as const, code: invalid ? 'RECEIPT_INVALID' : issued ? 'RECEIPT_MISSING' : 'NOT_STARTED' }, shell: value ? observeProcess(value.shellPid) : { state: 'unknown' as const, code: 'PID_MISSING' }, exit }
    },
    confirmedExited() {
      try {
        const value = receipt()
        return !sessionId && !issued || Boolean(value && observeProcess(value.pid).state === 'exited' && observeProcess(value.shellPid).state === 'exited')
      } catch { return false }
    },
    async stopProgram() {
      const value = receipt()
      if (!value) { if (issued) throw new Error('Cannot identify the issued terminal program for cleanup'); return }
      if (observeProcess(value.pid).state === 'exited') return
      const identity = JSON.parse(await control('GET', '/identity', value)) as ProgramReceipt
      if (identity.pid !== value.pid || identity.marker !== marker) throw new Error('Owned terminal control identity changed; refusing cleanup')
      await control('POST', '/stop', value)
    },
  }
}

export type OwnedPtyProgram = ReturnType<typeof ownedPtyProgram>
