/**
 * OSS publish dispatcher.
 *
 * Packs the spec into a temporary `.dhpkg` and opens a pre-filled GitHub
 * new-issue URL so the user can attach the artifact manually. The full
 * OAuth + PR flow is not yet wired.
 */

import { shell } from 'electron'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pack } from '../../dhpkg'
import type { AppSpec } from '../../../apps/spec'
import type { PublishContext, PublishResult } from '../types'

interface GithubPrConfig {
  github?: { owner: string; repo: string; clientId?: string }
}

export async function dispatch(
  spec: AppSpec,
  files: Record<string, string | Buffer>,
  ctx: PublishContext,
  config: GithubPrConfig,
): Promise<PublishResult> {
  if (!config.github?.owner || !config.github?.repo) {
    return {
      status: 'error',
      target: 'github-pr',
      details: 'GitHub publish target is missing required github.owner/github.repo in product.json',
    }
  }

  const { owner, repo } = config.github
  console.log(`[publish/github-pr] Dispatching for ${spec.name} -> ${owner}/${repo}`)

  const buf = await pack(spec, files)
  const dir = mkdtempSync(join(tmpdir(), 'halo-dhpkg-'))
  const safeName = spec.name.replace(/[^a-z0-9-]/gi, '-').toLowerCase()
  const outPath = join(dir, `${safeName}-${spec.version ?? '0.0.0'}.dhpkg`)
  writeFileSync(outPath, buf)
  console.log(`[publish/github-pr] Wrote staging package: ${outPath}`)

  const title = encodeURIComponent(`Publish: ${spec.name} v${spec.version ?? '0.0.0'}`)
  const body = encodeURIComponent(
    `Submitting App: **${spec.name}** v${spec.version ?? '0.0.0'}\n\n` +
    `Author: ${spec.author ?? 'unknown'}\n` +
    `Type: ${spec.type}\n` +
    `Slug: ${spec.store?.slug ?? '(none)'}\n\n` +
    `Local .dhpkg artifact: \`${outPath}\`\n\n` +
    `_(This issue was opened from Halo. Attach the .dhpkg file above for manual review.)_`
  )
  const newPrUrl = `https://github.com/${owner}/${repo}/issues/new?title=${title}&body=${body}`

  try {
    await shell.openExternal(newPrUrl)
  } catch (err) {
    return {
      status: 'error',
      target: 'github-pr',
      details: `Failed to open browser: ${err instanceof Error ? err.message : String(err)}`,
      stagingPath: outPath,
    }
  }

  void ctx

  return {
    status: 'stubbed',
    target: 'github-pr',
    details:
      `Opened https://github.com/${owner}/${repo}/issues/new in your browser. ` +
      `Attach the .dhpkg file at: ${outPath}`,
    stagingPath: outPath,
    url: newPrUrl,
  }
}
