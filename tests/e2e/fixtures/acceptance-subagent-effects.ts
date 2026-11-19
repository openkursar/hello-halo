import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

export function subagentEffects(profile: string): { participants: string[]; workspaces: string[] } {
  const script = fileURLToPath(new URL('./subagent-effects.cjs', import.meta.url))
  const output = execFileSync(electronPath as unknown as string, [script, profile], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HOME: profile, USERPROFILE: profile },
    encoding: 'utf8', timeout: 10000,
  })
  return JSON.parse(output)
}
