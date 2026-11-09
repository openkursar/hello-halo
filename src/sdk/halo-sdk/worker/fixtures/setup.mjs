import { threadId } from 'node:worker_threads';
import { appendFile, writeFile } from 'node:fs/promises';

export async function setup(options, data = {}) {
  if (data.preparingFile) await writeFile(data.preparingFile, 'preparing');
  if (data.stalledPreparation) await new Promise(() => {});
  if (data.prepareDelayMs) await new Promise(resolve => setTimeout(resolve, data.prepareDelayMs));
  let calls = 0;
  let sourceCalls = 0;
  let collaboratorCalls = 0;
  const usage = { input_tokens: 10, output_tokens: 10 };
  let hooks = options.hooks;
  if (data.stalledEndHook) hooks = { ...hooks, SessionEnd: [{ hooks: [() => new Promise(() => {})] }] };
  if (data.stalledCollaboratorEnd) hooks = { ...hooks, SessionEnd: [{ hooks: [async input => {
    if (input.session_id === options.sessionId) return {};
    await writeFile(data.collaboratorEndStartedFile, 'waiting');
    return new Promise(() => {});
  }] }] };
  return {
    ...options,
    hooks,
    provider: {
      id: 'worker-fixture', name: 'Worker fixture',
      capabilities: () => ({ streaming: true, toolCalling: true, thinking: false, imageInput: true,
        pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
      async *createMessageStream(request) {
        calls++;
        const collaborator = JSON.stringify(request.systemPrompt).includes('You are collaborator');
        const phase = collaborator ? ++collaboratorCalls : ++sourceCalls;
        if (data.captureRequestsFile) await appendFile(data.captureRequestsFile, JSON.stringify({ threadId, collaborator, request }) + '\n');
        if (data.startedFile) await writeFile(data.startedFile, String(threadId));
        if (data.stalledModel) await new Promise(() => {});
        if (data.hang) while (true) { /* Fault injection: the parent must remain responsive. */ }
        if (data.crash) process.exit(17);
        if (data.reject) { void Promise.reject(new Error('Injected worker rejection')); await new Promise(() => {}); }
        const delayMs = collaborator ? data.collaboratorDelayMs ?? data.delayMs : data.delayMs;
        if (delayMs) await new Promise((resolve, reject) => {
          const signal = request.providerOptions?.signal;
          const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, delayMs);
          const abort = () => { clearTimeout(timer); reject(new Error('Provider aborted')); };
          if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
        });
        yield { type: 'message_start', id: `request-${threadId}-${calls}`, model: request.model, usage };
        const tool = (collaborator ? data.collaboratorTools : data.tools)?.[phase - 1];
        if (tool) {
          yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `call-${calls}`, name: tool.name, input: {} } };
          yield { type: 'input_json_delta', index: 0, partialJson: JSON.stringify(tool.input ?? {}) };
          yield { type: 'content_block_stop', index: 0 };
        } else {
          yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
          const text = JSON.stringify({ threadId, calls, messages: request.messages, model: request.model });
          for (let i = 0; i < (data.deltas ?? 1); i++) yield { type: 'text_delta', index: 0, text: data.deltas ? 'x' : text };
          yield { type: 'content_block_stop', index: 0 };
        }
        yield { type: 'message_delta', stopReason: tool ? 'tool_use' : 'end_turn', usage };
        yield { type: 'message_stop' };
      },
      async createMessage() { throw new Error('Unexpected non-streaming fixture call'); },
    },
  };
}
