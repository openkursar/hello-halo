import { COMMAND_ENVIRONMENT_NOT_INSTALLED_ERROR } from '../../../shared/constants/agent-errors'

/** A turn's error as the chat shows it: the known English failures in the interface language, anything else as it came. */
export function agentErrorText(error: string, t: (key: string) => string): string {
  if (error === COMMAND_ENVIRONMENT_NOT_INSTALLED_ERROR) {
    return t('Command execution environment not installed. Please restart the app and complete setup, or install manually in settings.')
  }
  return error
}
