let mutations: Promise<unknown> = Promise.resolve()

/** Explicit workspace mutations are serialized so a destination cannot disappear mid-move. */
export function mutateWorkspace<T>(mutation: () => Promise<T>): Promise<T> {
  const result = mutations.then(mutation)
  mutations = result.catch(() => {})
  return result
}
