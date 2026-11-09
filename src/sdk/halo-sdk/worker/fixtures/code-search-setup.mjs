import { setup as baseSetup } from './setup.mjs';

export async function setup(options, data = {}) {
  if (data.failPreparation) throw new Error('Fixture preparation failed');
  const configured = await baseSetup(options, data);
  if (data.clearReadDenials) configured.disallowedTools = [];
  if (data.removeCodeSearch) delete configured.codeSearch;
  if (data.replaceCodeSearch) configured.codeSearch = data.replaceCodeSearch;
  const stream = configured.provider.createMessageStream.bind(configured.provider);
  configured.provider.createMessageStream = async function* (request) {
    if (request.model === 'crash-worker') process.exit(17);
    yield* stream(request);
  };
  return configured;
}
