export function setup(options, { refs }) {
  let rootStep = 0;
  let active = 0;
  let overlap = false;
  let completed = 0;
  let release;
  const joined = new Promise(resolve => { release = resolve; });
  const capabilities = () => ({ streaming: true, toolCalling: true, thinking: false, imageInput: false, pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' });
  async function* emit(model, block, id) {
    yield { type: 'message_start', id, model, usage: { input_tokens: 3, output_tokens: 0 } };
    yield { type: 'content_block_start', index: 0, content_block: block };
    yield { type: 'content_block_stop', index: 0 };
    yield { type: 'message_delta', stopReason: block.type === 'tool_use' ? 'tool_use' : 'end_turn', usage: { output_tokens: 2 } };
    yield { type: 'message_stop' };
  }
  const wait = async predicate => {
    const deadline = Date.now() + 10_000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('Concurrent sibling barrier timed out.');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  const createMessage = async () => { throw new Error('Streaming provider expected.'); };
  options.provider = { id: 'parent', name: 'Parent', capabilities, createMessage, async *createMessageStream(request) {
    rootStep++;
    if (rootStep <= 2) {
      const name = rootStep === 1 ? 'B' : 'C';
      yield* emit(request.model, { type: 'tool_use', id: `spawn-${name}`, name: 'mcp__halo-team__spawn_agent', input: { name, prompt: `Return only identity ${name}`, model_profile: refs[name] } }, `root-${rootStep}`);
    } else {
      await wait(() => completed === 2);
      if (!overlap) throw new Error('Sibling streams never overlapped.');
      yield* emit(request.model, { type: 'text', text: 'Both siblings overlapped with isolated bindings.' }, 'root-final');
    }
  } };
  const original = options.collaboration.modelSelection.prepare;
  options.collaboration.modelSelection.prepare = async (request, context) => {
    const { providerConfig, ...binding } = await original(request, context);
    const identity = request.plan.selection.profileId;
    return { ...binding, provider: { id: `provider-${identity}`, name: identity, capabilities, createMessage, async *createMessageStream(request) {
      if (request.model !== 'same-model') throw new Error('Wrong wire model.');
      if (!JSON.stringify(request.messages).includes(`identity ${identity}`)) throw new Error(`Sibling prompt/provider crossed: ${identity}`);
      active++;
      if (active === 2) { overlap = true; release(); }
      try {
        await Promise.race([joined, wait(() => overlap)]);
        yield* emit(request.model, { type: 'text', text: `Verified identity ${identity}` }, `stream-${identity}`);
        completed++;
      } finally { active--; }
    } } };
  };
  return options;
}
