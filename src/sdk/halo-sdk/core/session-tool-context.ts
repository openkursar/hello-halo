import type { TranscriptOptions } from './transcript.js';
import type { HistoryReadReport } from './transcript-reader.js';
import { ResumeHistoryError, type ResumeHistoryReason } from '../utils/errors.js';
import { getLogger } from '../utils/logger.js';

export type SessionToolContextMode = 'deferred' | 'full';

export interface ReadSessionToolContextModeOptions extends TranscriptOptions {
  cwd: string;
  resumeSessionAt?: string;
}

/** Reads and validates bounded history on this thread; UI hosts should use the pooled WorkerRuntime method. */
export async function readSessionToolContextMode(
  sessionId: string,
  options: ReadSessionToolContextModeOptions,
  controls: { signal?: AbortSignal } = {},
): Promise<SessionToolContextMode> {
  controls.signal?.throwIfAborted();
  if (!sessionId.trim() || !options.cwd.trim() || options.resumeSessionAt === '') {
    throw new TypeError('Session context inspection requires a session ID, working directory and nonempty optional anchor');
  }
  const refuse = (reason: ResumeHistoryReason): never => {
    getLogger('Transcript').warn('session tool context mode could not be read', { sessionId, reason });
    throw new ResumeHistoryError(reason);
  };
  let report: HistoryReadReport;
  try {
    const [{ getTranscriptPath }, { readHistoryReport }] = await Promise.all([
      import('./transcript.js'), import('./transcript-reader.js'),
    ]);
    report = await readHistoryReport(getTranscriptPath(sessionId, options.cwd, options), options.resumeSessionAt, controls.signal);
  } catch (error) {
    if (controls.signal?.aborted || (error as { name?: string }).name === 'AbortError') throw error;
    return refuse((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable');
  }
  if (report.anchorFound === false || report.damaged || report.toolContextDamaged) refuse('incomplete');
  if (!report.messages.length) refuse('unreadable');
  return report.messages.some(message => message.toolContext?.baseline !== undefined) ? 'deferred' : 'full';
}
