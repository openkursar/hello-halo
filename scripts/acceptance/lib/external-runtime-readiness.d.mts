export function externalRuntimeFailure(runtimeId: 'anthropic' | 'codex', options?: {
  environment?: NodeJS.ProcessEnv
  digest?: (file: string) => Promise<string>
}): Promise<string | null>
