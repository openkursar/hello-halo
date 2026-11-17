import type { ComponentProps } from 'react'
import { RuntimeInstallationList } from '../external-runtime/InstallationList'

export function CcInstallationList(props: Omit<ComponentProps<typeof RuntimeInstallationList>, 'runtimeId'>) {
  return <RuntimeInstallationList runtimeId="anthropic" {...props} />
}
