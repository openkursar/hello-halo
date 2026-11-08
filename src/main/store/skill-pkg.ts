import { zipSync, strToU8 } from 'fflate'
import type { SkillSpec } from '../apps/spec'
import { skillFilesOf } from '../../shared/skill-frontmatter'

/** Maximum total uncompressed size, mirroring the dhpkg cap. */
const MAX_PACK_BYTES = 50 * 1024 * 1024

/**
 * Pack a skill into a `.zip` of its folder files, with `SKILL.md` at the root.
 *
 * Skills distribute as their file tree (SKILL.md + assets), not a `spec.yaml`
 * package — that is what separates the skill format from dhpkg. The output is
 * consumable by the skill `.zip` import path. A single-file skill (no
 * `skill_files`) falls back to a lone `SKILL.md` entry from `skill_content`.
 */
export function packSkill(spec: SkillSpec): Buffer {
  const found = skillFilesOf(spec)
  const files = Object.keys(found).length > 0 ? found : { 'SKILL.md': '' }

  const entries: Record<string, Uint8Array> = {}
  let totalBytes = 0
  for (const [rawPath, content] of Object.entries(files)) {
    const normalized = rawPath.replace(/^\/+/, '').replace(/\\/g, '/')
    if (!normalized) continue
    // Reject path traversal: a skill's files are always relative to its own
    // folder, so a `..` segment would let a crafted package escape its
    // extraction root on import. Fail loudly rather than ship an unsafe archive.
    if (normalized.split('/').some((seg) => seg === '..')) {
      throw new Error(`[skill-pkg/pack] Unsafe path in skill files: ${rawPath}`)
    }
    const bytes = strToU8(content)
    totalBytes += bytes.byteLength
    if (totalBytes > MAX_PACK_BYTES) {
      throw new Error(
        `[skill-pkg/pack] Archive exceeds ${MAX_PACK_BYTES} bytes (current ${totalBytes}). ` +
        `Move large binary assets out of the skill.`
      )
    }
    entries[normalized] = bytes
  }

  const archive = zipSync(entries, { level: 6 })
  return Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength)
}
