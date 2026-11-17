import { getRuntime } from '../external-runtime'

export const reuseManagedInstallation: ReturnType<typeof getRuntime>['reuse']['reuseManagedInstallation'] = (...args) => getRuntime('anthropic').reuse.reuseManagedInstallation(...args)
