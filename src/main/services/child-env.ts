/**
 * Editing the environment Halo hands a child process.
 *
 * Windows variable names ignore case, but a copy of `process.env` is a plain
 * object that keeps the inherited spelling, usually `Path`: `env.PATH` reads
 * nothing there, and assigning it adds a second key. Node's spawn then passes
 * only the first spelling in sort order (`PATH` before `Path`), whatever it
 * holds. On macOS and Linux names are case-sensitive and only `PATH` is PATH.
 */

/**
 * Set a child environment's PATH to `update(current)`. On Windows `current` is
 * read from the spelling Node would pass on, and only that spelling remains.
 */
export function updateEnvPath(
  env: Record<string, string | number | undefined>,
  update: (current: string | undefined) => string
): void {
  const [key = 'PATH', ...shadowed] = process.platform === 'win32'
    ? Object.keys(env).filter(name => name.toUpperCase() === 'PATH').sort()
    : ['PATH']
  const current = env[key]
  for (const name of shadowed) delete env[name]
  env[key] = update(typeof current === 'string' ? current : undefined)
}
