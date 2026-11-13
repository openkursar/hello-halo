const { pathToFileURL } = require('node:url');
const configuration = JSON.parse(process.argv[1]);
let engine;
process.on('message', async request => {
  if (request.type === 'close') {
    try { await engine?.close(); } catch { process.send?.({ type: 'error', sdkError: { token: configuration.ownedErrorToken, kind: 'close_failed' } }); }
    process.disconnect();
    return;
  }
  try {
    let result;
    if (request.method === 'open') {
      if (Number(process.versions.node.split('.')[0]) < 22) { process.send?.({ type: 'error', id: request.id, sdkError: { token: configuration.ownedErrorToken, kind: 'node_version' } }); return; }
      const backend = await import(pathToFileURL(configuration.modulePath).href);
      if (typeof backend.createZvecGrep !== 'function') { process.send?.({ type: 'error', id: request.id, sdkError: { token: configuration.ownedErrorToken, kind: 'missing_factory' } }); return; }
      engine = await backend.createZvecGrep(request.args);
      result = null;
    } else {
      if (!engine || !['index', 'context'].includes(request.method)) { process.send?.({ type: 'error', id: request.id, sdkError: { token: configuration.ownedErrorToken, kind: 'invalid_method' } }); return; }
      result = await engine[request.method](request.args);
    }
    process.send?.({ type: 'result', id: request.id, result, rssBytes: process.memoryUsage().rss });
  } catch (error) {
    process.send?.({ type: 'error', id: request.id, ...(error instanceof Error ? { message: error.message.slice(0, 500) } : { sdkError: { token: configuration.ownedErrorToken, kind: 'failed' } }) });
  }
});
process.on('disconnect', () => process.exit(0));
process.send?.({ type: 'ready' });
