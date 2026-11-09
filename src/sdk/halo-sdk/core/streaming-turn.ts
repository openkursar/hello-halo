/** @module core/streaming-turn — bounded model/tool event multiplexing. @license MIT */
import { ToolMessages } from './tool-messages.js';
import type { ToolScheduler } from './tool-scheduler.js';

export type StreamedTurn<R, T> =
  | { response: R; results: T[]; failed: false }
  | { error: unknown; failed: true };

/** Drain tool messages while the provider is still producing its response. */
export async function* streamWithTools<M, R, C, T>(
  source: AsyncGenerator<M, R, undefined>,
  messages: ToolMessages<M>,
  scheduler: ToolScheduler<C, T>,
  controller: AbortController,
): AsyncGenerator<M, StreamedTurn<R, T>, undefined> {
  let finished = false;
  let outcome: StreamedTurn<R, T> | undefined;
  void scheduler.done.catch(error => controller.abort(error));
  const producing = (async () => {
    try {
      let next = await source.next();
      while (!next.done) {
        await messages.send(next.value);
        next = await source.next();
      }
      const results = await scheduler.finish();
      outcome = { response: next.value, results, failed: false };
    } catch (error) {
      scheduler.stop(error);
      controller.abort(error);
      await scheduler.done.catch(() => {});
      outcome = { error, failed: true };
    } finally {
      finished = true;
      messages.finish();
    }
  })();

  try {
    yield* messages.stream();
    await producing;
    return outcome!;
  } finally {
    if (!finished) controller.abort(new Error('Turn consumer closed'));
    messages.close();
    if (!finished) scheduler.stop(controller.signal.reason);
    // A suspended source may own provider I/O even if delivery was interrupted.
    await source.return(undefined as never);
    await producing;
  }
}
