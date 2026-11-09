import { join } from 'node:path';
import { BackgroundTaskRegistry } from '../tools/bash/index.js';
import { userConfigDir } from './conventions.js';
import { getLogger } from '../utils/logger.js';
import type { Options, QueryConfig } from '../types/config.js';
import type { ToolServices } from '../types/tool.js';

const log = getLogger('BackgroundTasks');
const MAX_NOTICES = 256;

/** Shell processes are session-owned independently of collaboration members. */
export interface SessionBackgroundTasks {
  readonly activeCount: number;
  services: ToolServices;
  drainNotices(): string[];
  dispose(): void;
  flush(): Promise<void>;
  stopTask(id: string): boolean;
  stopAll(): void;
}

const borrowedTasks = new WeakMap<Options, SessionBackgroundTasks>();

export function bindBackgroundTasks(options: Options, tasks: SessionBackgroundTasks): void {
  borrowedTasks.set(options, tasks);
}

export function borrowBackgroundTasks(options: Options): SessionBackgroundTasks | undefined {
  const owner = borrowedTasks.get(options);
  if (!owner) return undefined;
  return {
    get activeCount() { return owner.activeCount; },
    services: owner.services,
    drainNotices: () => owner.drainNotices(),
    dispose() {},
    flush: () => owner.flush(),
    stopTask: id => owner.stopTask(id),
    stopAll: () => owner.stopAll(),
  };
}

export function createSessionBackgroundTasks(options: {
  config: QueryConfig | (() => QueryConfig);
  sessionId: string;
  persistSession?: boolean;
}): SessionBackgroundTasks {
  const config = options.config;
  const getConfig = typeof config === 'function' ? config : () => config;
  let notices: string[] = [];
  let disposed = false;
  const backgroundTasks = new BackgroundTaskRegistry({
    outputDir: options.persistSession === false ? undefined : () => {
      const current = getConfig();
      return join(userConfigDir(current.env, current.conventions), 'bash-output');
    },
    onNotice: notice => {
      if (disposed) return;
      if (notices.length === MAX_NOTICES) {
        notices.shift();
        log.warn('oldest shell notice evicted from full session queue', { sessionId: options.sessionId, limit: MAX_NOTICES });
      }
      notices.push(notice.slice(0, 4096));
    },
  });
  return {
    get activeCount() { return backgroundTasks.activeCount; },
    services: { backgroundTasks },
    drainNotices() { const result = notices; notices = []; return result; },
    dispose() { disposed = true; backgroundTasks.dispose(); notices = []; },
    flush: () => backgroundTasks.flush(),
    stopTask: id => backgroundTasks.stop(id),
    stopAll: () => backgroundTasks.stopAll(),
  };
}
