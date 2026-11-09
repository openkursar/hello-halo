/**
 * @module utils/errors.test
 * Unit tests for the SDK error type hierarchy and detection utilities.
 */

import { describe, it, expect } from 'vitest';
import {
  SDKError,
  ProviderError,
  isContextWindowExceededError,
  outputTokenLimitFromError,
  withRetriesExhausted,
  ToolExecutionError,
  BudgetExceededError,
  MaxTurnsExceededError,
  AbortError,
  isAbortError,
  CompactError,
} from './errors.js';

// ---------------------------------------------------------------------------
// SDKError
// ---------------------------------------------------------------------------

describe('SDKError', () => {
  it('sets name, code, and message', () => {
    const err = new SDKError('MY_CODE', 'my message');
    expect(err.name).toBe('SDKError');
    expect(err.code).toBe('MY_CODE');
    expect(err.message).toBe('my message');
  });

  it('is an instanceof Error', () => {
    const err = new SDKError('X', 'y');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SDKError);
  });

  it('has a stack trace', () => {
    const err = new SDKError('X', 'y');
    expect(err.stack).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// ProviderError
// ---------------------------------------------------------------------------

describe('ProviderError', () => {
  it('defaults retryable to false and no statusCode', () => {
    const err = new ProviderError('oops');
    expect(err.name).toBe('ProviderError');
    expect(err.retryable).toBe(false);
    expect(err.statusCode).toBeUndefined();
    expect(err.code).toBe('PROVIDER_ERROR');
  });

  it('accepts statusCode and retryable overrides', () => {
    const err = new ProviderError('bad gateway', { statusCode: 502, retryable: true });
    expect(err.statusCode).toBe(502);
    expect(err.retryable).toBe(true);
  });

  it('is instanceof SDKError and Error', () => {
    const err = new ProviderError('x');
    expect(err).toBeInstanceOf(SDKError);
    expect(err).toBeInstanceOf(Error);
  });

  describe('static factories', () => {
    it.each([
      ['overloaded_error', 529, true], ['rate_limit_error', 429, true],
      ['api_error', 500, true], ['server_error', 500, true],
      ['authentication_error', 401, false], ['permission_error', 403, false],
      ['invalid_request_error', 400, false], ['not_found_error', 404, false],
      ['unknown_error', undefined, false],
    ])('classifies SSE %s consistently with HTTP errors', (type, statusCode, retryable) => {
      expect(ProviderError.fromStreamError('test', type, 'server message')).toMatchObject({
        provider: 'test', statusCode, retryable, retriesExhausted: false, message: 'server message',
      });
    });

    it('rateLimit() creates a 429 retryable error', () => {
      const err = ProviderError.rateLimit();
      expect(err.statusCode).toBe(429);
      expect(err.retryable).toBe(true);
      expect(err.message).toBe('Rate limit exceeded');
    });

    it('rateLimit() accepts a custom message', () => {
      const err = ProviderError.rateLimit('custom rate limit');
      expect(err.message).toBe('custom rate limit');
    });

    it('overloaded() creates a 529 retryable error', () => {
      const err = ProviderError.overloaded();
      expect(err.statusCode).toBe(529);
      expect(err.retryable).toBe(true);
      expect(err.message).toBe('API overloaded');
    });

    it('contextWindowExceeded() creates a 400 non-retryable error', () => {
      const err = ProviderError.contextWindowExceeded();
      expect(err.statusCode).toBe(400);
      expect(err.retryable).toBe(false);
      expect(err.message).toBe('Context window exceeded');
    });
  });

  describe('isContextWindowExceeded getter', () => {
    it('returns false for non-400 errors', () => {
      const err = new ProviderError('too many requests', { statusCode: 429 });
      expect(err.isContextWindowExceeded).toBe(false);
    });

    it('returns false for 400 with unrelated message', () => {
      const err = new ProviderError('bad input format', { statusCode: 400 });
      expect(err.isContextWindowExceeded).toBe(false);
    });

    it('detects "prompt is too long"', () => {
      const err = new ProviderError('prompt is too long for this model', { statusCode: 400 });
      expect(err.isContextWindowExceeded).toBe(true);
    });

    it('detects "context_window_exceeded"', () => {
      const err = new ProviderError('context_window_exceeded limit hit', { statusCode: 400 });
      expect(err.isContextWindowExceeded).toBe(true);
    });

    it('detects "prompt_too_long"', () => {
      const err = new ProviderError('prompt_too_long error', { statusCode: 400 });
      expect(err.isContextWindowExceeded).toBe(true);
    });

    it('detects "context window" phrase', () => {
      const err = new ProviderError('context window limit exceeded', { statusCode: 400 });
      expect(err.isContextWindowExceeded).toBe(true);
    });

    it('is case-insensitive', () => {
      const err = new ProviderError('PROMPT IS TOO LONG', { statusCode: 400 });
      expect(err.isContextWindowExceeded).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// isContextWindowExceededError
// ---------------------------------------------------------------------------

describe('isContextWindowExceededError', () => {
  it('returns true for ProviderError with context window condition', () => {
    const err = ProviderError.contextWindowExceeded();
    expect(isContextWindowExceededError(err)).toBe(true);
  });

  it('returns false for ProviderError without context window condition', () => {
    const err = ProviderError.rateLimit();
    expect(isContextWindowExceededError(err)).toBe(false);
  });

  it('returns false for non-error values', () => {
    expect(isContextWindowExceededError(null)).toBe(false);
    expect(isContextWindowExceededError(undefined)).toBe(false);
    expect(isContextWindowExceededError('string error')).toBe(false);
    expect(isContextWindowExceededError(42)).toBe(false);
  });

  it('detects raw Error with status=400 and context window message', () => {
    const err = Object.assign(new Error('prompt is too long'), { status: 400 });
    expect(isContextWindowExceededError(err)).toBe(true);
  });

  it('returns false for raw Error with status=400 but unrelated message', () => {
    const err = Object.assign(new Error('bad request: unknown field'), { status: 400 });
    expect(isContextWindowExceededError(err)).toBe(false);
  });

  it('returns false for raw Error with matching message but wrong status', () => {
    const err = Object.assign(new Error('prompt is too long'), { status: 500 });
    expect(isContextWindowExceededError(err)).toBe(false);
  });

  it('returns false for plain Error without status field', () => {
    const err = new Error('context window exceeded');
    expect(isContextWindowExceededError(err)).toBe(false);
  });

  it.each([400, 413, 422])('recognizes compatible context errors with statusCode %i', statusCode => {
    expect(isContextWindowExceededError(Object.assign(new Error('context_length_exceeded: maximum context length'), { statusCode }))).toBe(true);
    expect(isContextWindowExceededError(Object.assign(new Error('Unknown model name'), { statusCode }))).toBe(false);
  });

  it('normalizes transient transport errors without treating arbitrary exceptions as retryable', () => {
    expect(ProviderError.from(Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }))).toMatchObject({ retryable: true });
    expect(ProviderError.from(new TypeError('fetch failed', { cause: Object.assign(new Error('connect'), { code: 'ETIMEDOUT' }) })))
      .toMatchObject({ retryable: true });
    expect(ProviderError.from(new TypeError('Invalid request construction'))).toBeNull();
    expect(ProviderError.from(Object.assign(new Error('Forbidden'), { statusCode: 403 }))).toMatchObject({ retryable: false, statusCode: 403 });
  });
});

describe('outputTokenLimitFromError', () => {
  it('distinguishes an HTTP refusal from errors after a response stream started', () => {
    const refused = ProviderError.fromHttpResponse('Anthropic', 400, JSON.stringify({ error: { message: 'max_tokens must be between 1 and 4096' } }));
    expect(refused.requestRejected).toBe(true);
    expect(withRetriesExhausted(refused)).toMatchObject({ requestRejected: true });
    expect(ProviderError.fromStreamError('Anthropic', 'invalid_request_error', 'max_tokens must be between 1 and 4096').requestRejected).toBe(false);
    expect(new ProviderError('max_tokens must be between 1 and 4096', { statusCode: 400 }).requestRejected).toBe(false);
  });

  it('extracts the observed gateway limit without using request ID digits', () => {
    const err = new ProviderError(
      'Anthropic API error (400): Upstream request failed: [invalid_request_error] max_tokens must be between 1 and 393216 (request_id: gw-db10255fc9e-d50ea9)',
      { statusCode: 400 },
    );
    expect(outputTokenLimitFromError(err, 524288)).toBe(393216);
  });

  it.each(['max_tokens', 'max_completion_tokens', 'max_output_tokens'])('recognizes %s with optional matching quotes', parameter => {
    for (const statusCode of [400, 422]) {
      for (const quote of ['', "'", '"', '`']) {
        const err = new ProviderError(`${quote}${parameter}${quote} must be between 1 and 4096`, { statusCode });
        expect(outputTokenLimitFromError(err, 8192)).toBe(4096);
      }
    }
  });

  it.each([
    { status: 400 },
    { status: 422 },
    { statusCode: 400 },
    { statusCode: 422 },
  ])('accepts plain Error carrying a numeric validation status: %j', status => {
    const err = Object.assign(new Error('max_tokens must be between 1 and 4096.'), status);
    expect(outputTokenLimitFromError(err, 8192)).toBe(4096);
  });

  it('accepts a one-token ceiling', () => {
    expect(outputTokenLimitFromError(new ProviderError('max_tokens must be between 1 and 1', { statusCode: 400 }), 2)).toBe(1);
  });

  it.each([401, 403, 413, 429, 500, 529, undefined])('rejects non-validation status %s', statusCode => {
    const err = new ProviderError('API error (400): max_tokens must be between 1 and 4096', { statusCode });
    expect(outputTokenLimitFromError(err, 8192)).toBeUndefined();
  });

  it('does not infer validation status from message text or nonnumeric metadata', () => {
    const message = 'API error (400): max_tokens must be between 1 and 4096';
    expect(outputTokenLimitFromError(new Error(message), 8192)).toBeUndefined();
    expect(outputTokenLimitFromError(Object.assign(new Error(message), { status: '400' }), 8192)).toBeUndefined();
    expect(outputTokenLimitFromError(Object.assign(new Error(message), { statusCode: '422' }), 8192)).toBeUndefined();
    expect(outputTokenLimitFromError(Object.assign(new Error(message), { statusCode: 500, status: 400 }), 8192)).toBeUndefined();
  });

  it.each([
    null,
    undefined,
    'max_tokens must be between 1 and 4096',
    400,
    { status: 400, message: 'max_tokens must be between 1 and 4096' },
  ])('rejects non-Error values: %j', err => {
    expect(outputTokenLimitFromError(err, 8192)).toBeUndefined();
  });

  it.each([
    'Invalid request',
    'Invalid parameter: max_tokens',
    'max_tokens is too large',
    'max_tokens must be an integer',
    'max_tokens must be between 0 and 4096',
    'max_tokens must be between 2 and 4096',
    'temperature must be between 1 and 4096',
    'output tokens must be between 1 and 4096',
    'min_tokens must be between 1 and 4096',
    'prefix_max_tokens must be between 1 and 4096',
    'max_tokens_extra must be between 1 and 4096',
    '"max_tokens` must be between 1 and 4096',
  ])('rejects generic or unsupported parameter validation: %s', message => {
    expect(outputTokenLimitFromError(new ProviderError(message, { statusCode: 400 }), 8192)).toBeUndefined();
  });

  it.each([
    'context_window_exceeded: max_tokens must be between 1 and 4096',
    'context_length_exceeded: max_tokens must be between 1 and 4096',
    'maximum context length exceeded: max_tokens must be between 1 and 4096',
    'prompt is too long: max_tokens must be between 1 and 4096',
    'prompt_too_long: max_tokens must be between 1 and 4096',
    'token count + max_tokens must be between 1 and 4096',
    'tokens + max_tokens must be between 1 and 4096',
    'Unrecognized prefix: max_tokens must be between 1 and 4096',
    'input tokens + max_tokens must be between 1 and 4096',
    'input_tokens plus max_tokens must be between 1 and 4096',
    'combined token count: max_tokens must be between 1 and 4096',
    'total token count: max_tokens must be between 1 and 4096',
    'sum of tokens and max_tokens must be between 1 and 4096',
    'messages and max_tokens must be between 1 and 4096',
    'sequence length plus max_tokens must be between 1 and 4096',
    'max_tokens must be between 1 and 4096 due to input and output length',
    'max_tokens must be between 1 and 4096 (context window exhausted)',
  ])('rejects context-window or combined-token overflow: %s', message => {
    expect(outputTokenLimitFromError(new ProviderError(message, { statusCode: 400 }), 8192)).toBeUndefined();
  });

  it.each([
    'zero', 'NaN', 'Infinity', '0', '-4096', '+4096', '4096.5', '4096.0',
    '4e3', '0x1000', '4_096', '4,096', '4096,5', '4096/8192', '4096-8192',
    '4096 tokens', '9007199254740992', '999999999999999999999999999999999999999',
  ])('rejects nonnumeric, noninteger, or unsafe ceilings: %s', ceiling => {
    const err = new ProviderError(`max_tokens must be between 1 and ${ceiling}`, { statusCode: 400 });
    expect(outputTokenLimitFromError(err, Number.MAX_SAFE_INTEGER)).toBeUndefined();
  });

  it.each([4096, 2048])('rejects ceilings not below the requested value %i', requested => {
    const err = new ProviderError('max_tokens must be between 1 and 4096', { statusCode: 400 });
    expect(outputTokenLimitFromError(err, requested)).toBeUndefined();
  });

  it.each([0, -1, 8192.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid requested token counts: %s', requested => {
    const err = new ProviderError('max_tokens must be between 1 and 4096', { statusCode: 400 });
    expect(outputTokenLimitFromError(err, requested)).toBeUndefined();
  });

  it.each([
    'max_tokens must be between 1 and 4096; max_output_tokens must be between 1 and 2048',
    'max_tokens must be between 1 and 4096; max_tokens must be between 1 and 2048',
    'max_tokens must be between 1 and 4096; max_tokens must be between 1 and 4096',
    'temperature must be between 1 and 2; max_tokens must be between 1 and 4096',
    'max_output_tokens is invalid; max_tokens must be between 1 and 4096',
    'max_tokens must be between 1 and 4096 or 8192',
  ])('rejects multiple or ambiguous ranges: %s', message => {
    expect(outputTokenLimitFromError(new ProviderError(message, { statusCode: 400 }), 8192)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ToolExecutionError
// ---------------------------------------------------------------------------

describe('ToolExecutionError', () => {
  it('stores toolName, toolInput, and message', () => {
    const input = { path: '/tmp/foo.txt' };
    const err = new ToolExecutionError('Read', input, 'file not found');
    expect(err.name).toBe('ToolExecutionError');
    expect(err.toolName).toBe('Read');
    expect(err.toolInput).toBe(input);
    expect(err.message).toBe('file not found');
    expect(err.code).toBe('TOOL_EXECUTION_ERROR');
  });

  it('is instanceof SDKError and Error', () => {
    const err = new ToolExecutionError('Bash', {}, 'fail');
    expect(err).toBeInstanceOf(SDKError);
    expect(err).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// BudgetExceededError
// ---------------------------------------------------------------------------

describe('BudgetExceededError', () => {
  it('stores currentCostUsd and maxBudgetUsd', () => {
    const err = new BudgetExceededError(1.5, 1.0);
    expect(err.name).toBe('BudgetExceededError');
    expect(err.currentCostUsd).toBe(1.5);
    expect(err.maxBudgetUsd).toBe(1.0);
    expect(err.code).toBe('BUDGET_EXCEEDED');
  });

  it('includes dollar amounts in the message', () => {
    const err = new BudgetExceededError(2.1234, 2.0);
    expect(err.message).toContain('$2.1234');
    expect(err.message).toContain('$2.0000');
  });

  it('is instanceof SDKError', () => {
    const err = new BudgetExceededError(0, 0);
    expect(err).toBeInstanceOf(SDKError);
  });
});

// ---------------------------------------------------------------------------
// MaxTurnsExceededError
// ---------------------------------------------------------------------------

describe('MaxTurnsExceededError', () => {
  it('stores turns and maxTurns', () => {
    const err = new MaxTurnsExceededError(10, 5);
    expect(err.name).toBe('MaxTurnsExceededError');
    expect(err.turns).toBe(10);
    expect(err.maxTurns).toBe(5);
    expect(err.code).toBe('MAX_TURNS_EXCEEDED');
  });

  it('includes counts in the message', () => {
    const err = new MaxTurnsExceededError(10, 5);
    expect(err.message).toContain('10');
    expect(err.message).toContain('5');
  });

  it('is instanceof SDKError', () => {
    expect(new MaxTurnsExceededError(1, 1)).toBeInstanceOf(SDKError);
  });
});

// ---------------------------------------------------------------------------
// AbortError
// ---------------------------------------------------------------------------

describe('AbortError', () => {
  it('uses default message', () => {
    const err = new AbortError();
    expect(err.message).toBe('Operation was aborted');
    expect(err.name).toBe('AbortError');
    expect(err.code).toBe('ABORTED');
  });

  it('accepts a custom message', () => {
    const err = new AbortError('user cancelled');
    expect(err.message).toBe('user cancelled');
  });

  it('is instanceof SDKError', () => {
    expect(new AbortError()).toBeInstanceOf(SDKError);
  });
});

// ---------------------------------------------------------------------------
// isAbortError
// ---------------------------------------------------------------------------

describe('isAbortError', () => {
  it('returns true for AbortError instances', () => {
    expect(isAbortError(new AbortError())).toBe(true);
  });

  it('returns true for DOMException with name AbortError', () => {
    const dom = new Error('aborted');
    dom.name = 'AbortError';
    expect(isAbortError(dom)).toBe(true);
  });

  it('returns true for Anthropic SDK APIUserAbortError name', () => {
    const err = new Error('aborted by user');
    err.name = 'APIUserAbortError';
    expect(isAbortError(err)).toBe(true);
  });

  it('returns true for error with code ABORT_ERR', () => {
    const err = Object.assign(new Error('abort'), { code: 'ABORT_ERR' });
    expect(isAbortError(err)).toBe(true);
  });

  it('returns false for a regular Error', () => {
    expect(isAbortError(new Error('timeout'))).toBe(false);
  });

  it('returns false for non-error values', () => {
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
    expect(isAbortError('abort')).toBe(false);
  });

  it('returns true when the provided signal is aborted, even for a generic error', () => {
    const ctrl = new AbortController();
    ctrl.abort();
    expect(isAbortError(new Error('generic'), ctrl.signal)).toBe(true);
  });

  it('returns false when signal is not aborted and error is not abort-like', () => {
    const ctrl = new AbortController();
    expect(isAbortError(new Error('generic'), ctrl.signal)).toBe(false);
  });

  it('returns false when signal is present but not yet aborted', () => {
    const ctrl = new AbortController();
    // Signal exists but has not been triggered
    expect(isAbortError(new ProviderError('rate limit'), ctrl.signal)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CompactError
// ---------------------------------------------------------------------------

describe('CompactError', () => {
  it('uses default message', () => {
    const err = new CompactError();
    expect(err.message).toBe('Context compaction failed');
    expect(err.name).toBe('CompactError');
    expect(err.code).toBe('COMPACT_ERROR');
  });

  it('accepts a custom message', () => {
    const err = new CompactError('API compact failed');
    expect(err.message).toBe('API compact failed');
  });

  it('is instanceof SDKError', () => {
    expect(new CompactError()).toBeInstanceOf(SDKError);
  });
});

// ---------------------------------------------------------------------------
// instanceof across subclasses
// ---------------------------------------------------------------------------

describe('error class hierarchy', () => {
  it('all error subclasses are instanceof Error', () => {
    const errs: Error[] = [
      new SDKError('X', 'x'),
      new ProviderError('x'),
      new ToolExecutionError('t', {}, 'x'),
      new BudgetExceededError(0, 1),
      new MaxTurnsExceededError(1, 1),
      new AbortError(),
      new CompactError(),
    ];
    for (const e of errs) {
      expect(e).toBeInstanceOf(Error);
      expect(e).toBeInstanceOf(SDKError);
    }
  });

  it('ProviderError is not an AbortError', () => {
    expect(new ProviderError('x')).not.toBeInstanceOf(AbortError);
  });

  it('AbortError is not a ProviderError', () => {
    expect(new AbortError()).not.toBeInstanceOf(ProviderError);
  });
});
