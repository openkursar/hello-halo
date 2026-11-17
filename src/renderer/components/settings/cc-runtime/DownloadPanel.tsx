import type { ComponentProps } from 'react'
import { RuntimeDownloadPanel } from '../external-runtime/DownloadPanel'

export function CcDownloadPanel(props: Omit<ComponentProps<typeof RuntimeDownloadPanel>, 'runtimeId'>) {
  return <RuntimeDownloadPanel runtimeId="anthropic" {...props} />
}
