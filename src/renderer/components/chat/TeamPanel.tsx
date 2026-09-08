/**
 * TeamPanel - Displays Agent Team collaboration status in real-time.
 *
 * Shows when the AI coordinator spawns named agents (teammates) to work in
 * parallel. Each agent row displays: status dot, name, progress summary,
 * elapsed time, and token usage.
 *
 * Data is derived from the thoughts array via `deriveTeamAgents()` — a pure
 * function that extracts team info from Agent tool_use thoughts and their
 * taskProgress. No separate data pipeline or state management needed.
 *
 * Renders inside StreamingSection (between ThoughtProcess and BrowserTaskCard)
 * during active generation, and in CollapsedThoughtProcess for completed messages.
 */

import { useState, useEffect, useMemo, memo } from 'react'
import { Users } from 'lucide-react'
import type { Thought } from '../../types'
import { useTranslation } from '../../i18n'

// ============================================
// Derived types (replace old TeamState/TeamSnapshot)
// ============================================

/** Single agent info derived from a thought */
export interface DerivedTeamAgent {
  thoughtId: string
  name: string
  description: string
  status: 'running' | 'completed' | 'failed' | 'stopped'
  summary: string
  durationMs: number
  totalTokens: number
  startTime: number
  isRunning: boolean
}

/** Team info derived from thoughts array */
export interface DerivedTeamInfo {
  teamName: string
  agents: DerivedTeamAgent[]
}

// ============================================
// deriveTeamAgents - Pure derivation from thoughts
// ============================================

function mapTaskStatus(status?: string): 'running' | 'completed' | 'failed' | 'stopped' {
  switch (status) {
    case 'running': return 'running'
    case 'completed': return 'completed'
    case 'failed': return 'failed'
    case 'stopped': return 'stopped'
    default: return 'running'  // No task_started yet → default running
  }
}

/** Extract team info from thoughts array. Returns null if no team agents found. */
export function deriveTeamAgents(thoughts: Thought[]): DerivedTeamInfo | null {
  // Filter Agent tool_use thoughts that have team_name in input
  const agentThoughts = thoughts.filter(
    t => t.type === 'tool_use'
      && t.toolName === 'Agent'
      && t.toolInput?.team_name
  )

  if (agentThoughts.length === 0) return null

  const teamName = agentThoughts[0].toolInput!.team_name as string

  const agents: DerivedTeamAgent[] = agentThoughts.map(t => {
    const status = mapTaskStatus(t.taskProgress?.status)
    return {
      thoughtId: t.id,
      name: (t.toolInput!.name as string) || 'Agent',
      description: (t.toolInput!.description as string) || '',
      status,
      summary: t.taskProgress?.summary || t.taskProgress?.lastToolName || '',
      durationMs: t.taskProgress?.durationMs ?? 0,
      totalTokens: t.taskProgress?.totalTokens ?? 0,
      startTime: new Date(t.timestamp).getTime(),
      isRunning: status === 'running',
    }
  })

  return { teamName, agents }
}

// ============================================
// useElapsedTime - Live timer for running agents
// ============================================

/**
 * Returns a formatted elapsed time string that ticks every second while running.
 * Once endTime is set (agent finished), displays the final static duration.
 */
function useElapsedTime(startTime: number, endTime?: number): string {
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (endTime) return

    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [endTime])

  const elapsed = ((endTime || now) - startTime) / 1000
  if (elapsed < 60) return `${Math.floor(elapsed)}s`
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m ${Math.floor(elapsed % 60)}s`
  return `${Math.floor(elapsed / 3600)}h ${Math.floor((elapsed % 3600) / 60)}m`
}

// ============================================
// Formatting helpers
// ============================================

function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`
  return `${(tokens / 1_000_000).toFixed(1)}M`
}

// ============================================
// StatusDot - Semantic status indicator
// ============================================

function StatusDot({ status }: { status: DerivedTeamAgent['status'] }) {
  const styles: Record<DerivedTeamAgent['status'], string> = {
    running: 'bg-blue-500 animate-pulse',
    completed: 'bg-green-500',
    failed: 'bg-red-500',
    stopped: 'bg-muted-foreground/50',
  }
  return <div className={`w-2 h-2 rounded-full shrink-0 ${styles[status]}`} />
}

// ============================================
// TeamAgentRow - Single agent in the team
// ============================================

