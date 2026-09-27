/**
 * SkillsTab - "Skill" content for the space resource rail
 *
 * Read-only browse of every skill loadable in this space (disk-based, same
 * source AppSkillsSection uses — see main/apps/skill-discovery.ts).
 *
 * Clicking a row previews its SKILL.md in the canvas, consistent with the
 * file tree's click-to-preview convention. The reveal-on-hover "Use" button
 * is the quick-launch action — it pre-fills the skill's slash command into
 * this space's composer (same `pendingComposerInput` channel StoreDetail's
 * "Use" button already uses for the same purpose — see
 * StoreDetail.handleUse) rather than navigating away to the digital-humans
 * management page. Every listed skill supports both actions, not just ones
 * with a matching InstalledApp record — "use" only needs the directory slug.
 */

import { useState, useEffect } from 'react'
import { Loader2 } from 'lucide-react'
import { APP_TYPE_GLYPH } from '../store/app-type-glyph'
import { api } from '../../api'
import { useSpaceStore } from '../../stores/space.store'
import { useChatStore } from '../../stores/chat.store'
import { useCanvasStore } from '../../stores/canvas.store'
import { useTranslation } from '../../i18n'
import type { AvailableSkill } from '../../../shared/apps/app-types'
import { SpaceResourceRow } from './SpaceResourceRow'
import { AppTypeIcon } from '../store/AppTypeIcon'

export function SkillsTab() {
  const { t } = useTranslation()
  const spaceId = useSpaceStore(state => state.currentSpace?.id ?? '')

  const [skills, setSkills] = useState<AvailableSkill[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!spaceId) {
      setSkills([])
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    api.appListAvailableSkillsForSpace(spaceId)
      .then(res => {
        if (cancelled) return
        setSkills(res.success && Array.isArray(res.data) ? res.data : [])
      })
      .catch(() => { if (!cancelled) setSkills([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [spaceId])

  const handleUse = (skill: AvailableSkill) => {
    if (!spaceId) return
    useChatStore.setState({
      pendingComposerInput: {
        spaceId,
        text: `/${skill.dirName} `,
        // Shown regardless of whether the current session has this skill in
        // its own live command list (e.g. a brand-new, session-less
        // conversation) — this list already confirmed the skill is real.
        slashPreview: { command: `/${skill.dirName}`, label: skill.dirName, description: skill.description },
      }
    })
  }

  // Discovery guarantees every returned skill has a readable SKILL.md at
  // this fixed path (main/apps/skill-discovery.ts) — same file the "use"
  // command above ultimately invokes, opened read-only in the canvas so
  // there's room to actually read it instead of squeezing it into the rail.
  const handleViewDetail = (skill: AvailableSkill) => {
    useCanvasStore.getState().openFile(`${skill.path}/SKILL.md`, skill.name)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" />
      </div>
    )
  }

  if (skills.length === 0) {
    const SkillGlyph = APP_TYPE_GLYPH.skill
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-4 py-8">
        <SkillGlyph className="w-8 h-8 text-muted-foreground/40 mb-2" />
        <p className="text-xs text-muted-foreground">{t('No skills available yet.')}</p>
      </div>
    )
  }

  return (
    <div className="py-2 px-1.5 space-y-1.5 overflow-y-auto h-full">
      {skills.map(skill => (
        <SpaceResourceRow
          key={`${skill.scope}:${skill.dirName}`}
          icon={<AppTypeIcon type="skill" name={skill.name} size="xs" />}
          bareIcon
          name={skill.name}
          description={skill.description}
          scope={skill.scope}
          onClick={() => handleViewDetail(skill)}
          onUse={() => handleUse(skill)}
        />
      ))}
    </div>
  )
}
