import type { Query } from '../index.js';
import type { Options } from '../types/config.js';
import type { SDKMessage } from '../core/query-types.js';
import { getLogger } from '../utils/logger.js';
import { NativeSdkSession } from './session.js';
import { inheritProcessOwner } from './process-owner.js';
import { inheritOptionCapabilities } from './options.js';

export function query(params: { prompt: string | AsyncIterable<{ role: 'user'; content: string }>; options?: Options }): Query {
  const { prompt, options = {} } = params;
  const env = options.env as Record<string, string | undefined> | undefined;
  if (!options.provider && !(options.apiKey ?? env?.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY)) {
    throw new Error('query() requires options.provider, options.apiKey, or ANTHROPIC_API_KEY in env.');
  }
  const nativeOptions = inheritOptionCapabilities({ ...options, nativeQuery: true }, options);
  const session = new NativeSdkSession(nativeOptions);
  const prepared = session.initialized();
  // Preparation can reject before the caller starts reading the generator.
  void prepared.catch(() => undefined);
  const generator = (async function* (): AsyncGenerator<SDKMessage, void, undefined> {
    try {
      await prepared;
      let text: string;
      if (typeof prompt === 'string') text = prompt;
      else {
        text = '';
        for await (const message of prompt) {
          text = typeof message.content === 'string' ? message.content : String(message.content);
          break;
        }
        if (!text) return;
      }
      await session.send(text);
      yield* session.stream();
    } finally { await session[Symbol.asyncDispose](); }
  })() as Query;
  inheritProcessOwner(generator, session);
  const finish = generator.return.bind(generator);
  generator.return = async value => {
    await session.interrupt();
    try { return await finish(value); }
    finally { await session[Symbol.asyncDispose](); }
  };
  generator.getRuntimeStats = () => session.getRuntimeStats();
  generator.interrupt = () => session.interrupt();
  generator.setPermissionMode = mode => session.setPermissionMode(mode);
  generator.setModel = model => session.setModel(model);
  generator.setMaxThinkingTokens = value => session.setMaxThinkingTokens(value);
  generator.supportedCommands = () => session.query.supportedCommands();
  generator.supportedModels = () => session.query.supportedModels();
  generator.mcpServerStatus = () => session.query.mcpServerStatus();
  generator.accountInfo = async () => ({ apiKeySource: 'user' });
  generator.reconnectMcpServer = name => session.query.reconnectMcpServer(name);
  generator.toggleMcpServer = (name, enabled) => session.query.toggleMcpServer(name, enabled);
  generator.setMcpServers = servers => session.query.setMcpServers(servers);
  generator.stopTask = id => session.query.stopTask(id);
  generator.getGoal = () => session.getGoal();
  generator.setGoal = goal => session.setGoal(goal);
  generator.initializationResult = () => session.command('initializationResult');
  generator.close = () => session.close();
  generator.streamInput = async () => {
    getLogger('Native').warn('query.streamInput rejected: one-shot queries do not consume additional input');
    throw new Error('query.streamInput() is not supported. Use createSession().send() or sendIntoLiveTurn() for additional input.');
  };
  return generator;
}
