import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tls from 'node:tls';
import { CostTracker, getAllTools, findToolByName } from '../../index.js';
import { releaseNativeToolOwner } from '../../native/tools.js';

const WebFetchTool = findToolByName(getAllTools(), 'WebFetch')!;
import type { ToolContext } from '../../types/tool.js';

function context(): ToolContext {
  return { sessionId: 'web-tests', cwd: tmpdir(), abortSignal: new AbortController().signal,
    costTracker: new CostTracker('m'), currentTurn: 0, env: {} };
}

let server: Server;
let directory: string;
let baseUrl: string;
let calls = 0;
let originalCAs: string[];
const certificates = tls as typeof tls & {
  getCACertificates(type: 'default'): string[];
  setDefaultCACertificates(certificates: string[]): void;
};
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'sdk-web-tests-'));
  const key = join(directory, 'key.pem');
  const cert = join(directory, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-addext', 'basicConstraints=critical,CA:FALSE'], { stdio: 'ignore' });
  originalCAs = certificates.getCACertificates('default');
  certificates.setDefaultCACertificates([...originalCAs, await readFile(cert, 'utf8')]);
  server = createServer({ key: await readFile(key), cert: await readFile(cert) }, (request, response) => {
    calls++;
    const path = request.url ?? '/';
    if (path === '/redirect') {
      response.writeHead(302, { location: `${baseUrl.replace('127.0.0.1', 'localhost')}/redirected` });
      response.end();
      return;
    }
    if (path === '/pending') {
      response.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': '1000' });
      response.write('partial');
      return;
    }
    const body = path === '/json' ? '{"key":"value","num":42}' : path === '/long' ? 'A'.repeat(200_000)
      : path === '/html' ? '<h1>Welcome</h1><p>Hello world</p>' : 'Plain text content';
    response.writeHead(path === '/missing' ? 404 : 200, { 'Content-Type': path === '/json' ? 'application/json' : path === '/html' ? 'text/html' : 'text/plain' });
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '0.0.0.0', resolve); });
  baseUrl = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  await releaseNativeToolOwner('web-tests');
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  if (originalCAs) certificates.setDefaultCACertificates(originalCAs);
  if (directory) await rm(directory, { recursive: true, force: true });
});

const execute = (path: string) => WebFetchTool.execute({ url: `${baseUrl}${path}`, prompt: 'Inspect' }, context());
describe('public native WebFetch', () => {
  it('retains metadata', () => {
    expect(WebFetchTool.name).toBe('WebFetch');
    expect(WebFetchTool.permissionLevel).toBe('readonly');
    expect(WebFetchTool.inputSchema).toBeDefined();
  });
  it('rejects missing and invalid URLs', async () => {
    const missing = await WebFetchTool.execute({ prompt: 'Summary' }, context());
    expect(missing.isError).toBe(true);
    expect(missing.content).toContain('url');
    const invalid = await WebFetchTool.execute({ url: 'not-a-url', prompt: 'Inspect' }, context());
    expect(invalid.isError).toBe(true);
    expect(invalid.content).toContain('Invalid URL');
  });
  it('upgrades HTTP and converts actual HTML', async () => {
    const result = await WebFetchTool.execute({ url: `${baseUrl.replace('https:', 'http:')}/html`, prompt: 'Inspect' }, context());
    expect(result.isError).toBe(false);
    expect(result.content).toContain('# Welcome');
    expect(result.content).toContain('Hello world');
  });
  it('pretty prints JSON', async () => {
    const result = await execute('/json');
    expect(result.isError).toBe(false);
    expect(result.content).toContain('"key": "value"');
    expect(result.content).toContain('"num": 42');
  });
  it('retains plain text', async () => {
    const result = await execute('/plain');
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Plain text content');
  });
  it('reports HTTP status failures', async () => {
    const result = await execute('/missing');
    expect(result.isError).toBe(true);
    expect(result.content).toContain('404');
  });
  it('bounds returned content', async () => {
    const result = await execute('/long');
    expect(result.isError).toBe(false);
    expect((result.content as string).length).toBeLessThan(200_000);
    expect(result.content).toContain('truncated');
  });
  it('notifies about cross-host redirects without delivering the destination body', async () => {
    const result = await execute('/redirect');
    expect(result.isError).toBe(false);
    expect(result.content).toContain('destination uses a different host');
    expect(result.content).toContain('request it explicitly');
    expect(result.content).toContain(`${baseUrl.replace('127.0.0.1', 'localhost')}/redirected`);
    expect(result.content).not.toContain('Plain text content');
  });
  it('serves repeated URLs from cache', async () => {
    const before = calls;
    const first = await execute('/cache');
    const second = await execute('/cache');
    expect(first.isError).toBe(false);
    expect(second.isError).toBe(false);
    expect(first.output).toBe(second.output);
    expect(first.content).toBe(second.content);
    expect(calls - before).toBe(1);
  });
  it('reports refused connections', async () => {
    const result = await WebFetchTool.execute({ url: 'https://127.0.0.1:1/refused', prompt: 'Inspect' }, context());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Failed to fetch');
  });
  it('cancels pending response bodies without returning partial success', async () => {
    const controller = new AbortController();
    const ctx = context();
    ctx.abortSignal = controller.signal;
    const arrived = new Promise<void>(resolve => server.once('request', () => resolve()));
    const pending = WebFetchTool.execute({ url: `${baseUrl}/pending`, prompt: 'Inspect' }, ctx);
    await arrived;
    controller.abort(new Error('stop body'));
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.content).toContain('aborted');
    expect(result.content).not.toContain('partial');
  });

  it('refuses pre-aborted requests without HTTP work', async () => {
    const controller = new AbortController();
    controller.abort();
    const ctx = context();
    ctx.abortSignal = controller.signal;
    const before = calls;
    const result = await WebFetchTool.execute({ url: `${baseUrl}/aborted`, prompt: 'Inspect' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('aborted');
    expect(calls).toBe(before);
  });
});
