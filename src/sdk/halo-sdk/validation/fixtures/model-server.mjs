import { createServer } from 'node:http';
import { once } from 'node:events';

export async function createModelServer(handler) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const body = chunks.length ? JSON.parse(rawBody) : undefined;
    requests.push({ path: request.url, headers: request.headers, body, rawBody });
    try { await handler(request, response, body); }
    catch (error) {
      if (response.headersSent) response.destroy(error);
      else { response.writeHead(500); response.end(JSON.stringify({ error: { message: String(error) } })); }
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { requests, url: `http://127.0.0.1:${server.address().port}`,
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

export function sendSse(response, events) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end();
}

export function completionEvents(protocol, content, inputTokens = 17, outputTokens = 3) {
  if (protocol === 'openai') return [
    { id: 'fixture-response', model: 'fixture', choices: [{ delta: content }] },
    { choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens } },
  ];
  return [
    { type: 'message_start', message: { id: 'fixture-response', model: 'fixture', usage: { input_tokens: inputTokens, output_tokens: 0 } } },
    ...content.flatMap((block, index) => [
      { type: 'content_block_start', index, content_block: block },
      { type: 'content_block_stop', index },
    ]),
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: outputTokens } },
    { type: 'message_stop' },
  ];
}
