/**
 * Shared types for the SWE-Bench Verified evaluation harness.
 */

/** A single SWE-Bench Verified instance from HuggingFace dataset */
export interface SWEBenchInstance {
  instance_id: string         // e.g. "django__django-12345"
  repo: string                // e.g. "django/django"
  base_commit: string         // git commit hash to start from
  problem_statement: string   // the GitHub issue text
  hints_text: string          // optional hints
  created_at: string
  patch: string               // gold patch (reference only, never shown to agent)
  test_patch: string
  FAIL_TO_PASS: string        // JSON-encoded string array
  PASS_TO_PASS: string        // JSON-encoded string array
  environment_setup_commit: string
  version: string
}

/** Prediction entry in swebench format */
export interface Prediction {
  instance_id: string
  model_patch: string         // git diff output (empty string if no changes)
  model_name_or_path: string  // identifier like "agent-sdk/deepseek-v3.2"
}

/** Configuration for a full evaluation run */
export interface RunConfig {
  runId: string
  modelName: string           // e.g. "deepseek/deepseek-v3.2"
  providerType: string        // e.g. "openrouter"
  apiKey: string
  apiUrl?: string
  concurrency: number         // parallel workers (3-5)
  maxTurns: number            // max agent turns per instance (default 50)
  instanceIds?: string[]      // if set, only run these specific instances
  limit?: number              // if set, only run first N instances
  datasetPath: string         // path to local JSONL dataset cache
  outputDir: string           // where to write predictions + logs
  repoCache: string           // directory to cache cloned repos
}

/** Result for a single instance */
export interface InstanceResult {
  instanceId: string
  runId: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
  patch: string | null        // git diff output
  error: string | null
  startedAt: string | null
  completedAt: string | null
  inputTokens: number
  outputTokens: number
  turns: number
  agentLog: string | null     // summary of agent actions
}

/** Database record for a run */
export interface RunRecord {
  runId: string
  config: string              // JSON-serialized RunConfig
  createdAt: string
  status: 'running' | 'completed' | 'failed'
  totalInstances: number
  completedInstances: number
  failedInstances: number
}

/** Result from Python swebench evaluation */
export interface EvalScore {
  runId: string
  resolvedCount: number
  totalCount: number
  resolvedRate: number        // 0-1
  resolvedIds: string[]
  unresolved: string[]
  errorIds: string[]
  rawOutput: string
}
