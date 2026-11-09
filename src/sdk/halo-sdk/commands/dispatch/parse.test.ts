/**
 * Unit tests for parseSlashInvocation.
 */

import { describe, it, expect } from 'vitest';
import { parseSlashInvocation } from './parse.js';

describe('parseSlashInvocation', () => {
  it('returns null for empty / whitespace-only input', () => {
    expect(parseSlashInvocation('')).toBeNull();
    expect(parseSlashInvocation('   ')).toBeNull();
    expect(parseSlashInvocation('\n\t')).toBeNull();
  });

  it('returns null when input does not start with /', () => {
    expect(parseSlashInvocation('hello /clear')).toBeNull();
    expect(parseSlashInvocation('clear')).toBeNull();
  });

  it('returns null for double-slash prefixes (URLs, escaped)', () => {
    expect(parseSlashInvocation('//foo bar')).toBeNull();
  });

  it('parses bare command with no args', () => {
    expect(parseSlashInvocation('/clear')).toEqual({ name: 'clear', args: '' });
  });

  it('parses command with single arg', () => {
    expect(parseSlashInvocation('/model sonnet-4-5')).toEqual({
      name: 'model',
      args: 'sonnet-4-5',
    });
  });

  it('parses command with multi-token args', () => {
    expect(parseSlashInvocation('/compact tighten everything please')).toEqual({
      name: 'compact',
      args: 'tighten everything please',
    });
  });

  it('trims surrounding whitespace from args', () => {
    expect(parseSlashInvocation('/help    foo   ')).toEqual({
      name: 'help',
      args: 'foo',
    });
  });

  it('matches FIRST line only — subsequent lines are ignored for routing', () => {
    expect(parseSlashInvocation('/init\nextra context here')).toEqual({
      name: 'init',
      args: '',
    });
  });

  it('strips leading whitespace before the slash', () => {
    expect(parseSlashInvocation('   /clear')).toEqual({ name: 'clear', args: '' });
  });

  it('returns null for non-string input', () => {
    // @ts-expect-error — purposely passing wrong type
    expect(parseSlashInvocation(undefined)).toBeNull();
    // @ts-expect-error — purposely passing wrong type
    expect(parseSlashInvocation(42)).toBeNull();
  });

  it('returns null for `/` alone (empty name)', () => {
    expect(parseSlashInvocation('/')).toBeNull();
    expect(parseSlashInvocation('/   ')).toBeNull();
  });

  it('returns null when the name runs into a path separator', () => {
    expect(parseSlashInvocation('/uer/dsds')).toBeNull();
    expect(parseSlashInvocation('/tmp/example.txt')).toBeNull();
    expect(parseSlashInvocation('/Users/me/a.log 帮我看看')).toBeNull();
  });

  it('keeps namespaced command names', () => {
    expect(parseSlashInvocation('/plugin:review now')).toEqual({ name: 'plugin:review', args: 'now' });
  });
});
