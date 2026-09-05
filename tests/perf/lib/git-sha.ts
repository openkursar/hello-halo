import { execSync } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const projectRoot = path.resolve(path.dirname(__filename), '../../..')

/** Current HEAD sha of the outer repo, used to tag every result JSON. */
export function getGitSha(): string {
  try {
    return execSync('git rev-parse HEAD', { cwd: projectRoot, encoding: 'utf-8' }).trim()
  } catch {
    return 'unknown'
  }
}
