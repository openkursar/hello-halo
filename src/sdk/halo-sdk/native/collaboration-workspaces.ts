import { loadBinding, nativeError } from './binding.js';
import { collaborationValue } from './collaboration-values.js';
import type { CollaborationMember } from '../collaboration/runtime.js';
import type { MemberWorkspace } from '../collaboration/workspaces.js';
export type { MemberWorkspace } from '../collaboration/workspaces.js';

export class WorkspaceSetupError extends Error {
  constructor(readonly checkout: string, cause: unknown) {
    super('The isolated workspace could not be prepared. Any partial checkout is retained for inspection.', { cause });
  }
}
export async function openMemberWorkspace(options: {
  member: Pick<CollaborationMember, 'id' | 'cwd' | 'isolation'>;
  parentCwd: string;
  additionalDirectories?: readonly string[];
  metadataDirectory?: string;
  signal: AbortSignal;
}): Promise<MemberWorkspace> {
  options.signal.throwIfAborted();
  const handle = new (loadBinding().NativeCollaborationWorkspace)('open', JSON.stringify(options));
  const abort = () => handle.cancel();
  options.signal.addEventListener('abort', abort, { once: true });
  if (options.signal.aborted) abort();
  try { return JSON.parse(await handle.result()) as MemberWorkspace; }
  catch (error) {
    const failure = nativeError(error) as Error & { code?: string; details?: { checkout?: string } };
    if (failure.code === 'WORKSPACE_SETUP' && failure.details?.checkout) throw new WorkspaceSetupError(failure.details.checkout, failure);
    if (failure.code === 'ABORTED' && options.signal.aborted) throw options.signal.reason;
    throw failure;
  } finally { options.signal.removeEventListener('abort', abort); }
}
export async function releaseMemberWorkspace(workspace: MemberWorkspace): Promise<void> {
  const handle = new (loadBinding().NativeCollaborationWorkspace)('release', JSON.stringify(workspace));
  try { await handle.result(); }
  catch (error) { throw nativeError(error); }
}
export function remapWorkspaceDeniedRoots(roots: readonly string[], workspace: MemberWorkspace): string[] {
  return collaborationValue('remapDeniedRoots', { roots, workspace });
}
