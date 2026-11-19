import { getRuntimeRoot as runtimeRoot, isManagedPath as managedPath, claudeCodeProvider } from '../external-runtime/compatibility'
export { normalizeInputPath, fileExists, resolveCandidate, resolveCandidatePath } from '../external-runtime/compatibility'
export type { ResolvedCandidate } from '../external-runtime/compatibility'
export const getRuntimeRoot = () => runtimeRoot(claudeCodeProvider)
export const isManagedPath = (path: string) => managedPath(claudeCodeProvider, path)
