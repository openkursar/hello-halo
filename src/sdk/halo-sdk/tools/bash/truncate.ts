/**
 * @module tools/bash/truncate
 * Output truncation for bash command output.
 * @license MIT
 */

import { truncateContent, DEFAULT_MAX_RESULT_SIZE_CHARS } from '../../utils/truncate.js';

/**
 * Maximum output length before truncation (characters).
 * Aligned with the query-loop tool-result budget so the truncation
 * marker below survives instead of being re-truncated downstream.
 */
export const MAX_OUTPUT_LEN = DEFAULT_MAX_RESULT_SIZE_CHARS;

/**
 * Truncate bash output if it exceeds maxLen.
 * Keeps head and tail (failures usually surface at the end of output,
 * e.g. test-runner summaries) with an omission marker in the middle
 * stating what was cut and how to recover it.
 */
export function truncateBashOutput(output: string, maxLen: number = MAX_OUTPUT_LEN): string {
  return truncateContent(output, maxLen,
    'Inspect any saved command output. If repeating the command is safe, filter its output or redirect it to a file.');
}
