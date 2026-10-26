/**
 * The boot splash index.html draws before the app's code runs: taking it down
 * once the first screen has rendered underneath it (or the app fails to
 * render).
 */

const FADE_MS = 150

export function dismissBootSplash(): void {
  const splash = document.getElementById('boot-splash')
  if (!splash || splash.dataset.leaving) return
  splash.dataset.leaving = 'true'
  // Clicks and window drags reach the screen underneath while it fades.
  splash.style.pointerEvents = 'none'
  splash.style.setProperty('-webkit-app-region', 'no-drag')

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    splash.remove()
    return
  }
  splash.style.transition = `opacity ${FADE_MS}ms ease-out`
  splash.style.opacity = '0'
  // A timer rather than transitionend: a hidden window may never run the transition.
  setTimeout(() => splash.remove(), FADE_MS)
}
