/**
 * Onboarding RPC contract. Passthrough channels — handlers return the
 * onboarding service result shape unchanged.
 */
import { rawRpcMethod } from '../define'
import type { RpcResponse } from '../define'

export const onboardingRpc = {
  writeOnboardingArtifact: rawRpcMethod<
    [spaceId: string, filename: string, content: string],
    RpcResponse
  >('onboarding:write-artifact'),

  saveOnboardingConversation: rawRpcMethod<
    [spaceId: string, userPrompt: string, aiResponse: string],
    RpcResponse
  >('onboarding:save-conversation'),
}
