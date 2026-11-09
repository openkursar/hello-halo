/**
 * Agent runner — runs the Agent SDK on a single SWE-Bench instance.
 *
 * Flow:
 *   1. Clone/update repo into a temp working directory using a bare cache
 *   2. Build the OpenRouter provider via createWellKnownProvider
 *   3. Construct the SWE-Bench prompt
 *   4. Run query() and collect SDKMessages
 *   5. Collect git diff after the agent finishes
 *   6. Return InstanceResult
 */

import { execSync } from 'child_process'
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Import SDK from parent — tsx resolves .ts imports directly
import { query } from '../../index.ts'
import { createWellKnownProvider, createProvider } from '../../llm/provider.ts'
import type { SDKMessage } from '../../core/query-types.ts'
import type { SWEBenchInstance, RunConfig, InstanceResult } from './types.ts'

// ---------------------------------------------------------------------------
// Provider headers
// ---------------------------------------------------------------------------

/**
 * Extra request headers for the OAuth-gated Qwen portal, supplied by the
 * operator as a JSON object in `QWEN_OAUTH_HEADERS`. Nothing is hardcoded —
 * the required set depends on the account and endpoint being used.
 */
function qwenOAuthHeaders(): Record<string, string> {
  const raw = process.env.QWEN_OAUTH_HEADERS
  if (!raw) return {}
  try {
    return JSON.parse(raw) as Record<string, string>
  } catch {
    console.warn('[eval] QWEN_OAUTH_HEADERS is not valid JSON — ignoring.')
    return {}
  }
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

function buildSWEBenchPrompt(instance: SWEBenchInstance): string {
  return `You are an expert software engineer working on a real GitHub issue.

Repository: ${instance.repo}

ISSUE:
${instance.problem_statement}

Your task:
- Analyze the issue carefully
- Explore the codebase using available tools (Read, Grep, Glob, Bash)
- Implement a minimal, targeted fix
- Do NOT run the full test suite (environment not set up for it)
- Do NOT commit your changes
- When finished, simply stop — the framework collects your changes automatically

The repository is at the correct base commit. Start by understanding the issue, then locate and fix the relevant code.`
}

// ---------------------------------------------------------------------------
// Repo setup helpers
// ---------------------------------------------------------------------------

function ensureRepoCache(repo: string, repoCache: string): string {
  const [org, repoName] = repo.split('/')
  if (!org || !repoName) throw new Error(`Invalid repo format: ${repo}`)

  const orgDir = join(repoCache, org)
  if (!existsSync(orgDir)) {
    mkdirSync(orgDir, { recursive: true })
  }

  const cacheDir = join(orgDir, `${repoName}.git`)

  if (existsSync(cacheDir)) {
    // Update the bare clone
    try {
      execSync(`git -C "${cacheDir}" fetch origin --quiet`, { stdio: 'pipe' })
    } catch {
      // Fetch failure is non-fatal; we may still have the commit locally
    }
  } else {
    // Fresh bare clone
    execSync(
      `git clone --bare "https://github.com/${repo}.git" "${cacheDir}"`,
      { stdio: 'pipe', timeout: 300_000 }
    )
  }

  return cacheDir
}

function createWorkDir(cacheDir: string, baseCommit: string): string {
  const workDir = mkdtempSync(join(tmpdir(), 'swe-bench-'))

  execSync(`git clone "${cacheDir}" "${workDir}"`, { stdio: 'pipe', timeout: 120_000 })
  execSync(`git -C "${workDir}" checkout "${baseCommit}" --quiet`, { stdio: 'pipe' })

  return workDir
}

// ---------------------------------------------------------------------------
// SDKMessage parsing helpers
// ---------------------------------------------------------------------------

interface ParsedStats {
  inputTokens: number
  outputTokens: number
  turns: number
  agentLog: string
}

function parseMessages(messages: SDKMessage[]): ParsedStats {
  let inputTokens = 0
  let outputTokens = 0
  let turns = 0
  const logLines: string[] = []

  for (const msg of messages) {
    if (msg.type === 'assistant') {
      turns++
      // Extract text content for the agent log (first 200 chars per turn)
      for (const block of msg.message.content) {
        if (block.type === 'text' && block.text) {
          const snippet = block.text.slice(0, 200).replace(/\n/g, ' ')
          logLines.push(`[turn ${turns}] ${snippet}`)
          break
        }
      }
      // Collect token usage from assistant messages
      if (msg.usage) {
        inputTokens += msg.usage.input_tokens ?? 0
        outputTokens += msg.usage.output_tokens ?? 0
      }
    } else if (msg.type === 'result') {
      // The result message has authoritative cumulative usage
      if (msg.usage) {
        inputTokens = msg.usage.input_tokens ?? inputTokens
        outputTokens = msg.usage.output_tokens ?? outputTokens
      }
      turns = msg.num_turns ?? turns
    }
  }

  return {
    inputTokens,
    outputTokens,
    turns,
    agentLog: logLines.slice(0, 20).join('\n'),
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function runInstance(
  instance: SWEBenchInstance,
  config: RunConfig,
): Promise<InstanceResult> {
  const startedAt = new Date().toISOString()
  let workDir: string | null = null

  const baseResult: InstanceResult = {
    instanceId: instance.instance_id,
    runId: config.runId,
    status: 'failed',
    patch: null,
    error: null,
    startedAt,
    completedAt: null,
    inputTokens: 0,
    outputTokens: 0,
    turns: 0,
    agentLog: null,
  }

  try {
    // 1. Repo setup with caching
    const cacheDir = ensureRepoCache(instance.repo, config.repoCache)
    workDir = createWorkDir(cacheDir, instance.base_commit)

    // 2. Build provider
    let provider
    if (config.providerType === 'qwen-oauth') {
      // Qwen OAuth (portal.qwen.ai) — requires custom headers; not a well-known provider
      // portal.qwen.ai requires stream:true and returns reasoning in reasoning_content field
      provider = createProvider({
        type: 'openai-compat',
        apiKey: config.apiKey,
        baseUrl: config.apiUrl ?? 'https://portal.qwen.ai/v1',
        defaultModel: config.modelName,
        headers: qwenOAuthHeaders(),
        providerId: 'qwen-oauth',
        providerName: 'Qwen (OAuth)',
        quirks: {
          reasoningField: 'reasoning_content',
          includeUsageInStream: true,
        },
      })
    } else {
      provider = createWellKnownProvider(config.providerType, {
        apiKey: config.apiKey,
        defaultModel: config.modelName,
        ...(config.apiUrl ? { baseUrl: config.apiUrl } : {}),
      })
    }

    // 3. Build prompt
    const prompt = buildSWEBenchPrompt(instance)

    // 4. Run agent
    const messages: SDKMessage[] = []
    const q = query({
      prompt,
      options: {
        provider,
        cwd: workDir,
        permissionMode: 'bypassPermissions',
        maxTurns: config.maxTurns,
        model: config.modelName,
      },
    })

    for await (const msg of q) {
      messages.push(msg)
    }

    // Check for SDK-level execution error (e.g. API 402, auth failure)
    const resultMsg = messages.find(m => m.type === 'result')
    if (resultMsg && resultMsg.type === 'result' && resultMsg.is_error) {
      const errText = resultMsg.errors?.join('; ') ?? resultMsg.result ?? 'SDK error_during_execution'
      throw new Error(errText)
    }

    // 5. Parse messages
    const stats = parseMessages(messages)

    // 6. Collect git diff
    try {
      execSync(`git -C "${workDir}" add -A`, { stdio: 'pipe' })
    } catch {
      // If add fails, diff may still work against HEAD
    }
    let patch = ''
    try {
      patch = execSync(`git -C "${workDir}" diff --cached HEAD`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 50 * 1024 * 1024, // 50MB
      })
    } catch {
      // If cached diff fails, try unstaged diff
      try {
        patch = execSync(`git -C "${workDir}" diff HEAD`, {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
          maxBuffer: 50 * 1024 * 1024,
        })
      } catch {
        patch = ''
      }
    }

    return {
      ...baseResult,
      status: 'completed',
      patch,
      error: null,
      completedAt: new Date().toISOString(),
      inputTokens: stats.inputTokens,
      outputTokens: stats.outputTokens,
      turns: stats.turns,
      agentLog: stats.agentLog,
    }
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    return {
      ...baseResult,
      status: 'failed',
      error: errorMsg.slice(0, 2000),
      completedAt: new Date().toISOString(),
    }
  } finally {
    // Cleanup work dir (keep cache)
    if (workDir) {
      try {
        rmSync(workDir, { recursive: true, force: true })
      } catch {
        // Non-fatal
      }
    }
  }
}
