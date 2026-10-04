/**
 * How the confirmation for discarding a new file names the trash it goes to:
 * the one on the computer Halo runs on. Only the desktop app knows that
 * computer's system (`host`); a remote client is on another device, so it
 * names none rather than its own.
 */

import type { Translate } from './scope'

export interface TrashWording {
  title: string
  message: string
  confirmLabel: string
}

export function trashWording(name: string, host: { isWindows: boolean } | undefined, t: Translate): TrashWording {
  if (!host) {
    return {
      title: t('Move {{name}} to your computer’s trash?', { name }),
      message: t('Git has no copy of this new file. You can restore it from your computer’s trash.'),
      confirmLabel: t('Move to trash'),
    }
  }
  if (host.isWindows) {
    return {
      title: t('Move {{name}} to the Recycle Bin?', { name }),
      message: t('Git has no copy of this new file. You can restore it from the Recycle Bin.'),
      confirmLabel: t('Move to Recycle Bin'),
    }
  }
  return {
    title: t('Move {{name}} to the Trash?', { name }),
    message: t('Git has no copy of this new file. You can restore it from the Trash.'),
    confirmLabel: t('Move to Trash'),
  }
}
