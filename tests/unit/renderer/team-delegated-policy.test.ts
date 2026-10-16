/**
 * "What others can ask it to do": the page shows what a request from another
 * computer actually gets, and changing it never takes more than the one switch
 * that was flipped.
 *
 *   - never saved, or saved granting everything → every switch on;
 *   - anything else → the strict reading (an unlisted skill or server is off);
 *   - the first change from "everything" spells everything out first, so the
 *     other switches stay on; a change that leaves everything on saves the
 *     unlisted form, so a skill installed later is lent too;
 *   - the invite screen recognises a saved policy as the answer it amounts to.
 */

import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('../../../src/renderer/i18n', () => ({
  useTranslation: () => ({
    t: (text: string, values?: Record<string, unknown>) =>
      text.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values?.[name] ?? '')),
  }),
}))
vi.mock('../../../src/renderer/stores/apps.store', () => ({
  useAppsStore: (select: (s: unknown) => unknown) => select({
    apps: [{ specId: 'not-in-this-space', spec: { type: 'mcp', name: 'Elsewhere' } }],
  }),
}))
vi.mock('../../../src/renderer/components/ui/HelpHint', () => ({ HelpHint: () => null }))

import {
  capabilityPolicyFromPreset,
  colleagueReach,
  fullCapabilityPolicy,
  grantsEverything,
} from '../../../src/shared/apps/capability-policy'
import type { LendableInventory } from '../../../src/shared/apps/capability-policy'
import type { TeamDelegatedPolicy } from '../../../src/shared/apps/team-types'
import {
  delegatedPolicyToSave,
  delegatedPolicyView,
  presetOfDelegatedPolicy,
  withPreset,
} from '../../../src/renderer/components/team/delegated-policy'
import { CapabilityPolicyFields } from '../../../src/renderer/components/capability/CapabilityPolicyFields'
import { DelegationPresetPicker } from '../../../src/renderer/components/capability/DelegationPresetPicker'

const INVENTORY: LendableInventory = { skills: ['pdf', 'xlsx'], userMcp: ['github'] }

/** Every switch on the page, by its visible label, with whether it shows on. */
function switches(saved: TeamDelegatedPolicy | null): Map<string, boolean> {
  const view = delegatedPolicyView(saved, INVENTORY)
  const html = renderToStaticMarkup(createElement(CapabilityPolicyFields, {
    policy: view.policy,
    mode: view.mode,
    audience: 'teammate',
    skills: [
      { dirName: 'pdf', name: 'PDF', description: '' },
      { dirName: 'xlsx', name: 'Spreadsheets', description: '' },
    ],
    userMcp: [{ specId: 'github', name: 'GitHub' }],
    onChange: () => {},
  }))
  const out = new Map<string, boolean>()
  const row = /<label[^>]*>(?:(?!<\/label>).)*?<span[^>]*>([^<]+)<(?:(?!<\/label>).)*?role="switch" aria-checked="(true|false)"/gs
  for (const match of html.matchAll(row)) out.set(match[1].trim(), match[2] === 'true')
  return out
}

describe('the page shows what a request from another computer gets', () => {
  it('shows everything on, skills and servers included, while nothing is saved', () => {
    const shown = switches(null)
    expect(shown.size).toBeGreaterThan(10)
    expect([...shown.values()].every(Boolean)).toBe(true)
    expect(shown.get('PDF')).toBe(true)
    expect(shown.get('GitHub')).toBe(true)
  })

  it('shows everything on for the "everything" answer, whose lists are unset', () => {
    expect([...switches(fullCapabilityPolicy()).values()].every(Boolean)).toBe(true)
  })

  it('reads anything less strictly: an unlisted skill, server or capability is off', () => {
    const shown = switches(capabilityPolicyFromPreset('read_only'))
    expect(shown.get('Read files')).toBe(true)
    expect(shown.get('Web search')).toBe(true)
    expect(shown.get('Write files')).toBe(false)
    expect(shown.get('AI Browser')).toBe(false)
    expect(shown.get('PDF')).toBe(false)
    expect(shown.get('GitHub')).toBe(false)
  })

  it('offers only the servers its own sessions get, not every installed one', () => {
    expect(switches(null).has('Elsewhere')).toBe(false)
  })

  it('names the reach of a request from another computer with the note the page passes', () => {
    const html = renderToStaticMarkup(createElement(CapabilityPolicyFields, {
      policy: undefined, mode: 'strict', audience: 'teammate', onChange: () => {}, note: 'NOTE FROM THE PAGE',
    }))
    expect(html).toContain('People on other computers can currently only chat and use memory.')
    expect(html).toContain('NOTE FROM THE PAGE')
  })

  it('leaves the IM guest screen exactly as it was', () => {
    const html = renderToStaticMarkup(createElement(CapabilityPolicyFields, {
      policy: { allowedTools: ['Read'] }, mode: 'strict', audience: 'guest', onChange: () => {},
    }))
    expect(html).toContain('Guests can currently: view files in this workspace')
    expect(html).toContain('Memory is always available and not affected by these settings. File access is limited to this workspace.')
    expect(html).toContain('Elsewhere')
  })
})

