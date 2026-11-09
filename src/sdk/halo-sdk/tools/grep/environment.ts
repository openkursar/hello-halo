import * as path from 'node:path';

/** Windows environment names are case-insensitive; do not leave PATH/Path duplicates for spawn. */
export function ripgrepEnvironment(
  overrides: Record<string, string | undefined> | undefined,
  inherited: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (platform !== 'win32') return { ...inherited, ...overrides };
  const env: NodeJS.ProcessEnv = {};
  for (const source of [inherited, overrides]) {
    for (const [key, value] of Object.entries(source ?? {})) env[key.toUpperCase()] = value;
  }
  return env;
}

/** Relative executable overrides are ignored so lookup retains its PATH semantics. */
export function ripgrepCommand(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  const configured = env.AGENT_RIPGREP_PATH;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  return configured && paths.isAbsolute(configured) ? configured : 'rg';
}
