import { loadBinding, nativeError } from './binding.js';

let handle: InstanceType<ReturnType<typeof loadBinding>['NativeCollaborationValue']> | undefined;
export function collaborationValue<T>(name: string, payload: unknown = {}): T {
  try {
    handle ??= new (loadBinding().NativeCollaborationValue)('{}');
    return JSON.parse(handle.call(name, JSON.stringify(payload))) as T;
  } catch (error) { throw nativeError(error); }
}
