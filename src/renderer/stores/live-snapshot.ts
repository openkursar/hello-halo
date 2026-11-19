import { isElectron, onWsAuthenticated } from '../api/transport'

/** Merge the snapshot with live changes delivered while the read was in flight. */
export function followLiveSnapshot<Snapshot, Key>(
  read: () => Promise<Snapshot>,
  apply: (snapshot: Snapshot, changed: ReadonlySet<Key>) => void,
  label: string,
) {
  let pending: Set<Key> | undefined
  const refresh = (isCurrent: () => boolean) => {
    const changed = new Set<Key>()
    pending = changed
    void read().then(snapshot => {
      if (pending === changed && isCurrent()) apply(snapshot, changed)
    }).catch(error => {
      console.warn(`[${label}] Could not reconcile the live snapshot`, error)
    }).finally(() => {
      if (pending === changed) pending = undefined
    })
  }
  const unsubscribe = isElectron() ? undefined : onWsAuthenticated(refresh)
  if (!unsubscribe) refresh(() => true)
  return {
    changed(key: Key) { pending?.add(key) },
    dispose() {
      pending = undefined
      unsubscribe?.()
    },
  }
}
