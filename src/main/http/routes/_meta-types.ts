/**
 * Type contract for the route metadata files (`*.routes.meta.ts`).
 *
 * Metadata lives beside the routes it describes but stays free of runtime
 * imports: the build-time generator loads these modules standalone, from a
 * temp file where no relative import would resolve. The one import below is
 * type-only and therefore erased — keep every import in this file that way.
 */

import type { ApiRefGroupId } from '../../services/api-ref/groups'

/** Re-exported under the name the meta files use; the list itself lives in `services/api-ref/groups.ts`. */
export type GroupId = ApiRefGroupId

/**
 * `ai` — listed in the manual, allowed through the self-API scope.
 * `wrapped` — listed in the manual as a pointer to the MCP tool that owns this
 *   operation, and denied by the scope so the wrapper stays the only door.
 * `internal` — absent from both. Renderer-facing plumbing.
 * `unlabeled` — nobody has judged this route yet. Scaffolding writes it and the
 *   generator refuses to build while any remain, so an unreviewed route cannot
 *   reach the same silent outcome as one deliberately kept internal.
 */
export type Expose = 'ai' | 'wrapped' | 'internal' | 'unlabeled'

interface RouteMetaBase {
  expose: Expose
}

export interface InternalRouteMeta extends RouteMetaBase {
  expose: 'internal'
}

export interface UnlabeledRouteMeta extends RouteMetaBase {
  expose: 'unlabeled'
}

export interface AiRouteMeta extends RouteMetaBase {
  expose: 'ai'
  group: GroupId | GroupId[]
  /** Imperative one-liner, English, ≤80 chars. */
  summary: string
  /** Request body shape, written as the literal JSON an agent would send. */
  body?: string
  /** Response shape, read off the handler — never guessed. */
  returns?: string
  /** Error meanings and recovery hints, one per line. */
  notes?: string
  /**
   * Consequence of a successful call. Absent means safe/read-only.
   * Rendered as a loud marker: the agent runs without a confirmation prompt,
   * so wiping a whole collection and removing one document must not read as
   * equally weighty on the page.
   */
  impact?: 'irreversible' | 'reversible'
  /**
   * The narrower operation a user more likely meant, as a full path.
   * A wide destructive route is the one that reads as canonical — shortest
   * path, and the only one whose method is DELETE — so the correction has to
   * appear on the very line being misread, not in a group-level cross
   * reference the agent has already scrolled past.
   */
  narrowerAlternative?: string
}

export interface WrappedRouteMeta extends RouteMetaBase {
  expose: 'wrapped'
  group: GroupId | GroupId[]
  summary: string
  /** Name of the MCP tool that must be used instead. */
  useInstead: string
  /** What a raw call would skip, phrased so the reason is self-evident. */
  bypassCost: string
  /**
   * What to do when the named tool is not in this session's toolset.
   * Without it the agent tries the tool, finds nothing, falls back to the raw
   * path, gets a 403, and concludes Halo cannot do the thing — each step a
   * reasonable inference, ending in the one answer this whole design exists
   * to prevent.
   */
  unavailable?: string
}

export type RouteMeta =
  | InternalRouteMeta
  | UnlabeledRouteMeta
  | AiRouteMeta
  | WrappedRouteMeta

export interface RouteModuleMeta {
  /** Basename of the described routes file, without `.routes.ts`. */
  file: string
  /** Keyed by `"<METHOD> <path>"`, matching the source literal exactly. */
  routes: Record<string, RouteMeta>
}

export interface GroupMeta {
  /** Rendered as the manual page heading. */
  title: string
  /** What lives here, as a comma-separated list of user-facing capabilities. */
  covers: string
  /**
   * Capability an agent might wrongly look for here, pointing at where it does
   * live — another group, or `tool:<name>` when an MCP tool owns it outright.
   */
  notHere: Record<string, GroupId | `tool:${string}`>
  /**
   * Capabilities Halo has but this build does not hand to the assistant.
   * Silence would read as "Halo cannot do this"; naming them lets the agent
   * tell the user the truth — it exists, do it in the UI.
   */
  withheld?: string[]
  /**
   * Capabilities users ask for that this build has no endpoint for at all,
   * mapped to what to do or say instead.
   *
   * Group -> cross-reference -> full-index search all assume the target
   * exists. When it does not, that ladder only makes the dead end slower to
   * reach and more convincing, so the absence has to be stated where the
   * agent is already looking.
   */
  noEndpoint?: Record<string, string>
}
