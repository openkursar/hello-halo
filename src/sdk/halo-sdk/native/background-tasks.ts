import type { BackgroundTask, BackgroundTaskRegistry } from '../tools/bash/background.js';
import type { ToolContextTransport } from './tool-context.js';

export function backgroundTasks(transport: ToolContextTransport): BackgroundTaskRegistry {
  const tasks = new Map<string, WeakRef<BackgroundTask>>();
  const task = (value: Omit<BackgroundTask, 'done'> | null): BackgroundTask | undefined => {
    if (!value) return undefined;
    const existing = tasks.get(value.id)?.deref();
    if (existing) return existing;
    let settled = false;
    const snapshot = { ...value };
    const done = transport.asyncCall('backgroundTasks.wait', [value.id]).then((final: typeof value) => {
      if (final) Object.assign(snapshot, final);
      settled = true;
    });
    // A caller may inspect task status without consuming its completion promise.
    void done.catch(() => undefined);
    const result = new Proxy({ ...snapshot, done }, {
      get(_target, key) {
        if (key === 'done') return done;
        if (!settled) {
          const latest = transport.call('backgroundTasks.snapshot', [value.id]);
          if (latest) Object.assign(snapshot, latest);
        }
        return Reflect.get(snapshot, key);
      },
    }) as BackgroundTask;
    tasks.set(value.id, new WeakRef(result));
    return result;
  };
  return {
    get activeCount() { return transport.call('backgroundTasks.activeCount'); },
    get: (id: string) => task(transport.call('backgroundTasks.get', [id])),
    getAll: () => (transport.call('backgroundTasks.getAll') as Array<Omit<BackgroundTask, 'done'>>).map(value => task(value)!),
    async start(options: Parameters<BackgroundTaskRegistry['start']>[0]) {
      if (options.abortSignal.aborted) throw new Error('Command cancelled before launch');
      const { abortSignal, state, ...plain } = options;
      const value = await transport.asyncCall('backgroundTasks.start', [{ ...plain,
        state: { cwd: state.cwd, envVars: [...state.envVars] },
      }], abortSignal);
      return task(value)!;
    },
    stop: (id: string) => transport.call('backgroundTasks.stop', [id]),
    stopAll: () => { transport.call('backgroundTasks.stopAll'); },
    readOutput: (value: BackgroundTask) => transport.asyncCall('backgroundTasks.readOutput', [{ id: value.id, outputFile: value.outputFile, outputTruncated: value.outputTruncated }]),
    dispose: () => { transport.call('backgroundTasks.dispose'); tasks.clear(); },
    flush: () => transport.asyncCall('backgroundTasks.flush'),
  } as unknown as BackgroundTaskRegistry;
}
