/**
 * services/code-review — the review buttons of the changes view.
 *
 * Starts an AI review of a repository's changes as an ordinary conversation
 * of the space, created in the background, and remembers the latest review of
 * each repository. Reaches git, the conversation store and the agent engine
 * only through their public surfaces; knows nothing about the renderer.
 *
 * Does NOT parse or score what the review found: the report is the review
 * conversation's last reply, shown as written.
 */

export { startReview, getReviewAvailability } from './start-review'
export { getLatestReview } from './review-store'
