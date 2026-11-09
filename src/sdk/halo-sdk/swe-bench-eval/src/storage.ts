/**
 * SQLite persistence for runs and results using better-sqlite3 (synchronous API).
 */

import BetterSqlite3 from 'better-sqlite3'
import { mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import type { RunRecord, InstanceResult, EvalScore, RunConfig } from './types.ts'

export function serializeRunConfig(config: RunConfig): string {
  let apiUrl: string | undefined
  if (config.apiUrl) {
    try {
      const endpoint = new URL(config.apiUrl)
      apiUrl = `${endpoint.origin}${endpoint.pathname}`
    } catch {
      console.warn('[Evaluation] Invalid endpoint omitted from saved configuration', { runId: config.runId })
    }
  }
  return JSON.stringify({
    runId: config.runId,
    modelName: config.modelName,
    providerType: config.providerType,
    apiUrl,
    concurrency: config.concurrency,
    maxTurns: config.maxTurns,
    instanceIds: config.instanceIds,
    limit: config.limit,
    datasetPath: config.datasetPath,
    outputDir: config.outputDir,
    repoCache: config.repoCache,
  })
}

export class Database {
  private db: BetterSqlite3.Database

  constructor(outputDir: string) {
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true })
    }
    const dbPath = join(outputDir, 'swe-bench.db')
    this.db = new BetterSqlite3(dbPath)
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        config TEXT NOT NULL,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        total_instances INTEGER NOT NULL DEFAULT 0,
        completed_instances INTEGER NOT NULL DEFAULT 0,
        failed_instances INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS results (
        instance_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        patch TEXT,
        error TEXT,
        started_at TEXT,
        completed_at TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        turns INTEGER NOT NULL DEFAULT 0,
        agent_log TEXT,
        PRIMARY KEY (instance_id, run_id)
      );

      CREATE TABLE IF NOT EXISTS eval_scores (
        run_id TEXT PRIMARY KEY,
        resolved_count INTEGER NOT NULL,
        total_count INTEGER NOT NULL,
        resolved_rate REAL NOT NULL,
        resolved_ids TEXT NOT NULL,
        unresolved TEXT NOT NULL,
        error_ids TEXT NOT NULL,
        raw_output TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `)
  }

  createRun(runId: string, config: RunConfig, totalInstances: number): void {
    const stmt = this.db.prepare(`
      INSERT INTO runs (run_id, config, created_at, status, total_instances, completed_instances, failed_instances)
      VALUES (?, ?, ?, 'running', ?, 0, 0)
    `)
    stmt.run(runId, serializeRunConfig(config), new Date().toISOString(), totalInstances)
  }

  updateRunStatus(runId: string, status: 'running' | 'completed' | 'failed'): void {
    const stmt = this.db.prepare(`UPDATE runs SET status = ? WHERE run_id = ?`)
    stmt.run(status, runId)
  }

  updateRunCounters(runId: string, completedDelta: number, failedDelta: number): void {
    const stmt = this.db.prepare(`
      UPDATE runs
      SET completed_instances = completed_instances + ?,
          failed_instances = failed_instances + ?
      WHERE run_id = ?
    `)
    stmt.run(completedDelta, failedDelta, runId)
  }

  getRun(runId: string): RunRecord | null {
    const row = this.db.prepare(`SELECT * FROM runs WHERE run_id = ?`).get(runId) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      runId: row.run_id as string,
      config: row.config as string,
      createdAt: row.created_at as string,
      status: row.status as 'running' | 'completed' | 'failed',
      totalInstances: row.total_instances as number,
      completedInstances: row.completed_instances as number,
      failedInstances: row.failed_instances as number,
    }
  }

  getAllRuns(): RunRecord[] {
    const rows = this.db.prepare(`SELECT * FROM runs ORDER BY created_at DESC`).all() as Record<string, unknown>[]
    return rows.map(row => ({
      runId: row.run_id as string,
      config: row.config as string,
      createdAt: row.created_at as string,
      status: row.status as 'running' | 'completed' | 'failed',
      totalInstances: row.total_instances as number,
      completedInstances: row.completed_instances as number,
      failedInstances: row.failed_instances as number,
    }))
  }

  insertResult(result: InstanceResult): void {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO results
        (instance_id, run_id, status, patch, error, started_at, completed_at, input_tokens, output_tokens, turns, agent_log)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      result.instanceId,
      result.runId,
      result.status,
      result.patch,
      result.error,
      result.startedAt,
      result.completedAt,
      result.inputTokens,
      result.outputTokens,
      result.turns,
      result.agentLog,
    )
  }

  updateResult(result: Partial<InstanceResult> & { instanceId: string; runId: string }): void {
    const fields: string[] = []
    const values: unknown[] = []

    if (result.status !== undefined) { fields.push('status = ?'); values.push(result.status) }
    if (result.patch !== undefined) { fields.push('patch = ?'); values.push(result.patch) }
    if (result.error !== undefined) { fields.push('error = ?'); values.push(result.error) }
    if (result.startedAt !== undefined) { fields.push('started_at = ?'); values.push(result.startedAt) }
    if (result.completedAt !== undefined) { fields.push('completed_at = ?'); values.push(result.completedAt) }
    if (result.inputTokens !== undefined) { fields.push('input_tokens = ?'); values.push(result.inputTokens) }
    if (result.outputTokens !== undefined) { fields.push('output_tokens = ?'); values.push(result.outputTokens) }
    if (result.turns !== undefined) { fields.push('turns = ?'); values.push(result.turns) }
    if (result.agentLog !== undefined) { fields.push('agent_log = ?'); values.push(result.agentLog) }

    if (fields.length === 0) return

    values.push(result.instanceId, result.runId)
    const stmt = this.db.prepare(`UPDATE results SET ${fields.join(', ')} WHERE instance_id = ? AND run_id = ?`)
    stmt.run(...values)
  }

  getResult(instanceId: string, runId: string): InstanceResult | null {
    const row = this.db.prepare(`SELECT * FROM results WHERE instance_id = ? AND run_id = ?`).get(instanceId, runId) as Record<string, unknown> | undefined
    if (!row) return null
    return this.rowToResult(row)
  }

  getRunResults(runId: string): InstanceResult[] {
    const rows = this.db.prepare(`SELECT * FROM results WHERE run_id = ? ORDER BY instance_id`).all(runId) as Record<string, unknown>[]
    return rows.map(r => this.rowToResult(r))
  }

  getPendingInstances(runId: string): string[] {
    const rows = this.db.prepare(
      `SELECT instance_id FROM results WHERE run_id = ? AND status IN ('pending', 'running')`
    ).all(runId) as Record<string, unknown>[]
    return rows.map(r => r.instance_id as string)
  }

  saveEvalScore(score: EvalScore): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO eval_scores
        (run_id, resolved_count, total_count, resolved_rate, resolved_ids, unresolved, error_ids, raw_output, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      score.runId,
      score.resolvedCount,
      score.totalCount,
      score.resolvedRate,
      JSON.stringify(score.resolvedIds),
      JSON.stringify(score.unresolved),
      JSON.stringify(score.errorIds),
      score.rawOutput,
      new Date().toISOString(),
    )
  }

  getEvalScore(runId: string): EvalScore | null {
    const row = this.db.prepare(`SELECT * FROM eval_scores WHERE run_id = ?`).get(runId) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      runId: row.run_id as string,
      resolvedCount: row.resolved_count as number,
      totalCount: row.total_count as number,
      resolvedRate: row.resolved_rate as number,
      resolvedIds: JSON.parse(row.resolved_ids as string) as string[],
      unresolved: JSON.parse(row.unresolved as string) as string[],
      errorIds: JSON.parse(row.error_ids as string) as string[],
      rawOutput: row.raw_output as string,
    }
  }

  private rowToResult(row: Record<string, unknown>): InstanceResult {
    return {
      instanceId: row.instance_id as string,
      runId: row.run_id as string,
      status: row.status as InstanceResult['status'],
      patch: row.patch as string | null,
      error: row.error as string | null,
      startedAt: row.started_at as string | null,
      completedAt: row.completed_at as string | null,
      inputTokens: row.input_tokens as number,
      outputTokens: row.output_tokens as number,
      turns: row.turns as number,
      agentLog: row.agent_log as string | null,
    }
  }

  close(): void {
    this.db.close()
  }
}
