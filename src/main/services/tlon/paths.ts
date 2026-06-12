/**
 * Tlon path helpers — pure functions over getHaloDir().
 *
 * Layout:
 *   ~/.halo/
 *     knowledge-bases-index.json          (registry, KBIndexV1)
 *     knowledge-bases/<uuid>/
 *       meta.json schema.md index.md log.md
 *       raw/  wiki/  .ingest/hashes.json
 */

import { join } from 'path'
import { getHaloDir } from '../../foundation/config.service'
import type { KnowledgeBaseId } from '../../../shared/types/tlon'

/** Root directory containing all knowledge bases. */
export function getTlonRoot(): string {
  return join(getHaloDir(), 'knowledge-bases')
}

/** Registry file path (~/.halo/knowledge-bases-index.json). */
export function getKBIndexPath(): string {
  return join(getHaloDir(), 'knowledge-bases-index.json')
}

export function getKBDir(id: KnowledgeBaseId): string {
  return join(getTlonRoot(), id)
}

export function getKBMetaPath(id: KnowledgeBaseId): string {
  return join(getKBDir(id), 'meta.json')
}

export function getKBSchemaPath(id: KnowledgeBaseId): string {
  return join(getKBDir(id), 'schema.md')
}

export function getKBIndexMdPath(id: KnowledgeBaseId): string {
  return join(getKBDir(id), 'index.md')
}

export function getKBLogPath(id: KnowledgeBaseId): string {
  return join(getKBDir(id), 'log.md')
}

export function getKBRawDir(id: KnowledgeBaseId): string {
  return join(getKBDir(id), 'raw')
}

export function getKBWikiDir(id: KnowledgeBaseId): string {
  return join(getKBDir(id), 'wiki')
}

export function getKBIngestDir(id: KnowledgeBaseId): string {
  return join(getKBDir(id), '.ingest')
}

export function getKBHashesPath(id: KnowledgeBaseId): string {
  return join(getKBIngestDir(id), 'hashes.json')
}
