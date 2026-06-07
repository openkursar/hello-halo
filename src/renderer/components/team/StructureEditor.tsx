/**
 * Full-canvas editor for the collaboration topology. Persists edits by writing
 * the full edge set through the store; "Reset to recommendation" regenerates
 * the default lead → member links.
 */

import { useCallback } from 'react'
import { Check, RotateCcw, Network } from 'lucide-react'
import type { TeamDetail, TeamEdge } from '../../../shared/apps/team-types'
import { useTeamStore } from '../../stores/team.store'
import { useTranslation } from '../../i18n'
import { TeamFlowCanvas } from './flow/TeamFlowCanvas'

interface StructureEditorProps {
  detail: TeamDetail
  onDone: () => void
}

export function StructureEditor({ detail, onDone }: StructureEditorProps) {
  const { t } = useTranslation()
  const setEdges = useTeamStore(s => s.setEdges)
  const updateTeam = useTeamStore(s => s.updateTeam)

  const teamId = detail.team.id
  const edges = detail.edges
  const isStructured = detail.team.collabMode === 'structured'

  const addRelation = useCallback((from: string, to: string, sync: boolean) => {
    if (edges.some(e => e.fromAppId === from && e.toAppId === to)) return
    setEdges(teamId, [...edges, { teamId, fromAppId: from, toAppId: to, sync }])
  }, [edges, teamId, setEdges])

  const removeRelation = useCallback((from: string, to: string) => {
    setEdges(teamId, edges.filter(e => !(e.fromAppId === from && e.toAppId === to)))
  }, [edges, teamId, setEdges])

  const setSync = useCallback((from: string, to: string, sync: boolean) => {
    setEdges(teamId, edges.map(e => (e.fromAppId === from && e.toAppId === to ? { ...e, sync } : e)))
  }, [edges, teamId, setEdges])

  // Reset to the recommended structure: lead → each member (sync), the same
  // default createTeam generates. A real, working reset (the old one was a no-op
  // when already structured).
  const resetToRecommended = useCallback(() => {
    const leadAppId = detail.team.leadAppId
    if (!leadAppId) { setEdges(teamId, []); return }
    const defaults: TeamEdge[] = detail.members
      .filter(m => m.appId !== leadAppId)
      .map(m => ({ teamId, fromAppId: leadAppId, toAppId: m.appId, sync: true }))
    setEdges(teamId, defaults)
  }, [detail.team.leadAppId, detail.members, teamId, setEdges])

  return (
    <div className="flex h-full min-h-[520px] flex-col">
      {/* Toolbar */}
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-border px-3 py-2.5 sm:px-4">
        <Network className="h-4 w-4 text-primary" />
        <div className="min-w-0">
          <span className="text-sm font-medium text-foreground">{t('Edit collaboration structure')}</span>
          <span className="ml-2 hidden text-xs text-muted-foreground sm:inline">
            {t('Connect members three ways: the panel, a member\u2019s “Connect to…”, or dragging the dots.')}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {isStructured && (
            <button
              onClick={resetToRecommended}
              className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              title={t('Reset to recommendation')}
            >
              <RotateCcw className="h-3 w-3" />
              <span className="hidden sm:inline">{t('Reset to recommendation')}</span>
            </button>
          )}
          <button
            onClick={onDone}
            className="flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <Check className="h-3 w-3" />
            {t('Done')}
          </button>
        </div>
      </div>

      {/* Body. A definite height (not just flex-1) so React Flow always has a
          real size to render into — relying on h-full up an indefinite flex chain
          collapsed the canvas to 0 and the graph looked empty. */}
      {isStructured ? (
        <div className="h-[60vh] min-h-[460px]">
          <TeamFlowCanvas
            roster={detail.roster}
            edges={edges}
            teamId={teamId}
            editable
            onAddRelation={addRelation}
            onRemoveRelation={removeRelation}
            onSetSync={setSync}
          />
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="max-w-sm text-sm text-muted-foreground">
            {t('This team uses free collaboration — every member can reach every other, so there is no fixed structure to edit.')}
          </p>
          <button
            onClick={() => updateTeam(teamId, { collabMode: 'structured' })}
            className="rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground transition-colors hover:bg-primary/90"
          >
            {t('Switch to structured mode')}
          </button>
        </div>
      )}
    </div>
  )
}
