/**
 * What the person opened in a reply's work stays open when the running reply
 * is replaced by its saved form, and a new turn starts as first drawn.
 */

import { describe, expect, it } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { LIVE_WORK, TranscriptWorkView, WorkViewMemory, WorkViewMemoryProvider, WorkViewScope, useRememberedOpen, useWorkOpen } from '../../../src/renderer/components/chat/work-history/view-memory'

describe('work view memory', () => {
  it('moves what was opened in the running reply to the reply it was saved as', () => {
    const memory = new WorkViewMemory()
    const live = memory.view(LIVE_WORK)
    live.open = true
    live.steps.set('group:t1', true)
    memory.settle('reply-2')
    expect(memory.view('reply-2')).toBe(live)
    expect(memory.isOpen('reply-2')).toBe(true)
    expect(memory.view(LIVE_WORK)).not.toBe(live)
  })

  it('leaves a saved reply as first drawn when nothing was chosen while it ran', () => {
    const memory = new WorkViewMemory()
    memory.view(LIVE_WORK)
    memory.settle('reply-2')
    expect(memory.isOpen('reply-2')).toBe(false)
  })

  it('lets only the reply that just finished open stand in with its streamed steps, until the next turn', () => {
    const memory = new WorkViewMemory()
    memory.view(LIVE_WORK).open = true
    memory.settle('reply-2')
    expect(memory.carriedOpen('reply-2')).toBe(true)
    expect(memory.carriedOpen('reply-1')).toBe(false)
    memory.view('reply-2').open = false
    expect(memory.carriedOpen('reply-2')).toBe(false)
    memory.view('reply-2').open = true
    memory.startTurn()
    expect(memory.carriedOpen('reply-2')).toBe(false)
  })

  it('has nothing to stand in for a reply finished folded', () => {
    const memory = new WorkViewMemory()
    memory.view(LIVE_WORK).steps.set('t1', true)
    memory.settle('reply-2')
    expect(memory.carriedOpen('reply-2')).toBe(false)
  })

  it('starts a new turn folded', () => {
    const memory = new WorkViewMemory()
    memory.view(LIVE_WORK).open = true
    memory.startTurn()
    expect(memory.isOpen(LIVE_WORK)).toBe(false)
  })
})

describe('a transcript following its turns', () => {
  it('hands the running reply’s view to the saved reply once it appears', () => {
    const follower = new TranscriptWorkView(false, 'r1')
    follower.observe(true, 'r1').view(LIVE_WORK).open = true
    // The turn ended; its reply is not read yet (a team chat reloads after the turn).
    expect(follower.observe(false, 'r1').isOpen('r1')).toBe(false)
    expect(follower.observe(false, 'r2').isOpen('r2')).toBe(true)
  })

  it('moves nothing when a turn saved no reply', () => {
    const follower = new TranscriptWorkView(false, 'r1')
    follower.observe(true, 'r1').view(LIVE_WORK).open = true
    const memory = follower.observe(false, 'r1')
    expect(memory.isOpen('r1')).toBe(false)
    // The next turn starts folded, and its own reply takes only its own view.
    follower.observe(true, 'r1')
    expect(memory.isOpen(LIVE_WORK)).toBe(false)
    follower.observe(false, 'r3')
    expect(memory.isOpen('r3')).toBe(false)
  })

  it('treats a transcript opened mid-turn as that turn', () => {
    const follower = new TranscriptWorkView(true, 'r1')
    follower.observe(true, 'r1').view(LIVE_WORK).open = true
    expect(follower.observe(false, 'r2').isOpen('r2')).toBe(true)
  })
})

describe('remembered open state', () => {
  function Step({ id }: { id: string }) {
    const [open] = useRememberedOpen(id, false)
    return createElement('i', null, open ? `${id}:open` : `${id}:closed`)
  }
  function Work({ view, children }: { view: { open?: boolean; steps: Map<string, boolean> } | null; children?: ReactNode }) {
    const [open] = useWorkOpen(view, false)
    return createElement('b', null, open ? 'work:open' : 'work:closed', children)
  }

  it('reads what the person last chose for the work and each step', () => {
    const memory = new WorkViewMemory()
    const view = memory.view('reply-1')
    view.open = true
    view.steps.set('t2', true)
    const steps = createElement(Work, { view, children: [createElement(Step, { key: 't1', id: 't1' }), createElement(Step, { key: 't2', id: 't2' })] })
    const html = renderToStaticMarkup(createElement(WorkViewMemoryProvider, { memory, children: createElement(WorkViewScope, { view, children: steps }) }))
    expect(html).toContain('work:open')
    expect(html).toContain('t1:closed')
    expect(html).toContain('t2:open')
  })

  it('falls back to the default outside a transcript', () => {
    expect(renderToStaticMarkup(createElement(Work, { view: null }))).toContain('work:closed')
  })
})