const TeamAgentRow = memo(function TeamAgentRow({ agent }: { agent: DerivedTeamAgent }) {
  // For finished agents, compute endTime from startTime + durationMs
  const endTime = !agent.isRunning && agent.durationMs > 0
    ? agent.startTime + agent.durationMs
    : undefined
  const elapsed = useElapsedTime(agent.startTime, endTime)

  return (
    <div className="flex items-center gap-2 py-1 text-sm min-w-0">
      {/* Status */}
      <StatusDot status={agent.status} />

      {/* Name */}
      <span className="font-medium text-foreground shrink-0 max-w-[100px] truncate" title={agent.name}>
        {agent.name}
      </span>

      {/* Summary */}
      <span
        className="flex-1 text-muted-foreground truncate min-w-0 text-xs"
        title={[agent.description, agent.summary].filter(Boolean).join(' — ') || undefined}
      >
        {agent.summary}
      </span>

      {/* Meta: elapsed + tokens */}
      <span className="text-xs text-muted-foreground/60 whitespace-nowrap shrink-0">
        {elapsed}
        {agent.totalTokens > 0 && (
          <span className="hidden sm:inline"> · {formatTokens(agent.totalTokens)}</span>
        )}
      </span>
    </div>
  )
})

// ============================================
// TeamPanel - Main component (live state)
// ============================================

interface TeamPanelProps {
  thoughts: Thought[]
}

export function TeamPanel({ thoughts }: TeamPanelProps) {
  const { t } = useTranslation()
  const teamInfo = useMemo(() => deriveTeamAgents(thoughts), [thoughts])

  if (!teamInfo || teamInfo.agents.length === 0) return null

  const { teamName, agents } = teamInfo
  const runningCount = agents.filter(a => a.isRunning).length

  return (
    <div className="mb-3 rounded-lg border border-border/50 bg-muted/30 p-3">
      {/* Header */}
      <div className="flex items-center gap-2 mb-1.5 text-xs text-muted-foreground">
        <Users className="w-3.5 h-3.5 shrink-0" />
        <span className="font-medium">{t('Team')}: {teamName}</span>
        <span>·</span>
        <span>
          {runningCount}/{agents.length} {t('active')}
        </span>
      </div>

      {/* Agent list */}
      <div className="space-y-0.5">
        {agents.map(agent => (
          <TeamAgentRow key={agent.thoughtId} agent={agent} />
        ))}
      </div>
    </div>
  )
}

// ============================================
// TeamSnapshotPanel - Frozen state (history)
// ============================================

interface TeamSnapshotPanelProps {
  thoughts: Thought[]
}

export function TeamSnapshotPanel({ thoughts }: TeamSnapshotPanelProps) {
  const { t } = useTranslation()
  const teamInfo = useMemo(() => deriveTeamAgents(thoughts), [thoughts])

  if (!teamInfo || teamInfo.agents.length === 0) return null

  const { teamName } = teamInfo
  // Normalize: any agent still 'running' in history means the SDK never sent
  // a terminal event — treat as 'stopped' so the UI doesn't show misleading status.
  const agents = teamInfo.agents.map(a =>
    a.status === 'running' ? { ...a, status: 'stopped' as const, isRunning: false } : a
  )
  const completedCount = agents.filter(a => a.status === 'completed').length
  const failedCount = agents.filter(a => a.status === 'failed').length

  return (
    <div className="mb-2 rounded-lg border border-border/30 bg-muted/20 p-2.5">
      {/* Header */}
      <div className="flex items-center gap-2 mb-1 text-xs text-muted-foreground">
        <Users className="w-3 h-3 shrink-0" />
        <span className="font-medium">{t('Team')}: {teamName}</span>
        <span>·</span>
        <span>
          {completedCount}/{agents.length} {t('completed')}
          {failedCount > 0 && ` · ${failedCount} ${t('failed')}`}
        </span>
      </div>

      {/* Agent list (compact) */}
      <div className="space-y-0.5">
        {agents.map(agent => (
          <div key={agent.thoughtId} className="flex items-center gap-2 py-0.5 text-xs min-w-0">
            <StatusDot status={agent.status} />
            <span className="font-medium text-foreground shrink-0 max-w-[100px] truncate" title={agent.name}>
              {agent.name}
            </span>
            <span
              className="flex-1 text-muted-foreground/70 truncate min-w-0"
              title={[agent.description, agent.summary].filter(Boolean).join(' — ') || undefined}
            >
              {agent.summary}
            </span>
            {agent.durationMs > 0 && (
              <span className="text-muted-foreground/50 whitespace-nowrap shrink-0">
                {Math.round(agent.durationMs / 1000)}s
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
