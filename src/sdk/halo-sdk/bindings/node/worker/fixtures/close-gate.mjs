import { BroadcastChannel, parentPort, threadId } from 'node:worker_threads';

export async function startWithCloseGate(entry, channelName, mode) {
  const channel = new BroadcastChannel(channelName);
  channel.unref();
  let receive;
  const originalOn = parentPort.on;
  parentPort.on = function (event, listener) {
    if (event !== 'message') return originalOn.call(this, event, listener);
    if (receive) throw new Error('Expected a single SDK worker message listener');
    receive = listener;
    return originalOn.call(this, event, intercept);
  };
  const originalPost = parentPort.postMessage.bind(parentPort);
  const withheld = [];
  const responses = [];
  const forwarded = new Set();
  const lockProbe = `close-gate-probe-${channelName}`;
  let scope;
  let released = false;
  const reply = (frame, args) => {
    originalPost(frame, ...args);
    channel.postMessage({ type: 'closed', error: frame.error });
  };
  parentPort.postMessage = (frame, ...args) => {
    if (frame.type !== 'response' || !forwarded.delete(frame.id)) {
      originalPost(frame, ...args);
    } else if (mode === 'response' && !released) {
      responses.push([frame, args]);
      channel.postMessage({ type: 'held' });
    } else {
      reply(frame, args);
    }
  };
  const forward = frame => {
    forwarded.add(frame.id);
    receive.call(parentPort, frame);
  };
  function intercept(frame) {
    if (frame.type === 'response' && frame.id === lockProbe) {
      if (!frame.error) originalPost({ type: 'event', event: 'unlock', value: { lockId: lockProbe } });
      channel.postMessage({ type: 'probe', error: frame.error });
      return;
    }
    if (frame.type === 'request' && frame.method === 'close') {
      if (!scope) {
        scope = frame.value.scope;
        if (mode === 'request' && !released) channel.postMessage({ type: 'held', threadId });
      }
      if (frame.value.scope === scope) {
        if (mode === 'request' && !released) withheld.push(frame);
        else forward(frame);
        return;
      }
    }
    receive.call(parentPort, frame);
  }
  channel.onmessage = ({ data }) => {
    if (data?.type === 'probe:lock') {
      originalPost({ type: 'request', id: lockProbe, scope, method: 'lock', value: { key: data.key, lockId: lockProbe } });
      return;
    }
    const targeted = data?.type === 'release:thread' && data.threadId === threadId;
    if (!targeted && data !== 'release' && data?.type !== 'release:error') return;
    released = true;
    if (targeted) channel.postMessage({ type: 'released', threadId });
    for (const frame of withheld.splice(0)) forward(frame);
    for (const [frame, args] of responses.splice(0)) {
      const error = data?.type === 'release:error' && !frame.error ? { name: 'Error', message: data.message } : frame.error;
      reply(error ? { type: 'response', id: frame.id, error } : frame, args);
    }
  };
  try {
    await import(entry);
    if (!receive) throw new Error('SDK worker message listener was not installed');
  } finally {
    parentPort.on = originalOn;
  }
}
