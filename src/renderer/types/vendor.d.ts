/**
 * Minimal ambient type declarations for third-party packages that lack
 * official @types/* packages.
 */

declare module 'js-yaml' {
  export function load(input: string, options?: Record<string, unknown>): unknown
  export function dump(obj: unknown, options?: Record<string, unknown>): string
}

/** Vite default asset import — resolves to the built asset's URL. */
declare module '*.svg' {
  const src: string
  export default src
}
