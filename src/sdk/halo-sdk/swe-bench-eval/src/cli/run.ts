/**
 * `swe-eval run` command — runs agent inference on SWE-Bench instances.
 */

import { Command } from 'commander'
import { randomUUID } from 'crypto'
import { mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { loadDataset, filterInstances } from '../dataset.ts'
import { Database } from '../storage.ts'
import { runBatch } from '../batch-runner.ts'
import type { RunConfig } from '../types.ts'

export const runCommand = new Command('run')
  .description('Run agent inference on SWE-Bench Verified instances')
  .option('--limit <n>', 'Only run first N instances', (v) => parseInt(v, 10))
  .option('--concurrency <n>', 'Parallel workers', (v) => parseInt(v, 10), 3)
  .option('--max-turns <n>', 'Max agent turns per instance', (v) => parseInt(v, 10), 50)
  .requiredOption('--model <model>', 'Model name (explicit selection required)')
  .requiredOption('--provider <type>', 'qwen-oauth or an SDK provider name such as openrouter or deepseek (explicit selection required)')
  .option('--api-key <key>', 'API key / OAuth token (default: QWEN_TOKEN env for qwen-oauth, OPENROUTER_API_KEY for openrouter)')
  .option('--api-url <url>', 'Base URL override for the selected provider')
  .option('--instance <id>', 'Run specific instance ID (repeatable)', (val: string, prev: string[]) => [...prev, val], [] as string[])
  .option('--run-id <id>', 'Resume an existing run (uses existing run ID)')
  .option('--dataset <path>', 'Dataset JSONL path', './data/swe-bench-verified.jsonl')
  .option('--output <dir>', 'Output directory', './runs')
  .option('--repo-cache <dir>', 'Repo cache directory', join(homedir(), '.swe-bench-eval', 'repos'))
  .option('--dry-run', 'Show what would be run without executing')
  .action(async (opts: {
    limit?: number
    concurrency: number
    maxTurns: number
    model: string
    provider: string
    apiKey?: string
    apiUrl?: string
    instance: string[]
    runId?: string
    dataset: string
    output: string
    repoCache: string
    dryRun?: boolean
  }) => {
    // Resolve API key — check provider-specific env vars first
    let apiKey = opts.apiKey
    if (!apiKey) {
      if (opts.provider === 'qwen-oauth') {
        apiKey = process.env.QWEN_TOKEN
      } else if (opts.provider === 'openrouter') {
        apiKey = process.env.OPENROUTER_API_KEY
      } else {
        apiKey = process.env.LLM_API_KEY ?? process.env.OPENROUTER_API_KEY
      }
    }
    if (!apiKey) {
      console.error(`Error: --api-key or corresponding env var required (QWEN_TOKEN for qwen-oauth, OPENROUTER_API_KEY for openrouter, LLM_API_KEY otherwise)`)
      process.exit(1)
    }

    // Load dataset
    let instances
    try {
      instances = loadDataset(opts.dataset)
    } catch (err) {
      console.error(`Error loading dataset: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }

    // Filter instances
    instances = filterInstances(instances, {
      instanceIds: opts.instance.length > 0 ? opts.instance : undefined,
      limit: opts.limit,
    })

    if (instances.length === 0) {
      console.error('No instances to run after filtering.')
      process.exit(1)
    }

    const runId = opts.runId ?? `run-${Date.now()}-${randomUUID().slice(0, 8)}`

    const config: RunConfig = {
      runId,
      modelName: opts.model,
      providerType: opts.provider,
      apiKey,
      apiUrl: opts.apiUrl,
      concurrency: opts.concurrency,
      maxTurns: opts.maxTurns,
      instanceIds: opts.instance.length > 0 ? opts.instance : undefined,
      limit: opts.limit,
      datasetPath: opts.dataset,
      outputDir: opts.output,
      repoCache: opts.repoCache,
    }

    if (opts.dryRun) {
      console.log(`Dry run — would process ${instances.length} instances`)
      console.log(`Run ID:      ${runId}`)
      console.log(`Provider:    ${opts.provider}`)
      console.log(`Model:       ${opts.model}`)
      console.log(`Concurrency: ${opts.concurrency}`)
      console.log(`Max turns:   ${opts.maxTurns}`)
      console.log(`Output:      ${opts.output}`)
      console.log(`Repo cache:  ${opts.repoCache}`)
      console.log('\nFirst 5 instance IDs:')
      for (const inst of instances.slice(0, 5)) {
        console.log(`  ${inst.instance_id}`)
      }
      return
    }

    // Ensure output dir exists
    if (!existsSync(opts.output)) {
      mkdirSync(opts.output, { recursive: true })
    }

    // Ensure repo cache dir exists
    if (!existsSync(opts.repoCache)) {
      mkdirSync(opts.repoCache, { recursive: true })
    }

    const db = new Database(opts.output)

    // Create run record (or resume existing)
    const existingRun = db.getRun(runId)
    if (!existingRun) {
      db.createRun(runId, config, instances.length)
      console.log(`Created run: ${runId}`)
    } else {
      console.log(`Resuming run: ${runId}`)
    }

    console.log(`Processing ${instances.length} instances with concurrency ${opts.concurrency}...`)

    const startTime = Date.now()

    await runBatch(instances, config, db, (completed, total, lastResult) => {
      const pct = Math.round((completed / total) * 100)
      const elapsed = Math.round((Date.now() - startTime) / 1000)
      const rate = completed > 0 ? (elapsed / completed).toFixed(1) : '?'
      const eta = completed > 0 ? Math.round(((total - completed) * elapsed) / completed) : 0
      process.stdout.write(
        `\r[${pct}%] ${completed}/${total} | Last: ${lastResult.id} (${lastResult.status}) | ${elapsed}s elapsed | ~${eta}s remaining | ${rate}s/instance  `
      )
    })

    console.log('\n')

    db.updateRunStatus(runId, 'completed')

    const run = db.getRun(runId)
    const results = db.getRunResults(runId)
    const completedCount = results.filter(r => r.status === 'completed').length
    const failedCount = results.filter(r => r.status === 'failed').length

    console.log('=== Run Summary ===')
    console.log(`Run ID:     ${runId}`)
    console.log(`Completed:  ${completedCount}/${instances.length}`)
    console.log(`Failed:     ${failedCount}/${instances.length}`)
    console.log(`Total time: ${Math.round((Date.now() - startTime) / 1000)}s`)
    if (run) {
      console.log(`DB:         ${join(opts.output, 'swe-bench.db')}`)
    }

    db.close()
  })
