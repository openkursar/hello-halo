import { api } from '../api'
import { clearUpdateSnooze } from './update-snooze'

/** An update check the user asked for: it outranks an earlier deferral, so the prompt reopens. */
export async function requestUpdateCheck(): Promise<void> {
  clearUpdateSnooze()
  await api.checkForUpdates()
}
