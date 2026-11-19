/**
 * canvas_show — the AI brings one thing in front of the user: its own browser
 * page, a terminal of the space, or a file in the workspace.
 *
 * Restraint is the system's, not the model's: clients only switch the screen
 * for a person looking at this conversation who is not typing, and a target is
 * brought forward at most once per reply. The result says what happened in
 * plain words, so the AI can point the person to it when it did not pop.
 */

import { promises as fs } from 'fs'
import * as path from 'path'
import { z } from 'zod'
import { tool, createSdkMcpServer } from '../agent/resolved-sdk'
import { onAgentEvent } from '../agent/events'
import { conversationPage } from '../ai-browser'
import { peekGlobalTerminalContext } from '../ai-terminal'
import { requestCanvasShow, type CanvasShowOutcome } from './service'
import type { CanvasShowTarget } from '../../../shared/types/canvas-show'

export const CANVAS_SHOW_DESCRIPTION = 'Bring a page, terminal or file in front of the user in Halo\'s canvas.'

const TOOL_DESCRIPTION =
  'Bring something in front of the user in Halo\'s canvas: target "page" shows the current page you opened ' +
  '(borrowed pages and plain URLs are not accepted), target "terminal" shows a terminal session of this ' +
  'workspace, target "file" shows a file inside this workspace. ' +
  'Use it only when the user asked to see it, when the user must act there (sign in, solve a captcha, confirm ' +
  'something), or when the result itself is something to look at — and say in your reply why you opened it. ' +
  'It does not close, list or reorder the user\'s tabs. Halo decides whether the screen switches: never while the ' +
  'user is typing or looking at another conversation, and at most once per target in a reply. The result says what ' +
  'happened; when it was not shown, tell the user where to find it.'

export interface CanvasToolScope {
  spaceId: string
  conversationId: string
  workDir: string
}

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] })
const errorText = (value: string) => ({ content: [{ type: 'text' as const, text: value }], isError: true })

/**
 * Targets already brought forward in each conversation's current reply. The
 * record ends with the reply (it completed or failed) and with the start of
 * the next one; the listener exists only while some reply holds a record.
 */
interface ReplyShows {
  calls: number
  shown: Set<string>
  pending: Map<string, Promise<CanvasShowOutcome>>
}

const replies = new Map<string, ReplyShows>()
let replyListener: { dispose(): void } | null = null
const REPLY_BOUNDARIES = new Set(['agent:turn-start', 'agent:complete', 'agent:error'])

function forgetReply(conversationId: string, reply?: ReplyShows): void {
  if (reply && replies.get(conversationId) !== reply) return
  replies.delete(conversationId)
  if (replies.size === 0) {
    replyListener?.dispose()
    replyListener = null
  }
}

function currentReply(conversationId: string): ReplyShows {
  let reply = replies.get(conversationId)
  if (!reply) {
    reply = { calls: 0, shown: new Set(), pending: new Map() }
    replies.set(conversationId, reply)
    replyListener ??= onAgentEvent(event => {
      if (REPLY_BOUNDARIES.has(event.channel) && !event.relayed) forgetReply(event.conversationId)
    })
  }
  return reply
}

function targetKey(target: CanvasShowTarget): string {
  if (target.kind === 'page') return `page:${target.viewId}`
  if (target.kind === 'terminal') return `terminal:${target.sessionId}`
  return `file:${target.path}`
}

function describe(target: CanvasShowTarget): string {
  if (target.kind === 'page') return `the page "${target.title || target.url || 'untitled'}"`
  if (target.kind === 'terminal') return `the terminal "${target.title}"`
  return `the file ${target.path}`
}

function report(target: CanvasShowTarget, outcome: CanvasShowOutcome, alreadyShown: boolean): string {
  const what = describe(target)
  if (alreadyShown) {
    const current = outcome === 'shown' ? ` ${what} is still visible.`
      : outcome === 'added' ? ` Its tab is in the user's canvas.` : ' No client confirmed that its tab is still available.'
    return `Already brought forward earlier in this reply, so it was not switched to again.${current}`
  }
  if (outcome === 'shown') return `Shown: the user now sees ${what} in the canvas.`
  if (outcome === 'opened') return `Opened ${what}'s tab, but could not confirm the content was visible. Do not assume the user saw it.`
  if (outcome === 'added') return `Added, not switched: ${what} is a tab in the user's canvas, but no client confirmed it was visible. Tell the user where to find it if they need it.`
  if (outcome === 'unavailable') return `Not added or shown: no client could keep a tab for ${what}. Point the user to it another way.`
  return 'No Halo screen confirmed that anything was shown. Reach the user another way, for example say in your reply where to find it.'
}

