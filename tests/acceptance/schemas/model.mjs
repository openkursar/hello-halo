import { z } from 'zod'

export const textSchema = z.union([z.string().min(1), z.object({ en: z.string().min(1), zh: z.string().min(1).optional() }).strict()])
const id = z.string().regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/)
const texts = z.array(textSchema)
export const platformSchema = z.enum(['darwin', 'win32', 'linux'])
export const evidenceSchema = z.enum(['ui', 'app-e2e', 'integration', 'live-model', 'external', 'manual'])
export const modeSchema = z.enum(['none', 'scripted', 'live'])
const dimensions = z.record(id, z.array(z.string().min(1)).min(1)).default({})

export const scenarioSchema = z.object({
  id, title: textSchema, verifies: z.array(id).min(1),
  platforms: z.array(platformSchema).min(1),
  profiles: z.array(z.enum(['fast', 'regression', 'live', 'external'])).min(1),
  evidence: evidenceSchema, mode: modeSchema,
  automation: z.enum(['automated', 'planned', 'manual']),
  variants: dimensions,
  requirements: z.array(z.string().min(1)).default([]),
  reason: textSchema.optional(), notes: textSchema.optional(),
  preconditions: texts.optional(), steps: texts.optional(), expected: texts.optional(),
}).strict().superRefine((value, context) => {
  if (value.automation === 'manual' && !value.reason) context.addIssue({ code: 'custom', path: ['reason'], message: 'Manual scenarios require a reason' })
  if (value.evidence === 'live-model' && value.mode !== 'live') context.addIssue({ code: 'custom', path: ['mode'], message: 'Live-model evidence requires live execution mode' })
  if ((value.mode === 'live' || value.evidence === 'live-model') && !value.profiles.some(profile => profile === 'live' || profile === 'external')) context.addIssue({ code: 'custom', path: ['profiles'], message: 'Live model scenarios require a live or external profile' })
})

export const moduleSchema = z.object({
  version: z.literal(1), id, title: textSchema, description: textSchema,
  paths: z.array(z.string().min(1)).min(1), dependsOn: z.array(id).default([]), scope: textSchema,
}).strict()

const storyShape = {
  version: z.literal(1), id, title: textSchema,
  promises: z.record(id, textSchema),
  scenarios: z.array(scenarioSchema),
}
export const contractSchema = z.object(storyShape).strict().refine(value => Object.keys(value.promises).length > 0, 'At least one product promise is required')
export const storySchema = z.object({
  ...storyShape, module: id, story: textSchema,
  basis: z.enum(['documented', 'observed', 'proposed']),
  references: z.array(z.string().min(1)).default([]),
  uses: z.array(z.object({ contract: id, scenarios: z.array(id).min(1) }).strict()).default([]),
  overrides: z.array(scenarioSchema).default([]), questions: texts.default([]),
}).strict()

export const bindingSchema = z.object({
  caseId: id, evidence: evidenceSchema, mode: modeSchema,
  variant: z.record(z.string(), z.string()).default({}),
}).strict()

export const approvalSchema = z.object({
  version: z.literal(1), storyId: id, semanticHash: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(['approved', 'rejected']), reviewer: z.string().min(1),
  decidedAt: z.string().datetime(), note: z.string().optional(),
}).strict()

export function text(value, locale = 'en') {
  if (typeof value === 'string') return value
  return value?.[locale] ?? value?.en ?? ''
}