describe('changing the page', () => {
  it('spells everything out before the first change, so turning one switch off leaves the rest on', () => {
    const view = delegatedPolicyView(null, INVENTORY)
    const saved = delegatedPolicyToSave({ ...view.policy, allowEmail: false }, INVENTORY)

    expect(colleagueReach(saved, INVENTORY)).toBe('strict')
    expect(saved.allowEmail).toBe(false)
    expect(saved.allowAiBrowser).toBe(true)
    expect(saved.allowedSkills).toEqual(['pdf', 'xlsx'])
    expect(saved.allowedUserMcp).toEqual(['github'])
    expect(switches(saved).get('Email')).toBe(false)
    expect([...switches(saved)].filter(([, on]) => !on).map(([label]) => label)).toEqual(['Email'])
  })

  it('does the same from a saved "everything" answer, keeping its periodic-check answer', () => {
    const view = delegatedPolicyView({ ...fullCapabilityPolicy(), allowChecks: false }, INVENTORY)
    const saved = delegatedPolicyToSave({ ...view.policy, allowedSkills: ['xlsx'] }, INVENTORY)

    expect(saved.allowedSkills).toEqual(['xlsx'])
    expect(saved.allowedUserMcp).toEqual(['github'])
    expect(saved.allowChecks).toBe(false)
  })

  it('saves "everything" unlisted when a change leaves everything on, so later skills are lent too', () => {
    const turnedOff = delegatedPolicyToSave({ ...delegatedPolicyView(null, INVENTORY).policy, allowEmail: false }, INVENTORY)
    const turnedBackOn = delegatedPolicyToSave({ ...delegatedPolicyView(turnedOff, INVENTORY).policy, allowEmail: true }, INVENTORY)

    expect(turnedBackOn).toEqual(fullCapabilityPolicy())
    expect(grantsEverything(turnedBackOn, { skills: ['pdf', 'xlsx', 'installed-later'], userMcp: ['github'] })).toBe(true)
  })

  it('applies an invite answer without touching the periodic-check answer', () => {
    expect(withPreset({ ...fullCapabilityPolicy(), allowChecks: false }, 'read_only'))
      .toEqual({ ...capabilityPolicyFromPreset('read_only'), allowChecks: false })
    expect(withPreset(null, 'workspace')).toEqual(capabilityPolicyFromPreset('workspace'))
  })
})

describe('the invite screen recognises what is saved', () => {
  it('reads never-saved as "everything", which is what it grants', () => {
    expect(presetOfDelegatedPolicy(null)).toBe('full')
    expect(presetOfDelegatedPolicy(fullCapabilityPolicy())).toBe('full')
  })

  it('recognises each answer by what it grants, whatever else was stored with it', () => {
    expect(presetOfDelegatedPolicy(capabilityPolicyFromPreset('read_only'), INVENTORY)).toBe('read_only')
    expect(presetOfDelegatedPolicy({ ...capabilityPolicyFromPreset('workspace'), allowChecks: false }, INVENTORY)).toBe('workspace')
    // An older save that left the capability switches unstated reads the same strictly.
    expect(presetOfDelegatedPolicy({ allowedTools: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'] }, INVENTORY)).toBe('read_only')
  })

  it('names nothing for a policy that is none of the answers', () => {
    expect(presetOfDelegatedPolicy({ ...capabilityPolicyFromPreset('read_only'), allowedSkills: ['pdf'] }, INVENTORY)).toBeNull()
    // The engine's old name for the sub-agent tool does not grant it.
    expect(presetOfDelegatedPolicy({ ...fullCapabilityPolicy(), allowedTools: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'Bash', 'Write', 'Edit', 'NotebookEdit'] }, INVENTORY)).toBeNull()
  })

  it('counts an "everything" saved with lists only when they name all there is', () => {
    const listed = { ...fullCapabilityPolicy(), allowedSkills: ['pdf', 'xlsx'], allowedUserMcp: ['github'] }
    expect(presetOfDelegatedPolicy(listed, INVENTORY)).toBe('full')
    expect(presetOfDelegatedPolicy(listed, { ...INVENTORY, skills: ['pdf', 'xlsx', 'docx'] })).toBeNull()
  })

  it('shows no answer chosen, and says why, when the members differ', () => {
    const html = renderToStaticMarkup(createElement(DelegationPresetPicker, {
      value: null, onChange: () => {}, title: 'T', subtitle: 'S', notice: 'They differ',
    }))
    expect(html).not.toContain('aria-pressed="true"')
    expect(html).toContain('They differ')
  })
})
