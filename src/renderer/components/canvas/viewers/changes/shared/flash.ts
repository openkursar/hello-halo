const FLASH_CLASSES = ['ring-2', 'ring-primary', 'bg-primary/10']

/**
 * Marks `element` for a moment — where the user came back to. A class rather
 * than only an animation, so it still shows with reduced motion.
 */
export function flashElement(element: HTMLElement): () => void {
  element.classList.add(...FLASH_CLASSES)
  const timer = setTimeout(() => element.classList.remove(...FLASH_CLASSES), 1800)
  return () => {
    clearTimeout(timer)
    element.classList.remove(...FLASH_CLASSES)
  }
}
