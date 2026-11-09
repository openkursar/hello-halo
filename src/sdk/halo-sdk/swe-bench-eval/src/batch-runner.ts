/**
 * Concurrent batch execution using p-limit.
 * Handles resumable runs — already completed/failed instances are skipped.
 */

import pLimit from 'p-limit'
import { runInstance } from './agent-runner.ts'
import { Database } from './storage.ts'
import type { RunConfig, SWEBenchInstance } from './types.ts'

export async function runBatch(
  instances: SWEBenchInstance[],
  config: RunConfig,
  db: Database,
  onProgress?: (completed: number, total: number, lastResult: { id: string; status: string }) => void,
): Promise<void> {
  const total = instances.length

  // Initialize all instances as 'pending' — skip if they already exist
  for (const instance of instances) {
    const existing = db.getResult(instance.instance_id, config.runId)
    if (!existing) {
      db.insertResult({
        instanceId: instance.instance_id,
        runId: config.runId,
        status: 'pending',
        patch: null,
        error: null,
        startedAt: null,
        completedAt: null,
        inputTokens: 0,
        outputTokens: 0,
        turns: 0,
        agentLog: null,
      })
    }
  }

  // Find instances that still need processing (skip completed/failed from prior runs)
  const toProcess = instances.filter(instance => {
    const existing = db.getResult(instance.instance_id, config.runId)
    return !existing || (existing.status !== 'completed' && existing.status !== 'failed')
  })

  let completed = total - toProcess.length // already done
  const limit = pLimit(config.concurrency)

  const tasks = toProcess.map(instance =>
    limit(async () => {
      // Mark as running
      db.updateResult({
        instanceId: instance.instance_id,
        runId: config.runId,
        status: 'running',
        startedAt: new Date().toISOString(),
      })

      let result
      try {
        result = await runInstance(instance, config)
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        result = {
          instanceId: instance.instance_id,
          runId: config.runId,
          status: 'failed' as const,
          patch: null,
          error: errorMsg.slice(0, 2000),
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          inputTokens: 0,
          outputTokens: 0,
          turns: 0,
          agentLog: null,
        }
      }

      // Persist result
      db.updateResult(result)

      // Update run counters atomically
      const wasCompleted = result.status === 'completed' ? 1 : 0
      const wasFailed = result.status === 'failed' ? 1 : 0
      db.updateRunCounters(config.runId, wasCompleted, wasFailed)

      completed++
      onProgress?.(completed, total, { id: instance.instance_id, status: result.status })
    })
  )

  await Promise.all(tasks)
}
