import { loadBinding } from './binding.js';
import { createCollaborationCallbacks } from './collaboration-callbacks.js';
import { CollaborationRefusal } from '../collaboration/errors.js';
import type { BlackboardWriterOptions, createBlackboardWriter as OriginalBlackboardWriter } from '../collaboration/board-writes.js';
export type * from '../collaboration/board-writes.js';

export function createBlackboardWriter(options: BlackboardWriterOptions): ReturnType<typeof OriginalBlackboardWriter> {
  const callbacks = createCollaborationCallbacks((name, input) => {
    switch (name) {
      case 'insertTask': return options.store.insertTask(input.task);
      case 'getTaskById': return options.store.getTaskById(input.id);
      case 'updateTask': return options.store.updateTask(input.id, input.patch, input.now);
      case 'insertFinding': return options.store.insertFinding(input.finding);
      case 'insertActivity': return options.store.insertActivity(input.activity);
      case 'onChange': return options.onChange?.(input.value);
      case 'onWrite': return options.onWrite?.(input.value);
      case 'clock': return options.clock!();
      case 'createId': return options.createId!();
      default: throw new Error(`Unknown native blackboard callback: ${name}`);
    }
  });
  const handle = new (loadBinding().NativeBlackboardWriter)(JSON.stringify({
    onChange: !!options.onChange, onWrite: !!options.onWrite, clock: !!options.clock, createId: !!options.createId,
  }), callbacks.callback);
  const call = <T>(name: string, input: unknown): T => {
    try { return JSON.parse(handle.call(name, JSON.stringify(input), callbacks.callback)) as T; }
    catch (error) {
      const failure = callbacks.error(error) as Error & { code?: string; details?: { teamId: string; epochId: string; taskId?: string } };
      if (callbacks.isOriginal(failure)) throw failure;
      if (failure?.code === 'task_parent_scope' || failure?.code === 'task_update_scope') {
        throw new CollaborationRefusal(failure.code, failure.message, failure.details);
      }
      throw failure;
    }
  };
  return {
    postTask: input => call('postTask', input),
    updateTask: input => { call('updateTask', input); },
    postFinding: input => call('postFinding', input),
    postActivity: input => call('postActivity', input),
  };
}
