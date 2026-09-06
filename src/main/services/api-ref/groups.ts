/**
 * The capability groups an agent navigates the self-API by.
 *
 * Deliberately a leaf module with zero imports: it is the single source this
 * list has, and its three consumers sit in different layers and different
 * lifetimes — the `halo_api_ref` tool enum (runtime), the loopback middleware's
 * "here is what you can ask for" error (runtime), and `GroupId` in
 * `http/routes/_meta-types.ts` (build time, type-only so the generator still
 * loads that file standalone). A dependency here would reach all three.
 *
 * `scripts/gen-api-ref.mjs` fails the build when this list and the pages
 * declared in `_meta-groups.ts` disagree, so a group can never be offered
 * without a manual page behind it.
 */

export const API_REF_GROUP_IDS = [
  'conversation',
  'workspace',
  'digital-human',
  'knowledge-base',
  'channels',
  'settings',
  'store',
  'terminal',
] as const

export type ApiRefGroupId = (typeof API_REF_GROUP_IDS)[number]
