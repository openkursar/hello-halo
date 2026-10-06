export interface FileFingerprint {
  path: string
  role: string
  bytes: number
  sha256: string
  mtimeMs: number
  ctimeMs: number
  inode: number
}
export interface ContentManifest { count: number; rootSha256: string; files: FileFingerprint[] }
export interface GitContext { sha: string; dirty: boolean; statusSha256?: string }
export interface ContentIdentityReference {
  runId: string
  witnessPath: string
  recordSha256: string
  sourceSha256: string
  artifactSha256: string
  harnessSha256: string
  fixtureSha256: string
  expectedElectron: string
  launchId?: string
  observedRuntime?: ObservedRuntime
}
export interface ContentSnapshot {
  source: ContentManifest
  inputs: ContentManifest
  artifacts: ContentManifest
  harness: ContentManifest
  fixtures: ContentManifest
  external: ContentManifest | null
  runtime: {
    expectedElectron: string
    executable: string
    executableSha256: string
    distributionRoot: string
    manifest: ContentManifest
    tooling: Record<string, { version: string; packageSha256: string }>
    collectorNode: string
    platform: string
    arch: string
  } | null
  artifactKind: string
  artifactDir: string
  productionMain: string
  sampledAt: string
}
export interface ContentBuildRecord {
  schemaVersion: number
  sha: string
  dirty: boolean
  git: GitContext
  artifactKind: string
  recordedAt: string
  freshness: { kind: string; sourceBinding: string; mainMtimeMs: number; newestInputMtimeMs: number }
  content: ContentSnapshot
}
export interface ObservedRuntime {
  electron: string
  chromium: string
  node: string
  pid: number
  execPath: string
  appPath: string
  appVersion: string
  appData: string
  userData: string
}
export const SCHEMA_VERSION: number
export const SIDECAR_NAME: string
export const ARTIFACT_LAYOUTS: Array<{ dir: string; kind: string }>
export function atomicJson(file: string, value: unknown): void
export function gitCatalogue(root: string): string[]
export function gitContext(root: string): GitContext
export function fingerprintFile(file: string, name: string, role: string): Promise<FileFingerprint>
export function manifestFromFiles(files: FileFingerprint[]): ContentManifest
export function validateManifest(manifest: ContentManifest, role: string): ContentManifest
export function snapshotContent(root: string, options?: { artifactDir?: string; includeRuntime?: boolean }): Promise<ContentSnapshot>
export function assertBuildFreshness(snapshot: ContentSnapshot): ContentBuildRecord['freshness']
export function createBuildRecord(snapshot: ContentSnapshot, git: GitContext): ContentBuildRecord
export function compareSnapshots(recorded: ContentSnapshot, current: ContentSnapshot, options?: { includeHarness?: boolean }): true
export function recordBuild(root: string, options?: { artifactDir?: string }): Promise<ContentBuildRecord>
export function verifyBuild(root: string, options?: { artifactDir?: string }): Promise<{ record: ContentBuildRecord; current: ContentSnapshot; git: GitContext }>
export function beginRun(root: string, resultDir: string, options?: { artifactDir?: string }): Promise<{ file: string; run: Record<string, unknown> }>
export function readRunReference(file: string): ContentIdentityReference
export function readBuildReference(file: string): { schemaVersion: number; sha: string; dirty: boolean; artifactKind: string; identity: ContentIdentityReference }
export function readReportReference(file: string): ReturnType<typeof readBuildReference>
export function validateObservedRuntime(run: unknown, evidence: unknown): true
export function finishRun(file: string): Promise<Record<string, unknown>>
export function prepareLaunch(runFile: string, options: { productionMain: string; entryPath: string; bootstrap: string; launchArgs: string[] }): Promise<string>
export function observeLaunch(file: string, observed: ObservedRuntime, launchExecutable: string, actualArgs: string[]): void
export function closeLaunch(file: string): void
export function failLaunch(file: string, error: unknown): void
export function verifyFrozenResults(root: string, results: unknown[], options?: { resultDir?: string; compareTo?: string }): Promise<Record<string, unknown>>
