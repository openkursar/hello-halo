/**
 * Halo Apps Conversation MCP Server
 *
 * Creates an in-process MCP server using Claude Agent SDK's
 * tool() and createSdkMcpServer() functions.
 *
 * Exposes app management tools to the AI during conversations so the
 * user can ask the AI to list, create, delete, pause, resume, or
 * manually trigger their installed automation apps.
 */

import { z } from 'zod'
import { tool, createSdkMcpServer } from '../../services/agent/resolved-sdk'
import { getAppManager } from '../manager'
import { AppAlreadyInstalledError } from '../manager/errors'
import { getAppRuntime } from '../runtime'
import { ConcurrencyLimitError } from '../runtime/errors'
import { validateAppSpec } from '../spec'
import { installFromStore, installRequiredSkills } from '../../store/registry.service'

// ============================================
// Helpers
// ============================================

/** Build a standard text content response. */
function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {})
  }
}

/** Error message returned when services are not yet initialised. */
const NOT_READY = 'App services are not initialized. Please try again shortly.'

/**
 * Wait for AppManager to become available (handles bootstrap race condition).
 * initPlatformAndApps() is fire-and-forget, so AppManager may not be ready
 * when the first MCP tool call arrives.
 */
async function waitForAppManager(maxMs = 5000, intervalMs = 200) {
  const manager = getAppManager()
  if (manager) return manager

  console.log('[HaloAppsMcp] AppManager not ready, waiting...')
  let waited = 0
  while (waited < maxMs) {
    await new Promise(r => setTimeout(r, intervalMs))
    waited += intervalMs
    const m = getAppManager()
    if (m) {
      console.log(`[HaloAppsMcp] AppManager ready after ${waited}ms`)
      return m
    }
  }
  console.error(`[HaloAppsMcp] AppManager still null after ${maxMs}ms — initPlatformAndApps may have failed`)
  return null
}

// ============================================
// Tool Factories (closed over spaceId)
// ============================================

