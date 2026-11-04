/**
 * Default agent turn limit — single source of truth.
 *
 * Every session entry point (space chat, digital-human chat, automation runs)
 * and the settings UI fall back to this when the user has not set a value.
 * Deliberately high: a turn should end because the work is done, not because
 * a counter ran out.
 */
export const DEFAULT_MAX_TURNS = 999

/**
 * The default before `DEFAULT_MAX_TURNS`. Saving any agent setting wrote the
 * whole agent block, so many configs still carry it without the user ever
 * having chosen it.
 */
export const LEGACY_DEFAULT_MAX_TURNS = 50

/**
 * The team chain-depth default before it became the shared extreme (999).
 * Settings used to save both team circuit limits together, so configs can
 * carry this value without the user ever having chosen it.
 */
export const LEGACY_TEAM_DEFAULT_FORWARD_DEPTH = 8
