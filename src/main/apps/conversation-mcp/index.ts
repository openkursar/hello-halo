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
import { readOfficialDoc } from '../../services/official-docs.service'

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
 * Guide the AI must consult before authoring a spec. The path is hard-coded
 * here and nowhere else; renaming the published document would strand every
 * shipped client, so it is fixed for the lifetime of the tool.
 */
const CREATE_GUIDE_PATH = 'create-digital-human/SKILL.md'

/** Everything under this prefix counts as "the authoring guide was consulted". */
const CREATE_GUIDE_PREFIX = 'create-digital-human/'

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
  /**
   * Whether the authoring guide was consulted in this session. The MCP server
   * instance is created per session (see toolsets/broker.ts), so this closure
   * is exactly session-scoped. Set on any guide read attempt, successful or
   * not: the point is that the AI tried, and readOfficialDoc's offline
   * fallback must never be able to lock creation out on an air-gapped machine.
   */
  let guideConsulted = false

  const read_halo_doc = tool(
    'read_halo_doc',
    "Read official Halo documentation and return its raw markdown — Halo's own account of how it " +
    'works, kept current independently of this Halo version. Paths are relative to the ' +
    'documentation root: read "index.md" for the list of available documents, or ' +
    `"${CREATE_GUIDE_PATH}" before creating or updating a digital human. Each entry document ` +
    'lists its companion documents.',
    {
      path: z.string().describe(
        `Document path relative to the guide root, e.g. "${CREATE_GUIDE_PATH}".`
      )
    },
    async (args) => {
      const path = args.path.trim()
      if (path.startsWith(CREATE_GUIDE_PREFIX)) {
        guideConsulted = true
      }

      try {
        const result = await readOfficialDoc(path)
        if (!result.ok) {
          const hint = result.available.length > 0
            ? `\n\nDocuments available offline:\n${result.available.map(d => `- ${d}`).join('\n')}`
            : ''
          return textResult(`${result.reason}${hint}`, true)
        }

        const provenance = result.source === 'bundled'
          ? `<!-- source: offline snapshot bundled with this Halo version${result.snapshotDate ? ` (${result.snapshotDate})` : ''} — the documentation host was unreachable, content may be outdated -->`
          : `<!-- source: ${result.source === 'remote' ? 'documentation host (current)' : 'documentation host (cached this session)'} -->`

        return textResult(`${provenance}\n\n${result.text}`)
      } catch (e) {
        return textResult(`Error reading guide document: ${(e as Error).message}`, true)
      }
    }
  )

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
    `REQUIRED FIRST STEP: call read_halo_doc with path "${CREATE_GUIDE_PATH}" and follow it. ` +
    'It holds the current authoring guide — interview checklist, real trigger mechanics, and the ' +
    'full field reference — and is updated independently of this Halo version.\n\n' +
    'Rules that hold even when that guide cannot be reached:\n' +
    '  - Ask the user for the schedule interval or cron expression. Never assume one.\n' +
    '  - A digital human triggered by WeCom/IM messages needs NO subscriptions: inbound routing comes from binding a channel instance to the app in Settings, not from the spec.\n' +
    '  - Never create config_schema fields for passwords, cookies, or session tokens. Declare login-gated sites in browser_login instead; the app runs in the user\'s own browser session.\n' +
    '  - Any task touching the web must declare permissions ["ai-browser"] and instruct the agent to use AI Browser tools — never HTTP fetch.\n\n' +
    'spec fields: name*, description*, system_prompt* (the sole driver of every run — write it so the ' +
    'agent can execute end to end without improvising; it receives no other context), subscriptions?, ' +
    'config_schema?, requires?, filters?, memory_schema?, output?, escalation?, permissions?, ' +
    'browser_login?, version? (default "1.0"), author? (default "Halo").\n' +
    'Working subscription sources: { source: { type: "schedule", config: { every: "30m" | cron: "0 8 * * *" } } }, ' +
    '{ source: { type: "file", config: { pattern?, path? } } }, ' +
    '{ source: { type: "webhook", config: { path?, secret? } } }.',
    {
      spec: z.string().describe(
        'JSON string of the App Spec object. Must include name, description, system_prompt, and subscriptions. ' +
        'type is always "automation". version defaults to "1.0", author defaults to "Halo".'
      )
    },
    async (args) => {
      try {
        if (!guideConsulted) {
          return textResult(
            `Read the authoring guide first: call read_halo_doc with path "${CREATE_GUIDE_PATH}", ` +
            'follow it (in particular its interview checklist), then call this tool again. ' +
            'The guide carries platform behavior this description cannot keep current.',
            true
          )
        }

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
    read_halo_doc,
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
