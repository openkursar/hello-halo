import { constants } from 'node:fs';
import { access, open, realpath, stat } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { RuntimeError } from '../../errors';
import { fileExists, normalizeInputPath } from '../../paths';
import type { ResolvedCandidate } from '../../provider';
export async function resolveCandidatePath(input: string): Promise<string> {
  const path = normalizeInputPath(input);
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new RuntimeError('not-found');
  }
  if (info.isDirectory()) {
    const names = process.platform === 'win32' ? ['claude.exe', 'bin/claude.exe'] : ['claude', 'bin/claude'];
    for (const name of [...names, 'bin/claude.exe', 'cli.js', 'node_modules/@anthropic-ai/claude-code/cli.js', 'lib/node_modules/@anthropic-ai/claude-code/cli.js', 'node_modules/@anthropic-ai/claude-code/bin/claude.exe', 'lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe']) {
      const candidate = join(path, name);
      if (await fileExists(candidate)) {
        return candidate;
      }
    }
    throw new RuntimeError('not-found');
  }
  if (!info.isFile()) {
    throw new RuntimeError('not-executable');
  }
  if (['.cmd', '.bat', '.ps1'].includes(extname(path).toLowerCase())) {
    for (const candidate of [join(dirname(path), 'node_modules/@anthropic-ai/claude-code/bin/claude.exe'), join(dirname(path), 'node_modules/@anthropic-ai/claude-code/cli.js')]) if (await fileExists(candidate)) {
      return candidate;
    }
    throw new RuntimeError('unsupported-launcher');
  }
  return path;
}
export async function resolveCandidate(input: string): Promise<ResolvedCandidate> {
  const path = await resolveCandidatePath(input),
    resolvedPath = await realpath(path),
    info = await stat(resolvedPath),
    handle = await open(resolvedPath, 'r');
  let header: Buffer;
  try {
    header = Buffer.alloc(256);
    const read = await handle.read(header, 0, header.length, 0);
    header = header.subarray(0, read.bytesRead);
  } finally {
    await handle.close();
  }
  const javascript = ['.js', '.mjs', '.cjs'].includes(extname(resolvedPath)) || /^#![^\n]*\b(?:node|bun)\b/.test(header.toString('utf8'));
  const magic = header.length >= 4 ? header.readUInt32BE(0) : 0;
  const native = [0x7f454c46, 0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic) || header.subarray(0, 2).toString() === 'MZ';
  if (!javascript && !native) {
    throw new RuntimeError('unsupported-launcher');
  }
  if (!javascript && process.platform !== 'win32') {
    try {
      await access(resolvedPath, constants.X_OK);
    } catch {
      throw new RuntimeError('not-executable');
    }
  }
  const env: Record<string, string> = {
    DISABLE_AUTOUPDATER: '1',
    DISABLE_UPDATES: '1'
  };
  if (javascript) {
    env.ELECTRON_RUN_AS_NODE = '1';
  }
  return {
    path,
    resolvedPath,
    stamp: `${resolvedPath}:${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}`,
    launch: {
      command: javascript ? process.execPath : resolvedPath,
      argsPrefix: javascript ? [resolvedPath] : [],
      env,
      path,
      kind: javascript ? 'javascript' : 'native'
    }
  };
}
