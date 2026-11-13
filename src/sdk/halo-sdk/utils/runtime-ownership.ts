import { transcriptLocks } from './locks.js';

interface Reservation { owner: string; closing(): boolean }
const owners = new Map<string, Reservation>();

export function reserveTranscript(owner: string, path: string, sessionId: string, closing: () => boolean): { keys: string[]; release(): void } {
  const normalized = process.platform === 'win32' || process.platform === 'darwin' ? path.toLowerCase() : path;
  const keys = [`session:${sessionId}`, `path:${normalized}`];
  for (const key of keys) {
    const previous = owners.get(key);
    if (previous && !previous.closing()) throw new Error('Transcript is already owned by another live session');
  }
  for (const key of keys) owners.set(key, { owner, closing });
  return { keys, release() { for (const key of keys) if (owners.get(key)?.owner === owner) owners.delete(key); } };
}

export async function acquireRuntimeTranscript(owner: string, path: string, sessionId: string, closing: () => boolean, signal: AbortSignal): Promise<() => void> {
  const reservation = reserveTranscript(owner, path, sessionId, closing);
  const releases: Array<() => void> = [];
  const release = () => { reservation.release(); for (const unlock of releases.splice(0).reverse()) unlock(); };
  try {
    for (const key of reservation.keys) { releases.push(await transcriptLocks.acquire(key, owner, signal)); signal.throwIfAborted(); }
    return release;
  } catch (error) { release(); throw error; }
}
