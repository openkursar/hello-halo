/**
 * Pure decision for the StreamingBubble text-block version counter.
 *
 * StreamingBubble resets its snapshot/scroll state on every `textBlockVersion`
 * change, so bumping it is only meaningful when there is already streamed content
 * to snapshot away from. A flood of empty new-text-block signals with no streamed
 * content (e.g. a malformed/duplicated relay stream) would otherwise bump the
 * version on every event and drive that reset effect into an unbounded React
 * update cycle ("Maximum update depth exceeded").
 *
 * Kept as a pure, dependency-free function so this rule is unit-testable without
 * a React/zustand harness.
 */
export function nextTextBlockVersion(
  current: number,
  isNewTextBlock: boolean | undefined,
  prevContentLength: number
): number {
  const meaningful = !!isNewTextBlock && prevContentLength > 0
  return meaningful ? current + 1 : current
}
