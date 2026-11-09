/**
 * Guards an asynchronous result against input changes.
 *
 * Call `begin()` when starting a request and apply its result only while
 * `isCurrent(token)` holds. Every input the result depends on calls
 * `invalidate()`, so a stale response cannot overwrite newer state.
 */
export interface RequestGate {
  begin(): number
  invalidate(): void
  isCurrent(token: number): boolean
}

export function createRequestGate(): RequestGate {
  let current = 0
  return {
    begin: () => ++current,
    invalidate: () => { current++ },
    isCurrent: token => token === current
  }
}
