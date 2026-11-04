import { describe, it, expect } from 'vitest'
import { agentErrorText } from '../../../../src/renderer/components/chat/agent-error-text'
import { COMMAND_ENVIRONMENT_NOT_INSTALLED_ERROR } from '../../../../src/shared/constants/agent-errors'

describe('agentErrorText', () => {
  const t = (key: string) => `translated:${key}`

  // The t() key must stay the stored English text, or nothing is ever translated.
  it('shows the missing command environment in the interface language', () => {
    expect(agentErrorText(COMMAND_ENVIRONMENT_NOT_INSTALLED_ERROR, t)).toBe(`translated:${COMMAND_ENVIRONMENT_NOT_INSTALLED_ERROR}`)
  })

  it('leaves any other error as it came', () => {
    expect(agentErrorText('process exited with code 1', t)).toBe('process exited with code 1')
  })
})
