/**
 * Sentinel used in space-picker UIs (<select> options, scope dropdowns) to
 * represent `spaceId = null` (global scope). A DOM option value cannot be
 * null, so each picker needs an in-band marker; this constant keeps every
 * picker on the same marker instead of drifting between '' and '__global__'
 * across pickers.
 */
export const GLOBAL_SCOPE = '__global__'
