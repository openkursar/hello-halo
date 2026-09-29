/**
 * apps/manager -- Default App Seed
 *
 * Seeds a "Halo AI 数字人模板" default automation app when no automation-type apps
 * exist. Runs as a Tier 3 idle task so it never blocks startup. Failures
 * are logged as warnings and do not affect any functionality.
 *
 * Idempotency: subsequent launches skip seeding because an automation app
 * already exists. Skill/MCP apps are ignored — only automation apps count.
 *
 * Built-in awareness: if the build ships at least one built-in automation
 * digital human (resources/builtin-apps/, materialized by the builtin loader),
 * this seed is skipped entirely — the bundled apps already give the user a
 * useful starting point and adding "Halo 助手" on top would clutter the UI.
 */

import { DEFAULT_SPACE_ID } from '../../../shared/apps/install-scope'
import type { AppManagerService } from './types'
import type { AutomationSpec } from '../spec'
import { countBuiltinAppsOnDisk } from './builtin-loader'

/** Space ID for the default temporary space */
const SEED_SPACE_ID = DEFAULT_SPACE_ID

/** Default app spec — no subscriptions (IM / manual-trigger only) */
const DEFAULT_APP_SPEC: AutomationSpec = {
  spec_version: '1',
  name: 'Halo AI 数字人模板',
  version: '1.0',
  author: 'Halo',
  description: '默认数字人，可绑定 IM 机器人或手动对话',
  type: 'automation',
  system_prompt: [
    '你是 AI 数字人，一个有用的 AI 助手。',
    '准确、简洁地回答用户的问题。',
    '如果不确定，请诚实告知。',
  ].join('\n'),
  // No subscriptions — pure IM/manual mode
}

/**
 * Seed the default app if no automation apps exist AND no built-ins ship
 * with this build.
 *
 * The built-in check is intentionally based on the on-disk manifest, not on
 * what the loader has already inserted — the loader runs as a sibling idle
 * task and the order between the two is not guaranteed. Reading the manifest
 * is cheap (single small JSON file) and lets this seed make a correct decision
 * regardless of timing.
 *
 * @param appManager - The initialized AppManagerService
 */
export async function seedDefaultAppIfNeeded(appManager: AppManagerService): Promise<void> {
  const automationApps = appManager.listApps({ type: 'automation' })
  if (automationApps.length > 0) {
    console.log(`[Seed] Skipped — ${automationApps.length} automation app(s) already exist`)
    return
  }

  const builtinCount = countBuiltinAppsOnDisk()
  if (builtinCount > 0) {
    console.log(`[Seed] Skipped — ${builtinCount} built-in app(s) bundled with this build will be installed by the loader`)
    return
  }

  console.log('[Seed] No automation apps found — seeding default "Halo 助手" app')

  try {
    const appId = await appManager.install(SEED_SPACE_ID, DEFAULT_APP_SPEC)
    console.log(`[Seed] Default app installed: id=${appId}, space=${SEED_SPACE_ID}`)
  } catch (err) {
    console.warn('[Seed] Failed to seed default app (non-critical):', err)
  }
}
