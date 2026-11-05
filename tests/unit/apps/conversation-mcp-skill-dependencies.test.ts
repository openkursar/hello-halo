/**
 * The digital-human tools leave skill dependencies to the AI: they normalize
 * what it declared, install only what this space cannot load, and say what to
 * check — never adding a dependency themselves.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../src/main/services/analytics/analytics.service', () => ({
  analytics: { track: vi.fn(), trackErrorSurface: vi.fn() }
}))

import {
  createFailureHint,
  prepareCreatedSkills,
  reviewUpdatedSkills,
} from '../../../src/main/apps/conversation-mcp/skill-dependencies'
import type { LoadableSkill } from '../../../src/main/apps/skill-discovery'
import type { AutomationSpec } from '../../../src/main/apps/spec'

const storeInstall = { id: 'app-image', spaceId: null, specId: 'Image Gen', status: 'active', spec: { type: 'skill', store: { slug: 'acme/image-gen-2', install_source: 'store' } } }
const loadable = [
  { folder: 'Image_Gen', path: '/skills/Image_Gen', app: storeInstall },
  { folder: 'report-builder', path: '/skills/report-builder', app: null },
] as unknown as LoadableSkill[]

function dh(prompt: string, skills?: Array<string | { id: string; bundled?: boolean }>): AutomationSpec {
  return { type: 'automation', name: 'dh', system_prompt: prompt, requires: skills ? { skills } : undefined } as unknown as AutomationSpec
}

describe('prepareCreatedSkills', () => {
  it('rewrites a Store install to its slug and installs only what this space cannot load', () => {
    const prepared = prepareCreatedSkills(dh('run report-builder', ['image_gen', 'report-builder', 'acme/remote']), loadable)
    expect(prepared.spec.requires?.skills).toEqual(['acme/image-gen-2', 'report-builder', 'acme/remote'])
    expect(prepared.toInstall).toEqual(['acme/remote'])
    expect(prepared.undeclared).toEqual([])
  })

  it('reports a named local skill left undeclared without declaring it', () => {
    const prepared = prepareCreatedSkills(dh('first report-builder, then Image_Gen'), loadable)
    expect(prepared.spec.requires).toBeUndefined()
    expect(prepared.undeclared).toEqual(['acme/image-gen-2', 'report-builder'])
  })
})

describe('createFailureHint', () => {
  it('points at folder names only when an id names nothing the Store serves', () => {
    const listed = (id: string) => id === 'acme/remote'
    expect(createFailureHint(['acme/remote'], listed)).toBe('')
    expect(createFailureHint(['acme/remote', 'typo-skill'], listed)).toContain('folder name')
    expect(createFailureHint([{ id: 'packed', bundled: true }], listed)).toBe('')
  })
})

describe('reviewUpdatedSkills', () => {
  const base = { previousPrompt: 'use report-builder', loadable, isListed: (id: string) => id === 'acme/remote' }

  it('raises only skills the new prompt starts naming', () => {
    const review = reviewUpdatedSkills({ ...base, spec: dh('use report-builder and Image_Gen'), promptChanged: true, skillsChanged: false })
    expect(review).toEqual({ undeclared: ['acme/image-gen-2'], notInstalled: [], unknown: [] })
  })

  it('splits declared skills this space cannot load by whether the Store serves them', () => {
    const review = reviewUpdatedSkills({ ...base, spec: dh('x', ['acme/image-gen-2', 'acme/remote', 'typo-skill']), promptChanged: false, skillsChanged: true })
    expect(review).toEqual({ undeclared: [], notInstalled: ['acme/remote'], unknown: ['typo-skill'] })
  })
})
