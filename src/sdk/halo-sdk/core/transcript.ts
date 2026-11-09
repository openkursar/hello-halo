/**
 * @module core/transcript
 * Session transcript persistence — read/write JSONL files.
 *
 * Transcript file path:
 *   <configDir>/projects/<project-dir>/<session-id>.jsonl
 *
 * where:
 *   - config dir = the configured env var, else `<home>/<userConfigDirName>`
 *   - project-dir = cwd.replace(/[^a-zA-Z0-9]/g, '-')
 *
 * @license MIT
 */

import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Message } from '../types/provider.js';
import type { SDKAssistantMessage } from './query-types.js';
import { getLogger } from '../utils/logger.js';
import { readTranscriptPage, isCompactCheckpoint, MAX_COMPACT_CHECKPOINT_BYTES, MAX_HISTORY_MESSAGES, type CompactCheckpointMessage } from './transcript-reader.js';
import { resolveConventions, userConfigDir, type AgentConventions } from './conventions.js';
import { isToolContextRecord, readToolContextSnapshot } from './tool-context/index.js';

export type { CompactCheckpointMessage } from './transcript-reader.js';

export interface TranscriptOptions {
  env?: Record<string, string | undefined>;
  conventions?: Partial<AgentConventions>;
}

const log = getLogger('Transcript');

// ---------------------------------------------------------------------------
// Module-level metadata helpers
// ---------------------------------------------------------------------------

/** Read the SDK version from the local package.json once at module load time. */
function readSdkVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const raw = fs.readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? '1.0.0';
  } catch {
    return '1.0.0';
  }
}

const SDK_VERSION: string = readSdkVersion();

