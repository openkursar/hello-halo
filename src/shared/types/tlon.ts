/**
 * Tlon Knowledge Base - Cross-process Type Definitions
 *
 * Shared between main process, preload, and renderer. Keep this file
 * renderer-safe: no Node/Electron runtime imports.
 *
 * Storage model (see src/main/services/tlon/paths.ts):
 *   ~/.halo/knowledge-bases-index.json   — registry (KBIndexV1)
 *   ~/.halo/knowledge-bases/<uuid>/       — per-KB directory
 *     meta.json schema.md index.md log.md raw/ wiki/ .ingest/hashes.json
 */

export type KnowledgeBaseId = string

export type KBStatus = 'active' | 'paused' | 'error'

export type IngestStatus = 'pending' | 'running' | 'completed' | 'error' | 'skipped'

/** A directory outside raw/ that the KB watches and ingests in-place. */
export interface LinkedDirectory {
  id: string
  path: string
  label: string
  watching: boolean
  lastScannedAt?: string
}

export interface KBStats {
  rawFileCount: number
  wikiPageCount: number
  rawSizeBytes: number
  lastIngestAt?: string
}

export interface KnowledgeBaseEntry {
  id: KnowledgeBaseId
  name: string
  icon: string
  description: string
  status: KBStatus
  createdAt: string
  updatedAt: string
  /** Absolute path to ~/.halo/knowledge-bases/<uuid>/ */
  path: string
  linkedDirs: LinkedDirectory[]
  spaceIds: string[]
  appIds: string[]
  stats: KBStats
  /** At most one KB is the default; new conversations auto-load it. */
  isDefault?: boolean
}

/** Registry file persisted to ~/.halo/knowledge-bases-index.json */
export interface KBIndexV1 {
  version: 1
  knowledgeBases: Record<KnowledgeBaseId, KnowledgeBaseEntry>
}

export interface WikiPageMeta {
  /** Wiki-relative path, e.g. "topics/foo.md" */
  path: string
  title: string
  sources: string[]
  generatedAt: string
  sourceHash: string
}

/**
 * Persisted learned-status facts (the source of truth for "learned").
 * Keyed by raw-relative path (for raw/) or absolute path (for linked dirs).
 */
export interface IngestHashesV1 {
  version: 1
  files: Record<string, { hash: string; ingestedAt: string; wikiPages: string[] }>
}

export interface IngestJob {
  id: string
  kbId: KnowledgeBaseId
  /** Key used in hashes.json: raw-relative path or linked absolute path */
  sourcePath: string
  /** Real absolute path to read from */
  absolutePath: string
  sourceType: 'raw' | 'linked'
  status: IngestStatus
  contentHash?: string
  startedAt?: string
  completedAt?: string
  error?: string
  wikiPagesAffected?: string[]
}

/** Lightweight reference injected into agent/app system prompts. */
export interface KBReference {
  id: KnowledgeBaseId
  name: string
  indexContent: string
}

/**
 * Learned status the UI pulls (NOT derived from events).
 * `learned` is true IFF hashes.json has an entry whose hash matches the
 * current file content.
 */
export interface RawFileStatus {
  name: string
  /** Raw-relative path */
  path: string
  size: number
  learned: boolean
}

export interface IngestProgressEvent {
  kbId: KnowledgeBaseId
  /** Total in this batch — set ONCE after enqueue-all */
  total: number
  completed: number
  /** Filename currently being processed */
  current?: string
  phase: 'idle' | 'running' | 'done' | 'error'
  error?: string
}

export interface KBStatsUpdatedEvent {
  kbId: KnowledgeBaseId
  stats: KBStats
}

export interface CreateKBInput {
  name: string
  /** Vestigial — KBs render a single fixed line icon; not user-chosen. */
  icon?: string
  description?: string
  linkedDirs?: Array<{ path: string; label: string }>
}

export interface UpdateKBInput {
  name?: string
  icon?: string
  description?: string
  status?: KBStatus
}

export interface AddRawFilesResult {
  added: string[]
  rejected: string[]
}
