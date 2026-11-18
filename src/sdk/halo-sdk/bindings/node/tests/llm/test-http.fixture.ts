import { createServer, type Server } from 'node:http';

export interface ProviderHttpFixture {
  baseUrl: string;
  close(): Promise<void>;
}

export async function providerHttpFixture(
  handler: (url: string, options: RequestInit) => Response | Promise<Response>,
): Promise<ProviderHttpFixture> {
  const completedBodies = new WeakMap<Response, Uint8Array[]>();
  let server: Server;
  let baseUrl = '';
  server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const headers = Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value ?? '']));
      try {
        const result = await handler(`${baseUrl}${request.url}`, {
          method: request.method,
          headers,
          body: Buffer.concat(chunks).toString(),
        });
        response.writeHead(result.status, Object.fromEntries(result.headers));
        const cached = completedBodies.get(result);
        if (cached) {
          for (const chunk of cached) response.write(chunk);
        } else if (result.body) {
          const reader = result.body.getReader();
          const body: Uint8Array[] = [];
          const cancel = () => { void reader.cancel().catch(() => {}); };
          response.once('close', cancel);
          try {
            while (!response.destroyed) {
              const next = await reader.read();
              if (next.done) break;
              body.push(next.value);
              response.write(next.value);
            }
            completedBodies.set(result, body);
          } finally {
            response.off('close', cancel);
            reader.releaseLock();
          }
        }
        response.end();
      } catch {
        response.destroy();
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    baseUrl,
    async close() {
      if (!server.listening) return;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
