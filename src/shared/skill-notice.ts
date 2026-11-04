import type { SkillNotice } from './types/skills'

/** Generic stored wording only: skill names and paths never cross a caller boundary. */
export const SKILL_NOTICE_TEXT: Record<SkillNotice, string> = {
  'catalog-unavailable': 'Skills are temporarily unavailable. You can keep chatting; start a new conversation to try skills again.',
  'engine-unsupported': 'Some Halo skills may be unavailable with this engine. Switch to Halo SDK to use them.',
  'skill-unsupported': 'This skill may be unavailable with this engine. Switch to Halo SDK to use it.',
}

export function readSkillNotice(frame: { type?: unknown; subtype?: unknown; skillNotice?: unknown }): SkillNotice | undefined {
  if (frame.type !== 'system' || frame.subtype !== 'skill_notice') return undefined
  const code = frame.skillNotice
  return code === 'catalog-unavailable' || code === 'engine-unsupported' || code === 'skill-unsupported' ? code : undefined
}
