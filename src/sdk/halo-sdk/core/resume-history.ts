/**
 * @module core/resume-history
 * Loads a stored session's history for resume and decides whether it can be
 * restored as recorded.
 * @license MIT
 */

import type { Message } from '../types/provider.js';
import { getLogger } from '../utils/logger.js';
import { ResumeHistoryError, type ResumeHistoryReason } from '../utils/errors.js';
import { getTranscriptPath, type TranscriptOptions } from './transcript.js';
import { readHistoryReport } from './transcript-reader.js';
import { repairToolResultPairing } from './messages.js';

const log = getLogger('Transcript');

/**
 * History to resume from, paired for the provider.
 *
 * Without `strict`, whatever is readable is used, as before. With `strict`, a
 * history that is absent, unreadable, or would lose recorded content is refused
 * with {@link ResumeHistoryError}. Losing recorded content means damaged
 * records, results recorded for a call that could not be paired with it, or
 * duplicate calls. A call with no recorded result is not a loss: nothing was
 * stored for it, typically because the process stopped while it ran. Records
 * left out by the history size bounds are reported to the model and not
 * treated as a loss.
 */
export async function loadResumeHistory(input: {
  sessionId: string;
  cwd: string;
  stopAtMessageUuid?: string;
  options?: TranscriptOptions;
  strict?: boolean;
}): Promise<Message[]> {
  const path = getTranscriptPath(input.sessionId, input.cwd, input.options);
  const refuse = (reason: ResumeHistoryReason, counts: Record<string, number> = {}): never => {
    log.warn('resume refused: stored history cannot be restored as recorded', { sessionId: input.sessionId, reason, ...counts });
    throw new ResumeHistoryError(reason);
  };

  let report: Awaited<ReturnType<typeof readHistoryReport>>;
  try {
    report = await readHistoryReport(path, input.stopAtMessageUuid);
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    if (!missing) log.warn('transcript could not be read', { path, error: String(error) });
    if (input.strict) refuse(missing ? 'missing' : 'unreadable');
    return [];
  }
  if (report.toolContextDamaged || report.anchorFound === false) refuse('incomplete', { damaged: report.damaged, omitted: report.omitted });
  if (report.messages.length === 0) {
    if (input.strict) refuse('unreadable');
    log.warn('resume requested but no readable messages were found; starting without history', { sessionId: input.sessionId, path });
    return [];
  }

  const { messages, changes } = repairToolResultPairing(report.messages);
  if (input.strict && (report.damaged > 0 || changes.lateResults > 0 || changes.duplicateCalls > 0)) {
    refuse('incomplete', { damaged: report.damaged, lateResults: changes.lateResults, duplicateCalls: changes.duplicateCalls });
  }
  log.info('resumed session from transcript', { sessionId: input.sessionId, messages: messages.length });
  return messages;
}