/** A file inside the workspace (symlinks resolved), or why it cannot be shown. */
async function workspaceFile(workDir: string, input: string): Promise<{ path: string } | { error: string }> {
  const candidate = path.isAbsolute(input) ? path.normalize(input) : path.resolve(workDir, input)
  let real: string
  let root: string
  try {
    ;[real, root] = await Promise.all([fs.realpath(candidate), fs.realpath(workDir)])
  } catch {
    return { error: `No such file: ${input}` }
  }
  const relative = path.relative(root, real)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return { error: 'Only files inside this workspace can be shown.' }
  }
  const stat = await fs.stat(real).catch(() => null)
  if (!stat?.isFile()) return { error: `Not a file: ${input}` }
  // Loaded on demand: the tool is built with every session, a file is shown rarely.
  const { detectFileType } = await import('../artifact.service')
  if (!detectFileType(real).canViewInCanvas) return { error: `Halo cannot display this kind of file in the canvas: ${input}` }
  return { path: real }
}

async function resolveTarget(
  scope: CanvasToolScope,
  args: { target: 'page' | 'terminal' | 'file'; session?: string; path?: string },
): Promise<CanvasShowTarget | { error: string }> {
  if (args.target === 'page') {
    const page = conversationPage(scope.conversationId)
    if (!page) return { error: 'There is no browser page to show. Open it with your browser tools first.' }
    if (!page.owned || page.spaceId !== scope.spaceId) return { error: 'The current page was not opened by this conversation in this workspace. Open your own page with your browser tools first.' }
    return { kind: 'page', viewId: page.viewId, url: page.url, title: page.title }
  }
  if (args.target === 'terminal') {
    if (!args.session) return { error: 'Give the terminal session id in "session".' }
    const terminals = peekGlobalTerminalContext()
    const session = terminals?.get(args.session)
    if (!terminals || !session || session.info.spaceId !== scope.spaceId) return { error: `No such terminal session: ${args.session}` }
    if (session.info.state !== 'running') return { error: `The terminal session ${args.session} has ended.` }
    // Bringing it forward is the AI's work in it too: from now on it is one of the AI's tabs.
    terminals.markAiTouched(session.id)
    return { kind: 'terminal', sessionId: session.id, title: session.info.title }
  }
  if (!args.path) return { error: 'Give the file in "path".' }
  const file = await workspaceFile(scope.workDir, args.path)
  return 'error' in file ? file : { kind: 'file', path: file.path }
}

export function createCanvasMcpServer(scope: CanvasToolScope) {
  const showTool = tool(
    'canvas_show',
    TOOL_DESCRIPTION,
    {
      target: z.enum(['page', 'terminal', 'file']).describe('What to show: your browser page, a terminal, or a file'),
      session: z.string().optional().describe('target "terminal": the terminal session id'),
      path: z.string().optional().describe('target "file": the file path, absolute or relative to the workspace'),
    },
    async (args: { target: 'page' | 'terminal' | 'file'; session?: string; path?: string }) => {
      const { spaceId, conversationId } = scope
      const reply = currentReply(conversationId)
      reply.calls++
      try {
        const target = await resolveTarget(scope, args)
        if ('error' in target) return errorText(target.error)
        if (replies.get(conversationId) !== reply) return errorText('This reply ended before the target could be shown.')

        const key = targetKey(target)
        const inFlight = reply.pending.get(key)
        if (inFlight) {
          const outcome = await inFlight
          return text(report(target, outcome, outcome === 'shown' || outcome === 'opened'))
        }
        const alreadyShown = reply.shown.has(key)
        const pending = requestCanvasShow({ spaceId, conversationId, target, bringForward: !alreadyShown })
        reply.pending.set(key, pending)
        try {
          const outcome = await pending
          if (!alreadyShown && (outcome === 'shown' || outcome === 'opened')) reply.shown.add(key)
          return text(report(target, outcome, alreadyShown))
        } finally {
          reply.pending.delete(key)
        }
      } finally {
        if (--reply.calls === 0 && reply.shown.size === 0) forgetReply(conversationId, reply)
      }
    },
  )

  return createSdkMcpServer({
    name: 'canvas',
    version: '1.0.0',
    description: CANVAS_SHOW_DESCRIPTION,
    tools: [showTool],
  })
}
