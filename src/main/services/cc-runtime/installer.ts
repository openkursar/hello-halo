import type { CcDownloadSource, CcInstallProgress } from '../../../shared/types/cc-runtime'
import { getRuntime } from '../external-runtime'
export const downloadAndPublish = (source: CcDownloadSource, version: string, signal: AbortSignal, progress: (value: CcInstallProgress) => void) => getRuntime('anthropic').installer.downloadAndPublish(source, version, signal, progress)
