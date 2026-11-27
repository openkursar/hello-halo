// Development-only model account provider for the organization sign-in mock.
// It has no login of its own and never contacts a server: the account is placed
// in the profile by a test, and its quota is fixed.
export function getExampleCloudProvider() {
  const model = 'example-model'
  return {
    type: 'example-cloud',
    displayName: 'Example Cloud',
    isConfigured: () => true,
    getBackendConfig: () => null,
    getCurrentModel: () => model,
    getAvailableModels: async () => [model],
    startLogin: async () => ({ success: false, error: 'Example Cloud accounts come with the organization sign-in' }),
    completeLogin: async () => ({ success: false, error: 'Example Cloud accounts come with the organization sign-in' }),
    refreshToken: async () => ({ success: true }),
    checkToken: async () => ({ success: true, data: { valid: true } }),
    logout: async () => ({ success: true }),
    getUserInfo: () => ({ name: 'Example Member' }),
    getQuota: async () => ({ success: true, data: { total: 1000, used: 320, remaining: 680, unit: { en: 'credits' } } }),
  }
}
