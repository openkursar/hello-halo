import type { AISourcesConfig } from './ai-sources'
import { CLI_DELEGATED_PROVIDER_ID } from '../constants/claude-models'

export type CcCompatibility = 'verified' | 'compatible' | 'incompatible' | 'unavailable' | 'unchecked'

export type CcRuntimeIssue =
  | 'not-found' | 'not-executable' | 'unsupported-launcher' | 'version-unrecognized'
  | 'version-too-old' | 'probe-timeout' | 'probe-busy' | 'protocol-unsupported' | 'process-failed'
  | 'install-busy' | 'invalid-source' | 'invalid-version' | 'download-failed'
  | 'invalid-manifest' | 'unsupported-platform' | 'checksum-mismatch'
  | 'version-mismatch' | 'cancelled' | 'storage-failed'
  | 'version-not-found' | 'source-unreachable' | 'source-timeout' | 'source-unauthorized'

export interface CcDownloadSource {
  id: string
  name: string
  baseUrl: string
}

export interface CcRuntimeConfig {
  selectedPath?: string
  selectionOrigin?: 'user'
  sourceId?: string
  sources?: CcDownloadSource[]
  installVersion?: string
  /** Written by earlier releases' startup discovery; read-compatible, never written. */
  discoveryCompleted?: boolean
}

export function hasExplicitCcSelection(config?: CcRuntimeConfig, sources?: AISourcesConfig): boolean {
  if (config?.selectionOrigin === 'user') return true
  const selected = sources?.version === 2 ? sources.sources.find(source => source.id === sources.currentId) : undefined
  return selected?.authType === 'delegated' && selected.provider === CLI_DELEGATED_PROVIDER_ID
}

export type CcRuntimePreferences = Pick<CcRuntimeConfig, 'sources' | 'sourceId' | 'installVersion'>

export interface CcInstallation {
  path: string
  resolvedPath?: string
  kind?: 'native' | 'javascript'
  version?: string
  compatibility: CcCompatibility
  recommended: boolean
  managed: boolean
  sourceId?: string
  installedAt?: string
  checkedAt?: string
  issue?: CcRuntimeIssue
}

export interface CcRuntimeLaunch {
  command: string
  argsPrefix: string[]
  env: Record<string, string>
  path: string
  kind: 'native' | 'javascript'
  version: string
}

export interface CcInstallRequest {
  version?: string
  sourceId?: string
  preferences?: CcRuntimePreferences
}

export interface CcReleaseInfo {
  requestedVersion: string
  version: string
  sourceId: string
  platform: string
  checksum: string
  size?: number
  installedPath?: string
  recommended: boolean
}

export interface CcInstallProgress {
  phase: 'idle' | 'manifest' | 'downloading' | 'verifying' | 'checking' | 'complete' | 'error' | 'cancelled'
  version?: string
  downloadedBytes: number
  totalBytes?: number
  issue?: CcRuntimeIssue
}

export interface CcRuntimeStatus {
  /** Effective explicit selection; ambiguous legacy paths remain in the installation catalog. */
  selectedPath?: string
  selected: CcInstallation | null
  installations: CcInstallation[]
  catalogTruncated: boolean
  sources: CcDownloadSource[]
  sourceId: string
  installVersion: string
  recommendedVersion: string
  recommendedRange: string
  verifiedVersions: string[]
  install: CcInstallProgress
}

export interface CcScanResult {
  installations: CcInstallation[]
  searchedLocations: number
  truncated: boolean
}
