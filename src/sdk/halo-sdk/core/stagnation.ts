/**
 * @module core/stagnation
 * Loop-stagnation detector — pure, code-level feature extraction over recent
 * tool calls. No model calls, no I/O: callers feed one record per executed
 * tool call and receive either null or a fact-based notice string to append
 * to the latest tool result.
 *
 * Fires only on determinable facts: the same tool called with identical
 * input, or the same tool failing with the same error type, repeatedly
 * within a sliding window. Notices state observations, never judgments.
 * @license MIT
 */

/** One executed tool call, reduced to cheap comparable features. */
export interface StagnationRecord {
  toolName: string;
  /** Digest of the tool input — use contentDigest() over a stable serialization. */
  inputDigest: string;
  isError: boolean;
  /** Coarse error classification (e.g. first line of the error), when isError. */
  errorType?: string;
  /** Digest of the result content — use contentDigest(). */
  resultDigest: string;
}

export interface StagnationDetectorOptions {
  /** How many prior records to compare against. Default 5. */
  windowSize?: number;
  /** Prior occurrences needed before firing (current call + N priors). Default 2. */
  repeatThreshold?: number;
}

const DEFAULT_WINDOW_SIZE = 5;
const DEFAULT_REPEAT_THRESHOLD = 2;

/**
 * Cheap content digest: length plus a head sample. Collision-tolerant by
 * design — a false negative costs one extra turn; a hash would cost CPU on
 * every result for no behavioral gain.
 */
export function contentDigest(text: string): string {
  return `${text.length}:${text.slice(0, 200)}`;
}

/**
 * Sliding-window repetition detector.
 *
 * Firing rule: the current record matches ≥ repeatThreshold prior records in
 * the window by (same tool + same input digest) OR (same tool + same error
 * type, both errors). After firing it stays silent until a non-repeating
 * record re-arms it, so the model is warned once per streak, not every turn.
 */
export class StagnationDetector {
  private readonly windowSize: number;
  private readonly repeatThreshold: number;
  private window: StagnationRecord[] = [];
  private armed = true;

  constructor(options?: StagnationDetectorOptions) {
    this.windowSize = options?.windowSize ?? DEFAULT_WINDOW_SIZE;
    this.repeatThreshold = options?.repeatThreshold ?? DEFAULT_REPEAT_THRESHOLD;
  }

  /** Clear all state (e.g. on a new user turn). */
  reset(): void {
    this.window = [];
    this.armed = true;
  }

  /**
   * Feed one executed tool call. Returns a notice string when a repetition
   * streak crosses the threshold, otherwise null.
   */
  record(rec: StagnationRecord): string | null {
    const inputRepeats = this.window.filter(
      (r) => r.toolName === rec.toolName && r.inputDigest === rec.inputDigest,
    );
    const errorRepeats = rec.isError
      ? this.window.filter(
          (r) =>
            r.toolName === rec.toolName &&
            r.isError &&
            (r.errorType ?? '') === (rec.errorType ?? ''),
        )
      : [];
    const isRepeating = inputRepeats.length > 0 || errorRepeats.length > 0;
    const considered = this.window.length + 1;

    this.window.push(rec);
    if (this.window.length > this.windowSize) {
      this.window = this.window.slice(this.window.length - this.windowSize);
    }

    if (!this.armed) {
      if (!isRepeating) {
        this.armed = true;
      }
      return null;
    }

    if (inputRepeats.length >= this.repeatThreshold) {
      const occurrences = inputRepeats.length + 1;
      const allErrors = rec.isError && inputRepeats.every((r) => r.isError);
      const sameResults =
        !allErrors &&
        inputRepeats.every((r) => r.resultDigest === rec.resultDigest);
      let detail = '';
      if (allErrors) {
        detail = ', each returning an error';
      } else if (sameResults) {
        detail = ', each returning an identical result';
      }
      this.armed = false;
      return (
        `The ${rec.toolName} tool was called ${occurrences} times with identical input within the last ${considered} tool calls${detail}. ` +
        'This may be intentional; consider whether to continue or adjust your approach.'
      );
    }

    if (errorRepeats.length >= this.repeatThreshold) {
      const occurrences = errorRepeats.length + 1;
      const typeText = rec.errorType ? ` (${rec.errorType})` : '';
      this.armed = false;
      return (
        `The ${rec.toolName} tool failed with the same error type${typeText} ${occurrences} times within the last ${considered} tool calls. ` +
        'This may be intentional; consider whether to continue or adjust your approach.'
      );
    }

    return null;
  }
}
