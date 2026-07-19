/**
 * Tlon Knowledge Base - Cross-process Type Definitions
 *
 * Shared between main process, preload, and renderer. Keep this file
 * renderer-safe: no Node/Electron runtime imports.
 *
 * Storage model (see src/main/services/tlon/paths.ts):
 *   ~/.halo/knowledge-bases-index.json   — registry (KBIndexV1)
 *   ~/.halo/knowledge-bases/<uuid>/       — per-KB directory
 *     meta.json index.md log.md raw/ text/ .ingest/hashes.json  (wiki/ is legacy)
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
  /** Source documents extracted into text/ and thus queryable. */
  indexedCount: number
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

/**
 * Persisted learned-status facts (the source of truth for "learned").
 * Keyed by raw-relative path (for raw/) or absolute path (for linked dirs).
 *
 * `textPath` is the text/-relative path of the extracted plaintext (agentic
 * search). `empty` marks a source whose extraction yielded no text, so it is
 * not retried on every launch (distinct from a legacy entry that predates
 * text extraction and has neither field). `lastError` records why the latest
 * extraction attempt failed; such entries retry on the next scan.
 */
export interface IngestHashesV1 {
  version: 1
  files: Record<string, { hash: string; ingestedAt: string; textPath?: string; empty?: boolean; lastError?: string }>
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
 * current file content. `state` refines it: 'no-text' = extraction found
 * nothing (e.g. scanned PDF), 'failed' = last extraction threw (`error`
 * carries the message), 'pending' = not yet learned.
 */
export interface RawFileStatus {
  name: string
  /** Raw-relative path for `raw` sources; absolute path for `linked` sources. */
  path: string
  size: number
  learned: boolean
  state: 'learned' | 'pending' | 'no-text' | 'failed'
  error?: string
  /** 'raw' = added directly (copied into raw/); 'linked' = from a watched folder. */
  source: 'raw' | 'linked'
  /** Watched-folder label, set only for `linked` sources (for grouping). */
  dirLabel?: string
}

/**
 * A source document a KB chat answer actually drew from, for clickable
 * citations. `path` is the absolute path of the original file, openable in the
 * Content Canvas.
 */
export interface KBSource {
  name: string
  path: string
}

export interface IngestProgressEvent {
  kbId: KnowledgeBaseId
  /** Batch total. Grows if the watcher enqueues more files mid-batch. */
  total: number
  completed: number
  /** Filename currently being processed */
  current?: string
  phase: 'idle' | 'running' | 'done' | 'error'
  error?: string
  /** Per-file extraction failures accumulated over the batch. */
  errors?: Array<{ file: string; message: string }>
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
