/**
 * Unit tests for core/goal-reminders — the goal and open-work text the
 * harness shows the model.
 */

import { describe, it, expect } from 'vitest';
import type { Goal } from '../types/goal.js';
import {
  goalChangeNoticeText,
  goalRecitationText,
  openWorkCheckText,
  openWorkStateKey,
  renderGoal,
} from './goal-reminders.js';

const goal: Goal = {
  objective: 'Reconcile all invoices',
  doneWhen: ['Every invoice marked', 'Summary saved'],
  status: 'active',
  updatedBy: 'agent',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('renderGoal', () => {
  it('lists the objective, criteria and status', () => {
    expect(renderGoal(goal)).toBe(
      'Objective: Reconcile all invoices\nDone when:\n- Every invoice marked\n- Summary saved\nStatus: active',
    );
  });

  it('omits the criteria heading when there are none', () => {
    expect(renderGoal({ ...goal, doneWhen: [] })).not.toContain('Done when');
  });
});

describe('goalRecitationText', () => {
  it('adds todo progress when there is a list', () => {
    const text = goalRecitationText(goal, [
      { content: 'Match January', status: 'completed' },
      { content: 'Match February', status: 'in_progress' },
      { content: 'Match March', status: 'pending' },
    ]);
    expect(text).toContain('Current goal:');
    expect(text).toContain('Todo: 1 of 3 completed; in progress: "Match February".');
  });

  it('is just the goal without a list', () => {
    expect(goalRecitationText(goal)).not.toContain('Todo:');
  });
});

describe('goalChangeNoticeText', () => {
  it('announces a new goal', () => {
    expect(goalChangeNoticeText(null, goal)).toMatch(/^The user set a goal for this work\./);
  });

  it('announces an edit with the previous objective', () => {
    const text = goalChangeNoticeText({ ...goal, objective: 'Old objective' }, goal);
    expect(text).toMatch(/^The user updated the goal\./);
    expect(text).toContain('Previous objective: Old objective');
  });

  it('announces a removal', () => {
    expect(goalChangeNoticeText(goal, null)).toBe(
      'The user removed the goal "Reconcile all invoices". It no longer applies.',
    );
  });
});

describe('openWorkCheckText', () => {
  it('is null when nothing is open', () => {
    expect(openWorkCheckText(null, [])).toBeNull();
    expect(openWorkCheckText({ ...goal, status: 'complete' }, [{ content: 'x', status: 'completed' }])).toBeNull();
  });

  it('names the open goal and the next todo, and leaves the decision to the model', () => {
    const text = openWorkCheckText(goal, [
      { content: 'Match January', status: 'completed' },
      { content: 'Match February', status: 'pending' },
    ])!;
    expect(text).toContain('the goal "Reconcile all invoices" is not marked complete');
    expect(text).toContain('1 of 2 todo items are unfinished (next: "Match February")');
    expect(text).toContain('This is a check, not an instruction to continue.');
  });

  it('prefers the in-progress item as next', () => {
    const text = openWorkCheckText(null, [
      { content: 'A', status: 'pending' },
      { content: 'B', status: 'in_progress' },
    ])!;
    expect(text).toContain('next: "B"');
  });
});

describe('openWorkStateKey', () => {
  it('changes when the goal or todos change, not otherwise', () => {
    const todos = [{ content: 'A', status: 'pending' }];
    const key = openWorkStateKey(goal, todos);
    expect(openWorkStateKey({ ...goal, updatedAt: 'later' }, todos)).toBe(key);
    expect(openWorkStateKey(goal, [{ content: 'A', status: 'in_progress' }])).not.toBe(key);
    expect(openWorkStateKey({ ...goal, objective: 'Other' }, todos)).not.toBe(key);
  });
});
