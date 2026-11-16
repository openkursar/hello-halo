import { appendFile } from 'node:fs/promises';

export function setup(options, data) {
  let requestIndex = 0;
  return { ...options, provider: {
    id: 'tool-context-fixture', name: 'Tool context fixture',
    capabilities: () => ({ streaming: true, toolCalling: true, thinking: false,
      imageInput: true, pdfInput: false, audioInput: false, videoInput: false,
      caching: false, systemPromptStyle: 'top_level' }),
    async createMessage(request) {
      await appendFile(data.requests, JSON.stringify({ summary: true, model: request.model,
        systemPrompt: request.systemPrompt, tools: request.tools, messages: request.messages }) + '\n');
      return { id: 'summary', model: request.model, content: [{ type: 'text', text: 'Continue the requested work.' }],
        stopReason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } };
    },
    async *createMessageStream(request) {
      const reply = data.replies[requestIndex++];
      await appendFile(data.requests, JSON.stringify({ model: request.model,
        systemPrompt: request.systemPrompt, tools: request.tools, messages: request.messages }) + '\n');
      yield { type: 'message_start', id: `response-${requestIndex}`, model: request.model,
        usage: { input_tokens: 0, output_tokens: 0 } };
      if (reply) {
        yield { type: 'content_block_start', index: 0,
          content_block: { type: 'tool_use', id: reply.id, name: reply.name, input: {} } };
        const input = JSON.stringify(reply.input);
        yield { type: 'input_json_delta', index: 0, partialJson: input.slice(0, 7) };
        yield { type: 'input_json_delta', index: 0, partialJson: input.slice(7) };
      } else {
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
        yield { type: 'text_delta', index: 0, text: 'Done.' };
      }
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', stopReason: reply ? 'tool_use' : 'end_turn' };
      yield { type: 'message_stop' };
    },
  } };
}
