import type { RuntimeId } from '../../../shared/types/external-runtime';
import { claudeCodeProvider } from './providers/claude-code';
import { codexProvider } from './providers/codex';
import { createExternalRuntime } from './service';
import { RuntimeError } from './errors';
const instances = new Map<RuntimeId, ReturnType<typeof createExternalRuntime>>();
export function getRuntime(runtimeId: RuntimeId) {
  if (runtimeId !== 'anthropic' && runtimeId !== 'codex') {
    throw new RuntimeError('unsupported-platform');
  }
  let instance = instances.get(runtimeId);
  if (!instance) {
    instance = createExternalRuntime(runtimeId === 'anthropic' ? claudeCodeProvider : codexProvider);
    instances.set(runtimeId, instance);
  }
  return instance;
}
export async function shutdownExternalRuntimes(): Promise<void> {
  await Promise.allSettled([...instances.values()].map(instance => instance.shutdown()));
}
