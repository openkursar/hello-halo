import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir, cpus, platform, release } from 'os'
import { join } from 'path'
import { performance } from 'perf_hooks'
import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import { migrations as managerMigrations } from '../../../../src/main/apps/manager/migrations'
import { migrations } from '../../../../src/main/apps/runtime/migrations'
import { AppManagerStore } from '../../../../src/main/apps/manager/store'
import { ActivityStore } from '../../../../src/main/apps/runtime/store'
import { buildPeopleDirectory } from '../../../../src/main/apps/runtime/people-directory'
import type { AppManagerService } from '../../../../src/main/apps/manager'
import type { AppRuntimeService } from '../../../../src/main/apps/runtime/types'

/** Opt-in: measures real SQLite stores without booting the app or an AI engine. */
describe.runIf(process.env.HALO_PEOPLE_BENCH === '1')('people-directory SQLite performance', () => {
  it('records same-data legacy and summary reads plus large-history query plans', () => {
    const root = mkdtempSync(join(tmpdir(), 'halo-directory-bench-'))
    const output = process.env.HALO_PEOPLE_BENCH_OUTPUT
    if (!output) throw new Error('HALO_PEOPLE_BENCH_OUTPUT is required')
    mkdirSync(output, { recursive: true })
    const samples = 50
    const warmups = 10
    const results: Array<Record<string, unknown>> = []
    const prompt = 'Review incoming work, verify evidence, explain uncertainty and ask the owner when a decision is required. '.repeat(82).slice(0, 8192)
    const runtime = { getDirectoryRuntimeSnapshot: () => ({}) } as unknown as AppRuntimeService
    try {
      for (const [people, history] of [[5, 100], [50, 1000], [200, 4000], [200, 10000], [200, 100000]]) {
        const file = join(root, `people-${people}-history-${history}.db`)
        const database = createDatabaseManager(file)
        const db = database.getAppDatabase()
        database.runMigrations(db, 'app_manager', managerMigrations)
        database.runMigrations(db, 'app_runtime', migrations)
        db.pragma('cache_size = -2048')
        const insertPerson = db.prepare(`INSERT INTO installed_apps(id,spec_id,space_id,spec_json,user_config_json,installed_at)
          VALUES (?,?,'work',?,'{}',100)`)
        const insertRun = db.prepare(`INSERT INTO automation_runs(run_id,app_id,session_key,status,trigger_type,trigger_data_json,started_at,finished_at,duration_ms)
          VALUES (?,?,?,'ok','schedule',?,?,?,10)`)
        const insertActivity = db.prepare(`INSERT INTO activity_entries(id,app_id,run_id,type,ts,content_json) VALUES (?,?,?,'report',?,?)`)
        db.transaction(() => {
          for (let index = 0; index < people; index++) {
            const id = `person-${String(index).padStart(3, '0')}`
            insertPerson.run(id, id, JSON.stringify({ type: 'automation', name: id, description: 'Research and recurring operations', system_prompt: prompt }))
          }
          for (let index = 0; index < history; index++) {
            const id = `person-${String(index % people).padStart(3, '0')}`
            insertRun.run(`run-${index}`, id, `session-${index}`, JSON.stringify({ fixture: 'x'.repeat(1024) }), index, index + 10)
            insertActivity.run(`activity-${index}`, id, `run-${index}`, index, JSON.stringify({ summary: 'y'.repeat(256) }))
          }
        })()
        db.pragma('wal_checkpoint(TRUNCATE)')
        let executions = 0
        const prepare = db.prepare.bind(db)
        const trace = vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
          const statement = prepare(sql)
          return new Proxy(statement, { get(target, key) {
            const value = Reflect.get(target, key)
            if (typeof value !== 'function') return value
            return (...args: unknown[]) => {
              if (key === 'all' || key === 'get' || key === 'run') executions++
              return value.apply(target, args)
            }
          } })
        }) as typeof db.prepare)
        const managerStore = new AppManagerStore(db)
        const store = new ActivityStore(db)
        const manager = {
          listPeopleDirectory: filter => managerStore.listPeopleDirectory(filter),
          listPersonIdsByStatus: statuses => managerStore.listPersonIdsByStatus(statuses),
        } as AppManagerService
        // Replays the legacy directory reads, not run execution: list payload + getAllAppStates reads per person.
        const legacy = () => {
          const apps = managerStore.list()
          const states: Record<string, unknown> = {}
          for (const person of managerStore.list({ type: 'automation' })) {
            const app = managerStore.getById(person.id)!
            const count = store.getDecisionCounts(app.id)
            const latest = store.getLatestRunForApp(app.id)
            const recent = store.getRunsForApp(app.id, 5)
            let consecutiveErrors = 0
            for (const run of recent) {
              if (run.status !== 'error' || store.wasRunStopped(run.runId) || store.isRunClosed(run.runId)) break
              consecutiveErrors++
            }
            states[app.id] = { status: 'idle', automaticEnabled: true, runningCount: 0,
              pendingDecisionCount: count.pending, pendingSoloDecisionCount: count.solo, continuationCount: count.continuations,
              lastRunAtMs: latest?.startedAt, lastDurationMs: latest?.durationMs, lastStatus: latest?.status, consecutiveErrors }
          }
          return [{ success: true, data: apps }, { success: true, data: states }]
        }
        const summary = () => ({ success: true, data: buildPeopleDirectory(manager, store, runtime, [], { limit: 24 }) })
        const measurements = { legacy: [] as number[], summary: [] as number[] }
        const metrics: Record<string, { bytes: number; sql: number; medianMs: number; p95Ms: number }> = {}
        for (let index = 0; index < warmups; index++) { JSON.stringify(legacy()); JSON.stringify(summary()) }
        for (let index = 0; index < samples; index++) {
          for (const name of (index % 2 ? ['summary', 'legacy'] : ['legacy', 'summary']) as Array<'legacy' | 'summary'>) {
            executions = 0
            const start = performance.now()
            const json = JSON.stringify(name === 'legacy' ? legacy() : summary())
            measurements[name].push(performance.now() - start)
            metrics[name] = { bytes: Buffer.byteLength(json), sql: executions, medianMs: 0, p95Ms: 0 }
          }
        }
        for (const name of ['legacy', 'summary'] as const) {
          const sorted = measurements[name].sort((a, b) => a - b)
          metrics[name].medianMs = Number(sorted[Math.floor(sorted.length / 2)].toFixed(3))
          metrics[name].p95Ms = Number(sorted[Math.ceil(sorted.length * 0.95) - 1].toFixed(3))
        }
        trace.mockClear()
        const ids = managerStore.listPeopleDirectory({ limit: 24 }).items.map(person => person.id)
        expect(store.getDirectoryRecentRuns(ids)).toHaveLength(Math.min(24, people) * 5)
        const recentSql = trace.mock.calls.map(call => String(call[0])).find(sql => sql.includes('FROM json_each(?) person JOIN automation_runs'))!
        const plan = prepare(`EXPLAIN QUERY PLAN ${recentSql}`).all(JSON.stringify(ids))
        expect(JSON.stringify(plan)).toContain('idx_runs_app')
        expect(metrics.summary.sql).toBe(8)
        expect(metrics.legacy.sql).toBe(2 + 5 * people)
        results.push({ people, history, databaseBytes: statSync(file).size, ...metrics, recentRunQueryPlan: plan })
        trace.mockRestore()
        database.closeAll()
      }
      const report = { measuredAt: new Date().toISOString(), machine: { cpu: cpus()[0]?.model, platform: platform(), release: release(), node: process.versions.node, electron: process.versions.electron }, promptBytesPerPerson: Buffer.byteLength(prompt), samples, warmups, sqliteCacheKiB: 2048, results }
      writeFileSync(join(output, 'people-directory-performance.json'), JSON.stringify(report, null, 2))
      const rows = results.map(row => {
        const old = row.legacy as typeof metricsShape
        const current = row.summary as typeof metricsShape
        return `| ${row.people} | ${row.history} | ${old.bytes} / ${current.bytes} | ${old.sql} / ${current.sql} | ${old.medianMs} / ${current.medianMs} | ${old.p95Ms} / ${current.p95Ms} |`
      })
      writeFileSync(join(output, 'people-directory-performance.md'), `# People directory SQLite measurement\n\nMeasured: ${report.measuredAt}\n\nCPU: ${report.machine.cpu}; ${report.machine.platform} ${report.machine.release}; Node ${report.machine.node}; Electron-as-Node ${report.machine.electron}.\n\nSame disk-backed SQLite fixture per paired comparison; ${report.promptBytesPerPerson} bytes of prompt per person; ${warmups} warmups per path; ${samples} samples, alternating execution order. Each timed read includes JSON serialization, excludes seeding and output writing. SQLite cache is 2 MiB; OS caches are warm.\n\nEach cell lists **legacy / summary**. Summary returns at most 24 people.\n\n| People | Historical runs (+ same count of reports) | JSON bytes | SQL executions | Median ms | p95 ms |\n|---:|---:|---:|---:|---:|---:|\n${rows.join('\n')}\n\n## Measurement boundary\n\nThe legacy trace replays the prior full-list plus per-person state reads against real manager/runtime stores. It does not execute the entire runtime service or start an agent. Fixtures have successful historical runs, no active jobs, no pending questions and no teams. The new measurement calls the production directory builder. Membership retrieval and in-memory scheduler traversal are omitted from both paths; production adds one lightweight membership query. The summary path includes an id-only status lookup for stopped people, which the fixtures do not contain. IPC/HTTP transport overhead, renderer work, Electron startup, network, and cold OS caches are not measured. This is not a before/after whole-app startup benchmark.\n\nThe large-history fixtures are disk databases with 10,000 and 100,000 runs plus reports. The production recent-run query is capped at five records per returned person. Raw JSON contains each actual EXPLAIN QUERY PLAN; the test asserts use of the existing per-app run index. SQL execution counts include reads using cached prepared statements, not only prepare calls. The test is opt-in and excluded from routine execution unless HALO_PEOPLE_BENCH=1.\n\n## Reproduce\n\n\`HALO_PEOPLE_BENCH=1 HALO_PEOPLE_BENCH_OUTPUT=/absolute/report/path npm run test:unit -- tests/unit/apps/runtime/people-directory.performance.test.ts\`\n`)
    } finally { rmSync(root, { recursive: true, force: true }) }
  }, 120000)
})

const metricsShape = { bytes: 0, sql: 0, medianMs: 0, p95Ms: 0 }
