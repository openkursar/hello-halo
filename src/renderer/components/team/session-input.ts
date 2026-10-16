import { api } from '../../api'
import i18n from '../../i18n'

/** Team transcripts live outside the board chat backend; use their app-chat entry directly. */
export async function injectTeamSessionMessage(
  input: Parameters<typeof api.appChatInject>[0],
  sendAfterTurn: () => Promise<boolean>
): Promise<boolean> {
  const response = await api.appChatInject(input)
  if (!response.success) throw new Error(response.error || i18n.t('Failed to add message'))
  if (response.data?.delivered !== false) return true
  if (response.data.stopped) return false
  return sendAfterTurn()
}
