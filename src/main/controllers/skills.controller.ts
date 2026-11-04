import { z } from 'zod'
import { getSkillLibrary } from '../apps/skills'
import { AppSpecValidationError, validateAppSpec } from '../apps/spec'

const spaceIdSchema = z.string().min(1).max(128).refine(value => value.trim().length > 0).nullable()
const appIdSchema = z.string().uuid()
const skillIdSchema = z.union([
  z.string().regex(/^file:[a-f0-9]{64}$/),
  z.string().max(40).refine(value => value.startsWith('app:') && appIdSchema.safeParse(value.slice(4)).success),
])
const refSchema = z.object({ id: skillIdSchema, spaceId: spaceIdSchema }).strict()
const revisionSchema = z.string().min(1).max(512).refine(value => value.trim().length > 0)
const nameSchema = z.string().min(1).max(128).refine(value => value.trim().length > 0)
const contentSchema = z.string().max(1024 * 1024).refine(value => Buffer.byteLength(value, 'utf8') <= 1024 * 1024)

const listSchema = z.object({
  spaceId: spaceIdSchema,
  q: z.string().max(1024).optional(),
  source: z.enum(['all', 'mine', 'digital-human', 'builtin']).optional(),
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict()
const saveSchema = z.object({ ref: refSchema, content: contentSchema, revision: revisionSchema }).strict()
const importSchema = z.object({
  spaceId: spaceIdSchema,
  spec: z.record(z.unknown()),
  requestId: z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/),
  replace: z.object({ ref: refSchema, revision: revisionSchema }).strict().optional(),
}).strict()
const enabledSchema = z.object({ ref: refSchema, enabled: z.boolean() }).strict()
const movePreviewSchema = z.object({ ref: refSchema, spaceId: spaceIdSchema }).strict()
const moveSchema = movePreviewSchema.extend({ revision: revisionSchema })
const copySchema = z.object({
  ref: refSchema,
  spaceId: spaceIdSchema,
  name: nameSchema,
  content: contentSchema.optional(),
}).strict()
const deleteSchema = z.object({ ref: refSchema, revision: revisionSchema }).strict()
const restoreLegacySchema = z.object({ appId: appIdSchema, spaceId: spaceIdSchema, name: nameSchema.optional() }).strict()
const deleteLegacySchema = z.object({ appId: appIdSchema }).strict()

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input)
  if (result.success) return result.data
  // Zod errors can include submitted values; transport logs must not retain skill content.
  const field = result.error.issues[0]?.path.join('.')
  throw new Error(field ? `Invalid skill request field: ${field}` : 'Invalid skill request.')
}

export function listSkills(input: unknown) {
  const query = parseInput(listSchema, input)
  return getSkillLibrary().list(query)
}

export function readSkill(input: unknown) {
  const ref = parseInput(refSchema, input)
  return getSkillLibrary().read(ref)
}

export function saveSkill(input: unknown) {
  const request = parseInput(saveSchema, input)
  return getSkillLibrary().save(request)
}

export function importSkill(input: unknown) {
  const request = parseInput(importSchema, input)
  let spec
  try {
    spec = validateAppSpec(request.spec)
  } catch (error) {
    if (error instanceof AppSpecValidationError) throw new Error(error.message)
    throw error
  }
  if (spec.type !== 'skill') throw new Error('Only a skill can be imported here.')
  return getSkillLibrary().import({ ...request, spec })
}

export function setSkillEnabled(input: unknown) {
  const request = parseInput(enabledSchema, input)
  return getSkillLibrary().setEnabled(request)
}

export function previewSkillMove(input: unknown) {
  const request = parseInput(movePreviewSchema, input)
  return getSkillLibrary().movePreview(request)
}

export function moveSkill(input: unknown) {
  const request = parseInput(moveSchema, input)
  return getSkillLibrary().move(request)
}

export function copySkill(input: unknown) {
  const request = parseInput(copySchema, input)
  return getSkillLibrary().copy(request)
}

export function deleteSkill(input: unknown) {
  const request = parseInput(deleteSchema, input)
  return getSkillLibrary().delete(request)
}

export function openSkillFolder(input: unknown) {
  const ref = parseInput(refSchema, input)
  return getSkillLibrary().openFolder(ref)
}

export function exportSkill(input: unknown) {
  const ref = parseInput(refSchema, input)
  return getSkillLibrary().export(ref)
}

export function restoreLegacySkill(input: unknown) {
  const request = parseInput(restoreLegacySchema, input)
  return getSkillLibrary().restoreLegacy(request)
}

export function deleteLegacySkill(input: unknown) {
  const request = parseInput(deleteLegacySchema, input)
  return getSkillLibrary().deleteLegacy(request)
}
