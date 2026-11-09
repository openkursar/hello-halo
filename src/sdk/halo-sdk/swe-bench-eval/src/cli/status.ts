/**
 * `swe-eval status` command — show run status.
 * --json produces machine-readable JSON to stdout with nothing else.
 */

import { Command } from 'commander'
import { Database } from '../storage.ts'

export const statusCommand = new Command('status')
  .description('Show the status of evaluation runs')
  .option('--run-id <id>', 'Specific run ID to show (omit to list all runs)')
  .option('--output <dir>', 'Output directory', './runs')
  .option('--json', 'Output machine-readable JSON')
  .action((opts: {
    runId?: string
    output: string
    json?: boolean
  }) => {
    const db = new Database(opts.output)

    if (opts.runId) {
      // Show details for a specific run
      const run = db.getRun(opts.runId)
      if (!run) {
        if (opts.json) {
          console.log(JSON.stringify({ error: `Run "${opts.runId}" not found` }))
        } else {
          console.error(`Error: Run "${opts.runId}" not found in ${opts.output}/swe-bench.db`)
        }
        db.close()
        process.exit(1)
      }

      const results = db.getRunResults(opts.runId)
      const score = db.getEvalScore(opts.runId)
      const config = JSON.parse(run.config) as Record<string, unknown>

      const pending = results.filter(r => r.status === 'pending').length
      const running = results.filter(r => r.status === 'running').length
      const completed = results.filter(r => r.status === 'completed').length
      const failed = results.filter(r => r.status === 'failed').length

      if (opts.json) {
        const output = {
          runId: run.runId,
          status: run.status,
          createdAt: run.createdAt,
          progress: {
            total: run.totalInstances,
            completed,
            running,
            failed,
            pending,
          },
          score: score
            ? {
                resolvedCount: score.resolvedCount,
                totalCount: score.totalCount,
                resolvedRate: score.resolvedRate,
              }
            : null,
          config: {
            model: config.modelName,
            concurrency: config.concurrency,
            maxTurns: config.maxTurns,
          },
        }
        console.log(JSON.stringify(output))
      } else {
        console.log(`Run ID:     ${run.runId}`)
        console.log(`Status:     ${run.status}`)
        console.log(`Created:    ${run.createdAt}`)
        console.log(`Model:      ${config.modelName ?? 'unknown'}`)
        console.log(``)
        console.log(`Progress:`)
        console.log(`  Total:     ${run.totalInstances}`)
        console.log(`  Completed: ${completed}`)
        console.log(`  Running:   ${running}`)
        console.log(`  Failed:    ${failed}`)
        console.log(`  Pending:   ${pending}`)

        if (score) {
          console.log(``)
          console.log(`Eval Score:`)
          console.log(`  Resolved:  ${score.resolvedCount} / ${score.totalCount}`)
          console.log(`  Rate:      ${(score.resolvedRate * 100).toFixed(2)}%`)
        }

        // Show recent failures
        const recentFailed = results.filter(r => r.status === 'failed').slice(0, 5)
        if (recentFailed.length > 0) {
          console.log(``)
          console.log(`Recent Failures (up to 5):`)
          for (const r of recentFailed) {
            const errSnippet = r.error ? r.error.slice(0, 100) : 'unknown error'
            console.log(`  ${r.instanceId}: ${errSnippet}`)
          }
        }
      }
    } else {
      // List all runs
      const allRuns = db.getAllRuns()

      if (opts.json) {
        console.log(JSON.stringify(allRuns.map(run => {
          const config = JSON.parse(run.config) as Record<string, unknown>
          return {
            runId: run.runId,
            status: run.status,
            createdAt: run.createdAt,
            totalInstances: run.totalInstances,
            completedInstances: run.completedInstances,
            failedInstances: run.failedInstances,
            model: config.modelName,
          }
        })))
      } else {
        if (allRuns.length === 0) {
          console.log('No runs found.')
        } else {
          console.log(`Found ${allRuns.length} run(s):\n`)
          const colW = [36, 12, 8, 10, 8]
          const header = [
            'Run ID'.padEnd(colW[0]),
            'Status'.padEnd(colW[1]),
            'Total'.padEnd(colW[2]),
            'Completed'.padEnd(colW[3]),
            'Failed'.padEnd(colW[4]),
          ].join('  ')
          console.log(header)
          console.log('-'.repeat(header.length))
          for (const run of allRuns) {
            const row = [
              run.runId.slice(0, colW[0]).padEnd(colW[0]),
              run.status.padEnd(colW[1]),
              String(run.totalInstances).padEnd(colW[2]),
              String(run.completedInstances).padEnd(colW[3]),
              String(run.failedInstances).padEnd(colW[4]),
            ].join('  ')
            console.log(row)
          }
        }
      }
    }

    db.close()
  })
