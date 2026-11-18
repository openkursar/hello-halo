/** Text a toolset carries into compacted context, read when compaction starts. */
export type CompactionContextReader = (signal: AbortSignal) => string | null | Promise<string | null>

const readers = new WeakMap<object, CompactionContextReader>()

/** Bind trusted host state without adding policy to an MCP transport record. */
export function markCompactionContextReader<T extends object>(server: T, reader: CompactionContextReader): T {
  readers.set(server, reader)
  return server
}

export function getCompactionContextReader(server: unknown): CompactionContextReader | undefined {
  return server && typeof server === 'object' ? readers.get(server) : undefined
}

/** A `PreCompact` hook matcher that returns the reader's text as `additionalContext`. */
export function compactionContextHook(reader: CompactionContextReader) {
  return {
    timeout: 5,
    hooks: [async (_input: unknown, _toolUseId: string | undefined, { signal }: { signal: AbortSignal }) => {
      const context = await reader(signal)
      return context ? { additionalContext: context } : {}
    }],
  }
}
