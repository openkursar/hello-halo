import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTurnGate, TurnGateCapacityError } from './index.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('shared collaboration admission', () => {
  it('starts no timer or engine for an unused gate and does not format success traces by default', async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const describeJob = vi.fn(() => { throw new Error('must not format unused traces'); });
    const dispatch = vi.fn(async () => {});
    const gate = createTurnGate({ isBusy: () => false, dispatch }, { describeJob });
    expect(vi.getTimerCount()).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
    await gate.deliver('first', { body: 'private context' });
    gate.release('first');
    expect(describeJob).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('separates unknown and different permissions but delivers compatible inputs into a live turn', async () => {
    vi.useFakeTimers();
    type Input = { identity?: string; body: string };
    let busy = true;
    const live = vi.fn(() => true);
    const dispatch = vi.fn(async (_key: string, _job: Input) => {});
    const gate = createTurnGate<Input>({
      isBusy: () => busy,
      getActiveIdentity: () => 'owner',
      getJobIdentity: job => job.identity,
      deliverMidTurn: live,
      dispatch,
    });
    expect(await gate.deliver('chat', { body: 'unknown' })).toBe('buffered');
    expect(await gate.deliver('chat', { identity: 'guest', body: 'guest' })).toBe('buffered');
    expect(await gate.deliver('chat', { identity: 'owner', body: 'owner' })).toBe('mid_turn');
    expect(live).toHaveBeenCalledTimes(1);
    expect(live).toHaveBeenCalledWith('chat', { identity: 'owner', body: 'owner' });
    busy = false;
    gate.release('chat');
    gate.drain('chat');
    await Promise.resolve();
    expect(dispatch).toHaveBeenLastCalledWith('chat', { body: 'unknown' });
    gate.release('chat');
    gate.drain('chat');
    await Promise.resolve();
    expect(dispatch).toHaveBeenLastCalledWith('chat', { identity: 'guest', body: 'guest' });
    gate.release('chat');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refuses new overflow without losing previously accepted work', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const discarded = vi.fn();
    const gate = createTurnGate({ isBusy: () => true, dispatch: async () => {} }, {
      bufferCap: 1, onDiscard: discarded,
    });
    await gate.deliver('chat', 'accepted');
    await expect(gate.deliver('chat', 'overflow')).rejects.toBeInstanceOf(TurnGateCapacityError);
    expect(gate.bufferedJobs('chat')).toEqual(['accepted']);
    expect(discarded).not.toHaveBeenCalled();
    gate.discard(() => true, 'test teardown');
    expect(discarded).toHaveBeenCalledTimes(1);
    expect(discarded).toHaveBeenCalledWith('accepted', 'test teardown');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('holds returned work after a stop until an explicit new delivery', async () => {
    vi.useFakeTimers();
    const dispatch = vi.fn(async () => {});
    const gate = createTurnGate<string>({ isBusy: () => false, dispatch });
    gate.park('chat');
    gate.putBack('chat', ['interrupted input']);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(dispatch).not.toHaveBeenCalled();
    await gate.deliver('chat', 'continue');
    await Promise.resolve();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith('chat', 'interrupted input');
    gate.release('chat');
    gate.drain('chat');
    await Promise.resolve();
    expect(dispatch).toHaveBeenLastCalledWith('chat', 'continue');
    gate.release('chat');
    expect(vi.getTimerCount()).toBe(0);
  });
});