/** Read git branch for a given cwd. Returns undefined silently on failure. */
function readGitBranch(cwd: string): string | undefined {
  try {
    return (
      execSync('git rev-parse --abbrev-ref HEAD', {
        cwd,
        encoding: 'utf-8',
        timeout: 2000,
        windowsHide: true,
      }).trim() || undefined
    );
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Get the user config directory — the configured env var first, then the
 * default under `$HOME`. See {@link userConfigDir}.
 */
function getConfigDir(options?: TranscriptOptions): string {
  return userConfigDir(options?.env, resolveConventions(options?.conventions));
}

/**
 * Convert a working directory path to the project directory name.
 * Replaces all non-alphanumeric characters with '-'.
 *
 * e.g., /Users/dev/Desktop/myproject → -Users-dev-Desktop-myproject
 */
function getProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Compute the full path to a session's transcript JSONL file.
 *
 * @param sessionId - The session UUID
 * @param cwd - The working directory for this session
 */
export function getTranscriptPath(sessionId: string, cwd: string, options?: TranscriptOptions): string {
  const configDir = getConfigDir(options);
  const projectDir = getProjectDir(cwd);
  return path.join(configDir, 'projects', projectDir, `${sessionId}.jsonl`);
}

// ---------------------------------------------------------------------------
// JSONL entry types
// ---------------------------------------------------------------------------

interface TranscriptUserEntry {
  toolContextVersion?: 1;
  type: 'user';
  message: Message;
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  timestamp: string;
  isSidechain: boolean;
  userType: 'external';
  cwd: string;
  version: string;
  gitBranch?: string;
}

interface TranscriptAssistantEntry {
  toolContextVersion?: 1;
  type: 'assistant';
  responseUuid?: string;
  message: Message;
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  timestamp: string;
  isSidechain: boolean;
  userType: 'external';
  cwd: string;
  version: string;
  gitBranch?: string;
}

export interface AssistantMetadataMessage {
  type: 'assistant_metadata';
  responseUuid: string;
  uuid: string;
  message: Omit<SDKAssistantMessage['message'], 'content'>;
}

type TranscriptMetadataEntry = Omit<TranscriptAssistantEntry, 'type' | 'message'> & AssistantMetadataMessage;
type TranscriptCompactEntry = Omit<TranscriptAssistantEntry, 'type' | 'message' | 'responseUuid'> & CompactCheckpointMessage;
type TranscriptEntry = TranscriptUserEntry | TranscriptAssistantEntry | TranscriptMetadataEntry | TranscriptCompactEntry;
type AssistantTranscriptRecord = Pick<TranscriptAssistantEntry, 'type' | 'message' | 'uuid' | 'responseUuid'> | AssistantMetadataMessage;

export function buildAssistantMetadataMessage(message: SDKAssistantMessage, responseUuid: string): AssistantMetadataMessage {
  const { content: _content, toolContext: _toolContext, ...metadata } = message.message as SDKAssistantMessage['message'] & Message;
  return { type: 'assistant_metadata', responseUuid, uuid: message.uuid, message: metadata };
}

/** Capture reduced history without borrowing mutable arrays from the running loop. */
export function buildCompactCheckpointMessage(messages: readonly Message[], summary: string): CompactCheckpointMessage {
  const snapshot = readToolContextSnapshot(messages);
  return { type: 'compact_checkpoint', checkpointVersion: snapshot ? 2 : 1, uuid: randomUUID(), summary, messages: structuredClone(messages) };
}

function transcriptLine(entry: TranscriptEntry): string {
  if ((entry.type === 'assistant' || entry.type === 'user') && entry.message.toolContext !== undefined &&
      !isToolContextRecord(entry.message.toolContext)) throw new TypeError('Invalid tool context journal metadata');
  const hasToolContext = (entry.type === 'assistant' || entry.type === 'user') && entry.message.toolContext !== undefined;
  const line = JSON.stringify(hasToolContext || entry.toolContextVersion === 1
    ? { toolContextVersion: 1, toolContextRecord: hasToolContext, ...entry } : entry);
  if (entry.type === 'compact_checkpoint') {
    if (!isCompactCheckpoint(entry as unknown as Record<string, unknown>)) {
      throw new RangeError(`Compact checkpoint requires 1 to ${MAX_HISTORY_MESSAGES} valid messages`);
    }
    if (Buffer.byteLength(line, 'utf8') > MAX_COMPACT_CHECKPOINT_BYTES) {
      throw new RangeError('Compact checkpoint exceeds the 16 MiB restoration limit');
    }
  }
  return line + '\n';
}

function withoutUsage(message: Message): Message {
  const stored = { ...message } as Message & { usage?: unknown };
  delete stored.usage;
  return stored;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Append a single transcript entry to the JSONL file.
 * Creates the file and parent directories if they don't exist.
 *
 * Errors are propagated to the caller so the writer can decide how to react
 * (the `TranscriptWriter` chain logs them; standalone callers may handle them
 * differently). Silently swallowing errors here would hide on-disk corruption
 * that later breaks session resume.
 *
 * @param transcriptPath - Full path to the .jsonl file
 * @param entry - Entry to append
 */
export async function appendToTranscript(
  transcriptPath: string,
  entry: TranscriptEntry,
): Promise<void> {
  const line = transcriptLine(entry);
  const dir = path.dirname(transcriptPath);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.appendFile(transcriptPath, line, 'utf8');
}

// ---------------------------------------------------------------------------
// Session transcript writer
// ---------------------------------------------------------------------------

/**
 * A stateful writer that appends messages to the session transcript.
 *
 * **Ordering guarantee.** All writes are serialized through an internal
 * promise chain. Two `writeXxxMessage()` calls issued in source order will
 * land on disk in the same order, regardless of whether callers `await`
 * them. This is essential for correctness because session resume reads the
 * JSONL file line-by-line and trusts the order — any reordering between
 * an assistant `tool_use` and the corresponding user `tool_result` would
 * produce orphan blocks that break the next API request.
 *
 * **Error visibility.** Write failures are logged through the SDK logger
 * rather than swallowed silently. Ordinary history writes are advisory.
 * Streaming execution checkpoints opt into strict errors so a tool never
 * starts after its call record failed to append.
 *
 * **Flush.** Call `flush()` before constructing a new session that resumes
 * the same `sessionId`, otherwise pending writes from the previous session
 * may not yet be on disk when the resumed history is read.
 */
export class TranscriptWriter {
  private readonly transcriptPath: string;
  private readonly sessionId: string;
  private readonly cwd: string;
  private readonly gitBranch: string | undefined;
  private lastUuid: string | null = null;
  private enabled: boolean;
  private writeFailed = false;
  private toolContextMode = false;

  /**
   * Tail of the serialized write chain. Each `writeXxxMessage()` call
   * appends a `.then(() => append(...))` link, so writes are processed
   * in submission order even when callers fire-and-forget. Errors are
   * caught at the link level to keep the chain alive.
   */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(sessionId: string, cwd: string, options?: TranscriptOptions) {
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.transcriptPath = getTranscriptPath(sessionId, cwd, options);
    // Only write if we have a valid cwd
    this.enabled = cwd.length > 0;
    // Read gitBranch once at construction time to avoid per-write subprocess overhead
    this.gitBranch = cwd.length > 0 ? readGitBranch(cwd) : undefined;
  }

  /** Append a user message to the transcript. */
  writeUserMessage(message: Message, options?: { strict?: boolean; existingUuid?: string }): Promise<string> {
    if (message.toolContext) this.setToolContextMode();
    const uuid = options?.existingUuid ?? randomUUID();
    if (!this.enabled) {
      this.lastUuid = uuid;
      return Promise.resolve(uuid);
    }
    const entry: TranscriptUserEntry = {
      ...(this.toolContextMode ? { toolContextVersion: 1 as const } : {}),
      type: 'user',
      message,
      uuid,
      parentUuid: this.lastUuid,
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      isSidechain: false,
      userType: 'external',
      cwd: this.cwd,
      version: SDK_VERSION,
      ...(this.gitBranch !== undefined && { gitBranch: this.gitBranch }),
    };
    this.lastUuid = uuid;
    return this.enqueue(entry, options?.strict).then(() => uuid);
  }

  /** Append an assistant message to the transcript.
   * @param existingUuid - If provided, use this UUID instead of generating a new one.
   *   Pass SDKAssistantMessage.uuid so that resumeSessionAt truncation works correctly.
   * @param options - Streamed blocks share a local response UUID; strict writes
   *   reject on append failure before the corresponding tool is allowed to run.
   */
  writeAssistantMessage(message: Message, existingUuid?: string, options?: { responseUuid?: string; strict?: boolean }): Promise<string> {
    return this.writeAssistantRecord({
      type: 'assistant',
      ...(options?.responseUuid ? { responseUuid: options.responseUuid } : {}),
      message: options?.responseUuid ? withoutUsage(message) : message,
      uuid: existingUuid ?? randomUUID(),
    }, options?.strict);
  }

  /** Final response accounting is recorded once without repeating block content. */
  async writeAssistantMetadata(message: SDKAssistantMessage, responseUuid: string): Promise<void> {
    await this.writeAssistantRecord(buildAssistantMetadataMessage(message, responseUuid));
  }

  /** Append one self-contained replacement history; never discard the original journal. */
  async writeCompactCheckpoint(messages: readonly Message[], summary: string): Promise<void> {
    if (!this.enabled) return;
    const entry: TranscriptCompactEntry = {
      ...buildCompactCheckpointMessage(messages, summary),
      parentUuid: this.lastUuid,
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      isSidechain: false,
      userType: 'external',
      cwd: this.cwd,
      version: SDK_VERSION,
      ...(this.gitBranch !== undefined && { gitBranch: this.gitBranch }),
    };
    if (entry.checkpointVersion === 2) this.setToolContextMode();
    await this.enqueue(entry, true);
  }

  private writeAssistantRecord(record: AssistantTranscriptRecord, strict = false): Promise<string> {
    if (record.type === 'assistant' && record.message.toolContext) this.setToolContextMode();
    const { uuid } = record;
    if (!this.enabled) {
      this.lastUuid = uuid;
      return Promise.resolve(uuid);
    }
    const entry: TranscriptAssistantEntry | TranscriptMetadataEntry = {
      ...(this.toolContextMode ? { toolContextVersion: 1 as const } : {}),
      ...record,
      parentUuid: this.lastUuid,
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      isSidechain: false,
      userType: 'external',
      cwd: this.cwd,
      version: SDK_VERSION,
      ...(this.gitBranch !== undefined && { gitBranch: this.gitBranch }),
    };
    if (record.type === 'assistant') this.lastUuid = uuid;
    return this.enqueue(entry, strict).then(() => uuid);
  }

  /**
   * Wait for all queued writes to complete.
   *
   * Resolves once the current chain tail has settled. Any writes submitted
   * after this call returns are not awaited. Call this before resuming the
   * same `sessionId` from disk to guarantee the previous turn's messages
   * are durably persisted.
   */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  /** Get the path to the transcript file (for logging/debugging). */
  get path(): string {
    return this.transcriptPath;
  }

  get hasCompleteHistory(): boolean {
    return this.enabled && !this.writeFailed;
  }

  /** Called by a resumed owner before it appends new-format history without a fresh baseline. */
  setToolContextMode(): void { this.toolContextMode = true; }

  /**
   * Append a write to the serialized chain. Returns a promise that resolves
   * when this specific entry has been written. Strict callers receive append
   * errors; the shared queue recovers so subsequent writes can still proceed.
   */
  private enqueue(entry: TranscriptEntry, strict = false): Promise<void> {
    const next = this.writeChain.then(() => appendToTranscript(this.transcriptPath, entry));
    this.writeChain = next.catch((err: unknown) => {
      this.writeFailed = true;
      log.warn('failed to append entry; transcript may be incomplete on resume', {
        path: this.transcriptPath,
        entryType: entry.type,
        err: err instanceof Error ? err.message : String(err),
      });
    });
    return strict ? next : this.writeChain;
  }
}

// ---------------------------------------------------------------------------
// Read (for resume)
// ---------------------------------------------------------------------------

/**
 * Check if a transcript file exists for the given session.
 *
 * @param sessionId - The session ID to check
 * @param cwd - The working directory
 * @returns true if the transcript file exists and is readable
 */
export function transcriptExists(sessionId: string, cwd: string, options?: TranscriptOptions): boolean {
  const transcriptPath = getTranscriptPath(sessionId, cwd, options);
  try {
    fs.accessSync(transcriptPath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Archived sidechain records
// ---------------------------------------------------------------------------
//
// Older SDK versions stored related conversation records under their source
// session. This section reads that archive and never creates execution state:
//
//   <configDir>/projects/<projectDir>/<parentSessionId>/subagents/agent-<agentId>.jsonl
//
// Current collaborator histories use ordinary session transcripts.

/**
 * Locate the historical records belonging to a source session.
 */
export function getLegacyRecordDirectory(parentSessionId: string, cwd: string, options?: TranscriptOptions): string {
  const configDir = getConfigDir(options);
  const projectDir = getProjectDir(cwd);
  return path.join(configDir, 'projects', projectDir, parentSessionId, 'subagents');
}

/**
 * Locate one historical transcript record.
 */
export function getLegacyRecordPath(
  parentSessionId: string,
  agentId: string,
  cwd: string,
  options?: TranscriptOptions,
): string {
  return path.join(getLegacyRecordDirectory(parentSessionId, cwd, options), `agent-${agentId}.jsonl`);
}

/**
 * List historical transcript identifiers belonging to a source session.
 * The filename convention belongs to the stored format, not an executable catalog.
 */
export async function listLegacyRecordIds(
  parentSessionId: string,
  cwd: string,
  options?: TranscriptOptions,
): Promise<string[]> {
  const dir = getLegacyRecordDirectory(parentSessionId, cwd, options);
  try {
    const files = await fs.promises.readdir(dir);
    const ids: string[] = [];
    for (const file of files) {
      if (file.startsWith('agent-') && file.endsWith('.jsonl')) {
        ids.push(file.slice('agent-'.length, -'.jsonl'.length));
      }
    }
    return ids;
  } catch {
    return [];
  }
}

/**
 * Read a historical transcript record as ordinary session messages.
 *
 * @param parentSessionId - Parent session ID
 * @param agentId - Historical record identifier
 * @param cwd - Working directory of the parent session
 * @param options - Optional limit and offset for pagination
 */
export async function readLegacyRecordMessages(
  parentSessionId: string,
  agentId: string,
  cwd: string,
  options?: TranscriptOptions & { limit?: number; offset?: number },
): Promise<Array<{ type: string; uuid: string; session_id: string; message: unknown; parent_tool_use_id: string | null }>> {
  const transcriptPath = getLegacyRecordPath(parentSessionId, agentId, cwd, options);

  return readTranscriptPage(transcriptPath, agentId, options);
}
