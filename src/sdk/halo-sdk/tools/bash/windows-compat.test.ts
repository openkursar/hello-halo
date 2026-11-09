/**
 * @module tools/bash/windows-compat.test
 * Unit tests for Windows-compatibility helpers.
 *
 * These tests are platform-agnostic — they exercise pure-function
 * helpers that decide what to do on each platform. The behavior on
 * the actual platform is exercised in bash-tool.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { posixPathToWindowsPath, windowsPathToPosixPath } from './windows-paths.js';
import { rewriteWindowsNullRedirect } from './null-redirect.js';
import { posixQuote, posixQuoteArgs } from './shell-quote.js';

// ===========================================================================
// windowsPathToPosixPath
// ===========================================================================

describe('windowsPathToPosixPath', () => {
  it('converts drive letter paths', () => {
    expect(windowsPathToPosixPath('C:\\Users\\foo')).toBe('/c/Users/foo');
    expect(windowsPathToPosixPath('D:\\bar\\baz')).toBe('/d/bar/baz');
  });

  it('handles drive letter with forward slash', () => {
    expect(windowsPathToPosixPath('C:/Users/foo')).toBe('/c/Users/foo');
  });

  it('lowercases the drive letter', () => {
    expect(windowsPathToPosixPath('C:\\Foo')).toBe('/c/Foo');
    expect(windowsPathToPosixPath('Z:\\Bar')).toBe('/z/Bar');
  });

  it('converts UNC paths', () => {
    expect(windowsPathToPosixPath('\\\\server\\share\\file'))
      .toBe('//server/share/file');
  });

  it('handles relative paths', () => {
    expect(windowsPathToPosixPath('foo\\bar')).toBe('foo/bar');
    expect(windowsPathToPosixPath('.\\config')).toBe('./config');
  });

  it('is idempotent on already-POSIX input', () => {
    // No-op transform for backslash-free paths
    expect(windowsPathToPosixPath('/already/posix')).toBe('/already/posix');
  });

  it.each([
    ['', ''],
    ['C:', 'C:'],
    ['C:relative\\file', 'C:relative/file'],
    ['c:\\', '/c/'],
    ['R:\\team space\\文档.txt', '/r/team space/文档.txt'],
    ['C:\\one\\\\two\\..\\three', '/c/one//two/../three'],
    ['1:\\file', '1:/file'],
    ['K:\\file', 'K:/file'],
    ['\\\\host\\c\\file', '//host/c/file'],
  ])('preserves path structure when converting %j', (input, expected) => {
    expect(windowsPathToPosixPath(input)).toBe(expected);
  });
});

// ===========================================================================
// posixPathToWindowsPath
// ===========================================================================

describe('posixPathToWindowsPath', () => {
  it('converts /c/... format', () => {
    expect(posixPathToWindowsPath('/c/Users/foo')).toBe('C:\\Users\\foo');
    expect(posixPathToWindowsPath('/d/bar')).toBe('D:\\bar');
  });

  it('uppercases the drive letter', () => {
    expect(posixPathToWindowsPath('/c/foo')).toBe('C:\\foo');
    expect(posixPathToWindowsPath('/Z/bar')).toBe('Z:\\bar');
  });

  it('converts /cygdrive/c/... format', () => {
    expect(posixPathToWindowsPath('/cygdrive/c/Users/foo'))
      .toBe('C:\\Users\\foo');
  });

  it('converts UNC POSIX paths back to UNC', () => {
    expect(posixPathToWindowsPath('//server/share/file'))
      .toBe('\\\\server\\share\\file');
  });

  it('handles drive-only paths', () => {
    expect(posixPathToWindowsPath('/c')).toBe('C:\\');
    expect(posixPathToWindowsPath('/c/')).toBe('C:\\');
  });

  it('handles relative paths', () => {
    expect(posixPathToWindowsPath('foo/bar')).toBe('foo\\bar');
  });

  it.each([
    ['', ''],
    ['/', '\\'],
    ['//c/share', '\\\\c\\share'],
    ['/cygdrive/z', 'Z:\\'],
    ['/cygdrive/Z//folder/', 'Z:\\\\folder\\'],
    ['/cygdrive/ab/file', '\\cygdrive\\ab\\file'],
    ['/cygdrive/1/file', '\\cygdrive\\1\\file'],
    ['/K/file', '\\K\\file'],
    ['/cousin/file', '\\cousin\\file'],
    ['/c/team space/文档.txt', 'C:\\team space\\文档.txt'],
    ['../one//two/', '..\\one\\\\two\\'],
    ['C:\\unchanged', 'C:\\unchanged'],
  ])('recognizes drive mounts without resolving %j', (input, expected) => {
    expect(posixPathToWindowsPath(input)).toBe(expected);
  });
});

describe('windowsPathToPosixPath ↔ posixPathToWindowsPath roundtrip', () => {
  it('roundtrips drive paths', () => {
    const win = 'C:\\Users\\foo\\bar';
    expect(posixPathToWindowsPath(windowsPathToPosixPath(win))).toBe(win);
  });
});

// ===========================================================================
// rewriteWindowsNullRedirect
// ===========================================================================

describe('rewriteWindowsNullRedirect', () => {
  it('rewrites bare >nul', () => {
    expect(rewriteWindowsNullRedirect('cmd >nul')).toBe('cmd >/dev/null');
  });

  it('rewrites 2>nul', () => {
    expect(rewriteWindowsNullRedirect('cmd 2>nul')).toBe('cmd 2>/dev/null');
  });

  it('rewrites 2>NUL case-insensitively', () => {
    expect(rewriteWindowsNullRedirect('cmd 2>NUL')).toBe('cmd 2>/dev/null');
    expect(rewriteWindowsNullRedirect('cmd 2>Nul')).toBe('cmd 2>/dev/null');
  });

  it('rewrites &>nul (combined stdout+stderr)', () => {
    expect(rewriteWindowsNullRedirect('cmd &>nul')).toBe('cmd &>/dev/null');
  });

  it('rewrites >>nul', () => {
    expect(rewriteWindowsNullRedirect('cmd >>nul')).toBe('cmd >>/dev/null');
  });

  it('rewrites > nul with space', () => {
    expect(rewriteWindowsNullRedirect('cmd > nul')).toBe('cmd > /dev/null');
  });

  it('preserves >null (file named "null")', () => {
    expect(rewriteWindowsNullRedirect('cmd >null')).toBe('cmd >null');
  });

  it('preserves >nullable', () => {
    expect(rewriteWindowsNullRedirect('cmd >nullable')).toBe('cmd >nullable');
  });

  it('preserves cat nul.txt', () => {
    expect(rewriteWindowsNullRedirect('cat nul.txt')).toBe('cat nul.txt');
  });

  it('rewrites multiple occurrences in a single command', () => {
    expect(rewriteWindowsNullRedirect('cmd >nul 2>nul'))
      .toBe('cmd >/dev/null 2>/dev/null');
  });

  it('handles redirect at end of command before pipe', () => {
    expect(rewriteWindowsNullRedirect('cmd >nul | grep x'))
      .toBe('cmd >/dev/null | grep x');
  });

  it.each([
    ['cmd 12>>\tNUL; next', 'cmd 12>>\t/dev/null; next'],
    ['(cmd >nul)&&next', '(cmd >/dev/null)&&next'],
    ['cmd >\nnul\nnext', 'cmd >\n/dev/null\nnext'],
    ['cmd >nul.txt', 'cmd >nul.txt'],
    ['cmd >nul/path', 'cmd >nul/path'],
    ['cmd >nul_suffix', 'cmd >nul_suffix'],
    ['cmd >nul(', 'cmd >nul('],
    ['cmd >"nul"', 'cmd >"nul"'],
    ['echo ">nul"', 'echo ">nul"'],
    ['echo ">nul value"', 'echo ">/dev/null value"'],
    ['echo nul', 'echo nul'],
    ['cmd >', 'cmd >'],
    ['', ''],
  ])('retains textual redirection boundaries for %j', (input, expected) => {
    expect(rewriteWindowsNullRedirect(input)).toBe(expected);
  });

  it('handles a long operator run without recursive processing', () => {
    const operators = '>'.repeat(20_000);
    expect(rewriteWindowsNullRedirect(`${operators}NUL`)).toBe(`${operators}/dev/null`);
  });
});

// ===========================================================================
// posixQuote
// ===========================================================================

describe('posixQuote', () => {
  it('wraps simple strings in single quotes', () => {
    expect(posixQuote('hello')).toBe("'hello'");
  });

  it('preserves spaces', () => {
    expect(posixQuote('a b c')).toBe("'a b c'");
  });

  it('does not expand $variables', () => {
    expect(posixQuote('$PATH')).toBe("'$PATH'");
  });

  it('preserves embedded single quotes as literal argument characters', () => {
    // 'don't' → 'don'"'"'t'
    expect(posixQuote("don't")).toBe(`'don'"'"'t'`);
  });

  it('does NOT corrupt ! (no history expansion)', () => {
    // Critical: shell-quote npm would escape this to \!
    expect(posixQuote('select(.x != .y)')).toBe(`'select(.x != .y)'`);
  });

  it('handles backslashes literally', () => {
    expect(posixQuote('a\\b')).toBe(`'a\\b'`);
  });

  it('handles double quotes literally', () => {
    expect(posixQuote('say "hi"')).toBe(`'say "hi"'`);
  });

  it('handles newlines (preserved inside single quotes)', () => {
    expect(posixQuote('line1\nline2')).toBe(`'line1\nline2'`);
  });

  it('handles empty string', () => {
    expect(posixQuote('')).toBe("''");
  });

  it('handles all-quote string', () => {
    expect(posixQuote("'''")).toBe(`''"'"''"'"''"'"''`);
  });
});

describe('posixQuoteArgs', () => {
  it('joins quoted args with spaces', () => {
    expect(posixQuoteArgs(['echo', 'hello world']))
      .toBe(`'echo' 'hello world'`);
  });
});
