import type { LlmProvider } from '../types/provider.js';

export interface NativeProviderDescriptor { kind: string; config: unknown }
type Methods = Pick<LlmProvider, 'createMessage' | 'createMessageStream' | 'capabilities' | 'listModels' | 'healthCheck'>;
const providers = new WeakMap<LlmProvider, { descriptor: NativeProviderDescriptor; methods: Methods; id: string; name: string }>();
export function registerNativeProvider(provider: LlmProvider, descriptor: NativeProviderDescriptor, methods: Methods): void {
  providers.set(provider, { descriptor, methods, id: provider.id, name: provider.name });
}
export function nativeProviderDescriptor(provider: LlmProvider, underlying = false): NativeProviderDescriptor | undefined {
  const entry = providers.get(provider);
  return entry && (underlying || (entry.id === provider.id && entry.name === provider.name &&
    (Object.keys(entry.methods) as (keyof Methods)[]).every(key => {
      let owner: object | null = provider;
      while (owner) {
        const descriptor = Object.getOwnPropertyDescriptor(owner, key);
        if (descriptor) return Object.hasOwn(descriptor, 'value') && descriptor.value === entry.methods[key];
        owner = Object.getPrototypeOf(owner) as object | null;
      }
      return entry.methods[key] === undefined;
    }))) ? entry.descriptor : undefined;
}
