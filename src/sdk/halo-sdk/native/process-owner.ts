interface ProcessOwner {
  count(): number;
  reap(): Promise<void>;
}

const owners = new WeakMap<object, ProcessOwner>();

export function registerProcessOwner(target: object, owner: ProcessOwner): void { owners.set(target, owner); }
export function inheritProcessOwner(target: object, source: object): void {
  const owner = owners.get(source);
  if (owner) owners.set(target, owner);
}
export function ownedProcessCount(target: object): number { return owners.get(target)?.count() ?? 0; }
export async function reapOwnedProcesses(target: object): Promise<void> { await owners.get(target)?.reap(); }
