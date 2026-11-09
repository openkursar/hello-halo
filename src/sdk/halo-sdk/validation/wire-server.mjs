import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

// A real HTTP/SSE peer with scripted decisions. This is fault injection, not a live-model test.
export async function startWireServer() {
  let requests = 0;
  let active = 0;
  const server = createServer(async (request, response) => {
    requests++;
    active++;
    response.once('close', () => { active--; });
    let body = '';
    for await (const chunk of request) {
      body += chunk;
      if (body.length > 16 * 1024 * 1024) { response.writeHead(413).end(); return; }
    }
    const data = JSON.parse(body);
    let plan;
    let start = -1;
    for (let i = data.messages.length - 1; i >= 0; i--) {
      const message = data.messages[i];
      if (message.role !== 'user') continue;
      const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
      const match = /HALO_TEST_PLAN:([A-Za-z0-9+/=]+)/.exec(content);
      if (match) { plan = JSON.parse(Buffer.from(match[1], 'base64')); start = i; break; }
    }
    if (!plan) { response.writeHead(400).end('Missing test plan'); return; }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = delta => response.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', model: 'wire-fixture', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    send({ role: 'assistant', content: '' });
    if (plan.stall) return;
    if (plan.truncate) { send({ content: 'INCOMPLETE' }); response.end(); return; }
    const step = data.messages.slice(start + 1).filter(message => message.role === 'assistant' && message.tool_calls?.length).length;
    const call = plan.calls[step];
    if (call) {
      const previousTask = [...data.messages].reverse().find(message => message.role === 'tool' && /bash-[0-9a-f-]{36}/.test(String(message.content)));
      const taskId = /bash-[0-9a-f-]{36}/.exec(String(previousTask?.content))?.[0];
      const input = JSON.parse(JSON.stringify(call.input).replaceAll('$LAST_TASK', taskId ?? 'missing-task'));
      send({ tool_calls: [{ index: 0, id: `call_${randomUUID()}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(input) } }] });
    } else send({ content: plan.result ?? 'DONE' });
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, metrics: () => ({ requests, active }),
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

export function plan(calls, result = 'DONE', extra = {}) {
  return 'HALO_TEST_PLAN:' + Buffer.from(JSON.stringify({ calls, result, ...extra })).toString('base64');
}
