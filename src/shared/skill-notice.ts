import type { SkillNotice } from './types/skills'

/** Generic stored wording only: skill names and paths never cross a caller boundary. */
export const SKILL_NOTICE_TEXT: Record<SkillNotice, string> = {
  'catalog-unavailable': 'Skills are temporarily unavailable. You can keep chatting; start a new conversation to try skills again.',
}

export function readSkillNotice(frame: { type?: unknown; subtype?: unknown; skillNotice?: unknown }): SkillNotice | undefined {
  if (frame.type !== 'system' || frame.subtype !== 'skill_notice') return undefined
  return frame.skillNotice === 'catalog-unavailable' ? frame.skillNotice : undefined
}
