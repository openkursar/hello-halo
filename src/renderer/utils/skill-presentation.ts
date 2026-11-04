import type { SkillCopy, SkillGroup } from '../../shared/types/skills'
import { resolveSpecI18n } from './spec-i18n'

type Translate = (key: string) => string

export function skillInstructions(content: string): string {
  return content.replace(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '').trimStart()
}

export function selectedSkill(group: SkillGroup): SkillCopy | undefined {
  return group.copies.find(copy => copy.id === group.effectiveId) ?? group.copies[0]
}

export function skillDisplay(copy: SkillCopy, locale: string) {
  return resolveSpecI18n({ type: 'skill', spec_version: '1', name: copy.name, display_name: copy.displayName,
    description: copy.description, version: copy.version ?? '', i18n: copy.i18n }, locale)
}

export function skillSourceLabel(copy: SkillCopy, t: Translate): string {
  if (copy.source === 'builtin') return t('Built-in')
  if (copy.source === 'store') return t('Store')
  if (copy.source === 'digital-human') return copy.owners.map(owner => owner.name).join(', ') || t('Digital human skills')
  return t('Custom')
}

export function skillErrorMessage(error: unknown, fallback: string, t: Translate): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  if (/ENOENT|no longer available|file is missing|file is unavailable/i.test(message)) {
    return t('The skill file could not be found. Check its folder or import the skill again.')
  }
  if (/EACCES|EPERM|permission denied|read.only/i.test(message)) {
    return t('Halo cannot access this skill folder. Check its permissions and try again.')
  }
  if (/changed since|changed before|revision|concurrent|destination.*exists|destination.*conflict|already.*same name/i.test(message)) {
    return /destination|same name/i.test(message)
      ? t('A skill with this name already exists there. Choose another name or workspace.')
      : t('This skill was changed elsewhere. Your draft is kept; reload the file before saving again.')
  }
  return fallback
}
