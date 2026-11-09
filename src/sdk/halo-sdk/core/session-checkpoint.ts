import type { SDKSession } from './session.js';
import type { Options } from '../types/config.js';
import type { Message } from '../types/provider.js';
import type { FileReadState } from '../types/tool.js';
import type { SessionCostSnapshot } from '../commands/index.js';
import type { SessionToolSnapshot } from '../tools/session-state.js';

export interface SessionCheckpoint {
  sessionId: string;
  cwd: string;
  /** Absent when the settled transcript is the durable history owner. */
  messages?: Message[];
  reads: Map<string, FileReadState>;
  costs: SessionCostSnapshot;
  tools: SessionToolSnapshot;
}

const captures = new WeakMap<SDKSession, { capture(): SessionCheckpoint; history(): readonly Message[] }>();
const resumptions = new WeakMap<Options, SessionCheckpoint>();

export function registerSessionCheckpoint(session: SDKSession, capture: { capture(): SessionCheckpoint; history(): readonly Message[] }): void {
  captures.set(session, capture);
}

export function captureSessionCheckpoint(session: SDKSession): SessionCheckpoint {
  const capture = captures.get(session);
  if (!capture) throw new Error('A local SDK session is required for checkpoint capture.');
  return capture.capture();
}

export function readSessionHistory(session: SDKSession): readonly Message[] {
  const capture = captures.get(session);
  if (!capture) throw new Error('A local SDK session is required for history reading.');
  return capture.history();
}

export function bindSessionCheckpoint(options: Options, checkpoint: SessionCheckpoint): void {
  resumptions.set(options, checkpoint);
}

export function takeSessionCheckpoint(options: Options): SessionCheckpoint | undefined {
  const checkpoint = resumptions.get(options);
  resumptions.delete(options);
  return checkpoint;
}