function buildTools(spaceId: string) {
  const list_automation_apps = tool(
    'list_automation_apps',
    'List all automation apps installed in the current space. Returns app ID, name, description, status, and schedule.',
    {},
    async () => {
      try {
        const manager = await waitForAppManager()
        if (!manager) {
          return textResult(NOT_READY, true)
        }

        // Filter out uninstalled apps - they should not be visible to the AI
        const apps = manager.listApps({ spaceId }).filter(app => app.status !== 'uninstalled')

        if (apps.length === 0) {
          return textResult(`No automation apps installed in space ${spaceId}.`)
        }

        const lines = apps.map(app =>
          `- ID: ${app.id} | Name: ${app.spec.name} | Status: ${app.status} | Description: ${app.spec.description}`
        )

        return textResult(lines.join('\n'))
      } catch (e) {
        return textResult(`Error listing apps: ${(e as Error).message}`, true)
      }
    }
  )

  const create_automation_app = tool(
    'create_automation_app',
    'Create and install a new automation app (digital human) in the current space. ' +
    'Accepts a full App Spec object (type is forced to "automation"). Returns the new app ID on success.\n\n' +
    'IMPORTANT — Before calling this tool, you MUST confirm the following with the user:\n' +
    '  1. Schedule frequency — ask explicitly (e.g. every 30m / 1h / 24h / 7d, or a cron expression). Do NOT assume.\n' +
    '  2. Notifications — ask if they want desktop notifications on completion (output.notify.system: true, the default). External channel notifications (email, webhook, etc.) are AI-driven: during each run the digital human decides whether to notify via the notify_channel tool based on configured channels in Settings. No need to configure channels per-app.\n' +
    '  2b. IM Push — ask if they want the digital human to proactively send messages to IM contacts (e.g., WeCom bot chats). If yes, add "im-push" to permissions[]. The AI will use the notify_bot tool to decide when and whom to message.\n' +
    '  3. User-specific values — if the task requires URLs, keywords, API endpoints, or other dynamic inputs, define them as config_schema fields so the user can fill them in, rather than hardcoding guessed values.\n' +
    'Do NOT call this tool until you have the user\'s answers to the above. Guessing these values leads to a poor experience.\n\n' +
    'CRITICAL — config_schema restrictions:\n' +
    '  - NEVER create config fields for cookies, session tokens, or any login credentials. The App runs inside the user\'s Halo browser with shared session — authentication is automatic.\n\n' +
    'spec schema (JSON object):\n' +
    '  name*: string — Short descriptive name\n' +
    '  description*: string — One sentence describing what this automation does\n' +
    '  system_prompt*: string — The sole driver of this automation. Follow the user\'s task requirements to craft a high-quality automation prompt using strong prompt-engineering practices. Mentally execute the task end-to-end as if you were the runtime agent — every action, decision, and edge case you encounter during this simulation should be captured in the prompt. The agent receives no other context.\n' +
    '    CRITICAL — AI BROWSER: Any task involving web interaction (visiting pages, clicking, filling forms, posting comments, monitoring pages, scraping, etc.) MUST include "ai-browser" in permissions AND instruct the agent to use ai_browser tools. Do NOT use HTTP fetch or MCP for browser tasks.\n' +
    '  subscriptions*: array — At least one trigger source. Each item:\n' +
    '    { source: { type: "schedule", config: { every?: "30m"|"1h"|"24h"|"7d", cron?: string } } }\n' +
    '    { source: { type: "file", config: { pattern?: string, path?: string } } }\n' +
    '    { source: { type: "webhook", config: { path?: string, secret?: string } } }\n' +
    '    { source: { type: "webpage", config: { watch?: string, selector?: string, url?: string } } }\n' +
    '    { source: { type: "rss", config: { url?: string } } }\n' +
    '    { source: { type: "custom", config: Record<string,unknown> } }\n' +
    '  requires?: { mcps?: [{ id: string, reason?: string }], skills?: string[] } — External MCP/skill dependencies\n' +
    '  output?: { notify?: { system?: boolean }, format?: string } — notification config (system desktop notification). External channel notifications are AI-driven at runtime.\n' +
    '  filters?: array — Filter rules: [{ field: string, op: "eq"|"neq"|"contains"|"matches"|"gt"|"lt"|"gte"|"lte", value: any }]\n' +
    '  config_schema?: array — User configuration fields: [{ key, label, type: "url"|"text"|"string"|"number"|"select"|"boolean"|"email", required?, description?, default?, placeholder?, options?: [{label,value}] }]\n' +
    '  permissions?: string[] — e.g. ["ai-browser", "im-push"]\n' +
    '  memory_schema?: Record<string, { type: string, description?: string }> — Persistent memory fields\n' +
    '  escalation?: { enabled?: boolean, timeout_hours?: number }\n' +
    '  version?: string (default "1.0")\n' +
    '  author?: string (default "Halo")',
    {
      spec: z.string().describe(
        'JSON string of the App Spec object. Must include name, description, system_prompt, and subscriptions. ' +
        'type is always "automation". version defaults to "1.0", author defaults to "Halo".'
      )
    },
    async (args) => {
      try {
        const manager = await waitForAppManager()
        if (!manager) {
          return textResult(NOT_READY, true)
        }

        // Parse the spec JSON
        let parsedSpec: Record<string, unknown>
        try {
          parsedSpec = JSON.parse(args.spec)
        } catch (e) {
          return textResult(`Invalid JSON in spec: ${(e as Error).message}`, true)
        }

        // Force automation type and apply defaults
        parsedSpec.type = 'automation'
        if (!parsedSpec.version) parsedSpec.version = '1.0'
        if (!parsedSpec.author) parsedSpec.author = 'Halo'

        // Validate using the canonical schema
        let validatedSpec
        try {
          validatedSpec = validateAppSpec(parsedSpec)
        } catch (e) {
          return textResult(`Spec validation failed: ${(e as Error).message}`, true)
        }

        const appId = await manager.install(spaceId, validatedSpec, {})

        // Dependency failure rolls back the app — never leave a partial install.
        try {
          await installRequiredSkills(validatedSpec, spaceId)
        } catch (depErr) {
          try {
            // deleteApp() only accepts 'uninstalled' apps — soft-delete first
            await manager.uninstall(appId)
            await manager.deleteApp(appId)
          } catch { /* rollback is best-effort; the original error matters more */ }
          return textResult(`App creation failed: ${(depErr as Error).message}`, true)
        }

        let activationWarning = ''
        const runtime = getAppRuntime()
        if (runtime) {
          try {
            await runtime.activate(appId)
          } catch (e) {
            activationWarning = ` Warning: activation failed: ${(e as Error).message}`
          }
        }

        return textResult(`App created successfully. ID: ${appId}.${activationWarning}`)
      } catch (e) {
        if (e instanceof AppAlreadyInstalledError) {
          return textResult(
            `A digital human named "${e.specId}" is already installed in this space. ` +
            `Ask the user whether to uninstall the existing one first, or pick a different name before retrying.`,
            true
          )
        }
        return textResult(`Error creating app: ${(e as Error).message}`, true)
      }
    }
  )

  const delete_automation_app = tool(
    'delete_automation_app',
    'Permanently delete an automation app. This stops the app and removes all its data.',
    {
      app_id: z.string().describe('The app ID to delete')
    },
    async (args) => {
      try {
        const manager = await waitForAppManager()
        const runtime = getAppRuntime()

        if (!manager) {
          return textResult(NOT_READY, true)
        }

        const app = manager.getApp(args.app_id)
        if (!app) {
          return textResult(`App not found: ${args.app_id}`, true)
        }

        let deactivateWarning = ''
        if (runtime) {
          try {
            await runtime.deactivate(args.app_id)
          } catch (e) {
            deactivateWarning = ` Warning: deactivation failed: ${(e as Error).message}`
          }
        }

        // Soft-delete first (required by deleteApp)
        if (app.status !== 'uninstalled') {
          await manager.uninstall(args.app_id)
        }

        // Hard-delete: permanently removes DB record and work directory
        await manager.deleteApp(args.app_id)

        return textResult(`App ${args.app_id} permanently deleted.${deactivateWarning}`)
      } catch (e) {
        return textResult(`Error deleting app: ${(e as Error).message}`, true)
      }
    }
  )

  const get_automation_status = tool(
    'get_automation_status',
    'Get the full details of an automation app, including its complete spec (system_prompt, subscriptions, ' +
    'config_schema, etc.), runtime status, last run time, and any errors.',
    {
      app_id: z.string().describe('The app ID')
    },
    async (args) => {
      try {
        const manager = await waitForAppManager()
        const runtime = getAppRuntime()

        if (!manager || !runtime) {
          return textResult(NOT_READY, true)
        }

        const app = manager.getApp(args.app_id)
        if (!app) {
          return textResult(`App not found: ${args.app_id}`, true)
        }

        const state = runtime.getAppState(args.app_id)

        const result = {
          id: app.id,
          status: app.status,
          runtime_status: state.status,
          last_run: state.lastRunAtMs ? new Date(state.lastRunAtMs).toISOString() : null,
          last_outcome: state.lastStatus ?? null,
          last_error: state.lastError ?? null,
          next_run: state.nextRunAtMs ? new Date(state.nextRunAtMs).toISOString() : null,
          spec: app.spec,
          user_config: app.userConfig,
          user_overrides: app.userOverrides,
        }

        return textResult(JSON.stringify(result, null, 2))
      } catch (e) {
        return textResult(`Error getting app status: ${(e as Error).message}`, true)
      }
    }
  )

  const pause_automation_app = tool(
    'pause_automation_app',
    'Pause an active automation app. It will stop running on schedule until resumed.',
    {
      app_id: z.string().describe('The app ID to pause')
    },
    async (args) => {
      try {
        const manager = await waitForAppManager()
        const runtime = getAppRuntime()

        if (!manager || !runtime) {
          return textResult(NOT_READY, true)
        }

        manager.pause(args.app_id)

        // Deactivate is best-effort -- removes scheduler jobs / event subscriptions
        try {
          await runtime.deactivate(args.app_id)
        } catch (e) {
          console.warn(`[HaloAppsMcp] deactivate best-effort failed for ${args.app_id}:`, e)
        }

        return textResult(`Successfully paused app ${args.app_id}. It will not run again until resumed.`)
      } catch (e) {
        return textResult(`Error pausing app: ${(e as Error).message}`, true)
      }
    }
  )

  const resume_automation_app = tool(
    'resume_automation_app',
    'Resume a paused automation app. It will run on schedule again.',
    {
      app_id: z.string().describe('The app ID to resume')
    },
    async (args) => {
      try {
        const manager = await waitForAppManager()
        const runtime = getAppRuntime()

        if (!manager || !runtime) {
          return textResult(NOT_READY, true)
        }

        manager.resume(args.app_id)

        // Activate is best-effort -- re-registers scheduler jobs / event subscriptions
        try {
          await runtime.activate(args.app_id)
        } catch (e) {
          console.warn(`[HaloAppsMcp] activate best-effort failed for ${args.app_id}:`, e)
        }

        return textResult(`Successfully resumed app ${args.app_id}. It is now active and will run on schedule.`)
      } catch (e) {
        return textResult(`Error resuming app: ${(e as Error).message}`, true)
      }
    }
  )

  const update_automation_app = tool(
    'update_automation_app',
    'Update an existing automation app using JSON Merge Patch semantics.\n\n' +
    'IMPORTANT: Always call get_automation_status first to read the current spec before updating.\n\n' +
    'Only provide the fields you want to change — omitted fields are preserved.\n' +
    'Set a field to null to remove it (e.g. "filters": null removes filters).\n\n' +
    'Parameters:\n' +
    '  app_id*: string — The app ID to update\n' +
    '  updates*: string (JSON) — Fields to update. Supports:\n' +
    '    frequency?: string — Shorthand to update the schedule interval (e.g. "30m", "2h", "1d"). ' +
    'Automatically updates the primary subscription schedule.\n' +
    '    name?: string — New display name\n' +
    '    description?: string — New description\n' +
    '    system_prompt?: string — New system prompt\n' +
    '    subscriptions?: array — Full replacement of subscriptions array\n' +
    '    config_schema?: array — Full replacement of config schema\n' +
    '    output?: object | null — Output settings\n' +
    '    filters?: array | null — Filter rules\n' +
    '    memory_schema?: object | null — Memory schema\n' +
    '    escalation?: object | null — Escalation config\n' +
    '    permissions?: string[] — Permission list\n\n' +
    'Examples:\n' +
    '  Change frequency: {"frequency": "30m"}\n' +
    '  Change prompt: {"system_prompt": "New instructions..."}\n' +
    '  Multiple changes: {"name": "New Name", "frequency": "2h", "system_prompt": "..."}\n' +
    '  Remove filters: {"filters": null}',
    {
      app_id: z.string().describe('The app ID to update'),
      updates: z.string().describe(
        'JSON string of fields to update. Only include fields you want to change. ' +
        'Set a field to null to remove it. Use "frequency" shorthand for schedule changes.'
      )
    },
    async (args) => {
      try {
        const manager = await waitForAppManager()
        const runtime = getAppRuntime()

        if (!manager) {
          return textResult(NOT_READY, true)
        }

        const app = manager.getApp(args.app_id)
        if (!app) {
          return textResult(`App not found: ${args.app_id}`, true)
        }

        // Parse updates JSON
        let updates: Record<string, unknown>
        try {
          updates = JSON.parse(args.updates)
        } catch (e) {
          return textResult(`Invalid JSON in updates: ${(e as Error).message}`, true)
        }

        // Track whether user explicitly passed subscriptions (vs frequency shorthand)
        const userChangedSubscriptions = updates.subscriptions !== undefined

        // Extract frequency shorthand before passing to spec merge
        const frequencyShorthand = updates.frequency as string | undefined
        const specPatch = { ...updates }
        delete specPatch.frequency // Not a spec field

        // Handle frequency shorthand: update the primary subscription's schedule
        if (frequencyShorthand && typeof frequencyShorthand === 'string') {
          const currentSubs = app.spec.type === 'automation' ? (app.spec.subscriptions ?? []) : []
          const scheduleSub = currentSubs.find(s => s.source.type === 'schedule')

          if (scheduleSub) {
            // Update existing schedule subscription with new interval
            const updatedSubs = currentSubs.map(s => {
              if (s === scheduleSub) {
                return {
                  ...s,
                  source: {
                    type: 'schedule' as const,
                    config: { every: frequencyShorthand }
                  }
                }
              }
              return s
            })
            specPatch.subscriptions = updatedSubs
          } else {
            // No schedule subscription exists — add one
            const newSub = {
              source: { type: 'schedule' as const, config: { every: frequencyShorthand } }
            }
            specPatch.subscriptions = [...currentSubs, newSub]
          }
        }

        // Skip if no actual spec changes
        if (Object.keys(specPatch).length === 0) {
          return textResult('No updates provided.', true)
        }

        // Prevent type changes
        if (specPatch.type && specPatch.type !== 'automation') {
          return textResult('Cannot change app type. It must remain "automation".', true)
        }
        delete specPatch.type // Never allow type change via update

        // Apply JSON Merge Patch to spec
        try {
          manager.updateSpec(args.app_id, specPatch)
        } catch (e) {
          return textResult(`Update failed: ${(e as Error).message}`, true)
        }

        // Hot-sync subscriptions if subscriptions or frequency changed.
        // Uses syncAppSubscriptions() instead of deactivate/activate to avoid
        // aborting any currently running execution for this app.
        if (runtime && (userChangedSubscriptions || frequencyShorthand)) {
          runtime.syncAppSubscriptions(args.app_id)
        }

        // Build summary of what changed
        const changedFields = Object.keys(updates).filter(k => updates[k] !== undefined)
        return textResult(`App ${args.app_id} updated successfully. Changed: ${changedFields.join(', ')}.`)
      } catch (e) {
        return textResult(`Error updating app: ${(e as Error).message}`, true)
      }
    }
  )

  const trigger_automation_app = tool(
    'trigger_automation_app',
    'Manually trigger an automation app to run immediately, regardless of its schedule. ' +
    'Each app allows only one active execution at a time — if the app is already running ' +
    'or queued, the trigger is rejected and you should inform the user and wait.',
    {
      app_id: z.string().describe('The app ID to trigger')
    },
    async (args) => {
      try {
        const runtime = getAppRuntime()

        if (!runtime) {
          return textResult(NOT_READY, true)
        }

        const result = await runtime.triggerManually(args.app_id)

        const runIdPart = result.runId ? ` Run ID: ${result.runId}.` : ''
        return textResult(`App ${args.app_id} triggered successfully. Outcome: ${result.outcome}.${runIdPart}`)
      } catch (e) {
        if (e instanceof ConcurrencyLimitError && e.isPerApp) {
          // Per-app dedup: the same app is already running or queued.
          // Return a non-error response so the AI can inform the user gracefully.
          return textResult(
            `App ${args.app_id} is already running or queued. ` +
            `Only one execution per app is allowed at a time. ` +
            `Please wait for the current run to complete before triggering again.`
          )
        }
        return textResult(`Error triggering app: ${(e as Error).message}`, true)
      }
    }
  )

  // ============================================
  // Skill Management Tool
  // ============================================

  const skill_manage = tool(
    'skill_manage',
    'Manage skills. Supports install and uninstall actions.\n\n' +
    'Actions:\n' +
    '  install: Install a skill from the store (by slug) or from a spec directly\n' +
    '  uninstall: Remove an installed skill\n\n' +
    'Parameters:\n' +
    '  action*: "install" | "uninstall"\n' +
    '  slug?: string — For install from store, the skill slug (e.g. "code-commit")\n' +
    '  spec?: string (JSON) — For direct install, the full SkillSpec object. Must include: name, description, version, and either skill_content (single file) or skill_files (multi-file).\n' +
    '  skill_id?: string — For uninstall, the installed skill ID\n' +
    '  scope?: "global" | "space" — Install scope. "global" = available in all spaces, "space" = current space only. Default: "space".\n\n' +
    'Examples:\n' +
    '  Install from store (current space): { "action": "install", "slug": "code-commit" }\n' +
    '  Install globally: { "action": "install", "slug": "code-commit", "scope": "global" }\n' +
    '  Uninstall: { "action": "uninstall", "skill_id": "xxx-xxx-xxx" }',
    {
      action: z.enum(['install', 'uninstall']).describe('The action to perform'),
      slug: z.string().optional().describe('Skill slug for store install (e.g. "code-commit")'),
      spec: z.string().optional().describe('JSON string of SkillSpec for direct install'),
      skill_id: z.string().optional().describe('Skill ID for uninstall'),
      scope: z.enum(['global', 'space']).optional().describe('Install scope: "global" for all spaces, "space" for current space only. Default: "space"')
    },
    async (args) => {
      try {
        const manager = await waitForAppManager()
        if (!manager) {
          return textResult(NOT_READY, true)
        }

        const targetSpaceId = args.scope === 'global' ? null : spaceId

        if (args.action === 'install') {
          const scopeLabel = args.scope === 'global' ? 'globally' : 'to current space'

          // Install from store by slug
          if (args.slug) {
            try {
              const appId = await installFromStore(args.slug, targetSpaceId)
              return textResult(`Skill "${args.slug}" installed ${scopeLabel} from store. ID: ${appId}`)
            } catch (e) {
              const msg = (e as Error).message
              if (msg.includes('not found in store')) {
                return textResult(`Skill "${args.slug}" not found in store. Check the slug or try installing from spec directly.`, true)
              }
              throw e
            }
          }

          // Install from spec directly
          if (args.spec) {
            let parsedSpec: Record<string, unknown>
            try {
              parsedSpec = JSON.parse(args.spec)
            } catch (e) {
              return textResult(`Invalid JSON in spec: ${(e as Error).message}`, true)
            }

            // Force skill type and apply defaults
            parsedSpec.type = 'skill'
            if (!parsedSpec.version) parsedSpec.version = '1.0'
            if (!parsedSpec.author) parsedSpec.author = 'User'

            // Validate using the canonical schema
            let validatedSpec
            try {
              validatedSpec = validateAppSpec(parsedSpec)
            } catch (e) {
              return textResult(`Spec validation failed: ${(e as Error).message}`, true)
            }

            const appId = await manager.install(targetSpaceId, validatedSpec, {})
            return textResult(`Skill "${validatedSpec.name}" installed ${scopeLabel}. ID: ${appId}`)
          }

          return textResult(
            'Install requires either "slug" (for store install) or "spec" (for direct install).\n' +
            'Example: { "action": "install", "slug": "code-commit" }',
            true
          )
        }

        if (args.action === 'uninstall') {
          if (!args.skill_id) {
            return textResult(
              'Uninstall requires "skill_id".\n' +
              'Example: { "action": "uninstall", "skill_id": "xxx-xxx-xxx" }',
              true
            )
          }

          const app = manager.getApp(args.skill_id)
          if (!app) {
            return textResult(`Skill not found: ${args.skill_id}`, true)
          }

          if (app.spec.type !== 'skill') {
            return textResult(
              `App ${args.skill_id} is not a skill (type: ${app.spec.type}). ` +
              'Use delete_automation_app for automation apps.',
              true
            )
          }

          await manager.uninstall(args.skill_id)
          return textResult(`Skill "${app.spec.name}" (${args.skill_id}) uninstalled successfully.`)
        }

        return textResult(`Unknown action: ${args.action}`, true)
      } catch (e) {
        return textResult(`Error: ${(e as Error).message}`, true)
      }
    }
  )

  return [
    list_automation_apps,
    create_automation_app,
    update_automation_app,
    delete_automation_app,
    get_automation_status,
    pause_automation_app,
    resume_automation_app,
    trigger_automation_app,
    skill_manage
  ]
}

// ============================================
// Export SDK MCP Server
// ============================================

/**
 * Create Halo Apps SDK MCP Server.
 * Runs in-process and handles all automation app management tools.
 *
 * @param spaceId - The current space ID (captured via closure by all tools)
 */
export function createHaloAppsMcpServer(spaceId: string) {
  const allTools = buildTools(spaceId)

  return createSdkMcpServer({
    name: 'halo-apps',
    version: '1.0.0',
    tools: allTools
  })
}
