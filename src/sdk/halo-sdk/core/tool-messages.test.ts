import { describe, expect, it } from 'vitest';
import { ToolMessages } from './tool-messages.js';

describe('tool message backpressure', () => {
  it('stops a producer until the consumer advances and retains message order', async () => {
    const messages = new ToolMessages<string>();
    const produced: number[] = [];
    const producing = (async () => {
      for (let index = 0; index < 100; index++) {
        await messages.send(String(index));
        produced.push(index);
      }
      messages.finish();
    })();
    const stream = messages.stream();
    expect((await stream.next()).value).toBe('0');
    await new Promise(resolve => setImmediate(resolve));
    expect(produced).toEqual([]);
    for (let index = 1; index < 100; index++) expect((await stream.next()).value).toBe(String(index));
    expect((await stream.next()).done).toBe(true);
    await producing;
    expect(produced).toHaveLength(100);
  });

  it('releases a blocked producer when a consumer closes early', async () => {
    const messages = new ToolMessages<string>();
    const pending = messages.send('payload');
    const rejected = expect(pending).rejects.toThrow('consumer closed');
    const stream = messages.stream();
    await stream.next();
    await stream.return();
    await rejected;
  });
});
