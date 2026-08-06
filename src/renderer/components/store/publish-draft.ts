/**
 * Publish form draft persistence.
 *
 * Auto-saves the editable metadata a user types into the publish dialog so an
 * accidental close, a crash, or a session-expired publish never loses their
 * work — reopening the dialog for the same target restores the draft, and a
 * successful publish clears it. Author is persisted separately (publish-author).
 *
 * Scoped to the installed source only: the key is the stable installed appId.
 * Imported packages have no stable key (and their file blobs are not persisted),
 * so re-importing starts a fresh flow.
 */

const DRAFT_KEY_PREFIX = 'halo:publish-draft:'

export interface PublishDraft {
  name: string
  description: string
  version: string
  changelog: string
  category: string
  tags: string[]
}

/** Stable per-target draft key, or null when the target cannot be keyed. */
export function publishDraftKey(source: string, installedId: string | null | undefined): string | null {
  return source === 'installed' && installedId ? `installed:${installedId}` : null
}

export function loadPublishDraft(key: string | null): PublishDraft | null {
  if (!key) return null
  try {
    const raw = localStorage.getItem(DRAFT_KEY_PREFIX + key)
    if (!raw) return null
    const d = JSON.parse(raw) as Partial<PublishDraft>
    return {
      name: d.name ?? '',
      description: d.description ?? '',
      version: d.version ?? '',
      changelog: d.changelog ?? '',
      category: d.category ?? '',
      tags: Array.isArray(d.tags) ? d.tags : [],
    }
  } catch {
    return null
  }
}

export function savePublishDraft(key: string | null, draft: PublishDraft): void {
  if (!key) return
  try {
    localStorage.setItem(DRAFT_KEY_PREFIX + key, JSON.stringify(draft))
  } catch {
    // Storage full/unavailable — a lost draft is not worth surfacing an error.
  }
}

export function clearPublishDraft(key: string | null): void {
  if (!key) return
  try {
    localStorage.removeItem(DRAFT_KEY_PREFIX + key)
  } catch {
    // ignore
  }
}
