import type * as Cc from './cc-runtime'

export type RuntimeId = 'anthropic' | 'codex'
export type RuntimeCompatibility = Cc.CcCompatibility
export type RuntimeIssue = Cc.CcRuntimeIssue
export type RuntimeDownloadSource = Cc.CcDownloadSource
export type RuntimeConfig = Cc.CcRuntimeConfig
export type RuntimePreferences = Cc.CcRuntimePreferences
export type RuntimeInstallation = Cc.CcInstallation
export interface RuntimeLaunch extends Cc.CcRuntimeLaunch { pathDirs?: string[] }
export type RuntimeInstallRequest = Cc.CcInstallRequest
export type RuntimeReleaseInfo = Cc.CcReleaseInfo
export type RuntimeInstallProgress = Cc.CcInstallProgress
export type RuntimeStatus = Cc.CcRuntimeStatus
export type RuntimeScanResult = Cc.CcScanResult
