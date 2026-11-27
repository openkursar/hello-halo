import { oneLineExcerpt } from './text-truncate'

function quoteTaskTitle(title: string): string {
  return JSON.stringify(oneLineExcerpt(title, 120)).replace(/</g, '\\u003c')
}

/** No title field means there is no team task; an empty title is an unnamed task. */
export function teamTaskContextLine(title: string | undefined): string {
  if (title === undefined) return ''
  const place = title ? `Current team task: ${quoteTaskTitle(title)}.` : 'You are working in an untitled team task.'
  return `${place} Team messages, questions for the user and scheduled checks you create here are recorded under this task, so keep them about this task.`
}

export function withTeamTaskReceipt(text: string, title: string | undefined): string {
  if (title === undefined) return text
  return `${text} Recorded under ${title ? `task ${quoteTaskTitle(title)}` : 'this task'}.`
}
