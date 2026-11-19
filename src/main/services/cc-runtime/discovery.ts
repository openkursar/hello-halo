import { getRuntime } from '../external-runtime'
export const discoverInstallations = (selectedPath?: string, options: { signal?: AbortSignal; stopOnCompatible?: boolean; deadlineMs?: number } = {}) => getRuntime('anthropic').discovery.discoverInstallations(selectedPath, options)
