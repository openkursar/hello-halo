import { RuntimeSection, type RuntimeSectionProps } from './external-runtime/RuntimeSection'

export function CcRuntimeSection(props: Omit<RuntimeSectionProps, 'runtimeId'>) {
  return <RuntimeSection runtimeId="anthropic" {...props} />
}
