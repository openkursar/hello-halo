import { join } from 'node:path';
import { userConfigDir } from '../core/conventions.js';
import type { QueryConfig } from '../types/config.js';

const directories = new Map<string, string | null>();

export function configureSessionStorage(sessionId: string, config: Pick<QueryConfig, 'env' | 'conventions'>, persist: boolean): void {
  directories.set(sessionId, persist ? userConfigDir(config.env, config.conventions) : null);
}

export function sessionStoragePath(sessionId: string, kind: 'todos' | 'goals'): string | undefined {
  const directory = directories.get(sessionId);
  return directory === null ? undefined : join(directory ?? userConfigDir(), kind, `${sessionId}.json`);
}

export function releaseSessionStorage(sessionId: string): void {
  directories.delete(sessionId);
}
