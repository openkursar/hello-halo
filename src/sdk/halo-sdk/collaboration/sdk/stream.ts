import { CostTracker } from '../../core/cost.js';
import type { SDKMessage, SDKResultMessage } from '../../core/query-types.js';
import type { SdkCollaborationBinding } from './index.js';

/** A source request emits one terminal result even when teammate arrivals resume its model. */
export async function* streamCollaboration(options: {
  collaboration: SdkCollaborationBinding;
  run(completedTurns: number): AsyncGenerator<SDKMessage, void, undefined>;
  hasInput(): boolean;
  prepareNext(): void;
  wait(): Promise<void>;
  signal: AbortSignal;
  closed?: () => boolean;
}): AsyncGenerator<SDKMessage, void, undefined> {
  const { collaboration } = options;
  const totals = new CostTracker('collaboration');
  const started = Date.now();
  let result: SDKResultMessage | undefined;
  let idle: SDKMessage | undefined;
  let initialized = false;
  let answer = '';
  let turns = 0;
  let apiTime = 0;
  const denials: SDKResultMessage['permission_denials'] = [];
  try {
    do {
      for await (const message of options.run(turns)) {
        if (message.type === 'result') {
          result = message;
          totals.addReportedUsage(message.modelUsage);
          turns += message.num_turns;
          apiTime += message.duration_api_ms;
          denials.push(...message.permission_denials);
          if (message.subtype === 'success' && message.result.trim()) answer = message.result;
        } else if (message.type === 'system' && message.subtype === 'init') {
          if (!initialized) yield message;
          initialized = true;
        } else if (message.type === 'system' && message.subtype === 'session_state_changed' && message.state === 'idle') {
          idle = message;
        } else yield message;
      }
      if (options.closed?.()) return;
      if (options.signal.aborted || result?.is_error) {
        await collaboration.stopAll();
        while (collaboration.activeCount > 0 && !options.closed?.()) {
          await collaboration.waitForChange(collaboration.revision);
        }
        break;
      }
      while (collaboration.activeCount > 0 && !options.hasInput() && !options.signal.aborted && !options.closed?.()) await options.wait();
      if (options.closed?.()) return;
      if (options.signal.aborted) {
        await collaboration.stopAll();
        while (collaboration.activeCount > 0 && !options.closed?.()) await collaboration.waitForChange(collaboration.revision);
        break;
      }
      if (!options.hasInput()) break;
      options.prepareNext();
    } while (true);
  } catch (error) {
    await collaboration.stopAll();
    throw error;
  }
  if (options.closed?.()) return;
  if (!result) {
    if (idle) yield idle;
    return;
  }
  totals.addReportedUsage(collaboration.drainUsage());
  const common = {
    num_turns: turns, duration_ms: Date.now() - started, duration_api_ms: apiTime,
    total_cost_usd: totals.totalCostUsd, usage: totals.getUsage(), modelUsage: totals.getModelUsage(),
    permission_denials: denials,
  };
  if (options.signal.aborted) yield {
    ...result, ...common, subtype: 'error_during_execution', is_error: true,
    errors: ['Operation was aborted'], result: 'Operation was aborted',
  };
  else yield { ...result, ...common, result: result.subtype === 'success' ? answer : result.result };
  if (idle) yield idle;
}
