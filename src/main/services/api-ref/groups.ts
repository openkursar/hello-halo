/**
 * The capability groups an agent navigates the self-API by, and what each one is.
 *
 * Deliberately a leaf module with zero imports: it is the single source this
 * taxonomy has, and its consumers sit in different layers and different
 * lifetimes — the `halo_api_ref` tool enum and the group descriptions offered
 * beside it (runtime), the loopback middleware's "here is what you can ask
 * for" error (runtime), `GroupId` in `http/routes/_meta-types.ts` (build time,
 * type-only so the generator still loads that file standalone), and the page
 * headings written by `scripts/gen-api-ref.mjs` (build time). A dependency
 * here would reach all of them.
 *
 * The descriptions live here rather than beside the page furniture in
 * `routes/_meta-groups.ts` because they are read at the moment a group is
 * picked, and a page is what comes back *after* picking one. Kept there, the
 * fullest account of a group only arrived once the routing decision it should
 * have informed had already been made.
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

export interface ApiRefGroupDescription {
  /** The group named by the object it owns. Also the manual page heading. */
  title: string
  /**
   * What lives here, as the operations a user would recognise.
   *
   * Never phrased relative to whoever is reading it: "your own conversations"
   * inverts in a digital-human run, where the reader is the digital human and
   * the threads this group holds are the user's with the Halo assistant. Name
   * the object instead.
   *
   * Ends with an exclusion only where choosing wrong ends in "Halo cannot do
   * this". Cheaper misroutes are corrected by `notHere` on the page.
   */
  covers: string
}

export const API_REF_GROUPS: Record<ApiRefGroupId, ApiRefGroupDescription> = {
  conversation: {
    title: 'conversation — chat threads between the user and the Halo assistant, held by a space',
    covers:
      'start a new turn of work, stop or cancel whatever is currently running, see what is still running, list and read conversations and the reasoning behind a message, rename, star and delete them, see which toolsets a conversation has open. Chats with a digital human are not here — see digital-human.',
  },
  workspace: {
    title: 'workspace — spaces and the files they hold',
    covers:
      'create, rename, reorder and delete spaces, space settings and working directory, browse and read produced files and artifacts',
  },
  'digital-human': {
    title:
      'digital-human — digital humans: scheduled or event-triggered automations, and the chat threads users hold with them',
    covers:
      'install and uninstall, pause and resume, manual trigger, schedule and user config, run history and activity, list its chat threads, chat with it in any of them and read the transcript',
  },
  'knowledge-base': {
    title: 'knowledge-base — document collections agents can search',
    covers:
      'create and delete collections, bind them to a space, import and remove documents, resolve read paths back to their source documents, indexing progress and status',
  },
  channels: {
    title: 'channels — inbound IM channels and outbound notifications',
    covers:
      'connect and disconnect IM channels, bind a chat to a digital human, list every thread a digital human has (IM and its own), read a bound chat transcript, configure and test outbound notification channels, drop cached channel tokens',
  },
  settings: {
    title: 'settings — how this build is configured and what it can do',
    covers:
      'application version, sign-in and model providers this build offers, model capability presets, switching model source and model, deleting a model source, the security policy in force, agent engine capabilities and availability, MCP server diagnostics',
  },
  store: {
    title: 'store — browse and install from the app store',
    covers:
      'browse and search store listings, read a listing, install and uninstall store items, install from a local .dhpkg file, skills',
  },
  terminal: {
    title: 'terminal — the terminal session the user can see and type into',
    covers:
      'create a session, write input, read output, close a session. Commands you run for yourself go through your own Bash tool, not here.',
  },
}
