/** Line count of `text` without allocating a line array (same result as `split('\n').length`). */
export function countLines(text: string): number {
  let count = 1
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) count++
  return count
}
