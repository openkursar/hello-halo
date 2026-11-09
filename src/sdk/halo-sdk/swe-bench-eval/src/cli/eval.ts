/**
 * `swe-eval eval` command — invokes Python swebench for scoring.
 */

import { Command } from 'commander'
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs'
import { execSync, spawnSync } from 'child_process'
import { join } from 'path'
import { Database } from '../storage.ts'
import type { Prediction, EvalScore } from '../types.ts'

export const evalCommand = new Command('eval')
  .description('Score a completed run using the Python swebench harness')
  .requiredOption('--run-id <id>', 'Run ID to evaluate')
  .option('--output <dir>', 'Output directory (must match the run)', './runs')
  .option('--max-workers <n>', 'Parallel evaluation workers', (v) => parseInt(v, 10), 4)
  .option('--dataset <name>', 'SWE-bench dataset name', 'princeton-nlp/SWE-bench_Verified')
  .option('--namespace <ns>', 'Docker namespace (pass empty string for ARM)')
  .action(async (opts: {
    runId: string
    output: string
    maxWorkers: number
    dataset: string
    namespace?: string
  }) => {
    const db = new Database(opts.output)
    const run = db.getRun(opts.runId)

    if (!run) {
      console.error(`Error: Run "${opts.runId}" not found in ${opts.output}/swe-bench.db`)
      db.close()
      process.exit(1)
    }

    const results = db.getRunResults(opts.runId)
    const completedResults = results.filter(r => r.status === 'completed')

    if (completedResults.length === 0) {
      console.error('Error: No completed results to evaluate.')
      db.close()
      process.exit(1)
    }

    const config = JSON.parse(run.config) as { modelName?: string }
    const modelName = config.modelName ?? 'agent-sdk/unknown'

    // Build predictions JSONL
    const predictions: Prediction[] = completedResults.map(r => ({
      instance_id: r.instanceId,
      model_patch: r.patch ?? '',
      model_name_or_path: `agent-sdk/${modelName}`,
    }))

    const predictionsDir = join(opts.output, opts.runId)
    if (!existsSync(predictionsDir)) {
      mkdirSync(predictionsDir, { recursive: true })
    }
    const predictionsPath = join(predictionsDir, 'predictions.jsonl')
    writeFileSync(predictionsPath, predictions.map(p => JSON.stringify(p)).join('\n') + '\n', 'utf-8')
    console.log(`Wrote ${predictions.length} predictions to ${predictionsPath}`)

    // Detect architecture for namespace auto-detection
    let useEmptyNamespace = false
    if (opts.namespace !== undefined) {
      useEmptyNamespace = opts.namespace === ''
    } else {
      try {
        const arch = execSync('uname -m', { encoding: 'utf-8' }).trim()
        useEmptyNamespace = arch === 'arm64' || arch === 'aarch64'
        if (useEmptyNamespace) {
          console.log(`Detected ARM architecture (${arch}) — using empty namespace`)
        }
      } catch {
        // uname failed — don't add namespace flag
      }
    }

    // Detect python binary — prefer python3.11 (where swebench is installed for ARM macOS)
    let pythonBin = 'python3'
    try {
      execSync('python3.11 -c "import swebench"', { stdio: 'pipe' })
      pythonBin = 'python3.11'
    } catch {
      // fall back to python3
    }

    // Build Python command
    const pyArgs: string[] = [
      '-m', 'swebench.harness.run_evaluation',
      '--predictions_path', predictionsPath,
      '--max_workers', String(opts.maxWorkers),
      '--run_id', opts.runId,
      '--dataset_name', opts.dataset,
    ]

    if (useEmptyNamespace) {
      pyArgs.push('--namespace', '')
    } else if (opts.namespace !== undefined && opts.namespace !== '') {
      pyArgs.push('--namespace', opts.namespace)
    }

    console.log(`Running: ${pythonBin} ${pyArgs.join(' ')}`)

    // Set DOCKER_HOST for colima socket so swebench can reach Docker
    const dockerHost = process.env.DOCKER_HOST ?? 'unix:///var/run/docker.sock'

    const result = spawnSync(pythonBin, pyArgs, {
      stdio: 'inherit',
      encoding: 'utf-8',
      env: {
        ...process.env,
        DOCKER_HOST: dockerHost,
      },
    })

    if (result.error) {
      console.error(`Failed to spawn Python: ${result.error.message}`)
      db.close()
      process.exit(1)
    }

    if (result.status !== 0) {
      console.error(`Python swebench evaluation exited with code ${result.status}`)
      db.close()
      process.exit(result.status ?? 1)
    }

    // Parse evaluation results
    // swebench writes results to evaluation_results/<run_id>/results.json
    const evalResultsPath = join('evaluation_results', opts.runId, 'results.json')
    let rawOutput = ''
    let score: EvalScore = {
      runId: opts.runId,
      resolvedCount: 0,
      totalCount: completedResults.length,
      resolvedRate: 0,
      resolvedIds: [],
      unresolved: [],
      errorIds: [],
      rawOutput: '',
    }

    try {
      rawOutput = readFileSync(evalResultsPath, 'utf-8')
      const parsed = JSON.parse(rawOutput) as {
        resolved?: string[]
        unresolved?: string[]
        error_ids?: string[]
        total?: number
        resolved_rate?: number
      }

      const resolvedIds = parsed.resolved ?? []
      const unresolved = parsed.unresolved ?? []
      const errorIds = parsed.error_ids ?? []
      const resolvedCount = resolvedIds.length
      const totalCount = parsed.total ?? completedResults.length
      const resolvedRate = totalCount > 0 ? resolvedCount / totalCount : 0

      score = {
        runId: opts.runId,
        resolvedCount,
        totalCount,
        resolvedRate,
        resolvedIds,
        unresolved,
        errorIds,
        rawOutput,
      }
    } catch (err) {
      console.warn(`Warning: Could not parse evaluation results from ${evalResultsPath}`)
      console.warn(`You can manually inspect the results directory.`)
      score.rawOutput = `Parse error: ${err instanceof Error ? err.message : String(err)}`
    }

    db.saveEvalScore(score)
    db.close()

    console.log('\n=== Evaluation Results ===')
    console.log(`Run ID:        ${opts.runId}`)
    console.log(`Resolved:      ${score.resolvedCount} / ${score.totalCount}`)
    console.log(`Resolved rate: ${(score.resolvedRate * 100).toFixed(2)}%`)
    if (score.errorIds.length > 0) {
      console.log(`Errors:        ${score.errorIds.length}`)
    }
  })
