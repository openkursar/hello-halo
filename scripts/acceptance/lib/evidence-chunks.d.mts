export function evidenceChunks(value: unknown, root: string, environment?: NodeJS.ProcessEnv): {
  manifest: { version: number; encoding: string; byteLength: number; sha256: string; count: number; chunkBytes: number; redacted: boolean }
  chunks(): Generator<{ index: number; byteLength: number; sha256: string; data: string }>
}
