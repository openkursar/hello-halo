/**
 * Home-shell telemetry contract: every renderer-emitted event of the home
 * shell, global navigation and the pages it leads to, with the property keys
 * each one may carry.
 *
 * The main process derives both its renderer allow-list and its per-event
 * property whitelist from this table, so an event emitted here cannot be
 * silently dropped at either gate. Values must be enums, buckets, counts,
 * booleans or system ids — never user-authored text, paths or names.
 */

/** Carried by every event in this contract; injected by the renderer emitter. */
export const HOME_COMMON_PROPS = ['shell'] as const

export const HOME_EVENT_PROPS = {
  'nav.navigate':                   ['to', 'from', 'surface'],
  'nav.task_panel.toggle':          ['open', 'surface', 'continueCount', 'runningCount', 'pinnedCount'],

  'home.view':                      ['spaceKind', 'multiSpace', 'convCount', 'dhCount', 'railOpen', 'entry'],
  'home.empty_state.view':          ['chipCount'],
  'home.first_paint':               ['cold', 'sinceLaunchBucket'],

  'home.chip.click':                ['chip'],
  'home.composer.send':             ['source', 'chip', 'recipient', 'appId', 'hasImages', 'imageCount',
                                     'isInject', 'lenBucket', 'entry'],
  'home.composer.reply':            ['outcome', 'recipient', 'latencyBucket'],
  'home.composer.mention':          ['action', 'type'],
  'home.composer.slash':            ['action', 'kind'],
  'home.composer.attach':           ['action'],
  'home.composer.recipient.switch': ['to', 'appId', 'surface', 'entry'],
  // Controls beside the composer's send button.
  'home.composer.model':            ['action', 'kind'],
  'home.composer.quota':            ['action', 'low'],
  'home.composer.thinking':         ['level', 'kind'],

  'home.conversation.select':       ['kind', 'pinned', 'appId'],
  'home.conversation.create':       ['surface'],
  'home.conversation.action':       ['action', 'kind'],
  'home.dh_group.toggle':           ['collapsed'],
  'home.conversation.section':      ['section', 'action'],

  'home.rail.toggle':               ['open', 'surface'],
  'home.rail.tab.view':             ['tab', 'firstOpen', 'itemCount', 'empty', 'loadBucket', 'ok'],
  'home.rail.item.click':           ['tab', 'action', 'appId'],

  'home.task.item.click':           ['kind', 'status', 'section'],
  'home.task.item.action':          ['action', 'kind'],

  'home.header.action':             ['action', 'surface'],
  'home.space.switch':              ['kind', 'surface', 'toHalo', 'spaceCount', 'searched'],
  'home.space.action':              ['action', 'surface', 'zero'],
  'home.spaces.view':               ['entry', 'spaceCount'],

  'home.search.open':               ['surface', 'scope'],
  'home.search.query':              ['scope', 'outcome', 'zero', 'lenBucket', 'resultBucket', 'latencyBucket'],
  'home.search.pick':               ['kind', 'type', 'rank'],
  'home.search.close':              ['outcome', 'hadQuery', 'deepSearched'],

  'home.tool.open':                 ['tool', 'surface'],
  'home.tool.session':              ['tool', 'used', 'activityBucket', 'durationBucket'],

  'apps.view':                      ['tab', 'entry'],
  'kb.view':                        ['entry'],
} as const satisfies Record<string, readonly string[]>

export type HomeEventName = keyof typeof HOME_EVENT_PROPS

type PropKey<E extends HomeEventName> = (typeof HOME_EVENT_PROPS)[E][number]
type PropValue = string | number | boolean | undefined

/** Properties a caller may pass for event `E` (the common props are injected, not passed). */
export type HomeEventProps<E extends HomeEventName> = Partial<Record<PropKey<E>, PropValue>>

export const HOME_EVENT_NAMES = Object.keys(HOME_EVENT_PROPS) as HomeEventName[]

/** Full key list for an event, common props included — what the main-side whitelist admits. */
export function homeEventWhitelist(event: HomeEventName): string[] {
  return [...HOME_EVENT_PROPS[event], ...HOME_COMMON_PROPS]
}

/**
 * Where a user's intent came from, carried from the action that expressed it
 * to the event that lands it (a page view, a send). `direct` means nothing
 * recent was recorded.
 */
export type HomeEntry =
  | 'nav_rail'
  | 'nav_sheet'
  | 'header'
  | 'home_chip'
  | 'home_rail_dh'
  | 'home_rail_skill'
  | 'home_rail_mcp'
  | 'home_task'
  | 'home_conv_dh'
  | 'composer'
  | 'notification'
  | 'search'
  | 'direct'
