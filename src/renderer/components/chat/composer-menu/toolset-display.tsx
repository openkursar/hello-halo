/**
 * How each toolset presents itself in the composer: icon, name and the one
 * line that tells a newcomer what switching it on lets the AI do.
 *
 * Literal t('...') calls (not t(ts.displayName)) so the i18n extractor sees
 * every key; a toolset missing here falls back to its registry text.
 */

import { Wrench, Globe, TerminalSquare, ScanText, Settings2, Users } from 'lucide-react'
import type { ToolsetStatus } from '../../../stores/toolsets.store'

type Translate = (key: string) => string

export function toolsetIcon(id: string, size = 16) {
  switch (id) {
    case 'ai-browser':
      return <Globe size={size} />
    case 'ai-terminal':
      return <TerminalSquare size={size} />
    case 'ocr':
      return <ScanText size={size} />
    case 'halo-api-ref':
      return <Settings2 size={size} />
    case 'halo-team':
      return <Users size={size} />
    default:
      return <Wrench size={size} />
  }
}

export function toolsetLabel(t: Translate, ts: ToolsetStatus): string {
  switch (ts.id) {
    case 'ai-browser':
      return t('Web Control')
    case 'ai-terminal':
      return t('AI Terminal')
    case 'ocr':
      return t('Text Recognition')
    case 'halo-api-ref':
      return t('Operate Halo')
    case 'halo-team':
      return t('Team Collaboration')
    default:
      return ts.displayName
  }
}

export function toolsetDescription(t: Translate, ts: ToolsetStatus): string {
  switch (ts.id) {
    case 'ai-browser':
      return t('AI works in your browser, with your signed-in sessions')
    case 'ai-terminal':
      return t('Interactive terminal you share with AI: SSH, other CLIs, long tasks')
    case 'ocr':
      return t('Reads text in images on this device, no tokens used')
    case 'halo-api-ref':
      return t('AI operates Halo for you: spaces, digital humans, knowledge bases, settings')
    case 'halo-team':
      return t('For bigger tasks, AI assembles a team that works in parallel')
    default:
      return ts.summary
  }
}

/** Display order: the defaults first, then the rest as the registry lists them. */
const ORDER = ['ai-browser', 'halo-team', 'ai-terminal', 'ocr', 'halo-api-ref']

export function sortToolsets(list: ToolsetStatus[]): ToolsetStatus[] {
  const rank = (id: string) => {
    const index = ORDER.indexOf(id)
    return index === -1 ? ORDER.length : index
  }
  return [...list].sort((a, b) => rank(a.id) - rank(b.id))
}
