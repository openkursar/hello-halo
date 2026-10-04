/**
 * When the space's resource rail steps aside for the canvas: while the active
 * tab's viewer shows a file list of its own (two file trees side by side only
 * crowd each other), or while an open rail would squeeze the canvas below a
 * usable width. Stepping aside hides the rail without touching the user's own
 * setting, so it comes back by itself once neither holds. A user who opens the
 * rail anyway keeps it until the canvas context changes: another active tab,
 * or the canvas closing. Pure; `hooks/useRailYield` feeds it from the page.
 */

/** Narrowest canvas worth showing beside an open rail. */
export const MIN_CANVAS_WIDTH = 480

/** The user's own choice about the rail, and the canvas context it was made in. */
export interface RailChoice {
  /** The active tab while the canvas is open; null while it is closed. */
  context: string | null
  /** The user opened the rail in this context. */
  kept: boolean
}

export interface CanvasRoom {
  /** Desktop, with the canvas open beside the chat. */
  canvasOpen: boolean
  /** The active tab's viewer shows a file list of its own. */
  bringsFileList: boolean
  /** An open rail would leave the canvas narrower than MIN_CANVAS_WIDTH. */
  tooNarrow: boolean
}

export function railContext(canvasOpen: boolean, activeTabId: string | null): string | null {
  return canvasOpen ? activeTabId ?? '' : null
}

/** The choice as it stands in `context`: one made in another context does not carry over. */
export function choiceIn(choice: RailChoice, context: string | null): RailChoice {
  return choice.context === context ? choice : { context, kept: false }
}

/** After the user opens or closes the rail themselves (resizing it counts as keeping it open). */
export function userSetRail(choice: RailChoice, open: boolean): RailChoice {
  const kept = open && choice.context !== null
  return choice.kept === kept ? choice : { ...choice, kept }
}

/** `sharedWidth` is what the canvas and an open rail divide between them. */
export function canvasTooNarrow(sharedWidth: number, railWidth: number): boolean {
  return sharedWidth - railWidth < MIN_CANVAS_WIDTH
}

export function railYields(choice: RailChoice, room: CanvasRoom): boolean {
  if (!room.canvasOpen || choice.kept) return false
  return room.bringsFileList || room.tooNarrow
}

/** Whether something other than the user, such as files the AI just touched, may open the rail now. */
export function railMayAutoOpen(choice: RailChoice, room: CanvasRoom): boolean {
  return !railYields(choice, room)
}
