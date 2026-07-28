/**
 * Per-type action verbs shared by the store card and detail page so the install
 * / installed / use labels stay consistent (数字人=安装, skill=添加, mcp=连接).
 * Literal t() calls per branch so the i18n extractor picks each verb up.
 */

import type { AppType } from '../../../shared/apps/spec-types'

type Translate = (key: string) => string

export function installVerb(t: Translate, type: AppType): string {
  switch (type) {
    case 'skill': return t('Add')
    case 'mcp': return t('Connect')
    default: return t('Install')
  }
}

export function installedVerb(t: Translate, type: AppType): string {
  switch (type) {
    case 'skill': return t('Added')
    case 'mcp': return t('Connected')
    default: return t('Installed')
  }
}
