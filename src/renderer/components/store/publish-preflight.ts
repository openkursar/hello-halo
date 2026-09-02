/**
 * Local publish pre-flight: a client-side scan run before a spec is
 * submitted to the registry, so obvious problems surface instantly instead of
 * after a network round-trip and a server-side rejection.
 *
 * Three checks: leaked secrets in the prompt/skill body (blocking), version
 * monotonicity against the already-published version (blocking), and required
 * display fields (name blocking, description advisory). Findings are structured
 * — the UI translates each `code` — so the rules stay pure and unit-testable.
 */

import { compareDotVersions } from '../../../shared/store/version-compare'
import type { AppSpec } from '../../../shared/apps/spec-types'

export type PreflightCode =
  | 'secret-detected'
  | 'version-not-incremented'
  | 'missing-name'
  | 'missing-description'
  /** Not produced by `runPublishPreflight` — it needs the async skill-dependency
   * classification `useAssociatedSkills` already fetches, so the caller appends
   * it into the same findings list instead of duplicating that lookup here. */
  | 'missing-skill-dependency'

export interface PreflightFinding {
  severity: 'error' | 'warning'
  code: PreflightCode
  /** Non-secret context for the message (e.g. secret kind, version pair). Never the secret value itself. */
  detail?: string
}

/** High-confidence credential shapes. Matching the shape (not asserting the
 * value is live) is enough to block — a real key committed to a shared listing
 * is a leak regardless. Only the human-readable kind is surfaced, never the match. */
const SECRET_PATTERNS: ReadonlyArray<{ kind: string; re: RegExp }> = [
  { kind: 'Anthropic API key', re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { kind: 'OpenAI API key', re: /sk-[A-Za-z0-9]{20,}/ },
  { kind: 'AWS access key', re: /AKIA[0-9A-Z]{16}/ },
  { kind: 'Google API key', re: /AIza[0-9A-Za-z_-]{35}/ },
  { kind: 'GitHub token', re: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { kind: 'Slack token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { kind: 'Private key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
]

/** Collect the free-text bodies a creator authored, where a pasted secret would hide. */
function scanTargets(spec: AppSpec): string[] {
  if (spec.type === 'automation') return [spec.system_prompt ?? '']
  if (spec.type === 'skill') {
    const files = spec.skill_files ? Object.values(spec.skill_files) : []
    return spec.skill_content ? [spec.skill_content, ...files] : files
  }
  return []
}

export interface PreflightInput {
  spec: AppSpec
  /** Current version in the store index, or null when unpublished (skips the monotonicity check). */
  storeVersion?: string | null
  /** Effective display values from the publish form — snapshot edits override the spec. */
  overrideName?: string
  overrideDescription?: string
  /** Version entered in the publish form; checked in place of the spec's own. */
  overrideVersion?: string
}

export function runPublishPreflight({ spec, storeVersion, overrideName, overrideDescription, overrideVersion }: PreflightInput): PreflightFinding[] {
  const findings: PreflightFinding[] = []

  const seenKinds = new Set<string>()
  for (const body of scanTargets(spec)) {
    for (const { kind, re } of SECRET_PATTERNS) {
      if (!seenKinds.has(kind) && re.test(body)) {
        seenKinds.add(kind)
        findings.push({ severity: 'error', code: 'secret-detected', detail: kind })
      }
    }
  }

  const localVersion = (overrideVersion?.trim() || spec.version)?.trim()
  if (storeVersion && localVersion && compareDotVersions(localVersion, storeVersion) <= 0) {
    findings.push({ severity: 'error', code: 'version-not-incremented', detail: `${localVersion} ≤ ${storeVersion}` })
  }

  const name = (overrideName ?? spec.name)?.trim()
  if (!name) findings.push({ severity: 'error', code: 'missing-name' })

  const description = (overrideDescription ?? spec.description)?.trim()
  if (!description) findings.push({ severity: 'warning', code: 'missing-description' })

  return findings
}
