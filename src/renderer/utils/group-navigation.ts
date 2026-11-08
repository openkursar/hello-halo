import { useAppStore } from '../stores/app.store'
import { useGroupEditRequest } from '../stores/ai-group-ui.store'

/** Opens Settings on a group's editor, from wherever the group was seen. */
export function openGroupEditor(groupId: string) {
  useGroupEditRequest.getState().request(groupId)
  useAppStore.getState().navigate('settings')
}
