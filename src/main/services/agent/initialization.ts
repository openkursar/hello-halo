let initialization: Promise<void> | null = null

/** All entry points share bootstrap's one engine choice, including early desktop requests. */
export function initializeSdkOnce(initialize: () => Promise<void>): Promise<void> {
  initialization ??= Promise.resolve().then(initialize)
  return initialization
}

export function getSdkInitialization(): Promise<void> | null { return initialization }

export async function waitForSdkInitialization(): Promise<void> { await initialization }
