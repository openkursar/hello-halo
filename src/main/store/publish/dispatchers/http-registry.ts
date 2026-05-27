/**
 * Publish dispatcher for a private HTTP registry.
 *
 * Wire protocol (matches DHP v2 registry server in digital-human-protocol):
 *   POST <registry-url>/apps
 *     Content-Type: multipart/form-data
 *     Authorization: Bearer <token>
 *     File parts:
 *       spec     — the spec.yaml content (required)
 *       <name>   — any auxiliary file; the part name IS the relative path
 *                  inside the bundle (e.g. "SKILL.md", "references/guide.md")
 *   Response 200 OK    : { slug, version, verdict, report, path, checksum, size_bytes }
 *   Response 422       : { slug, version, verdict, report } (review hard-failed)
 *   Response 4xx text  : http.Error message body
 *
 * Token is read from `registryOverrides.<id>.publish.token` in product.json.
 */

import { stringify as yamlStringify } from 'yaml'
import type { AppSpec } from '../../../apps/spec'
import type { PublishContext, PublishResult } from '../types'

interface HttpRegistryConfig {
  /** Override registry url. Defaults to ctx.registryUrl. */
  url?: string
  token?: string
}

export async function dispatch(
  spec: AppSpec,
  files: Record<string, string | Buffer>,
  ctx: PublishContext,
  config: HttpRegistryConfig,
): Promise<PublishResult> {
  const url = config.url ?? ctx.registryUrl
  if (!url) {
    return {
      status: 'error',
      target: 'http-registry',
      details: 'http-registry publish target requires a registry URL (set via registryOverrides or product config)',
    }
  }

  if (!config.token || config.token === 'REPLACE_AT_DEPLOY_TIME') {
    return {
      status: 'error',
      target: 'http-registry',
      details: 'http-registry token is not configured (registryOverrides.<id>.publish.token).',
    }
  }

  // The wire-format spec lists skill files by name only — the file contents
  // travel as separate multipart parts (added below). The client-side
  // SkillSpec keeps them as a `Record<path, content>` map for local editing
  // convenience, so we project that map to a string[] before serialization.
  const specForWire = projectSpecForWire(spec)
  const yaml = yamlStringify(specForWire)
  const endpoint = `${url.replace(/\/+$/, '')}/apps`

  const form = new FormData()
  // 'spec' is the required part name the server reads via r.FormFile("spec").
  form.append(
    'spec',
    new Blob([yaml], { type: 'application/x-yaml' }),
    'spec.yaml',
  )

  // Auxiliary files: the form-field NAME is the file's relative path inside
  // the bundle. The server iterates r.MultipartForm.File and uses fh.Filename
  // as the storage key under apps/<slug>/<version>/files/<name>.
  let auxBytes = 0
  for (const [rawPath, value] of Object.entries(files)) {
    const normalized = rawPath.replace(/^\/+/, '').replace(/\\/g, '/')
    if (!normalized || normalized === 'spec.yaml') continue
    const bytes = typeof value === 'string'
      ? new TextEncoder().encode(value)
      : value instanceof Buffer
        ? new Uint8Array(value)
        : value
    auxBytes += bytes.byteLength
    form.append(
      normalized,
      new Blob([bytes], { type: 'application/octet-stream' }),
      normalized,
    )
  }

  console.log(
    `[publish/http-registry] POST ${endpoint} ` +
    `(spec=${yaml.length}B, ${Object.keys(files).length} files / ${auxBytes}B aux)`
  )

  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.token}` },
      body: form,
    })
  } catch (err) {
    return {
      status: 'error',
      target: 'http-registry',
      details: `Network error talking to registry: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  // Server responses are not always JSON. http.Error sends text/plain.
  // Shape matches server/internal/rules/runner.go Report/Verdict — field
  // names here must track that struct (json tags) exactly.
  let body: {
    slug?: string
    version?: string
    verdict?: string
    comment?: string
    report?: {
      overall?: string
      verdicts?: Array<{ rule: string; severity: string; message: string; requires_human?: boolean }>
    }
  } = {}
  let rawBody = ''
  const contentType = response.headers.get('content-type') ?? ''
  try {
    if (contentType.includes('application/json')) {
      body = await response.json() as typeof body
    } else {
      rawBody = await response.text()
    }
  } catch (err) {
    rawBody = `(failed to read response body: ${err instanceof Error ? err.message : String(err)})`
  }

  if (!response.ok) {
    // Surface as much of the actual failure as possible.
    // Surface anything that isn't a clean pass, plus warn-level verdicts that
    // tripped the human-review threshold — those are precisely the cases where
    // the user needs to see why publish was blocked.
    const ruleSummary = body.report?.verdicts
      ?.filter(r => (r.severity !== 'pass' && r.severity !== 'warn') || r.requires_human)
      .map(r => `  - [${r.severity}] ${r.rule}: ${r.message}`)
      .join('\n')
    const detailParts = [
      `Registry returned HTTP ${response.status}${response.statusText ? ' ' + response.statusText : ''}`,
    ]
    if (body.verdict) detailParts.push(`verdict=${body.verdict}`)
    if (body.comment) detailParts.push(body.comment)
    if (rawBody) detailParts.push(rawBody.trim())
    if (ruleSummary) detailParts.push('Review findings:\n' + ruleSummary)
    return {
      status: 'error',
      target: 'http-registry',
      details: detailParts.join(' — '),
    }
  }

  const verdict = body.verdict ?? 'submitted'
  const message =
    verdict === 'approved'
      ? `Published. ${body.comment ?? ''}`
      : verdict === 'rejected'
        ? `Rejected by registry: ${body.comment ?? '(no comment)'}`
        : `Submitted (verdict=${verdict}): ${body.comment ?? ''}`

  console.log(`[publish/http-registry] ${spec.name} -> ${verdict}`)
  return {
    status: verdict === 'rejected' ? 'error' : 'success',
    target: 'http-registry',
    details: message,
    verdict,
  }
}

/**
 * Strip inline file contents from the spec so the wire-format spec.yaml
 * only carries metadata. For skill specs, `skill_files` is a content-bearing
 * map locally but the registry expects a name-only list ([]string in Go).
 *
 * Keep this transformation here (not in the SkillSpec type) — local editing
 * needs the map form, only the publish wire format needs the list form.
 */
function projectSpecForWire(spec: AppSpec): AppSpec {
  if (spec.type !== 'skill') return spec
  const skillFiles = (spec as { skill_files?: unknown }).skill_files
  if (!skillFiles || Array.isArray(skillFiles) || typeof skillFiles !== 'object') {
    return spec
  }
  return {
    ...spec,
    skill_files: Object.keys(skillFiles as Record<string, unknown>).filter(n => n !== 'spec.yaml'),
  } as AppSpec
}
