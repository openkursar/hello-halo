import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { tool } from '../../services/agent/resolved-sdk'
import { getSkillLibrary } from '../skills'
import { validateAppSpec } from '../spec'
import { installFromStore } from '../../store'
import type { SkillRef } from '../../../shared/types/skills'

const MAX_OUTPUT = 24 * 1024

function result(value: unknown, isError = false) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return { content: [{ type: 'text' as const, text: text.length <= MAX_OUTPUT ? text : `${text.slice(0, MAX_OUTPUT)}\n[Output truncated; narrow the search or read a smaller content window.]` }], ...(isError ? { isError: true } : {}) }
}

export function createSkillManagementTool(spaceId: string) {
  return tool('skill_manage',
    'Manage skills using the same library as the user interface. list searches the current space and global skills and returns opaque refs; read returns current instructions and a revision. ' +
    'install copies a manual spec or installs a store slug. enable/disable retain files and affect new Halo SDK conversations. move changes one copy’s scope; preview the move first. ' +
    'save edits instructions with the revision from read. delete (uninstall is an alias) requires a prior read revision and moves the selected skill and its companion files to the host computer’s OS trash. ' +
    'Before deletion, replacement or moving, explain the exact copy, shared scope and file impact and obtain the user’s authorization. Never treat a tool call as authorization. ' +
    'Use list/read references, never arbitrary paths. list defaults to current-space and global skills; scope=global lists only globally shared skills, not every workspace. Other actions default to current space. ' +
    'Other engines may not honor availability controls. No action grants extra file or tool permissions.',
    {
      action: z.enum(['list', 'read', 'install', 'enable', 'disable', 'move', 'save', 'delete', 'uninstall']).describe('Action to perform'),
      slug: z.string().max(512).optional().describe('Store slug for install'),
      spec: z.string().max(14 * 1024 * 1024).optional().describe('JSON SkillSpec for manual import'),
      skill_id: z.string().max(132).optional().describe('Opaque file:/app: ID from list, or legacy installed app UUID'),
      ref: z.object({ id: z.string().max(132), spaceId: z.string().max(128).nullable() }).strict().optional().describe('Opaque reference returned by list'),
      scope: z.enum(['global', 'space']).optional().describe('Source or install scope; default current space'),
      target_scope: z.enum(['global', 'space']).optional().describe('Destination scope for move'),
      preview: z.boolean().optional().describe('For move, default true; false performs the authorized move'),
      revision: z.string().max(512).optional().describe('Revision returned by read; required for save, move and delete/uninstall. Preserve the "missing" sentinel when read returns it.'),
      content: z.string().max(1024 * 1024).optional().describe('New instruction text for save'),
      q: z.string().max(512).optional().describe('Name or description search'),
      offset: z.number().int().min(0).optional().describe('List pagination offset, or read text character offset'),
      limit: z.number().int().min(1).max(100).optional().describe('Maximum list groups, default 20'),
    },
    async args => {
      try {
        const library = getSkillLibrary()
        const selectedSpace = args.scope === 'global' ? null : spaceId
        if (args.action === 'list') {
          const inventory = library.list({ spaceId: selectedSpace, q: args.q, offset: args.offset, limit: args.limit ?? 20 })
          return result({ ...inventory, groups: inventory.groups.map(group => ({ ...group, copies: group.copies.map(copy => ({ ...copy, ref: { id: copy.id, spaceId: copy.spaceId } })) })) })
        }
        if (args.action === 'install') {
          if (args.slug) return result({ appId: await installFromStore(args.slug, selectedSpace), scope: selectedSpace })
          if (!args.spec) throw new Error('Install requires slug or spec.')
          const parsed = JSON.parse(args.spec)
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Spec must be a JSON object.')
          const spec = validateAppSpec({ ...parsed, type: 'skill', version: parsed.version || '1.0', author: parsed.author || 'User' })
          if (spec.type !== 'skill') throw new Error('Only skills can be imported.')
          return result(await library.import({ spaceId: selectedSpace, spec, requestId: randomUUID() }))
        }
        const id = args.ref?.id ?? (args.skill_id?.includes(':') ? args.skill_id : args.skill_id ? `app:${args.skill_id}` : undefined)
        if (!id) throw new Error('Use list to obtain a skill reference first.')
        const ref: SkillRef = args.ref ?? { id, spaceId: selectedSpace }
        if (ref.spaceId !== null && ref.spaceId !== spaceId) throw new Error('Only skills in the current space or global scope can be managed here.')
        if (args.action === 'read') {
          const detail = library.read(ref)
          const offset = args.offset ?? 0
          return result({ copy: detail.copy, ref, revision: detail.revision, content: detail.content.slice(offset, offset + 12000), offset,
            nextOffset: offset + 12000 < detail.content.length ? offset + 12000 : null,
            files: detail.files.slice(0, 50), filesTruncated: detail.files.length > 50 })
        }
        if (args.action === 'enable' || args.action === 'disable') return result(library.setEnabled({ ref, enabled: args.action === 'enable' }))
        if (args.action === 'move') {
          if (!args.target_scope) throw new Error('Move requires target_scope.')
          const targetSpace = args.target_scope === 'global' ? null : spaceId
          if (args.preview !== false) return result(library.movePreview({ ref, spaceId: targetSpace }))
          if (!args.revision) throw new Error('Read the skill first and provide its revision.')
          return result(library.move({ ref, spaceId: targetSpace, revision: args.revision }))
        }
        if (!args.revision) throw new Error('Read the skill first and provide its revision.')
        if (args.action === 'save') {
          if (args.content === undefined) throw new Error('Save requires content.')
          const saved = library.save({ ref, revision: args.revision, content: args.content })
          return result({ copy: saved.copy, revision: saved.revision })
        }
        await library.delete({ ref, revision: args.revision })
        return result('The selected skill was removed. Any remaining skill files were moved to the host computer’s OS trash; files already missing needed no trash operation. Already running conversations may retain previously loaded instructions.')
      } catch (error) {
        console.warn('[Skills] Skill management tool failed', { action: args.action, reason: (error as Error).message })
        return result(`Error: ${(error as Error).message}`, true)
      }
    })
}
