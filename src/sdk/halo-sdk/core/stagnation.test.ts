/**
 * @module core/stagnation.test
 * Unit tests for the loop-stagnation detector.
 * @license MIT
 */

import { describe, it, expect } from 'vitest';
import { StagnationDetector, contentDigest } from './stagnation.js';
import type { StagnationRecord } from './stagnation.js';

function rec(overrides: Partial<StagnationRecord> = {}): StagnationRecord {
  return {
    toolName: 'Bash',
    inputDigest: contentDigest('{"command":"ls"}'),
    isError: false,
    resultDigest: contentDigest('file.txt'),
    ...overrides,
  };
}

describe('contentDigest', () => {
  it('combines length and head sample', () => {
    expect(contentDigest('abc')).toBe('3:abc');
  });

  it('caps the sample at 200 chars but keeps full length', () => {
    const s = 'x'.repeat(500);
    const d = contentDigest(s);
    expect(d.startsWith('500:')).toBe(true);
    expect(d.length).toBe(204);
  });

  it('distinguishes same-length different content', () => {
    expect(contentDigest('aaaa')).not.toBe(contentDigest('bbbb'));
  });

  it('distinguishes same-head different length', () => {
    const a = 'y'.repeat(250);
    const b = 'y'.repeat(300);
    expect(contentDigest(a)).not.toBe(contentDigest(b));
  });
});

describe('StagnationDetector — identical-input firing', () => {
  it('does not fire on the first repeat (2 occurrences)', () => {
    const d = new StagnationDetector();
    expect(d.record(rec())).toBeNull();
    expect(d.record(rec())).toBeNull();
  });

  it('fires on the third identical call (2 prior repeats)', () => {
    const d = new StagnationDetector();
    d.record(rec());
    d.record(rec());
    const notice = d.record(rec());
    expect(notice).not.toBeNull();
    expect(notice).toContain('Bash');
    expect(notice).toContain('3 times with identical input');
    expect(notice).toContain('This may be intentional');
    expect(notice).toContain('continue or adjust your approach');
    expect(notice).not.toContain('Re-diagnose');
  });

  it('mentions identical results when all repeats returned the same result', () => {
    const d = new StagnationDetector();
    d.record(rec());
    d.record(rec());
    const notice = d.record(rec());
    expect(notice).toContain('identical result');
  });

  it('leaves successful polling with changing results to the model', () => {
    const d = new StagnationDetector();
    d.record(rec({ resultDigest: contentDigest('pending') }));
    d.record(rec({ resultDigest: contentDigest('running') }));
    const notice = d.record(rec({ resultDigest: contentDigest('complete') }));
    expect(notice).toContain('3 times with identical input');
    expect(notice).toContain('This may be intentional');
    expect(notice).not.toMatch(/failure|error|identical result|do not repeat/i);
  });

  it('mentions errors when all repeats errored', () => {
    const d = new StagnationDetector();
    const e = { isError: true, errorType: 'exit_1' };
    d.record(rec(e));
    d.record(rec(e));
    const notice = d.record(rec(e));
    expect(notice).not.toBeNull();
    expect(notice).toContain('error');
  });

  it('does not fire for identical inputs on different tools', () => {
    const d = new StagnationDetector();
    d.record(rec({ toolName: 'Read' }));
    d.record(rec({ toolName: 'Grep' }));
    expect(d.record(rec({ toolName: 'Bash' }))).toBeNull();
  });

  it('does not fire for the same tool with different inputs', () => {
    const d = new StagnationDetector();
    d.record(rec({ inputDigest: 'a' }));
    d.record(rec({ inputDigest: 'b' }));
    expect(d.record(rec({ inputDigest: 'c' }))).toBeNull();
  });
});

describe('StagnationDetector — same-error-type firing', () => {
  it('fires when the same tool fails with the same error type 3 times', () => {
    const d = new StagnationDetector();
    d.record(rec({ inputDigest: 'a', isError: true, errorType: 'not_found' }));
    d.record(rec({ inputDigest: 'b', isError: true, errorType: 'not_found' }));
    const notice = d.record(
      rec({ inputDigest: 'c', isError: true, errorType: 'not_found' }),
    );
    expect(notice).not.toBeNull();
    expect(notice).toContain('same error type');
    expect(notice).toContain('not_found');
    expect(notice).toContain('continue or adjust your approach');
    expect(notice).not.toContain('do not repeat');
  });

  it('does not fire on successes even with matching errorType field absent', () => {
    const d = new StagnationDetector();
    d.record(rec({ inputDigest: 'a' }));
    d.record(rec({ inputDigest: 'b' }));
    expect(d.record(rec({ inputDigest: 'c' }))).toBeNull();
  });

  it('does not fire across different error types', () => {
    const d = new StagnationDetector();
    d.record(rec({ inputDigest: 'a', isError: true, errorType: 'x' }));
    d.record(rec({ inputDigest: 'b', isError: true, errorType: 'y' }));
    expect(
      d.record(rec({ inputDigest: 'c', isError: true, errorType: 'z' })),
    ).toBeNull();
  });
});

describe('StagnationDetector — suppression and re-arm', () => {
  it('stays silent on continued repetition after firing', () => {
    const d = new StagnationDetector();
    d.record(rec());
    d.record(rec());
    expect(d.record(rec())).not.toBeNull();
    expect(d.record(rec())).toBeNull();
    expect(d.record(rec())).toBeNull();
  });

  it('re-arms after a non-repeating call and can fire again', () => {
    const d = new StagnationDetector({ windowSize: 3 });
    d.record(rec());
    d.record(rec());
    expect(d.record(rec())).not.toBeNull();
    // Non-repeating call re-arms (and evicts old records from the window).
    expect(d.record(rec({ toolName: 'Read', inputDigest: 'other' }))).toBeNull();
    d.record(rec({ inputDigest: 'fresh' }));
    d.record(rec({ inputDigest: 'fresh' }));
    expect(d.record(rec({ inputDigest: 'fresh' }))).not.toBeNull();
  });
});

describe('StagnationDetector — window eviction', () => {
  it('forgets repeats older than the window', () => {
    const d = new StagnationDetector({ windowSize: 3 });
    d.record(rec()); // will be evicted
    d.record(rec({ inputDigest: 'p' }));
    d.record(rec({ inputDigest: 'q' }));
    d.record(rec({ inputDigest: 'r' }));
    // Only one match left in window would be needed ×2; the first record is gone.
    expect(d.record(rec())).toBeNull();
  });
});

describe('StagnationDetector — options and reset', () => {
  it('honors a custom repeatThreshold', () => {
    const d = new StagnationDetector({ repeatThreshold: 1 });
    d.record(rec());
    expect(d.record(rec())).not.toBeNull();
  });

  it('reset clears the window and re-arms', () => {
    const d = new StagnationDetector();
    d.record(rec());
    d.record(rec());
    expect(d.record(rec())).not.toBeNull();
    d.reset();
    d.record(rec());
    d.record(rec());
    expect(d.record(rec())).not.toBeNull();
  });
});
