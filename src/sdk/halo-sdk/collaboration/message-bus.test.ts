import { expect, it, vi } from 'vitest';
import { createMessageBus } from './message-bus.js';
import type { MessageBusStore } from './message-store.js';
import type { TeamEnvelope, TeamTriggerContext } from './protocol.js';
import { spaceCoordinatorAppId, teamMemberAddress } from './protocol.js';

it('routes the reserved lead address to the scoped identity, not a same-named peer', async () => {
  const root = { appId: spaceCoordinatorAppId('original-chat'), memberName: 'coordinator', isLead: true };
  const peer = { appId: 'peer-id', memberName: 'lead', isLead: false };
  const alice = { appId: 'alice-id', memberName: 'Alice' };
  const members = [root, peer, alice];
  const getMember = vi.fn((team: string, id: string, work?: string) =>
    team === 'team' && work === 'work' ? members.find(member => member.appId === id) ?? null : null);
  const store: MessageBusStore = {
    getMember, getMemberByName: (_team, name) => members.find(member => member.memberName === name) ?? null,
    listMembersByTeam: () => members, isEdgeAllowed: () => false,
    getTeamById: () => ({ leadAppId: root.appId }), getEpochById: () => ({ endedAt: null }),
  };
  const deliver = vi.fn(async () => 'dispatched' as const);
  const bus = createMessageBus({ store, hooks: { deliverToCoordinator: deliver, wakeTarget: vi.fn(), isBusy: () => false } });
  await bus.send({ teamId: 'team', epochId: 'work', fromAppId: alice.appId, to: 'lead', message: 'Verified result.' });
  expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ envelope: expect.objectContaining({ toAppId: root.appId }) }));
  expect(bus.resolveMemberAppId('team', peer.appId, 'work')).toBe(peer.appId);
  expect(teamMemberAddress(peer)).toBe(peer.appId);
  expect(() => bus.resolveMemberAppId('team', 'lead', 'another-work')).toThrow('No member');
  expect(() => bus.assertCanContact('team', alice.appId, root.appId, 'structured', 'work')).toThrow('not allowed');
  expect(getMember).toHaveBeenCalledWith('team', root.appId, 'work');
  bus.resetEpoch('work');
});

it('uses the actual runtime sender for admission and never upgrades a previously stamped notice', async () => {
  const member = { appId: 'lead', memberName: 'lead' };
  const store: MessageBusStore = {
    getMember: () => member, getMemberByName: () => member, listMembersByTeam: () => [member],
    isEdgeAllowed: () => true, getTeamById: () => ({}), getEpochById: () => ({ endedAt: null }),
  };
  let incarnation = 'before-stop';
  const acquire = vi.fn(() => incarnation);
  const wake = vi.fn(async () => {});
  const bus = createMessageBus({ store, hooks: {
    acquireRecipientFence: acquire, acceptRecipientFence: (_target, fence) => fence === incarnation,
    wakeTarget: wake, isBusy: () => false,
  } });
  const envelope: TeamEnvelope = { id: 'notice', teamId: 'team', epochId: 'work', fromAppId: 'lead',
    toAppId: 'lead', body: 'A member finished.', createdAt: 1, correlationId: 'notice' };
  const trigger: TeamTriggerContext = { teamId: 'team', epochId: 'work', fromAppId: null,
    correlationId: 'notice', requestId: 'source/member', kind: 'member_stopped', wait: false };
  await bus.deliverRuntimeWake({ envelope, trigger, onBusy: 'buffer' });
  expect(acquire).toHaveBeenCalledTimes(1);
  expect(acquire).toHaveBeenCalledWith({ teamId: 'team', epochId: 'work', appId: 'lead', fromAppId: null, requestId: 'source/member' });
  expect(wake).toHaveBeenCalledTimes(1);
  expect(trigger.recipientFence).toBe('before-stop');
  incarnation = 'after-stop';
  await expect(bus.deliverRuntimeWake({ envelope, trigger, onBusy: 'buffer' })).rejects.toThrow('stopped recipient');
  expect(acquire).toHaveBeenCalledTimes(1);
  expect(wake).toHaveBeenCalledTimes(1);
  bus.resetEpoch('work');
});
