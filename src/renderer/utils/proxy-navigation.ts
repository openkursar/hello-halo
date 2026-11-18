/**
 * Opens Settings on the proxy block. The app store loads on demand: this is
 * reached from a click, so the surfaces that offer it never pull the store in
 * when they render.
 */
export async function openProxySettings(): Promise<void> {
  const { useAppStore } = await import('../stores/app.store')
  useAppStore.getState().openProxySettings()
}
