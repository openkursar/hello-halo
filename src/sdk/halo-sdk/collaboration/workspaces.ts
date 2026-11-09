import { execFile } from '../utils/processes.js';
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import type { CollaborationMember } from './runtime.js';

export interface MemberWorkspace {
  cwd: string;
  gitRoot?: string;
  gitCommonDirectory?: string;
  checkout?: string;
  initialHead?: string;
}

export class WorkspaceSetupError extends Error {
  constructor(readonly checkout: string, cause: unknown) {
    super('The isolated workspace could not be prepared. Any partial checkout is retained for inspection.', { cause });
  }
}

function within(root: string, path: string): boolean {
  const part = relative(root, path);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
}

async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolveResult, reject) => {
    execFile('git', args, { cwd, signal, windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolveResult(stdout.trim());
    });
  });
}

/** Placement survives idle session eviction; only host shutdown considers checkout removal. */
export async function openMemberWorkspace(options: {
  member: Pick<CollaborationMember, 'id' | 'cwd' | 'isolation'>;
  parentCwd: string;
  additionalDirectories?: readonly string[];
  metadataDirectory?: string;
  signal: AbortSignal;
}): Promise<MemberWorkspace> {
  const { member, signal } = options;
  signal.throwIfAborted();
  if (!/^[A-Za-z0-9_-]+$/.test(member.id)) throw new Error('Invalid collaborator workspace identity');
  const parentCwd = await realpath(options.parentCwd);
  const roots = await Promise.all([parentCwd, ...(options.additionalDirectories ?? []).map(path => resolve(parentCwd, path))].map(path => realpath(path)));
  const requested = member.cwd ?? parentCwd;
  if (!isAbsolute(requested)) throw new Error('Collaborator cwd must be an absolute path');
  const baseCwd = await realpath(requested);
  if (!roots.some(root => within(root, baseCwd)) || !(await stat(baseCwd)).isDirectory()) throw new Error('Collaborator cwd is outside the authorized workspace');
  if (member.cwd && member.isolation) throw new Error('cwd and isolation cannot be combined');
  const metadata = options.metadataDirectory ? join(options.metadataDirectory, `${member.id}.json`) : undefined;
  let previous: MemberWorkspace | undefined;
  if (metadata) {
    try {
      const value = JSON.parse(await readFile(metadata, 'utf8')) as MemberWorkspace;
      if (typeof value.cwd !== 'string') throw new Error('Invalid collaborator workspace record');
      previous = value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (member.isolation !== 'worktree') {
    if (previous && previous.cwd !== baseCwd) throw new Error('The collaborator workspace changed; its history cannot be silently moved');
    return { cwd: baseCwd };
  }

  const gitRoot = await realpath(await git(baseCwd, ['rev-parse', '--show-toplevel'], signal));
  const gitCommonDirectory = await realpath(resolve(baseCwd, await git(baseCwd, ['rev-parse', '--git-common-dir'], signal)));
  const checkout = join(await realpath(tmpdir()), `halo-collaboration-${member.id}`);
  const subdir = relative(gitRoot, baseCwd);
  if (!within(gitRoot, baseCwd)) throw new Error('Invalid collaborator repository root');
  if (previous && (previous.checkout !== checkout || previous.gitRoot !== gitRoot
    || (previous.gitCommonDirectory && previous.gitCommonDirectory !== gitCommonDirectory)
    || !previous.initialHead || !/^[a-f0-9]{40,64}$/.test(previous.initialHead))) {
    throw new Error('The isolated workspace record does not match this repository');
  }
  let exists = false;
  try { await stat(checkout); exists = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (exists && !previous) throw new Error('A collaborator checkout already exists without an ownership record; inspect it before retrying');
  const initialHead = previous?.initialHead ?? await git(gitRoot, ['rev-parse', '--verify', 'HEAD'], signal);
  if (!exists) {
    try { await git(gitRoot, ['worktree', 'add', '--detach', checkout, initialHead], signal); }
    catch (error) {
      console.warn(`[Collaboration] Worktree creation failed; any partial checkout is retained: member=${member.id}`);
      throw new WorkspaceSetupError(checkout, error);
    }
  }
  try {
    const checkoutRoot = await realpath(checkout);
    const registeredRoot = await realpath(await git(checkout, ['rev-parse', '--show-toplevel'], signal));
    const registeredCommon = await realpath(resolve(checkout, await git(checkout, ['rev-parse', '--git-common-dir'], signal)));
    if (registeredRoot !== checkoutRoot || registeredCommon !== gitCommonDirectory) throw new Error('The checkout does not belong to the authorized repository');
    const cwd = await realpath(join(checkout, subdir));
    if (!within(checkoutRoot, cwd) || !(await stat(cwd)).isDirectory()) throw new Error('The isolated working directory escapes or is absent from the checkout');
    const workspace: MemberWorkspace = { cwd, gitRoot, gitCommonDirectory, checkout, initialHead };
    if (metadata) {
      await mkdir(options.metadataDirectory!, { recursive: true, mode: 0o700 });
      const staging = `${metadata}.tmp`;
      await writeFile(staging, JSON.stringify(workspace), { mode: 0o600 });
      await rename(staging, metadata);
    }
    // Return an allocated lease to its owner even if cancellation raced the final write.
    return workspace;
  } catch (error) {
    throw new WorkspaceSetupError(checkout, error);
  }
}

export async function releaseMemberWorkspace(workspace: MemberWorkspace): Promise<void> {
  if (!workspace.checkout || !workspace.gitRoot || !workspace.initialHead) return;
  try {
    const [status, head, history] = await Promise.all([
      git(workspace.checkout, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored']),
      git(workspace.checkout, ['rev-parse', '--verify', 'HEAD']),
      git(workspace.checkout, ['reflog', 'show', '--format=%H', 'HEAD']),
    ]);
    if (status || head !== workspace.initialHead || history.split(/\r?\n/).some(commit => commit !== workspace.initialHead)) {
      console.warn('[Collaboration] Isolated checkout retained because it contains work or history changes');
      return;
    }
    const repository = workspace.gitCommonDirectory ?? workspace.gitRoot;
    await git(repository, ['worktree', 'remove', workspace.checkout]);
  } catch (error) {
    console.warn('[Collaboration] Isolated checkout retained because cleanup could not be verified', error);
  }
}

export function remapWorkspaceDeniedRoots(roots: readonly string[], workspace: MemberWorkspace): string[] {
  if (!workspace.checkout || !workspace.gitRoot) return [...roots];
  const mapped = roots.flatMap(root => within(root, workspace.gitRoot!) ? [workspace.checkout!]
    : within(workspace.gitRoot!, root) ? [join(workspace.checkout!, relative(workspace.gitRoot!, root))] : []);
  return [...new Set([...roots, ...mapped])];
}
