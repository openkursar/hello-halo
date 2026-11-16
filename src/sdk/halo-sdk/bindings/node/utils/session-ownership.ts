let acquire: ((owner: { path: string; sessionId: string }, signal: AbortSignal) => Promise<() => void>) | undefined;

/** Runtimes hold transcript ownership through preparation, execution and final flush. */
export function setSessionOwnershipCoordinator(coordinator: NonNullable<typeof acquire>): void { acquire = coordinator; }

export async function acquireSessionOwnership(path: string, signal: AbortSignal, sessionId: string): Promise<() => void> {
  return acquire ? acquire({ path, sessionId }, signal) : () => {};
}

export function getSessionOwnershipCoordinator(): typeof acquire { return acquire; }
